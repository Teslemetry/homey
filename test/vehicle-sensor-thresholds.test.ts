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
    metadata: {
      access: true,
      fleet_telemetry: "fleet_telemetry_config_id",
      polling: false,
      config: { rhd: false, can_actuate_trunks: false },
    },
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
            trigger: async (
              _device: unknown,
              tokens: unknown,
              state?: unknown,
            ) => {
              triggerCalls.push({ cardId: currentCardId, tokens, state });
            },
          };
        },
      },
    },
    driver: {
      manifest: {
        capabilities: Object.keys(capabilities),
        capabilitiesOptions: {},
      },
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

// The threshold helpers are fired without being awaited by the onSignal
// callbacks, so each emit needs a tick to flush before asserting.
const flush = () => new Promise((resolve) => setImmediate(resolve));

const MILES_TO_KM = 1.609344;

test("EstBatteryRange fires range_remaining_above/below on a real change, not on the first reading", async () => {
  const { stub, sse, capabilities, triggerCalls } = createDeviceStub({
    "measure_distance.range": undefined,
  });
  await stub.onInit();

  sse.data.emit("EstBatteryRange", 200);
  await flush();
  assert.equal(capabilities["measure_distance.range"], 200 * MILES_TO_KM);
  assert.deepEqual(triggerCalls, []);

  sse.data.emit("EstBatteryRange", 30);
  await flush();
  assert.deepEqual(
    triggerCalls.map((c) => c.cardId).sort(),
    ["range_remaining_above", "range_remaining_below"],
  );
  assert.deepEqual(triggerCalls[0].tokens, { kilometers: 30 * MILES_TO_KM });
  assert.deepEqual(triggerCalls[0].state, {
    previous: 200 * MILES_TO_KM,
    current: 30 * MILES_TO_KM,
  });
});

test("TimeToFullCharge converts hours to minutes and fires its threshold cards", async () => {
  const { stub, sse, capabilities, triggerCalls } = createDeviceStub({
    time_to_full_charge: undefined,
  });
  await stub.onInit();

  sse.data.emit("TimeToFullCharge", 2);
  await flush();
  assert.equal(capabilities["time_to_full_charge"], 120);
  assert.deepEqual(triggerCalls, []);

  sse.data.emit("TimeToFullCharge", 0.25);
  await flush();
  assert.equal(capabilities["time_to_full_charge"], 15);
  assert.deepEqual(
    triggerCalls.map((c) => c.cardId).sort(),
    ["time_to_full_charge_above", "time_to_full_charge_below"],
  );
  assert.deepEqual(triggerCalls[0].tokens, { minutes: 15 });
});

test("OutsideTemp fires outside_temperature_above/below on a real change", async () => {
  const { stub, sse, capabilities, triggerCalls } = createDeviceStub({
    "measure_temperature.outside": undefined,
  });
  await stub.onInit();

  sse.data.emit("OutsideTemp", 8);
  await flush();
  assert.equal(capabilities["measure_temperature.outside"], 8);
  assert.deepEqual(triggerCalls, []);

  sse.data.emit("OutsideTemp", -2);
  await flush();
  assert.deepEqual(
    triggerCalls.map((c) => c.cardId).sort(),
    ["outside_temperature_above", "outside_temperature_below"],
  );
  assert.deepEqual(triggerCalls[0].tokens, { degrees: -2 });
  assert.deepEqual(triggerCalls[0].state, { previous: 8, current: -2 });
});

test("null/undefined readings never write or trigger", async () => {
  const { stub, sse, capabilities, triggerCalls } = createDeviceStub({
    "measure_distance.range": 100,
    time_to_full_charge: 60,
    "measure_temperature.outside": 10,
  });
  await stub.onInit();

  sse.data.emit("EstBatteryRange", null);
  sse.data.emit("TimeToFullCharge", undefined);
  sse.data.emit("OutsideTemp", null);
  await flush();

  assert.equal(capabilities["measure_distance.range"], 100);
  assert.equal(capabilities["time_to_full_charge"], 60);
  assert.equal(capabilities["measure_temperature.outside"], 10);
  assert.deepEqual(triggerCalls, []);
});

// --- Tire pressure: one shared card for all four tires ---

const ATM_TO_BAR = 1.01325;

test("each tire fires the one shared tire_pressure_below card, tagged with which tire", async () => {
  const { stub, sse, capabilities, triggerCalls } = createDeviceStub({
    "measure_pressure.fl": undefined,
    "measure_pressure.rr": undefined,
  });
  await stub.onInit();

  // First reading for each tire only establishes a baseline.
  sse.data.emit("TpmsPressureFl", 2.9);
  sse.data.emit("TpmsPressureRr", 2.9);
  await flush();
  assert.equal(capabilities["measure_pressure.fl"], 2.9 * ATM_TO_BAR);
  assert.deepEqual(triggerCalls, []);

  sse.data.emit("TpmsPressureRr", 2.0);
  await flush();
  assert.deepEqual(
    triggerCalls.map((c) => c.cardId),
    ["tire_pressure_below"],
  );
  assert.deepEqual(triggerCalls[0].tokens, {
    bar: 2.0 * ATM_TO_BAR,
    tire: "Rear right",
  });
  assert.deepEqual(triggerCalls[0].state, {
    previous: 2.9 * ATM_TO_BAR,
    current: 2.0 * ATM_TO_BAR,
  });

  sse.data.emit("TpmsPressureFl", 2.1);
  await flush();
  assert.equal(triggerCalls.length, 2);
  assert.deepEqual(triggerCalls[1].tokens, {
    bar: 2.1 * ATM_TO_BAR,
    tire: "Front left",
  });
});

test("an unchanged tire pressure does not re-fire tire_pressure_below", async () => {
  const { stub, sse, triggerCalls } = createDeviceStub({
    "measure_pressure.fl": undefined,
  });
  await stub.onInit();

  sse.data.emit("TpmsPressureFl", 2.5);
  sse.data.emit("TpmsPressureFl", 2.5);
  sse.data.emit("TpmsPressureFl", 2.5);
  await flush();

  assert.deepEqual(triggerCalls, []);
});
