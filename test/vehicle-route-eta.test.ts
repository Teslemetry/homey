import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

class FakeVehicleStream extends EventEmitter {
  data = new EventEmitter();
  cache = { data: {} as Record<string, unknown> };

  onSignal(field: string, callback: (value: unknown) => void) {
    this.data.on(field, callback);
    return () => this.data.off(field, callback);
  }
}

const DEFAULT_VIN = "test-vin";

function createDeviceStub(capabilities: Record<string, unknown>) {
  const sse = new FakeVehicleStream();
  const vehicle = {
    sse,
    api: {},
    metadata: { access: true, fleet_telemetry: "fleet_telemetry_config_id", polling: false, config: { rhd: false, can_actuate_trunks: false } },
  };
  const triggerCalls: Array<{
    cardId: string;
    tokens: unknown;
    state: unknown;
  }> = [];
  let currentCardId = "";
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [DEFAULT_VIN]: vehicle } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: (cardId: string) => {
          currentCardId = cardId;
          return {
            trigger: async (_device: unknown, tokens: unknown, state?: unknown) => {
              triggerCalls.push({ cardId: currentCardId, tokens, state });
            },
          };
        },
      },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin: DEFAULT_VIN, id: DEFAULT_VIN }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    getStoreValue: () => null,
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, sse, capabilities, triggerCalls };
}

test("MilesToArrival converts miles to km on measure_distance.arrival", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "measure_distance.arrival": undefined,
  });
  await stub.onInit();

  sse.data.emit("MilesToArrival", 10);

  assert.equal(capabilities["measure_distance.arrival"], 10 * 1.609344);
});

test("null/undefined MilesToArrival is skipped", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "measure_distance.arrival": 5,
  });
  await stub.onInit();

  sse.data.emit("MilesToArrival", null);

  assert.equal(capabilities["measure_distance.arrival"], 5);
});

// updateWithThresholdTriggers() is fired without being awaited by the
// onSignal callbacks, so each emit needs a tick to let its internal
// setCapabilityValue/trigger promise chain flush before asserting.
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("MinutesToArrival fires minutes_to_arrival_above/below on a real change, not on the first reading", async () => {
  const { stub, sse, capabilities, triggerCalls } = createDeviceStub({
    minutes_to_arrival: undefined,
  });
  await stub.onInit();

  sse.data.emit("MinutesToArrival", 20);
  await flush();
  assert.equal(capabilities["minutes_to_arrival"], 20);
  assert.deepEqual(triggerCalls, []);

  sse.data.emit("MinutesToArrival", 5);
  await flush();
  assert.equal(capabilities["minutes_to_arrival"], 5);
  assert.deepEqual(
    triggerCalls.map((c) => c.cardId).sort(),
    ["minutes_to_arrival_above", "minutes_to_arrival_below"],
  );
  assert.deepEqual(triggerCalls[0].tokens, { minutes: 5 });
  assert.deepEqual(triggerCalls[0].state, { previous: 20, current: 5 });
});

test("RouteTrafficMinutesDelay fires route_traffic_delay_above/below on a real change, not on the first reading", async () => {
  const { stub, sse, capabilities, triggerCalls } = createDeviceStub({
    route_traffic_delay: undefined,
  });
  await stub.onInit();

  sse.data.emit("RouteTrafficMinutesDelay", 0);
  await flush();
  assert.equal(capabilities["route_traffic_delay"], 0);
  assert.deepEqual(triggerCalls, []);

  sse.data.emit("RouteTrafficMinutesDelay", 15);
  await flush();
  assert.equal(capabilities["route_traffic_delay"], 15);
  assert.deepEqual(
    triggerCalls.map((c) => c.cardId).sort(),
    ["route_traffic_delay_above", "route_traffic_delay_below"],
  );
  assert.deepEqual(triggerCalls[0].tokens, { minutes: 15 });
});

test("ExpectedEnergyPercentAtTripArrival fires energy_at_arrival_above/below on a real change, not on the first reading", async () => {
  const { stub, sse, capabilities, triggerCalls } = createDeviceStub({
    "measure_battery.arrival": undefined,
  });
  await stub.onInit();

  sse.data.emit("ExpectedEnergyPercentAtTripArrival", 40);
  await flush();
  assert.equal(capabilities["measure_battery.arrival"], 40);
  assert.deepEqual(triggerCalls, []);

  sse.data.emit("ExpectedEnergyPercentAtTripArrival", 12);
  await flush();
  assert.equal(capabilities["measure_battery.arrival"], 12);
  assert.deepEqual(
    triggerCalls.map((c) => c.cardId).sort(),
    ["energy_at_arrival_above", "energy_at_arrival_below"],
  );
  assert.deepEqual(triggerCalls[0].tokens, { percentage: 12 });
});

test("null/undefined RouteTrafficMinutesDelay and ExpectedEnergyPercentAtTripArrival are skipped", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    route_traffic_delay: 5,
    "measure_battery.arrival": 30,
  });
  await stub.onInit();

  sse.data.emit("RouteTrafficMinutesDelay", null);
  sse.data.emit("ExpectedEnergyPercentAtTripArrival", undefined);

  assert.equal(capabilities["route_traffic_delay"], 5);
  assert.equal(capabilities["measure_battery.arrival"], 30);
});
