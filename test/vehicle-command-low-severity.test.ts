import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

const manifest = JSON.parse(
  readFileSync(new URL("../app.json", import.meta.url), "utf8"),
);
const vehicleDriverManifest = manifest.drivers.find(
  (driver: { id: string }) => driver.id === "vehicle",
);

class FakeVehicleStream extends EventEmitter {
  data = new EventEmitter();
  cache: { data: Record<string, unknown> } = { data: {} };

  onSignal(field: string, callback: (value: unknown) => void) {
    this.data.on(field, callback);
    return () => this.data.off(field, callback);
  }
}

async function createDeviceStub({
  capabilities = {},
  cacheData = {},
  homeyLocation = { latitude: 51.5, longitude: -0.12 },
  failingCommands = new Set<string>(),
}: {
  capabilities?: Record<string, unknown>;
  cacheData?: Record<string, unknown>;
  homeyLocation?: { latitude: number; longitude: number } | null;
  failingCommands?: Set<string>;
} = {}) {
  const sse = new FakeVehicleStream();
  sse.cache.data = cacheData;
  const apiCalls: Array<{ method: string; args: unknown[] }> = [];
  const api = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (...args: unknown[]) => {
          apiCalls.push({ method, args });
          return Promise.resolve({
            response: failingCommands.has(method)
              ? { result: false, reason: "vehicle_unavailable" }
              : { result: true },
          });
        },
    },
  );
  const vehicle = {
    sse,
    api,
    // The captain's real Model 3 config.
    metadata: {
      access: true,
      fleet_telemetry: "fleet_telemetry_config_id",
      polling: false,
      config: {
        rhd: true,
        rear_seat_heaters: 1,
        can_actuate_trunks: true,
        cop_user_set_temp_supported: false,
      },
    },
  };
  const capabilityListeners: Record<string, (value?: unknown) => Promise<void>> = {};
  const capabilityOptions: Record<string, unknown> = {};

  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { "test-vin": vehicle } } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
      geolocation: {
        getLatitude: () => homeyLocation?.latitude,
        getLongitude: () => homeyLocation?.longitude,
      },
    },
    driver: {
      manifest: {
        capabilities: Object.keys(capabilities),
        capabilitiesOptions: vehicleDriverManifest.capabilitiesOptions,
      },
    },
    getData: () => ({ vin: "test-vin", id: "test-vin" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async (capability: string, options: unknown) => {
      capabilityOptions[capability] = options;
    },
    getStoreValue: () => null,
    registerCapabilityListener: (
      capability: string,
      listener: (value?: unknown) => Promise<void>,
    ) => {
      capabilityListeners[capability] = listener;
    },
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });

  await stub.onInit();
  return { stub, sse, apiCalls, capabilities, capabilityListeners, capabilityOptions };
}

// --- charge limit range (API minimum 50%) ---

test("charge_limit slider and set_charge_limit card start at the API's 50% minimum", () => {
  assert.equal(manifest.capabilities.charge_limit.min, 0.5);
  assert.equal(manifest.capabilities.charge_limit.max, 1);
  const card = manifest.flow.actions.find(
    (action: { id: string }) => action.id === "set_charge_limit",
  );
  const percentage = card.args.find(
    (arg: { name: string }) => arg.name === "percentage",
  );
  assert.equal(percentage.min, 50);
  assert.equal(percentage.max, 100);
});

// --- target temperature range ---

test("target_temperature uses HA's 15-28 °C range, applied to already-paired vehicles at bind", async () => {
  assert.deepEqual(
    {
      min: vehicleDriverManifest.capabilitiesOptions.target_temperature.min,
      max: vehicleDriverManifest.capabilitiesOptions.target_temperature.max,
    },
    { min: 15, max: 28 },
  );

  const { capabilityOptions } = await createDeviceStub({
    capabilities: { target_temperature: 21 },
  });
  assert.deepEqual(
    capabilityOptions.target_temperature,
    vehicleDriverManifest.capabilitiesOptions.target_temperature,
  );
});

// --- days of week (the server's own DAYS map) ---

test("charge/precondition schedule days accept the server's short names and \"weekends\"", async () => {
  const { stub, apiCalls } = await createDeviceStub();

  await stub.flowAddChargeSchedule({
    name: "Weekend",
    daysOfWeek: "Sat, sun",
    enabled: true,
    startEnabled: false,
    startTime: "00:00",
    endEnabled: false,
    endTime: "00:00",
    lat: 1,
    lon: 2,
    oneTime: false,
  });
  await stub.flowAddPreconditionSchedule({
    name: "Commute",
    daysOfWeek: "mon,TUE,wed,thu,fri,weekends",
    enabled: true,
    preconditionTime: "07:30",
    lat: 1,
    lon: 2,
    oneTime: false,
  });

  assert.equal(
    (apiCalls[0].args[0] as { days_of_week: string }).days_of_week,
    "Sat,Sun",
  );
  assert.equal(
    (apiCalls[1].args[0] as { days_of_week: string }).days_of_week,
    "Mon,Tue,Wed,Thu,Fri,Weekends",
  );
});

// --- mute/volume rollback ---

test("a failed mute restores the volume tile and keeps MediaAudioVolume updates flowing", async () => {
  const { sse, capabilities, capabilityListeners } = await createDeviceStub({
    capabilities: { volume_set: 0.6 },
    failingCommands: new Set(["adjustVolume"]),
  });

  await assert.rejects(capabilityListeners.volume_mute(true));
  assert.equal(capabilities.volume_set, 0.6);

  // Not left "muted": a later genuine volume report still reaches the tile.
  sse.data.emit("MediaAudioVolume", 3.1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capabilities.volume_set, 3.1 / 10.333);
});

test("a failed volume step does not move the baseline the next step builds on", async () => {
  const { sse, apiCalls, capabilityListeners } = await createDeviceStub({
    capabilities: { volume_set: 0.3 },
    failingCommands: new Set(["adjustVolume"]),
  });
  sse.data.emit("MediaAudioVolume", 3);

  await assert.rejects(capabilityListeners.volume_up());
  await assert.rejects(capabilityListeners.volume_up());

  assert.deepEqual(
    apiCalls.map((call) => call.args[0]),
    [3.333, 3.333],
  );
});

// --- climate keeper off only when it is actually on ---

for (const keeper of [undefined, null, "ClimateKeeperModeStateUnknown", "ClimateKeeperModeStateOff"]) {
  test(`thermostat auto with ClimateKeeperMode ${String(keeper)} sends no keeper-off command`, async () => {
    const { apiCalls, capabilityListeners } = await createDeviceStub({
      cacheData: { HvacPower: "HvacPowerStateOn", ClimateKeeperMode: keeper },
    });

    await capabilityListeners.thermostat_mode("auto");

    assert.equal(
      apiCalls.some((call) => call.method === "setClimateKeeperMode"),
      false,
    );
  });
}

test("thermostat auto turns a running climate keeper off", async () => {
  const { apiCalls, capabilityListeners } = await createDeviceStub({
    cacheData: {
      HvacPower: "HvacPowerStateOn",
      ClimateKeeperMode: "ClimateKeeperModeStateDog",
    },
  });

  await capabilityListeners.thermostat_mode("auto");

  assert.deepEqual(
    apiCalls.filter((call) => call.method === "setClimateKeeperMode"),
    [{ method: "setClimateKeeperMode", args: [0] }],
  );
});

// --- HomeLink location ---

test("HomeLink sends Homey's own location, not a {0,0} fallback", async () => {
  const { stub, apiCalls, capabilityListeners } = await createDeviceStub();

  await capabilityListeners["button.homelink"]();
  await stub.flowTriggerHomelink();

  assert.deepEqual(apiCalls, [
    { method: "triggerHomelink", args: [51.5, -0.12] },
    { method: "triggerHomelink", args: [51.5, -0.12] },
  ]);
});

test("HomeLink falls back to the vehicle's location, and rejects when neither is known", async () => {
  const located = await createDeviceStub({
    homeyLocation: null,
    cacheData: { Location: { latitude: -33.8, longitude: 151.2 } },
  });
  await located.stub.flowTriggerHomelink();
  assert.deepEqual(located.apiCalls, [
    { method: "triggerHomelink", args: [-33.8, 151.2] },
  ]);

  const unknown = await createDeviceStub({ homeyLocation: null });
  await assert.rejects(unknown.stub.flowTriggerHomelink());
  await assert.rejects(unknown.capabilityListeners["button.homelink"]());
  assert.deepEqual(unknown.apiCalls, []);
});

// --- steering wheel heater Flow level ---

test("flowSetSteeringWheelHeater rejects an unknown level instead of silently succeeding", async () => {
  const { stub, apiCalls } = await createDeviceStub();

  await assert.rejects(stub.flowSetSteeringWheelHeater("2"));
  assert.deepEqual(apiCalls, []);
});
