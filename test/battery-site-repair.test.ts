import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";
import PowerwallDriver from "../.homeybuild/drivers/battery/driver.js";

const COMMAND_CAPABILITIES = [
  "backup_reserve",
  "allow_export",
  "operation_mode",
  "onoff.charge_grid",
  "onoff.storm",
];

/** Mirrors TeslemetryEnergySiteStream's synchronous cached-payload replay. */
class FakeEnergySiteStream extends EventEmitter {
  siteInfoDocument: Record<string, unknown> | undefined;
}

function createSite(id: string) {
  const apiCalls: Array<[string, unknown[]]> = [];
  const api = new Proxy(
    {},
    {
      get: (_target, method: string) => (...args: unknown[]) => {
        apiCalls.push([method, args]);
        return Promise.resolve();
      },
    },
  );
  const sse = new FakeEnergySiteStream();
  return { id, api, sse, apiCalls };
}

/**
 * A PowerwallDevice whose saved pairing id ("missing-site") is absent from
 * the site registry, reproducing the exact "registered but dead" shape:
 * onInit() must mark it unavailable before registering anything.
 */
function createDeviceStub(sites: Record<string, ReturnType<typeof createSite>>) {
  const store: Record<string, unknown> = {};
  const capabilities: Record<string, unknown> = {
    backup_reserve: undefined,
    allow_export: undefined,
    operation_mode: undefined,
    "onoff.charge_grid": undefined,
    "onoff.storm": undefined,
    measure_battery: undefined,
    measure_power: undefined,
  };
  const capabilityListeners: Record<string, (value: unknown) => Promise<void>> = {};
  const unavailableCalls: unknown[] = [];
  let availableCalls = 0;

  const energySites: Record<string, unknown> = {};
  for (const site of Object.values(sites)) energySites[site.id] = site;

  const stub = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app: { products: { energySites } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: () => ({ trigger: async () => {} }),
      },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ id: "missing-site" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: (capability: string, listener: (value: unknown) => Promise<void>) => {
      capabilityListeners[capability] = listener;
    },
    getStoreValue: (key: string) => (key in store ? store[key] : null),
    setStoreValue: async (key: string, value: unknown) => {
      store[key] = value;
    },
    setAvailable: async () => {
      availableCalls += 1;
    },
    setUnavailable: async (message: unknown) => {
      unavailableCalls.push(message);
    },
    log: () => {},
    error: () => {},
  });
  stub.driver.getDevices = () => [stub];

  return {
    stub,
    capabilityListeners,
    unavailableCalls,
    getAvailableCalls: () => availableCalls,
  };
}

test("PowerwallDevice.onInit reports energy-site-not-found and registers zero listeners, and repairSite() then binds it without losing device identity", async () => {
  const goodSite = createSite("site-1");
  const { stub, capabilityListeners, unavailableCalls, getAvailableCalls } = createDeviceStub({
    "site-1": goodSite,
  });

  await stub.onInit();

  assert.deepEqual(unavailableCalls, ["error.energy_site_not_found"]);
  assert.equal(Object.keys(capabilityListeners).length, 0, "no command listener before repair");
  assert.equal(goodSite.sse.listenerCount("live_status"), 0, "no live_status listener before repair");
  assert.equal(stub.getSiteId(), "missing-site", "still resolves to the original pairing id");

  await stub.repairSite("site-1");

  assert.equal(getAvailableCalls(), 1, "repair marks the device available again");
  assert.equal(stub.getSiteId(), "site-1", "getSiteId now reflects the store override, not getData().id");
  assert.equal(stub.getData().id, "missing-site", "the immutable pairing id itself is untouched");
  assert.equal(goodSite.sse.listenerCount("live_status"), 1, "live_status listener registered");
  for (const capability of COMMAND_CAPABILITIES) {
    assert.equal(
      typeof capabilityListeners[capability],
      "function",
      `${capability} command listener registered after repair`,
    );
  }

  await capabilityListeners.operation_mode("backup");
  assert.deepEqual(goodSite.apiCalls, [["setOperationMode", ["backup"]]]);
});

test("PowerwallDevice.repairSite rejects and leaves the device unbound when the target site doesn't exist", async () => {
  const { stub } = createDeviceStub({ "site-1": createSite("site-1") });
  await stub.onInit();

  await assert.rejects(() => stub.repairSite("does-not-exist"));
  assert.equal(stub.getSiteId(), "missing-site", "no store override was written on failure");
});

/** A PowerwallDriver-owned energy site with a controllable battery flag. */
function createDriverSite(id: string, name: string, hasBattery: boolean) {
  return {
    id,
    name,
    api: {
      getSiteInfo: async () => ({ response: { components: { battery: hasBattery } } }),
    },
  };
}

function createDriverStub(sites: ReturnType<typeof createDriverSite>[]) {
  const energySites: Record<string, unknown> = {};
  for (const site of sites) energySites[site.id] = site;

  return Object.assign(new PowerwallDriver(), {
    homey: { app: { products: { energySites } } },
    getDevices: () => [] as unknown[],
    log: () => {},
  });
}

/** A PowerwallDevice stub sufficient for driver.onRepair's own bookkeeping. */
function createRepairTargetDevice(siteId: string) {
  return Object.assign(Object.create(PowerwallDevice.prototype), {
    driver: { manifest: { capabilities: [], capabilitiesOptions: {} } },
    getData: () => ({ id: siteId }),
    getCapabilities: () => [],
    getStoreValue: () => null,
    getName: () => `Powerwall (${siteId})`,
  });
}

function createSessionStub() {
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  return {
    setHandler: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers[name] = fn;
    },
    handlers,
  };
}

test("PowerwallDriver.onRepair reports needsRepair:false when the device's site already resolves", async () => {
  const driver = createDriverStub([createDriverSite("site-1", "Home Battery", true)]);
  const device = createRepairTargetDevice("site-1");
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_site_status(), { needsRepair: false });
});

test("PowerwallDriver.onRepair offers the single eligible battery site as a repair candidate", async () => {
  const driver = createDriverStub([
    createDriverSite("site-1", "Home Battery", true),
    createDriverSite("site-2", "Solar Only Site", false),
  ]);
  const device = createRepairTargetDevice("stale-site");
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_site_status(), {
    needsRepair: true,
    candidateId: "site-1",
    candidateName: "Home Battery",
  });
});

test("PowerwallDriver.onRepair never offers a candidate when multiple eligible battery sites exist", async () => {
  const driver = createDriverStub([
    createDriverSite("site-1", "Site A", true),
    createDriverSite("site-2", "Site B", true),
  ]);
  const device = createRepairTargetDevice("stale-site");
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_site_status(), {
    needsRepair: true,
    candidateId: null,
    candidateName: null,
  });
});

test("PowerwallDriver.onRepair excludes a battery site already bound to another live Powerwall device", async () => {
  const driver = createDriverStub([
    createDriverSite("site-1", "Already Bound", true),
    createDriverSite("site-2", "Available", true),
  ]);
  const device = createRepairTargetDevice("stale-site");
  const boundDevice = createRepairTargetDevice("site-1");
  driver.getDevices = () => [device, boundDevice];
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_site_status(), {
    needsRepair: true,
    candidateId: "site-2",
    candidateName: "Available",
  });
});

test("PowerwallDriver.onRepair's confirm_repair_site invokes the device's own identity-preserving repairSite", async () => {
  const driver = createDriverStub([createDriverSite("site-1", "Home Battery", true)]);
  const device = createRepairTargetDevice("stale-site");
  const repairSiteCalls: string[] = [];
  device.repairSite = async (siteId: string) => {
    repairSiteCalls.push(siteId);
  };
  const session = createSessionStub();

  await driver.onRepair(session, device);
  await session.handlers.confirm_repair_site("site-1");

  assert.deepEqual(repairSiteCalls, ["site-1"]);
});
