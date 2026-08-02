import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

function createDeviceStub({
  initialAtHome = null,
  initialAtWork = null,
}: {
  initialAtHome?: boolean | null;
  initialAtWork?: boolean | null;
} = {}) {
  const capabilities: Record<string, unknown> = {
    alarm_presence: initialAtHome,
    "alarm_generic.at_work": initialAtWork,
  };
  const triggerCalls: string[] = [];
  let currentCardId = "";
  const flowCardStub = {
    trigger: async () => {
      triggerCalls.push(currentCardId);
    },
  };

  const stub = Object.assign(Object.create(VehicleDevice.prototype), {
    homey: {
      flow: {
        getDeviceTriggerCard: (cardId: string) => {
          currentCardId = cardId;
          return flowCardStub;
        },
      },
    },
    driver: { getDevices: () => [] as unknown[] },
    getName: () => "Test Vehicle",
    log: () => {},
    error: () => {},
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
  });
  stub.driver.getDevices = () => [stub];
  return { stub, capabilities, triggerCalls };
}

// --- handleLocatedAtHome ---

test("no trigger fires on the first LocatedAtHome signal ever received", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub();

  (stub as any).handleLocatedAtHome(false);

  assert.equal(capabilities.alarm_presence, false);
  assert.deepEqual(triggerCalls, []);
});

test("vehicle_arrived_home fires exactly once when LocatedAtHome transitions to true", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub({
    initialAtHome: false,
  });
  (stub as any).handleLocatedAtHome(false);
  triggerCalls.length = 0;

  (stub as any).handleLocatedAtHome(true);

  assert.equal(capabilities.alarm_presence, true);
  assert.deepEqual(triggerCalls, ["vehicle_arrived_home"]);
});

test("vehicle_left_home fires exactly once when LocatedAtHome transitions to false", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub({
    initialAtHome: true,
  });
  (stub as any).handleLocatedAtHome(true);
  triggerCalls.length = 0;

  (stub as any).handleLocatedAtHome(false);

  assert.equal(capabilities.alarm_presence, false);
  assert.deepEqual(triggerCalls, ["vehicle_left_home"]);
});

test("vehicle_arrived_home does not re-fire while LocatedAtHome stays true", () => {
  const { stub, triggerCalls } = createDeviceStub({ initialAtHome: false });
  (stub as any).handleLocatedAtHome(true);
  triggerCalls.length = 0;

  (stub as any).handleLocatedAtHome(true);
  (stub as any).handleLocatedAtHome(true);

  assert.deepEqual(triggerCalls, []);
});

test("vehicle_arrived_home fires again on a second approach after leaving", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub({
    initialAtHome: false,
  });
  (stub as any).handleLocatedAtHome(false);
  (stub as any).handleLocatedAtHome(true);
  (stub as any).handleLocatedAtHome(false);
  triggerCalls.length = 0;

  (stub as any).handleLocatedAtHome(true);

  assert.equal(capabilities.alarm_presence, true);
  assert.deepEqual(triggerCalls, ["vehicle_arrived_home"]);
});

test("a null/undefined LocatedAtHome reading is ignored without throwing or updating the capability", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub({
    initialAtHome: true,
  });

  assert.doesNotThrow(() => (stub as any).handleLocatedAtHome(null));
  assert.doesNotThrow(() => (stub as any).handleLocatedAtHome(undefined));

  assert.equal(capabilities.alarm_presence, true);
  assert.deepEqual(triggerCalls, []);
});

test("a pending capability write does not let a second signal double-fire the transition trigger", () => {
  const { stub, triggerCalls } = createDeviceStub({ initialAtHome: false });
  (stub as any).handleLocatedAtHome(false);
  triggerCalls.length = 0;
  stub.setCapabilityValue = async () => new Promise<void>(() => {});

  (stub as any).handleLocatedAtHome(true);
  (stub as any).handleLocatedAtHome(true);

  assert.deepEqual(triggerCalls, ["vehicle_arrived_home"]);
});

// --- handleLocatedAtWork ---
// Homey auto-fires alarm_generic.at_work_true/_false straight off update(),
// so there's no explicit triggerFlow() call to test here - just the
// capability write.

test("LocatedAtWork updates alarm_generic.at_work", () => {
  const { stub, capabilities } = createDeviceStub();

  (stub as any).handleLocatedAtWork(true);
  assert.equal(capabilities["alarm_generic.at_work"], true);

  (stub as any).handleLocatedAtWork(false);
  assert.equal(capabilities["alarm_generic.at_work"], false);
});

test("a null/undefined LocatedAtWork reading is ignored without throwing or updating the capability", () => {
  const { stub, capabilities } = createDeviceStub({ initialAtWork: true });

  assert.doesNotThrow(() => (stub as any).handleLocatedAtWork(null));
  assert.doesNotThrow(() => (stub as any).handleLocatedAtWork(undefined));

  assert.equal(capabilities["alarm_generic.at_work"], true);
});

// --- full onInit wiring: vehicle_location scope not granted ---

class FakeVehicleStream extends EventEmitter {
  data = new EventEmitter();
  cache = { data: {} as Record<string, unknown> };

  onSignal(field: string, callback: (value: unknown) => void) {
    this.data.on(field, callback);
    return () => this.data.off(field, callback);
  }
}

test("without the vehicle_location scope, LocatedAtHome/LocatedAtWork never arrive and both stay an honest unknown", async () => {
  const sse = new FakeVehicleStream();
  const vin = "test-vin";
  const vehicle = {
    sse,
    api: {},
    metadata: { access: true, fleet_telemetry: "fleet_telemetry_config_id", polling: false, config: { rhd: false, can_actuate_trunks: false } },
  };
  const capabilities: Record<string, unknown> = {
    alarm_presence: null,
    "alarm_generic.at_work": null,
  };
  const triggerCalls: string[] = [];

  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [vin]: vehicle } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: (cardId: string) => ({
          trigger: async () => {
            triggerCalls.push(cardId);
          },
        }),
      },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin, id: vin }),
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

  await assert.doesNotReject(() => stub.onInit());

  assert.equal(capabilities.alarm_presence, null);
  assert.equal(capabilities["alarm_generic.at_work"], null);
  assert.deepEqual(triggerCalls, []);
});

test("with the vehicle_location scope, a live LocatedAtHome/LocatedAtWork event sets both capabilities", async () => {
  const sse = new FakeVehicleStream();
  const vin = "test-vin";
  const vehicle = {
    sse,
    api: {},
    metadata: { access: true, fleet_telemetry: "fleet_telemetry_config_id", polling: false, config: { rhd: false, can_actuate_trunks: false } },
  };
  const capabilities: Record<string, unknown> = {
    alarm_presence: null,
    "alarm_generic.at_work": null,
  };

  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [vin]: vehicle } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: () => ({ trigger: async () => {} }),
      },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin, id: vin }),
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

  await stub.onInit();
  sse.data.emit("LocatedAtHome", true);
  sse.data.emit("LocatedAtWork", false);

  assert.equal(capabilities.alarm_presence, true);
  assert.equal(capabilities["alarm_generic.at_work"], false);
});
