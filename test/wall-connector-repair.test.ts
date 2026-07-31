import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import WallConnecter from "../.homeybuild/drivers/wall-connector/device.js";
import WallConnectorDriver from "../.homeybuild/drivers/wall-connector/driver.js";

function createWcSite(
  id: string,
  wallConnectors: Array<{ din: string; part_name: string }> = [],
  name = "Home Site",
) {
  const site = {
    id,
    name,
    metadata: { access: true },
    sse: new EventEmitter(),
    api: Object.assign(new EventEmitter(), {
      requestPolling: () => () => {},
      cache: {} as Record<string, unknown>,
      getSiteInfo: async () => ({
        response: { components: { wall_connectors: wallConnectors } },
      }),
    }),
  };
  return site;
}

function createDeviceStub(
  sites: Record<string, ReturnType<typeof createWcSite>>,
  data: { site: string; din: string } = { site: "missing-site", din: "din-1" },
) {
  const store: Record<string, unknown> = {};
  const capabilities: Record<string, unknown> = {
    measure_power: undefined,
    evcharger_charging_state: undefined,
    connected_vehicle: undefined,
  };
  const unavailableCalls: Array<{ reason: string }> = [];
  let availableCalls = 0;

  const energySites: Record<string, unknown> = {};
  for (const site of Object.values(sites)) energySites[site.id] = site;

  const stub = Object.assign(Object.create(WallConnecter.prototype), {
    homey: {
      app: { products: { energySites, vehicles: {} } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => data,
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
    // markUnavailable's reason isn't otherwise observable from outside the
    // class (getAvailabilityReason() is protected); the message is a stable
    // stand-in since each reason maps to exactly one translation key here.
    setUnavailable: async (message: unknown) => {
      unavailableCalls.push({ reason: message as string });
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

test("WallConnecter.onInit reports energy-site-not-found when the site itself doesn't resolve", async () => {
  const goodSite = createWcSite("site-1", [{ din: "din-1", part_name: "Wall Connector" }]);
  const { stub, unavailableCalls } = createDeviceStub({ "site-1": goodSite });

  await stub.onInit();

  assert.deepEqual(unavailableCalls, [{ reason: "error.energy_site_not_found" }]);
});

test("WallConnecter's DIN miss grace period tolerates a few misses before flagging the connector missing", async () => {
  const site = createWcSite("site-1");
  const { stub, capabilities, unavailableCalls } = createDeviceStub(
    { "site-1": site },
    { site: "site-1", din: "din-1" },
  );
  await stub.onInit();

  const emitOtherDin = () =>
    site.sse.emit("live_status", {
      live_status: { wall_connectors: [{ din: "other-din", wall_connector_state: 1, wall_connector_power: 0 }] },
    });

  // Grace (2) + threshold (3) = 5 consecutive misses required before the
  // device is flagged - fewer than that must leave it alone.
  emitOtherDin();
  emitOtherDin();
  emitOtherDin();
  emitOtherDin();
  assert.deepEqual(unavailableCalls, [], "still within grace/threshold");
  assert.equal(capabilities.measure_power, undefined, "no data applied for a mismatched DIN");

  emitOtherDin();
  assert.deepEqual(unavailableCalls, [{ reason: "error.wall_connector_not_found" }]);
});

test("WallConnecter's DIN reappearing after misses clears the connector-not-found reason", async () => {
  const site = createWcSite("site-1");
  const { stub, capabilities, unavailableCalls } = createDeviceStub(
    { "site-1": site },
    { site: "site-1", din: "din-1" },
  );
  await stub.onInit();

  for (let i = 0; i < 5; i++) {
    site.sse.emit("live_status", {
      live_status: { wall_connectors: [{ din: "other-din", wall_connector_state: 1, wall_connector_power: 0 }] },
    });
  }
  assert.deepEqual(unavailableCalls, [{ reason: "error.wall_connector_not_found" }]);

  site.sse.emit("live_status", {
    live_status: { wall_connectors: [{ din: "din-1", wall_connector_state: 1, wall_connector_power: 750 }] },
  });

  assert.equal(capabilities.measure_power, 750, "recovered once the DIN reappears");
});

test("WallConnecter.repairConnector validates the target DIN exists at the target site before rebinding", async () => {
  const site = createWcSite("site-1", [{ din: "din-2", part_name: "Wall Connector" }]);
  const { stub } = createDeviceStub({ "site-1": site }, { site: "missing-site", din: "din-1" });
  await stub.onInit();

  await assert.rejects(() => stub.repairConnector("site-1", "does-not-exist"));
  assert.equal(stub.getSiteId(), "missing-site", "no store override written on a failed repair");

  await stub.repairConnector("site-1", "din-2");
  assert.equal(stub.getSiteId(), "site-1");
  assert.equal(stub.getDin(), "din-2");
});

function createDriverStub(sites: Record<string, ReturnType<typeof createWcSite>>) {
  const energySites: Record<string, unknown> = {};
  for (const site of Object.values(sites)) energySites[site.id] = site;

  return Object.assign(new WallConnectorDriver(), {
    homey: { app: { products: { energySites } } },
    getDevices: () => [] as unknown[],
    log: () => {},
  });
}

function createRepairTargetDevice(siteId: string, din: string) {
  return Object.assign(Object.create(WallConnecter.prototype), {
    driver: { manifest: { capabilities: [], capabilitiesOptions: {} } },
    getData: () => ({ site: siteId, din }),
    getCapabilities: () => [],
    getStoreValue: () => null,
    getName: () => `Wall Connector (${siteId}/${din})`,
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

test("WallConnectorDriver.onRepair reports needsRepair:false when the device's site+DIN already resolves", async () => {
  const site = createWcSite("site-1", [{ din: "din-1", part_name: "Wall Connector" }]);
  const driver = createDriverStub({ "site-1": site });
  const device = createRepairTargetDevice("site-1", "din-1");
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_connector_status(), { needsRepair: false });
});

test("WallConnectorDriver.onRepair offers the single unbound connector as a repair candidate", async () => {
  const site = createWcSite("site-1", [{ din: "din-2", part_name: "Wall Connector 2" }]);
  const driver = createDriverStub({ "site-1": site });
  const device = createRepairTargetDevice("stale-site", "stale-din");
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_connector_status(), {
    needsRepair: true,
    candidateId: "site-1::din-2",
    candidateName: "Home Site Wall Connector 2",
  });
});

test("WallConnectorDriver.onRepair never offers a candidate when multiple unbound connectors exist", async () => {
  const site = createWcSite("site-1", [
    { din: "din-2", part_name: "Wall Connector 2" },
    { din: "din-3", part_name: "Wall Connector 3" },
  ]);
  const driver = createDriverStub({ "site-1": site });
  const device = createRepairTargetDevice("stale-site", "stale-din");
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_connector_status(), {
    needsRepair: true,
    candidateId: null,
    candidateName: null,
  });
});

test("WallConnectorDriver.onRepair excludes a connector already bound to another live Wall Connector device", async () => {
  const site = createWcSite("site-1", [
    { din: "din-2", part_name: "Wall Connector 2" },
    { din: "din-3", part_name: "Wall Connector 3" },
  ]);
  const driver = createDriverStub({ "site-1": site });
  const device = createRepairTargetDevice("stale-site", "stale-din");
  const boundDevice = createRepairTargetDevice("site-1", "din-2");
  driver.getDevices = () => [device, boundDevice];
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_connector_status(), {
    needsRepair: true,
    candidateId: "site-1::din-3",
    candidateName: "Home Site Wall Connector 3",
  });
});

test("WallConnectorDriver.onRepair's confirm_repair_connector splits the candidate id and invokes repairConnector", async () => {
  const site = createWcSite("site-1", [{ din: "din-2", part_name: "Wall Connector 2" }]);
  const driver = createDriverStub({ "site-1": site });
  const device = createRepairTargetDevice("stale-site", "stale-din");
  const repairCalls: Array<[string, string]> = [];
  device.repairConnector = async (siteId: string, din: string) => {
    repairCalls.push([siteId, din]);
  };
  const session = createSessionStub();

  await driver.onRepair(session, device);
  await session.handlers.confirm_repair_connector("site-1::din-2");

  assert.deepEqual(repairCalls, [["site-1", "din-2"]]);
});
