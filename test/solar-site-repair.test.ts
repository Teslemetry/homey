import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import SolarDevice from "../.homeybuild/drivers/solar/device.js";
import SolarDriver from "../.homeybuild/drivers/solar/driver.js";

/** Mirrors TeslemetryEnergySiteStream's synchronous cached-payload replay. */
class FakeEnergySiteStream extends EventEmitter {
  siteInfoDocument: Record<string, unknown> | undefined;
}

function createSite(id: string) {
  return { id, api: {}, sse: new FakeEnergySiteStream() };
}

/**
 * A SolarDevice whose saved pairing id ("missing-site") is absent from the
 * site registry, reproducing the exact "registered but dead" shape: onInit()
 * must mark it unavailable before registering anything - generalizing the
 * same regression battery-site-repair.test.ts covers for Powerwall.
 */
function createDeviceStub(sites: Record<string, ReturnType<typeof createSite>>) {
  const store: Record<string, unknown> = {};
  const capabilities: Record<string, unknown> = {
    measure_power: undefined,
    meter_power: undefined,
    solar_generation_today: undefined,
  };
  const unavailableCalls: unknown[] = [];
  let availableCalls = 0;

  const energySites: Record<string, unknown> = {};
  for (const site of Object.values(sites)) energySites[site.id] = site;

  const stub = Object.assign(Object.create(SolarDevice.prototype), {
    homey: {
      app: { products: { energySites } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
      setTimeout: () => 0,
      clearTimeout: () => {},
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
    capabilities,
    unavailableCalls,
    getAvailableCalls: () => availableCalls,
  };
}

test("SolarDevice.onInit reports energy-site-not-found and registers zero listeners, and repairSite() then binds it without losing device identity", async () => {
  const goodSite = createSite("site-1");
  const { stub, capabilities, unavailableCalls, getAvailableCalls } = createDeviceStub({
    "site-1": goodSite,
  });

  await stub.onInit();

  assert.deepEqual(unavailableCalls, ["error.energy_site_not_found"]);
  assert.equal(goodSite.sse.listenerCount("live_status"), 0, "no live_status listener before repair");
  assert.equal(stub.getSiteId(), "missing-site", "still resolves to the original pairing id");

  await stub.repairSite("site-1");

  assert.equal(getAvailableCalls(), 1, "repair marks the device available again");
  assert.equal(stub.getSiteId(), "site-1", "getSiteId now reflects the store override, not getData().id");
  assert.equal(stub.getData().id, "missing-site", "the immutable pairing id itself is untouched");
  assert.equal(goodSite.sse.listenerCount("live_status"), 1, "live_status listener registered");

  goodSite.sse.emit("live_status", { live_status: { solar_power: 1234 } });
  assert.equal(capabilities.measure_power, 1234, "live again on the repaired site");
});

test("SolarDevice.repairSite rejects and leaves the device unbound when the target site doesn't exist", async () => {
  const { stub } = createDeviceStub({ "site-1": createSite("site-1") });
  await stub.onInit();

  await assert.rejects(() => stub.repairSite("does-not-exist"));
  assert.equal(stub.getSiteId(), "missing-site", "no store override was written on failure");
});

/** A SolarDriver-owned energy site with a controllable solar flag. */
function createDriverSite(id: string | number, name: string, hasSolar: boolean) {
  return {
    id,
    name,
    api: {
      getSiteInfo: async () => ({ response: { components: { solar: hasSolar } } }),
    },
  };
}

function createDriverStub(sites: ReturnType<typeof createDriverSite>[]) {
  const energySites: Record<string, unknown> = {};
  for (const site of sites) energySites[site.id] = site;

  return Object.assign(new SolarDriver(), {
    homey: { app: { products: { energySites } } },
    getDevices: () => [] as unknown[],
    log: () => {},
  });
}

function createRepairTargetDevice(siteId: string | number) {
  return Object.assign(Object.create(SolarDevice.prototype), {
    driver: { manifest: { capabilities: [], capabilitiesOptions: {} } },
    getData: () => ({ id: siteId }),
    getCapabilities: () => [],
    getStoreValue: () => null,
    getName: () => `Solar (${siteId})`,
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

test("SolarDriver.onRepair reports needsRepair:false when the device's site already resolves", async () => {
  const driver = createDriverStub([createDriverSite("site-1", "Home Solar", true)]);
  const device = createRepairTargetDevice("site-1");
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_site_status(), { needsRepair: false });
});

test("SolarDriver.onRepair offers the single eligible solar site as a repair candidate", async () => {
  const driver = createDriverStub([
    createDriverSite("site-1", "Home Solar", true),
    createDriverSite("site-2", "Battery Only Site", false),
  ]);
  const device = createRepairTargetDevice("stale-site");
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_site_status(), {
    needsRepair: true,
    candidateId: "site-1",
    candidateName: "Home Solar",
  });
});

test("SolarDriver.onRepair never offers a candidate when multiple eligible solar sites exist", async () => {
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

test("SolarDriver.onRepair excludes a solar site already bound to another live Solar device", async () => {
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

test("SolarDriver.onRepair excludes a solar site already bound to another live Solar device when ids are the SDK's real numeric type", async () => {
  // EnergyDetails.id is `number` in @teslemetry/api; a device paired before
  // any repair keeps that numeric value in its immutable getData().id.
  const driver = createDriverStub([
    createDriverSite(123, "Already Bound", true),
    createDriverSite(456, "Available", true),
  ]);
  const device = createRepairTargetDevice("stale-site");
  const boundDevice = createRepairTargetDevice(123);
  driver.getDevices = () => [device, boundDevice];
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_site_status(), {
    needsRepair: true,
    candidateId: "456",
    candidateName: "Available",
  });
});

test("SolarDevice.getSiteId always returns a string even when the immutable pairing data holds a numeric id", () => {
  const stub = Object.assign(Object.create(SolarDevice.prototype), {
    getStoreValue: () => null,
    getData: () => ({ id: 123 }),
  });

  assert.equal(stub.getSiteId(), "123");
  assert.equal(typeof stub.getSiteId(), "string");
});

test("SolarDriver.onRepair's confirm_repair_site invokes the device's own identity-preserving repairSite", async () => {
  const driver = createDriverStub([createDriverSite("site-1", "Home Solar", true)]);
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
