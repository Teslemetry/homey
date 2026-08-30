import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

function createDeviceStub(
  capabilities: Record<string, unknown> = {
    driver_seat_occupied: null,
    "alarm_generic.driver_unbuckled": null,
  },
) {
  const stub = Object.assign(Object.create(VehicleDevice.prototype), {
    homey: {
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: { getDevices: () => [] as unknown[] },
    log: () => {},
    error: () => {},
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
  });
  stub.driver.getDevices = () => [stub];
  return { stub, capabilities };
}

// --- updateDriverUnbuckledAlarm ---

test("the driver-unbuckled alarm stays unset until both seat occupancy and belt status are known", () => {
  const { stub, capabilities } = createDeviceStub();

  (stub as any).driverSeatOccupied = true;
  (stub as any).updateDriverUnbuckledAlarm();

  assert.equal(capabilities["alarm_generic.driver_unbuckled"], null);
});

test("occupied and unlatched raises the driver-unbuckled alarm", () => {
  const { stub, capabilities } = createDeviceStub();

  (stub as any).driverSeatOccupied = true;
  (stub as any).driverSeatBeltUnlatched = true;
  (stub as any).updateDriverUnbuckledAlarm();

  assert.equal(capabilities["alarm_generic.driver_unbuckled"], true);
});

test("occupied and latched does not raise the driver-unbuckled alarm", () => {
  const { stub, capabilities } = createDeviceStub();

  (stub as any).driverSeatOccupied = true;
  (stub as any).driverSeatBeltUnlatched = false;
  (stub as any).updateDriverUnbuckledAlarm();

  assert.equal(capabilities["alarm_generic.driver_unbuckled"], false);
});

test("an unlatched belt reading in an empty seat does not raise the driver-unbuckled alarm", () => {
  const { stub, capabilities } = createDeviceStub();

  (stub as any).driverSeatOccupied = false;
  (stub as any).driverSeatBeltUnlatched = true;
  (stub as any).updateDriverUnbuckledAlarm();

  assert.equal(capabilities["alarm_generic.driver_unbuckled"], false);
});

// --- full onInit wiring ---

class FakeVehicleStream extends EventEmitter {
  data = new EventEmitter();
  cache = { data: {} as Record<string, unknown> };

  onSignal(field: string, callback: (value: unknown) => void) {
    this.data.on(field, callback);
    return () => this.data.off(field, callback);
  }
}

function createWiredStub(capabilities: Record<string, unknown>) {
  const sse = new FakeVehicleStream();
  const vin = "test-vin";
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

  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [vin]: vehicle } } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
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
  return { stub, sse };
}

test("without the vehicle_location scope, Location never arrives and both coordinate capabilities stay an honest unknown", async () => {
  const capabilities: Record<string, unknown> = {
    measure_latitude: null,
    measure_longitude: null,
  };
  const { stub } = createWiredStub(capabilities);

  await assert.doesNotReject(() => stub.onInit());

  assert.equal(capabilities.measure_latitude, null);
  assert.equal(capabilities.measure_longitude, null);
});

test("a live Location event sets both coordinate capabilities", async () => {
  const capabilities: Record<string, unknown> = {
    measure_latitude: null,
    measure_longitude: null,
  };
  const { stub, sse } = createWiredStub(capabilities);

  await stub.onInit();
  sse.data.emit("Location", { latitude: 37.7749, longitude: -122.4194 });

  assert.equal(capabilities.measure_latitude, 37.7749);
  assert.equal(capabilities.measure_longitude, -122.4194);
});

test("a null Location event is ignored without clearing previously known coordinates", async () => {
  const capabilities: Record<string, unknown> = {
    measure_latitude: null,
    measure_longitude: null,
  };
  const { stub, sse } = createWiredStub(capabilities);

  await stub.onInit();
  sse.data.emit("Location", { latitude: 37.7749, longitude: -122.4194 });
  sse.data.emit("Location", null);

  assert.equal(capabilities.measure_latitude, 37.7749);
  assert.equal(capabilities.measure_longitude, -122.4194);
});

test("live DriverSeatOccupied/DriverSeatBelt events combine into the driver-unbuckled alarm", async () => {
  const capabilities: Record<string, unknown> = {
    driver_seat_occupied: null,
    "alarm_generic.driver_unbuckled": null,
  };
  const { stub, sse } = createWiredStub(capabilities);

  await stub.onInit();
  sse.data.emit("DriverSeatOccupied", true);
  sse.data.emit("DriverSeatBelt", "BuckleStatusUnlatched");

  assert.equal(capabilities.driver_seat_occupied, true);
  assert.equal(capabilities["alarm_generic.driver_unbuckled"], true);
});

test("an Unknown/Faulted DriverSeatBelt reading is ignored rather than treated as latched or unlatched", async () => {
  const capabilities: Record<string, unknown> = {
    driver_seat_occupied: null,
    "alarm_generic.driver_unbuckled": null,
  };
  const { stub, sse } = createWiredStub(capabilities);

  await stub.onInit();
  sse.data.emit("DriverSeatOccupied", true);
  sse.data.emit("DriverSeatBelt", "BuckleStatusUnknown");

  assert.equal(capabilities["alarm_generic.driver_unbuckled"], null);
});
