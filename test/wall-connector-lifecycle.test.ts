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

test("onChargeHistory accumulates energy_added_wh for this DIN into the cumulative meter", async () => {
  const { stub, apiHandlers, capabilities } = createDeviceStub({
    meter_power: 0,
  });
  await stub.onInit();

  // The first reading only anchors the monotonic offset to the existing
  // capability value (see updateCumulativeMeter); the running total only
  // reflects new energy from the second reading onward.
  await apiHandlers["chargeHistory"]({
    response: {
      charge_history: [
        { din: "din-1", energy_added_wh: 1000 },
        { din: "some-other-din", energy_added_wh: 9999 },
      ],
    },
  });
  await apiHandlers["chargeHistory"]({
    response: {
      charge_history: [
        { din: "din-1", energy_added_wh: 1000 },
        { din: "din-1", energy_added_wh: 500 },
        { din: "some-other-din", energy_added_wh: 9999 },
      ],
    },
  });

  assert.equal(capabilities["meter_power"], 0.5);
});

test("onChargeHistory skips events missing energy_added_wh and no-ops when the response is empty", async () => {
  const { stub, apiHandlers, capabilities } = createDeviceStub({
    meter_power: 0,
  });
  await stub.onInit();

  await apiHandlers["chargeHistory"]({ response: { charge_history: [] } });
  assert.equal(capabilities["meter_power"], 0);

  await apiHandlers["chargeHistory"]({
    response: { charge_history: [{ din: "din-1", energy_added_wh: undefined }] },
  });
  assert.equal(capabilities["meter_power"], 0);
});

test("WallConnecter.onInit requests chargeHistory polling alongside live_status/chargeHistory listeners", async () => {
  const { stub, site, isPollingRequested } = createDeviceStub({
    measure_power: undefined,
  });

  await stub.onInit();

  assert.ok(isPollingRequested(), "chargeHistory polling requested");
  assert.equal(typeof site.sse.on, "function");
});

test("WallConnecter.onUninit stops chargeHistory polling and removes both listeners", async () => {
  const { stub, site } = createDeviceStub({ measure_power: undefined });
  const offCalls: Array<string> = [];
  site.sse.off = (event: string) => {
    offCalls.push(`sse:${event}`);
  };
  site.api.off = (event: string) => {
    offCalls.push(`api:${event}`);
  };
  let pollingStopped = false;
  site.api.requestPolling = () => () => {
    pollingStopped = true;
  };
  await stub.onInit();

  await stub.onUninit();

  assert.ok(pollingStopped, "polling stop callback invoked");
  assert.deepEqual(offCalls.sort(), ["api:chargeHistory", "sse:live_status"]);
});
