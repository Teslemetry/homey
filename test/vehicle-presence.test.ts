import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

const EARTH_RADIUS_METERS = 6_371_000;

/** Offsets `lat` due north by `meters`, holding longitude fixed. */
function offsetNorth(lat: number, meters: number): number {
  return lat + (meters / EARTH_RADIUS_METERS) * (180 / Math.PI);
}

const HOME_LATITUDE = 52;
const HOME_LONGITUDE = 5;

function createDeviceStub({
  radius,
  homeLatitude = HOME_LATITUDE,
  homeLongitude = HOME_LONGITUDE,
  initialPresence = null,
}: {
  radius?: number;
  homeLatitude?: number | null;
  homeLongitude?: number | null;
  initialPresence?: boolean | null;
} = {}) {
  const capabilities: Record<string, unknown> = {
    alarm_presence: initialPresence,
  };
  const settings: Record<string, unknown> =
    radius === undefined ? {} : { presence_radius: radius };
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
      geolocation: {
        getLatitude: () => homeLatitude,
        getLongitude: () => homeLongitude,
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
    getSetting: (key: string) => settings[key],
  });
  stub.driver.getDevices = () => [stub];
  return { stub, capabilities, triggerCalls };
}

// --- boundary / hysteresis ---

test("no trigger fires and alarm_presence is set on the first Location signal ever received", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub();

  (stub as any).handleLocation({
    latitude: offsetNorth(HOME_LATITUDE, 500),
    longitude: HOME_LONGITUDE,
  });

  assert.equal(capabilities.alarm_presence, false);
  assert.deepEqual(triggerCalls, []);
});

test("vehicle_arrived_home fires exactly once when crossing into the default 100m radius", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub({
    initialPresence: false,
  });

  (stub as any).handleLocation({
    latitude: offsetNorth(HOME_LATITUDE, 50),
    longitude: HOME_LONGITUDE,
  });

  assert.equal(capabilities.alarm_presence, true);
  assert.deepEqual(triggerCalls, ["vehicle_arrived_home"]);
});

test("a vehicle sitting between the radius and the hysteresis margin stays home without flapping", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub({
    initialPresence: true,
  });

  // radius=100, hysteresis ratio=0.2 -> leave threshold is 120m; 110m is
  // past the radius but still inside the hysteresis margin.
  (stub as any).handleLocation({
    latitude: offsetNorth(HOME_LATITUDE, 110),
    longitude: HOME_LONGITUDE,
  });

  assert.equal(capabilities.alarm_presence, true);
  assert.deepEqual(triggerCalls, []);
});

test("vehicle_left_home fires exactly once once the vehicle drifts past the hysteresis margin", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub({
    initialPresence: true,
  });

  (stub as any).handleLocation({
    latitude: offsetNorth(HOME_LATITUDE, 130),
    longitude: HOME_LONGITUDE,
  });

  assert.equal(capabilities.alarm_presence, false);
  assert.deepEqual(triggerCalls, ["vehicle_left_home"]);
});

test("vehicle_arrived_home fires again on a second approach after leaving", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub({
    initialPresence: false,
  });

  (stub as any).handleLocation({
    latitude: offsetNorth(HOME_LATITUDE, 90),
    longitude: HOME_LONGITUDE,
  });

  assert.equal(capabilities.alarm_presence, true);
  assert.deepEqual(triggerCalls, ["vehicle_arrived_home"]);
});

test("repeated readings well inside the radius do not re-fire vehicle_arrived_home", () => {
  const { stub, triggerCalls } = createDeviceStub({ initialPresence: false });

  (stub as any).handleLocation({
    latitude: offsetNorth(HOME_LATITUDE, 10),
    longitude: HOME_LONGITUDE,
  });
  (stub as any).handleLocation({
    latitude: offsetNorth(HOME_LATITUDE, 20),
    longitude: HOME_LONGITUDE,
  });
  (stub as any).handleLocation({
    latitude: offsetNorth(HOME_LATITUDE, 5),
    longitude: HOME_LONGITUDE,
  });

  assert.deepEqual(triggerCalls, ["vehicle_arrived_home"]);
});

test("pending capability writes do not duplicate presence transitions", () => {
  const { stub, triggerCalls } = createDeviceStub({ initialPresence: false });
  stub.setCapabilityValue = async () => new Promise<void>(() => {});

  (stub as any).handleLocation({
    latitude: offsetNorth(HOME_LATITUDE, 10),
    longitude: HOME_LONGITUDE,
  });
  (stub as any).handleLocation({
    latitude: offsetNorth(HOME_LATITUDE, 20),
    longitude: HOME_LONGITUDE,
  });

  assert.deepEqual(triggerCalls, ["vehicle_arrived_home"]);
});

// --- radius setting ---

test("a custom presence_radius setting is honored", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub({
    radius: 50,
    initialPresence: false,
  });

  (stub as any).handleLocation({
    latitude: offsetNorth(HOME_LATITUDE, 55),
    longitude: HOME_LONGITUDE,
  });
  assert.equal(capabilities.alarm_presence, false);

  (stub as any).handleLocation({
    latitude: offsetNorth(HOME_LATITUDE, 45),
    longitude: HOME_LONGITUDE,
  });
  assert.equal(capabilities.alarm_presence, true);
  assert.deepEqual(triggerCalls, ["vehicle_arrived_home"]);
});

test("an unset or invalid presence_radius setting falls back to the default 100m radius", () => {
  const { stub, capabilities } = createDeviceStub({
    radius: 0,
    initialPresence: false,
  });

  (stub as any).handleLocation({
    latitude: offsetNorth(HOME_LATITUDE, 80),
    longitude: HOME_LONGITUDE,
  });

  assert.equal(capabilities.alarm_presence, true);
});

// --- scope / data unavailable degrade path ---

test("a malformed Location payload (missing coordinates) is ignored without throwing", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub();

  assert.doesNotThrow(() => (stub as any).handleLocation({}));
  assert.doesNotThrow(() => (stub as any).handleLocation(null));
  assert.doesNotThrow(() => (stub as any).handleLocation(undefined));

  assert.equal(capabilities.alarm_presence, null);
  assert.deepEqual(triggerCalls, []);
});

test("an unresolvable Homey geolocation leaves alarm_presence untouched without throwing", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub({
    homeLatitude: null,
    homeLongitude: null,
  });

  assert.doesNotThrow(() =>
    (stub as any).handleLocation({
      latitude: HOME_LATITUDE,
      longitude: HOME_LONGITUDE,
    }),
  );

  assert.equal(capabilities.alarm_presence, null);
  assert.deepEqual(triggerCalls, []);
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

test("without the vehicle_location scope, Location never arrives and alarm_presence stays an honest unknown", async () => {
  const sse = new FakeVehicleStream();
  const vin = "test-vin";
  const vehicle = {
    sse,
    api: {},
    metadata: { config: { rhd: false, can_actuate_trunks: false } },
  };
  const capabilities: Record<string, unknown> = { alarm_presence: null };
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
      geolocation: {
        getLatitude: () => HOME_LATITUDE,
        getLongitude: () => HOME_LONGITUDE,
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
    getSetting: () => undefined,
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });
  stub.driver.getDevices = () => [stub];

  await assert.doesNotReject(() => stub.onInit());

  assert.equal(capabilities.alarm_presence, null);
  assert.deepEqual(triggerCalls, []);
});
