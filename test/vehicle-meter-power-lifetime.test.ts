// Vehicle meter_power is a lifetime meter: DCChargingEnergyIn is a
// per-session counter that resets at every charge, so each session is folded
// into the monotonic total with updateCumulativeMeter (the energy devices'
// meter code). Wire-shaped events go through the REAL TeslemetryStream into
// the REAL compiled VehicleDevice; only the Homey runtime surface is stubbed,
// with a store and capability map that survive a simulated app restart.
import test from "node:test";
import assert from "node:assert/strict";
import { TeslemetryStream } from "./support/teslemetry-api-stub.js";
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

const VIN = "LRW3F7EK4NC716336";

function createStream() {
  const logger = { info() {}, error() {}, warn() {}, debug() {} };
  const root: Record<string, unknown> = { logger };
  const stream = new TeslemetryStream(root, { cache: true });
  root.sse = stream;
  return stream;
}

type Persisted = {
  capabilities: Record<string, unknown>;
  store: Record<string, unknown>;
};

function createVehicle(stream: any, persisted: Persisted) {
  const sse = stream.getVehicle(VIN);
  // Every field already "configured", so onSignal()'s addField() resolves
  // immediately instead of scheduling a real PATCH /api/config call.
  sse.fields = new Proxy({}, { get: () => ({ interval_seconds: 1 }) });

  const { capabilities, store } = persisted;
  const meterWrites: unknown[] = [];
  const vehicle = {
    vin: VIN,
    sse,
    api: {},
    // The captain's real Model 3 config.
    metadata: {
      access: true,
      fleet_telemetry: "x",
      polling: false,
      config: {
        rhd: true,
        rear_seat_heaters: 1,
        cop_user_set_temp_supported: false,
        can_actuate_trunks: true,
      },
    },
  };
  const stub: any = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [VIN]: vehicle } }, isReady: () => true },
      __: (k: string) => k,
      flow: {
        getDeviceTriggerCard: () => ({ trigger: async () => {} }),
      },
      geolocation: { getLatitude: () => 0, getLongitude: () => 0 },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin: VIN, id: VIN }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (c: string) => capabilities[c],
    setCapabilityValue: async (c: string, v: unknown) => {
      if (c === "meter_power") meterWrites.push(v);
      capabilities[c] = v;
    },
    setCapabilityOptions: async () => {},
    addCapability: async () => {},
    removeCapability: async () => {},
    getStoreValue: (k: string) => (k in store ? store[k] : null),
    setStoreValue: async (k: string, v: unknown) => {
      store[k] = structuredClone(v);
    },
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
    setAvailable: async () => {},
    setUnavailable: async () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, meterWrites };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function data(stream: any, d: Record<string, unknown>) {
  stream._dispatch({ createdAt: "2026-09-30T00:50:00.000Z", vin: VIN, data: d });
}

const kwh = (v: unknown) => Math.round((v as number) * 1000) / 1000;

test("a new charge session never makes meter_power drop; it adds the new session's energy", async () => {
  const stream = createStream();
  // An already-paired car from before the lifetime meter: meter_power shows
  // the last session's 1.22 kWh (captain's session, battery side).
  const persisted: Persisted = {
    capabilities: { meter_power: 1.22, evcharger_charging: false },
    store: {},
  };
  const { stub, meterWrites } = createVehicle(stream, persisted);
  await stub.onInit();

  data(stream, { DCChargingEnergyIn: 1.22 });
  await flush();
  assert.equal(kwh(persisted.capabilities.meter_power), 1.22);

  // Next charge: the car's session counter restarts from 0.
  data(stream, { DetailedChargeState: "DetailedChargeStateCharging", DCChargingEnergyIn: 0 });
  await flush();
  data(stream, { DCChargingEnergyIn: 0.3 });
  await flush();
  data(stream, { DCChargingEnergyIn: 2.0 });
  await flush();

  assert.equal(kwh(persisted.capabilities.meter_power), 3.22);
  const values = meterWrites.map(kwh);
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] >= values[i - 1], `meter_power dropped: ${values}`);
  }
});

test("a session whose first reading is already above zero still starts a new session", async () => {
  const stream = createStream();
  const persisted: Persisted = { capabilities: { meter_power: 5 }, store: {} };
  const { stub } = createVehicle(stream, persisted);
  await stub.onInit();

  data(stream, { DCChargingEnergyIn: 1.5 });
  await flush();
  // The reset reading itself (0 kWh) was delta-suppressed; the new session
  // first arrives at 0.4 kWh.
  data(stream, { DCChargingEnergyIn: 0.4 });
  await flush();
  data(stream, { DCChargingEnergyIn: 1.0 });
  await flush();

  assert.equal(kwh(persisted.capabilities.meter_power), 6);
});

test("a null session reading leaves meter_power untouched", async () => {
  const stream = createStream();
  const persisted: Persisted = { capabilities: { meter_power: 2 }, store: {} };
  const { stub } = createVehicle(stream, persisted);
  await stub.onInit();

  data(stream, { DCChargingEnergyIn: 1 });
  await flush();
  data(stream, { DCChargingEnergyIn: null });
  await flush();
  assert.equal(kwh(persisted.capabilities.meter_power), 2);

  data(stream, { DCChargingEnergyIn: 1.5 });
  await flush();
  assert.equal(kwh(persisted.capabilities.meter_power), 2.5);
});

test("a restart replaying the cached session value does not double-count", async () => {
  const persisted: Persisted = { capabilities: { meter_power: 10 }, store: {} };

  const before = createStream();
  const first = createVehicle(before, persisted);
  await first.stub.onInit();
  data(before, { DCChargingEnergyIn: 4 });
  await flush();
  data(before, { DCChargingEnergyIn: 0.5 });
  await flush();
  data(before, { DCChargingEnergyIn: 2 });
  await flush();
  assert.equal(kwh(persisted.capabilities.meter_power), 12);
  await first.stub.onUninit();

  // App restart: a fresh stream whose first event is the same cached
  // session value, then the session carries on.
  const after = createStream();
  const second = createVehicle(after, persisted);
  await second.stub.onInit();
  data(after, { DCChargingEnergyIn: 2 });
  await flush();
  assert.equal(kwh(persisted.capabilities.meter_power), 12);

  data(after, { DCChargingEnergyIn: 2.5 });
  await flush();
  assert.equal(kwh(persisted.capabilities.meter_power), 12.5);

  // And a session reset after the restart is still folded in, not dropped.
  data(after, { DCChargingEnergyIn: 0.2 });
  await flush();
  assert.equal(kwh(persisted.capabilities.meter_power), 12.7);
});
