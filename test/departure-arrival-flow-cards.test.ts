import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryApp from "../.homeybuild/app.js";
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

// Covers the exact card set a gate-automation flow composes:
//   departure: at home + driver seated + gear P -> R/D
//   arrival:   was not home -> now home + speed was above 0
// Each piece must exist as BOTH a trigger and a condition, since an
// Advanced Flow uses one to start the flow and the others as AND branches.

type RunListener = (args: any, state?: any) => Promise<unknown>;

function createAppStub() {
  const conditionListeners: Record<string, RunListener> = {};
  const triggerListeners: Record<string, RunListener> = {};
  const flow = {
    getActionCard: () => ({ registerRunListener: () => {} }),
    getConditionCard: (id: string) => ({
      registerRunListener: (fn: RunListener) => {
        conditionListeners[id] = fn;
      },
    }),
    getDeviceTriggerCard: (id: string) => ({
      registerRunListener: (fn: RunListener) => {
        triggerListeners[id] = fn;
      },
    }),
  };
  const app = Object.assign(Object.create(TeslemetryApp.prototype), {
    homey: { flow, __: (key: string) => key },
    log: () => {},
  }) as unknown as { registerFlowCards(): void };
  app.registerFlowCards();
  return { conditionListeners, triggerListeners };
}

const deviceWith = (values: Record<string, unknown>) => ({
  getCapabilityValue: (capability: string) =>
    capability in values ? values[capability] : null,
});

// --- departure: "driver seated" as an AND branch ---

test("driver_seat_occupied is usable as a condition, not only as a trigger", async () => {
  const { conditionListeners } = createAppStub();

  assert.equal(
    await conditionListeners["driver_seat_occupied"]({
      device: deviceWith({ driver_seat_occupied: true }),
    }),
    true,
  );
  assert.equal(
    await conditionListeners["driver_seat_occupied"]({
      device: deviceWith({ driver_seat_occupied: false }),
    }),
    false,
  );
});

test("driver_seat_occupied is false, not throwing, on a vehicle that never reports seat occupancy", async () => {
  const { conditionListeners } = createAppStub();

  // Unknown must read as "not seated" rather than crashing the flow.
  assert.equal(
    await conditionListeners["driver_seat_occupied"]({
      device: deviceWith({ driver_seat_occupied: null }),
    }),
    false,
  );
  assert.equal(
    await conditionListeners["driver_seat_occupied"]({ device: undefined }),
    false,
  );
});

test("gear_is distinguishes a reverse manoeuvre from park", async () => {
  const { conditionListeners } = createAppStub();
  const inReverse = deviceWith({ gear: "R" });

  assert.equal(await conditionListeners["gear_is"]({ device: inReverse, gear: "R" }), true);
  assert.equal(await conditionListeners["gear_is"]({ device: inReverse, gear: "P" }), false);
});

// --- arrival: "speed was above zero" ---

test("vehicle_speed compares in km/h even though measure_speed is stored in m/s", async () => {
  const { conditionListeners } = createAppStub();
  // 10 m/s = 36 km/h
  const moving = deviceWith({ measure_speed: 10 });

  assert.equal(await conditionListeners["vehicle_speed"]({ device: moving, speed: 30 }), true);
  assert.equal(await conditionListeners["vehicle_speed"]({ device: moving, speed: 40 }), false);
});

test("vehicle_speed at 0 km/h answers 'is the vehicle moving at all'", async () => {
  const { conditionListeners } = createAppStub();

  assert.equal(
    await conditionListeners["vehicle_speed"]({ device: deviceWith({ measure_speed: 0.5 }), speed: 0 }),
    true,
  );
  assert.equal(
    await conditionListeners["vehicle_speed"]({ device: deviceWith({ measure_speed: 0 }), speed: 0 }),
    false,
  );
  // Never reported yet - unknown is not "moving".
  assert.equal(
    await conditionListeners["vehicle_speed"]({ device: deviceWith({ measure_speed: null }), speed: 0 }),
    false,
  );
});

test("vehicle_speed_above/below run their crossing check in km/h", async () => {
  const { triggerListeners } = createAppStub();
  const device = deviceWith({});

  // 0 -> 36 km/h
  assert.equal(
    await triggerListeners["vehicle_speed_above"]({ device, speed: 10 }, { previous: 0, current: 36 }),
    true,
  );
  assert.equal(
    await triggerListeners["vehicle_speed_below"]({ device, speed: 10 }, { previous: 0, current: 36 }),
    false,
  );
  // 36 -> 0 km/h
  assert.equal(
    await triggerListeners["vehicle_speed_below"]({ device, speed: 10 }, { previous: 36, current: 0 }),
    true,
  );
});

test("distance_from_home accepts a radius tighter than the 100 m the old step allowed", async () => {
  const { conditionListeners } = createAppStub();
  const device = deviceWith({ "measure_distance.home": 0.04 });

  // 40 m from home, 50 m approach zone.
  assert.equal(
    await conditionListeners["distance_from_home"]({ device, radius: 0.05 }),
    true,
  );
  assert.equal(
    await conditionListeners["distance_from_home"]({ device, radius: 0.03 }),
    false,
  );
});

// --- the device side of the speed cards ---

class FakeVehicleStream extends EventEmitter {
  data = new EventEmitter();
  cache = { data: {} as Record<string, unknown> };
  onSignal(field: string, callback: (value: unknown) => void) {
    this.data.on(field, callback);
    return () => this.data.off(field, callback);
  }
}

function createVehicleStub(capabilities: Record<string, unknown>) {
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
  const triggerCalls: Array<{ cardId: string; tokens: any; state: any }> = [];
  let currentCardId = "";
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { "test-vin": vehicle } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: (cardId: string) => {
          currentCardId = cardId;
          return {
            trigger: async (_d: unknown, tokens: any, state?: any) => {
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
    getData: () => ({ vin: "test-vin", id: "test-vin" }),
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("VehicleSpeed writes m/s to the capability but fires the triggers in km/h", async () => {
  const { stub, sse, capabilities, triggerCalls } = createVehicleStub({
    measure_speed: undefined,
  });
  await stub.onInit();

  sse.data.emit("VehicleSpeed", 0);
  await flush();
  assert.equal(capabilities["measure_speed"], 0);
  assert.deepEqual(triggerCalls, []);

  // 30 mph = 13.4112 m/s = 48.28 km/h
  sse.data.emit("VehicleSpeed", 30);
  await flush();
  assert.equal(capabilities["measure_speed"], 30 * 0.44704);
  assert.deepEqual(
    triggerCalls.map((c) => c.cardId).sort(),
    ["vehicle_speed_above", "vehicle_speed_below"],
  );
  assert.ok(Math.abs(triggerCalls[0].tokens.speed - 48.28) < 0.01);
  assert.equal(triggerCalls[0].state.previous, 0);
  assert.ok(Math.abs(triggerCalls[0].state.current - 48.28) < 0.01);
});

test("an unchanged speed does not re-fire the speed triggers", async () => {
  const { stub, sse, triggerCalls } = createVehicleStub({ measure_speed: undefined });
  await stub.onInit();

  sse.data.emit("VehicleSpeed", 20);
  sse.data.emit("VehicleSpeed", 20);
  await flush();

  assert.deepEqual(triggerCalls, []);
});
