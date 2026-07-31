import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import VehicleDriver from "../.homeybuild/drivers/vehicle/driver.js";

/** Mirrors TeslemetryVehicleStream's synchronous cached-signal replay. */
class FakeVehicleStream extends EventEmitter {
  cache: { data: Record<string, unknown> } = { data: {} };
  onSignal(_field: string, _callback: (value: unknown) => void): () => void {
    return () => {};
  }
}

function createVehicle(
  vin: string,
  config: {
    can_actuate_trunks?: boolean;
    has_seat_cooling?: boolean;
    rear_seat_heaters?: number;
  } = {},
) {
  return {
    vin,
    sse: new FakeVehicleStream(),
    api: {},
    metadata: {
      access: true,
      fleet_telemetry: true,
      polling: false,
      config: { can_actuate_trunks: false, ...config },
    },
  };
}

/**
 * A VehicleDevice whose saved pairing VIN ("missing-vin") is absent from the
 * vehicle registry, reproducing the exact "registered but dead" shape:
 * generalizes battery-site-repair.test.ts's regression to Vehicle.
 */
function createDeviceStub(vehicles: Record<string, ReturnType<typeof createVehicle>>) {
  const store: Record<string, unknown> = {};
  const capabilities: Record<string, unknown> = { vehicle_state: undefined };
  const unavailableCalls: unknown[] = [];
  let availableCalls = 0;

  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin: "missing-vin", id: "missing-vin" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    addCapability: async (capability: string) => {
      capabilities[capability] = undefined;
    },
    removeCapability: async (capability: string) => {
      delete capabilities[capability];
    },
    registerCapabilityListener: () => {},
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

test("VehicleDevice.onInit reports vehicle-not-found and registers zero listeners, and repairVehicle() then binds it without losing device identity", async () => {
  const goodVehicle = createVehicle("vin-1");
  const { stub, capabilities, unavailableCalls, getAvailableCalls } = createDeviceStub({
    "vin-1": goodVehicle,
  });

  await stub.onInit();

  assert.deepEqual(unavailableCalls, ["error.vehicle_not_found"]);
  assert.equal(goodVehicle.sse.listenerCount("state"), 0, "no state listener before repair");
  assert.equal(stub.getVin(), "missing-vin", "still resolves to the original pairing vin");

  await stub.repairVehicle("vin-1");

  assert.equal(getAvailableCalls(), 1, "repair marks the device available again");
  assert.equal(stub.getVin(), "vin-1", "getVin now reflects the store override, not getData().vin");
  assert.equal(stub.getData().vin, "missing-vin", "the immutable pairing vin itself is untouched");
  assert.equal(goodVehicle.sse.listenerCount("state"), 1, "state listener registered");

  goodVehicle.sse.emit("state", { state: "online" });
  assert.equal(capabilities.vehicle_state, "online", "live again on the repaired vehicle");
});

test("VehicleDevice.repairVehicle rejects and leaves the device unbound when the target vehicle doesn't exist", async () => {
  const { stub } = createDeviceStub({ "vin-1": createVehicle("vin-1") });
  await stub.onInit();

  await assert.rejects(() => stub.repairVehicle("does-not-exist"));
  assert.equal(stub.getVin(), "missing-vin", "no store override was written on failure");
});

test("VehicleDevice.repairVehicle resyncs seat capabilities for the replacement vehicle", async () => {
  const seatCapabilities = [
    "seat_heater.rear_left",
    "seat_heater.rear_right",
    "seat_heater.rear_center",
    "seat_cooler.front_left",
    "seat_cooler.front_right",
  ];
  const replacement = createVehicle("vin-1", {
    has_seat_cooling: false,
    rear_seat_heaters: 0,
  });
  const { stub, capabilities } = createDeviceStub({ "vin-1": replacement });
  for (const capability of seatCapabilities) capabilities[capability] = undefined;
  stub.driver.manifest.capabilities = ["vehicle_state", ...seatCapabilities];

  await stub.repairVehicle("vin-1");

  assert.deepEqual(
    seatCapabilities.filter((capability) => capability in capabilities),
    [],
  );
});

function createDriverStub(vehicles: Record<string, ReturnType<typeof createVehicle> & { name: string }>) {
  return Object.assign(new VehicleDriver(), {
    homey: { app: { products: { vehicles } } },
    getDevices: () => [] as unknown[],
    log: () => {},
  });
}

function createRepairTargetDevice(vin: string) {
  return Object.assign(Object.create(VehicleDevice.prototype), {
    homey: { app: { products: {} } },
    driver: { manifest: { capabilities: [], capabilitiesOptions: {} } },
    getData: () => ({ vin, id: vin }),
    getCapabilities: () => [],
    getStoreValue: () => null,
    getName: () => `Vehicle (${vin})`,
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

test("VehicleDriver.onRepair reports needsRepair:false when the device's vehicle already resolves", async () => {
  const driver = createDriverStub({
    "vin-1": { ...createVehicle("vin-1"), name: "My Model 3" },
  });
  const device = createRepairTargetDevice("vin-1");
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_vehicle_status(), { needsRepair: false });
});

test("VehicleDriver.onRepair offers the single pairing-eligible vehicle as a repair candidate", async () => {
  const driver = createDriverStub({
    "vin-1": { ...createVehicle("vin-1"), name: "Eligible" },
    "vin-2": {
      ...createVehicle("vin-2"),
      name: "Polling Only",
      metadata: { access: true, fleet_telemetry: true, polling: true, config: {} },
    },
  });
  const device = createRepairTargetDevice("stale-vin");
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_vehicle_status(), {
    needsRepair: true,
    candidateId: "vin-1",
    candidateName: "Eligible",
  });
});

test("VehicleDriver.onRepair never offers a candidate when multiple eligible vehicles exist", async () => {
  const driver = createDriverStub({
    "vin-1": { ...createVehicle("vin-1"), name: "Car A" },
    "vin-2": { ...createVehicle("vin-2"), name: "Car B" },
  });
  const device = createRepairTargetDevice("stale-vin");
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_vehicle_status(), {
    needsRepair: true,
    candidateId: null,
    candidateName: null,
  });
});

test("VehicleDriver.onRepair excludes a vehicle already bound to another live Vehicle device", async () => {
  const driver = createDriverStub({
    "vin-1": { ...createVehicle("vin-1"), name: "Already Bound" },
    "vin-2": { ...createVehicle("vin-2"), name: "Available" },
  });
  const device = createRepairTargetDevice("stale-vin");
  const boundDevice = createRepairTargetDevice("vin-1");
  driver.getDevices = () => [device, boundDevice];
  const session = createSessionStub();

  await driver.onRepair(session, device);

  assert.deepEqual(await session.handlers.get_repair_vehicle_status(), {
    needsRepair: true,
    candidateId: "vin-2",
    candidateName: "Available",
  });
});

test("VehicleDriver.onRepair's confirm_repair_vehicle invokes the device's own identity-preserving repairVehicle", async () => {
  const driver = createDriverStub({
    "vin-1": { ...createVehicle("vin-1"), name: "Eligible" },
  });
  const device = createRepairTargetDevice("stale-vin");
  const repairVehicleCalls: string[] = [];
  device.repairVehicle = async (vin: string) => {
    repairVehicleCalls.push(vin);
  };
  const session = createSessionStub();

  await driver.onRepair(session, device);
  await session.handlers.confirm_repair_vehicle("vin-1");

  assert.deepEqual(repairVehicleCalls, ["vin-1"]);
});
