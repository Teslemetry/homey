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

function createWiredStub(
  capabilities: Record<string, unknown>,
  homeyLocation: { latitude: number | undefined; longitude: number | undefined },
) {
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
      geolocation: {
        getLatitude: () => homeyLocation.latitude,
        getLongitude: () => homeyLocation.longitude,
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
  return { stub, sse };
}

const HOME = { latitude: 37.7749, longitude: -122.4194 };
// Roughly 13.4km from HOME.
const VEHICLE_NEARBY = { latitude: 37.8044, longitude: -122.2712 };

test("a normal distance is computed when both the vehicle and the hub have a known position", async () => {
  const capabilities: Record<string, unknown> = {
    measure_latitude: null,
    measure_longitude: null,
    "measure_distance.home": null,
  };
  const { stub, sse } = createWiredStub(capabilities, HOME);

  await stub.onInit();
  sse.data.emit("Location", VEHICLE_NEARBY);

  const distance = capabilities["measure_distance.home"] as number;
  assert.ok(typeof distance === "number" && Number.isFinite(distance));
  assert.ok(Math.abs(distance - 13.43) < 0.1, `expected ~13.43km, got ${distance}`);
});

test("distance from home stays unknown when the vehicle's position hasn't arrived", async () => {
  const capabilities: Record<string, unknown> = {
    measure_latitude: null,
    measure_longitude: null,
    "measure_distance.home": null,
  };
  const { stub } = createWiredStub(capabilities, HOME);

  await stub.onInit();

  assert.equal(capabilities["measure_distance.home"], null);
});

test("distance from home is never a stale or wrong number when a Location event carries no coordinates", async () => {
  const capabilities: Record<string, unknown> = {
    measure_latitude: null,
    measure_longitude: null,
    "measure_distance.home": null,
  };
  const { stub, sse } = createWiredStub(capabilities, HOME);

  await stub.onInit();
  sse.data.emit("Location", VEHICLE_NEARBY);
  assert.ok(typeof capabilities["measure_distance.home"] === "number");

  // A null Location replay is ignored entirely (see the coordinate test in
  // vehicle-driver-seat-location.test.ts) - the previously computed
  // distance is left in place rather than cleared to an inaccurate value.
  sse.data.emit("Location", null);
  assert.ok(typeof capabilities["measure_distance.home"] === "number");
});

test("distance from home stays unknown when the Homey hub has no configured location", async () => {
  const capabilities: Record<string, unknown> = {
    measure_latitude: null,
    measure_longitude: null,
    "measure_distance.home": null,
  };
  const { stub, sse } = createWiredStub(capabilities, {
    latitude: undefined,
    longitude: undefined,
  });

  await stub.onInit();
  sse.data.emit("Location", VEHICLE_NEARBY);

  assert.equal(capabilities["measure_distance.home"], null);
});

test("a thrown geolocation permission error is treated as an unknown hub position, not a crash", async () => {
  const capabilities: Record<string, unknown> = {
    measure_latitude: null,
    measure_longitude: null,
    "measure_distance.home": null,
  };
  const { stub, sse } = createWiredStub(capabilities, HOME);
  stub.homey.geolocation.getLatitude = () => {
    throw new Error("missing homey:manager:geolocation permission");
  };

  await stub.onInit();
  assert.doesNotThrow(() => sse.data.emit("Location", VEHICLE_NEARBY));

  assert.equal(capabilities["measure_distance.home"], null);
});
