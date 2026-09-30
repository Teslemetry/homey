// Drives wire-shaped SSE events through the REAL @teslemetry/api
// TeslemetryStream (its real _dispatch, local cache and per-VIN emitter,
// re-exported by the test stub via a relative path) into the REAL compiled
// VehicleDevice, pinning which streaming field feeds each charging
// capability. Only the Homey runtime surface (capability store, flow cards)
// is stubbed.
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

function createVehicle(stream: any, capabilityNames: string[]) {
  const sse = stream.getVehicle(VIN);
  // Every field already "configured", so onSignal()'s addField() resolves
  // immediately instead of scheduling a real PATCH /api/config call.
  sse.fields = new Proxy({}, { get: () => ({ interval_seconds: 1 }) });

  const capabilities: Record<string, unknown> = {};
  for (const c of capabilityNames) capabilities[c] = null;
  const writes: Array<[string, unknown]> = [];
  const store: Record<string, unknown> = {};
  const triggers: Array<[string, unknown]> = [];
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
        getDeviceTriggerCard: (id: string) => ({
          trigger: async (_d: unknown, tokens: unknown) => {
            triggers.push([id, tokens]);
          },
        }),
      },
      geolocation: { getLatitude: () => 0, getLongitude: () => 0 },
    },
    driver: {
      manifest: { capabilities: capabilityNames, capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin: VIN, id: VIN }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (c: string) => capabilities[c],
    setCapabilityValue: async (c: string, v: unknown) => {
      writes.push([c, v]);
      capabilities[c] = v;
    },
    setCapabilityOptions: async () => {},
    addCapability: async () => {},
    removeCapability: async () => {},
    getStoreValue: (k: string) => store[k] ?? null,
    setStoreValue: async (k: string, v: unknown) => {
      store[k] = v;
    },
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
    setAvailable: async () => {},
    setUnavailable: async () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, capabilities, writes, triggers };
}

const flush = () => new Promise((r) => setImmediate(r));

function data(stream: any, d: Record<string, unknown>) {
  stream._dispatch({ createdAt: "2026-09-30T00:50:00.000Z", vin: VIN, data: d });
}

test("ChargeCurrentRequest feeds the charging_amps setpoint; ChargeAmps feeds measure_current", async () => {
  const stream = createStream();
  const { stub, capabilities, triggers } = createVehicle(stream, [
    "charging_amps",
    "measure_current",
  ]);
  await stub.onInit();

  // Captain's real cached telemetry 2026-09-30T00:58Z (car unplugged).
  data(stream, { ChargeCurrentRequest: 16, ChargeAmps: 0 });
  await flush();
  assert.equal(capabilities.charging_amps, 16);
  assert.equal(capabilities.measure_current, 0);

  // Charging, wall-limited to 10 A sensed; the setpoint is untouched, so
  // the slider stays put and charging_amps_changed does not fire.
  data(stream, { ChargeAmps: 10 });
  await flush();
  assert.equal(capabilities.charging_amps, 16);
  assert.equal(capabilities.measure_current, 10);
  assert.deepEqual(triggers, []);

  // A genuine setpoint change fires the card.
  data(stream, { ChargeCurrentRequest: 12 });
  await flush();
  assert.equal(capabilities.charging_amps, 12);
  assert.deepEqual(triggers, [["charging_amps_changed", { charging_amps: 12 }]]);
});

test("meter_power follows DCChargingEnergyIn only; ACChargingEnergyIn never writes it", async () => {
  const stream = createStream();
  const { stub, writes } = createVehicle(stream, [
    "meter_power",
    "measure_power",
    "evcharger_charging",
  ]);
  await stub.onInit();

  // One AC session: both counters advance, the wall side (AC) ahead of the
  // battery side (DC).
  data(stream, { DetailedChargeState: "DetailedChargeStateCharging", ACChargingEnergyIn: 1.0 });
  data(stream, { DCChargingEnergyIn: 0.8 });
  data(stream, { ACChargingEnergyIn: 1.546 });
  data(stream, { DCChargingEnergyIn: 1.22 });
  await flush();
  // meter_power is the lifetime meter (see
  // vehicle-meter-power-lifetime.test.ts): the first reading anchors it at
  // its prior value (0 here) and it then moves by the DC delta only.
  const meter = writes
    .filter(([c]) => c === "meter_power")
    .map(([, v]) => Math.round((v as number) * 1000) / 1000);
  assert.deepEqual(meter, [0, 0.42]);
});

test("measure_power reports DC power when above 0, else AC power, whatever the key order", async () => {
  const stream = createStream();
  const { stub, capabilities } = createVehicle(stream, ["measure_power"]);
  await stub.onInit();

  // One connect snapshot during an AC session (captain's car sent
  // DCChargingPower 0 @00:46:08Z while AC charging).
  data(stream, { ACChargingPower: 7.2, DCChargingPower: 0 });
  await flush();
  assert.equal(capabilities.measure_power, 7200);

  data(stream, { DCChargingPower: 0, ACChargingPower: 6.9 });
  await flush();
  assert.equal(capabilities.measure_power, 6900);

  // DC fast charging: DC wins even with a stale AC value in the cache.
  data(stream, { DCChargingPower: 120.5 });
  await flush();
  assert.equal(capabilities.measure_power, 120500);
  data(stream, { ACChargingPower: 0.3 });
  await flush();
  assert.equal(capabilities.measure_power, 120500);
});

test("unplugging zeroes measure_power and measure_current", async () => {
  const stream = createStream();
  const { stub, capabilities } = createVehicle(stream, [
    "measure_power",
    "measure_current",
    "evcharger_charging",
  ]);
  await stub.onInit();

  // Captain's car: ACChargingPower 0.6 kW @00:48:36Z, Disconnected
  // @00:57:41Z, no further ACChargingPower (0.6 -> 0 is below the 1 kW
  // minimum_delta) nor ChargeAmps.
  data(stream, {
    DetailedChargeState: "DetailedChargeStateCharging",
    ACChargingPower: 0.6,
    ChargeAmps: 3,
  });
  await flush();
  assert.equal(capabilities.measure_power, 600);
  assert.equal(capabilities.measure_current, 3);

  data(stream, { DetailedChargeState: "DetailedChargeStateDisconnected" });
  await flush();
  assert.equal(capabilities.evcharger_charging, false);
  assert.equal(capabilities.measure_power, 0);
  assert.equal(capabilities.measure_current, 0);
});

test("a plugged-in Complete car keeps reporting its real draw", async () => {
  const stream = createStream();
  const { stub, capabilities } = createVehicle(stream, [
    "measure_power",
    "measure_current",
  ]);
  await stub.onInit();

  // Polled 00:52Z: charging_state Complete, charger_power 1, actual current 6.
  data(stream, {
    DetailedChargeState: "DetailedChargeStateComplete",
    ACChargingPower: 1,
    ChargeAmps: 6,
  });
  await flush();
  assert.equal(capabilities.measure_power, 1000);
  assert.equal(capabilities.measure_current, 6);
});

test("the cached replay on bind does not resurrect the last draw of an unplugged car", async () => {
  const stream = createStream();
  // The stream cache already holds a finished session before the device binds.
  data(stream, {
    DetailedChargeState: "DetailedChargeStateCharging",
    ACChargingPower: 0.6,
    ChargeAmps: 3,
  });
  data(stream, { DetailedChargeState: "DetailedChargeStateDisconnected" });

  const { stub, capabilities } = createVehicle(stream, [
    "measure_power",
    "measure_current",
  ]);
  await stub.onInit();
  await flush();
  assert.equal(capabilities.measure_power, 0);
  assert.equal(capabilities.measure_current, 0);

  // Plugging back in lets the real readings through again.
  data(stream, {
    DetailedChargeState: "DetailedChargeStateCharging",
    ACChargingPower: 7.2,
    ChargeAmps: 16,
  });
  await flush();
  assert.equal(capabilities.measure_power, 7200);
  assert.equal(capabilities.measure_current, 16);
});
