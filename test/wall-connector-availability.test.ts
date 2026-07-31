import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import WallConnecter from "../.homeybuild/drivers/wall-connector/device.js";

function createWcSite(
  id: string | number,
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

test("WallConnecter.getSiteId always returns a string even when the immutable pairing data holds a numeric id", () => {
  const stub = Object.assign(Object.create(WallConnecter.prototype), {
    getData: () => ({ site: 123, din: "din-1" }),
  });

  assert.equal(stub.getSiteId(), "123");
  assert.equal(typeof stub.getSiteId(), "string");
});
