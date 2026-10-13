import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import WallConnecter from "../.homeybuild/drivers/wall-connector/device.js";

function createDeviceStub(
  capabilities: Record<string, unknown>,
  vehicles: Record<string, { name: string }> = {},
) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const apiHandlers: Record<string, (event: unknown) => void> = {};
  const store: Record<string, unknown> = {};
  let pollingRequested = false;
  const site = {
    sse: {
      on: (event: string, handler: (event: unknown) => void) => {
        handlers[event] = handler;
      },
      off: () => {},
    },
    api: {
      on: (event: string, handler: (event: unknown) => void) => {
        apiHandlers[event] = handler;
      },
      off: () => {},
      requestPolling: () => {
        pollingRequested = true;
        return () => {};
      },
      cache: {},
    },
    metadata: { access: true },
  };

  const stub = Object.assign(Object.create(WallConnecter.prototype), {
    homey: {
      app: { products: { energySites: { "site-1": site }, vehicles } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: () => ({ trigger: async () => {} }),
      },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
    },
    getData: () => ({ site: "site-1", din: "din-1" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    getStoreValue: (key: string) => (key in store ? store[key] : null),
    setStoreValue: async (key: string, value: unknown) => {
      store[key] = value;
    },
    log: () => {},
    error: () => {},
    destroyed: false,
  });

  return { stub, site, handlers, apiHandlers, capabilities, isPollingRequested: () => pollingRequested };
}

test("WallConnecter's live_status handler ignores an update for a different DIN and leaves capabilities untouched", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    measure_power: undefined,
    evcharger_charging_state: undefined,
    connected_vehicle: undefined,
  });
  await stub.onInit();

  handlers["live_status"]({
    live_status: {
      wall_connectors: [
        { din: "some-other-din", wall_connector_state: 1, wall_connector_power: 500 },
      ],
    },
  });

  assert.equal(capabilities["measure_power"], undefined);
  assert.equal(capabilities["evcharger_charging_state"], undefined);
});

test("mapWallConnectorState maps all four known states via the live_status handler", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    measure_power: undefined,
    evcharger_charging_state: undefined,
    connected_vehicle: undefined,
  });
  await stub.onInit();

  const emit = (state: number) =>
    handlers["live_status"]({
      live_status: {
        wall_connectors: [{ din: "din-1", wall_connector_state: state, wall_connector_power: 0 }],
      },
    });

  emit(1);
  assert.equal(capabilities["evcharger_charging_state"], "plugged_in_charging");
  emit(2);
  assert.equal(capabilities["evcharger_charging_state"], "plugged_out");
  emit(3);
  assert.equal(capabilities["evcharger_charging_state"], "plugged_in");
  emit(4);
  assert.equal(capabilities["evcharger_charging_state"], "plugged_in_paused");
});

test("mapWallConnectorState leaves evcharger_charging_state untouched for an unknown state code", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    measure_power: undefined,
    evcharger_charging_state: "plugged_in",
    connected_vehicle: undefined,
  });
  await stub.onInit();

  handlers["live_status"]({
    live_status: {
      wall_connectors: [{ din: "din-1", wall_connector_state: 99, wall_connector_power: 0 }],
    },
  });

  assert.equal(capabilities["evcharger_charging_state"], "plugged_in");
});

test("findVin resolves connected_vehicle to 'disconnected' when no vin is reported", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    measure_power: undefined,
    evcharger_charging_state: undefined,
    connected_vehicle: undefined,
  });
  await stub.onInit();

  handlers["live_status"]({
    live_status: {
      wall_connectors: [{ din: "din-1", wall_connector_state: 2, wall_connector_power: 0 }],
    },
  });

  assert.equal(capabilities["connected_vehicle"], "disconnected");
});

test("findVin resolves connected_vehicle to the matched vehicle's name", async () => {
  const { stub, handlers, capabilities } = createDeviceStub(
    { measure_power: undefined, evcharger_charging_state: undefined, connected_vehicle: undefined },
    { "5YJ3ABC": { name: "Model 3" } },
  );
  await stub.onInit();

  handlers["live_status"]({
    live_status: {
      wall_connectors: [
        { din: "din-1", vin: "5YJ3ABC", wall_connector_state: 1, wall_connector_power: 0 },
      ],
    },
  });

  assert.equal(capabilities["connected_vehicle"], "Model 3");
});

test("findVin falls back to the raw VIN when the vehicle isn't a paired product", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    measure_power: undefined,
    evcharger_charging_state: undefined,
    connected_vehicle: undefined,
  });
  await stub.onInit();

  handlers["live_status"]({
    live_status: {
      wall_connectors: [
        { din: "din-1", vin: "UNKNOWNVIN", wall_connector_state: 1, wall_connector_power: 0 },
      ],
    },
  });

  assert.equal(capabilities["connected_vehicle"], "UNKNOWNVIN");
});

test("wall_connector_totals feeds this DIN's Wh total into the cumulative meter in kWh", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    meter_power: 0,
  });
  await stub.onInit();

  // The first reading only anchors the monotonic offset to the existing
  // capability value (see updateCumulativeMeter); the running total only
  // reflects new energy from the second reading onward.
  await handlers["wall_connector_totals"]({
    id: "site-1",
    date: "2026-10-12",
    createdAt: "2026-10-12T10:00:00Z",
    totals: { "din-1": 1000, "some-other-din": 9999 },
  });
  await handlers["wall_connector_totals"]({
    id: "site-1",
    date: "2026-10-12",
    createdAt: "2026-10-12T11:00:00Z",
    totals: { "din-1": 1500, "some-other-din": 9999 },
  });

  assert.equal(capabilities["meter_power"], 0.5);
});

test("wall_connector_totals keys the cumulative meter on the event's date, so a new day continues upward", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    meter_power: 0,
  });
  await stub.onInit();

  const send = (date: string, wh: number) =>
    handlers["wall_connector_totals"]({
      id: "site-1",
      date,
      createdAt: `${date}T23:00:00Z`,
      totals: { "din-1": wh },
    });
  await send("2026-10-12", 1000);
  await send("2026-10-12", 4000);
  assert.equal(capabilities["meter_power"], 3);
  // The daily total resets to a lower number on the new day; the meter must
  // keep the prior day's energy and add the new day's on top.
  await send("2026-10-13", 500);
  assert.equal(capabilities["meter_power"], 3.5);
  await send("2026-10-13", 1500);
  assert.equal(capabilities["meter_power"], 4.5);
});

test("wall_connector_totals ignores an event without this DIN or with a non-numeric total", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    meter_power: 0,
  });
  await stub.onInit();

  await handlers["wall_connector_totals"]({
    id: "site-1",
    date: "2026-10-12",
    createdAt: "2026-10-12T10:00:00Z",
    totals: { "some-other-din": 9999 },
  });
  await handlers["wall_connector_totals"]({
    id: "site-1",
    date: "2026-10-12",
    createdAt: "2026-10-12T10:00:00Z",
    totals: { "din-1": null },
  });
  assert.equal(capabilities["meter_power"], 0);
});

test("WallConnecter.onInit listens for live_status and wall_connector_totals and no longer polls chargeHistory", async () => {
  const { stub, handlers, apiHandlers, isPollingRequested } = createDeviceStub({
    measure_power: undefined,
  });

  await stub.onInit();

  assert.equal(typeof handlers["live_status"], "function");
  assert.equal(typeof handlers["wall_connector_totals"], "function");
  assert.equal(isPollingRequested(), false, "no chargeHistory polling");
  assert.equal(apiHandlers["chargeHistory"], undefined);
});

test("WallConnecter.onUninit removes the live_status and wall_connector_totals listeners", async () => {
  const { stub, site } = createDeviceStub({ measure_power: undefined });
  const offCalls: Array<string> = [];
  site.sse.off = (event: string) => {
    offCalls.push(`sse:${event}`);
  };
  await stub.onInit();

  await stub.onUninit();

  assert.deepEqual(offCalls.sort(), [
    "sse:live_status",
    "sse:wall_connector_totals",
  ]);
});
