// A nullable streaming field that goes null means Tesla reports it as
// invalid - navigation ended, or the car stopped charging - so the capability
// must be cleared to null rather than keep the last trip's or session's value
// (threshold conditions then fail closed on null, like distance_from_home).
// Drives the REAL TeslemetryStream (_dispatch, cache, per-VIN emitters) into
// the compiled VehicleDevice; only the Homey runtime surface is stubbed.
import test from "node:test";
import assert from "node:assert/strict";
import { TeslemetryStream } from "./support/teslemetry-api-stub.js";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import TeslemetryApp from "../.homeybuild/app.js";

const VIN = "LRW3F7EK4NC716336";

function createStream() {
  const logger = { info() {}, error() {}, warn() {}, debug() {} };
  const root: Record<string, unknown> = { logger };
  const stream = new TeslemetryStream(root, { cache: true });
  root.sse = stream;
  return stream;
}

function createVehicle(stream: any, capabilityNames: string[]) {
  const capabilities: Record<string, unknown> = {};
  for (const c of capabilityNames) capabilities[c] = null;
  const triggers: string[] = [];
  const sse = stream.getVehicle(VIN);
  // Every field already "configured", so onSignal()'s addField() resolves
  // immediately instead of scheduling a real PATCH /api/config call.
  sse.fields = new Proxy({}, { get: () => ({ interval_seconds: 1 }) });
  const vehicle = {
    vin: VIN,
    sse,
    api: {},
    // Captain's real Model 3 config.
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
          trigger: async () => {
            triggers.push(id);
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
      capabilities[c] = v;
    },
    setCapabilityOptions: async () => {},
    addCapability: async () => {},
    removeCapability: async () => {},
    getStoreValue: () => null,
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
    setAvailable: async () => {},
    setUnavailable: async () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, capabilities, triggers };
}

const flush = () => new Promise((r) => setImmediate(r));

function data(stream: any, d: Record<string, unknown>) {
  stream._dispatch({ createdAt: "2026-09-30T00:50:00.000Z", vin: VIN, data: d });
}

test("null clears reset time to full, ETA, distance, arrival energy and traffic delay, without firing triggers", async () => {
  const stream = createStream();
  const { stub, capabilities, triggers } = createVehicle(stream, [
    "time_to_full_charge",
    "minutes_to_arrival",
    "measure_distance.arrival",
    "navigation_destination",
    "measure_battery.arrival",
    "route_traffic_delay",
  ]);
  await stub.onInit();

  data(stream, {
    TimeToFullCharge: 1.5,
    MinutesToArrival: 12,
    MilesToArrival: 5,
    DestinationName: "Home",
    ExpectedEnergyPercentAtTripArrival: 70,
    RouteTrafficMinutesDelay: 3,
  });
  await flush();
  assert.equal(capabilities.time_to_full_charge, 90);
  assert.equal(capabilities.route_traffic_delay, 3);
  triggers.length = 0;

  // Captain's car: TimeToFullCharge null @00:57:35Z (after unplug); Minutes/
  // MilesToArrival and DestinationName null @00:59:50Z (navigation ended).
  // ExpectedEnergyPercentAtTripArrival was NOT nulled by the car, and
  // RouteTrafficMinutesDelay is not nullable, so neither arrives here.
  data(stream, {
    TimeToFullCharge: null,
    MinutesToArrival: null,
    MilesToArrival: null,
    DestinationName: null,
  });
  await flush();

  assert.equal(capabilities.navigation_destination, "");
  assert.equal(capabilities.time_to_full_charge, null);
  assert.equal(capabilities.minutes_to_arrival, null);
  assert.equal(capabilities["measure_distance.arrival"], null);
  assert.equal(capabilities["measure_battery.arrival"], null);
  assert.equal(capabilities.route_traffic_delay, null);
  // Only the destination's own string change fires; no numeric card fires
  // on a transition to null.
  assert.deepEqual(triggers, ["navigation_destination_changed"]);
  triggers.length = 0;

  // A later real reading after the clear only re-establishes a baseline.
  data(stream, { MinutesToArrival: 20 });
  await flush();
  assert.equal(capabilities.minutes_to_arrival, 20);
  assert.deepEqual(triggers, []);
});

test("unplugging clears time_to_full_charge", async () => {
  const stream = createStream();
  const { stub, capabilities } = createVehicle(stream, [
    "time_to_full_charge",
    "evcharger_charging",
  ]);
  await stub.onInit();

  data(stream, {
    DetailedChargeState: "DetailedChargeStateCharging",
    TimeToFullCharge: 1.5,
  });
  await flush();
  assert.equal(capabilities.time_to_full_charge, 90);

  data(stream, { DetailedChargeState: "DetailedChargeStateDisconnected" });
  await flush();
  assert.equal(capabilities.evcharger_charging, false);
  assert.equal(capabilities.time_to_full_charge, null);
});

test("threshold conditions fail closed on a cleared (null) value, even at a threshold <= 0", async () => {
  const conditionListeners: Record<string, (args: any) => Promise<unknown>> = {};
  const noop = () => ({ registerRunListener: () => {} });
  const app = Object.assign(Object.create(TeslemetryApp.prototype), {
    homey: {
      flow: {
        getActionCard: noop,
        getDeviceTriggerCard: noop,
        getConditionCard: (id: string) => ({
          registerRunListener: (fn: (args: any) => Promise<unknown>) => {
            conditionListeners[id] = fn;
          },
        }),
      },
      __: (key: string) => key,
    },
    log: () => {},
  }) as unknown as { registerFlowCards(): void };
  app.registerFlowCards();

  const values: Record<string, unknown> = {
    minutes_to_arrival: null,
    "measure_temperature.outside": null,
  };
  const device = { getCapabilityValue: (c: string) => values[c] };

  assert.equal(await conditionListeners.minutes_to_arrival({ device, minutes: 0 }), false);
  assert.equal(
    await conditionListeners.outside_temperature({ device, degrees: -5 }),
    false,
  );

  values.minutes_to_arrival = 12;
  assert.equal(await conditionListeners.minutes_to_arrival({ device, minutes: 10 }), true);
});
