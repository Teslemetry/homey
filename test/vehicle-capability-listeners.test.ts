import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

class FakeVehicleStream extends EventEmitter {
  data = new EventEmitter();
  cache: { data: Record<string, unknown> } = { data: {} };

  onSignal(field: string, callback: (value: unknown) => void) {
    this.data.on(field, callback);
    return () => this.data.off(field, callback);
  }
}

async function createDeviceStub(
  capabilities: Record<string, unknown> = {},
  cacheData: Record<string, unknown> = {},
  copUserSetTempSupported: boolean | undefined = true,
) {
  const sse = new FakeVehicleStream();
  sse.cache.data = cacheData;
  const apiCalls: Array<{ method: string; args: unknown[] }> = [];
  const recordApiCall =
    (method: string) =>
    (...args: unknown[]) => {
      apiCalls.push({ method, args });
      return Promise.resolve({ response: { result: true } });
    };
  const api = new Proxy(
    {},
    {
      get: (_target, method: string) => recordApiCall(method),
    },
  );
  const vehicle = {
    sse,
    api,
    metadata: {
      access: true,
      fleet_telemetry: "fleet_telemetry_config_id",
      polling: false,
      config: {
        rhd: false,
        can_actuate_trunks: false,
        cop_user_set_temp_supported: copUserSetTempSupported,
      },
    },
  };
  const capabilityListeners: Record<string, (value: unknown) => Promise<void>> = {};

  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { "test-vin": vehicle } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: () => ({ trigger: async () => {} }),
      },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
    },
    getData: () => ({ vin: "test-vin", id: "test-vin" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    getStoreValue: () => null,
    registerCapabilityListener: (capability: string, listener: (value: unknown) => Promise<void>) => {
      capabilityListeners[capability] = listener;
    },
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });

  await stub.onInit();

  return { stub, capabilities, capabilityListeners, apiCalls, sse };
}

test("locked capability listener locks/unlocks doors", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners.locked(true);
  await capabilityListeners.locked(false);

  assert.deepEqual(
    apiCalls.map((c) => c.method),
    ["lockDoors", "unlockDoors"],
  );
});

test("steering_wheel_heater capability listener maps level codes to the SDK commands", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners.steering_wheel_heater("0");
  await capabilityListeners.steering_wheel_heater("1");
  await capabilityListeners.steering_wheel_heater("3");

  assert.deepEqual(apiCalls, [
    { method: "setSteeringWheelHeater", args: [false] },
    { method: "setSteeringWheelHeatLevel", args: [1] },
    { method: "setSteeringWheelHeatLevel", args: [3] },
  ]);
});

test("steering_wheel_heater capability listener throws on an invalid level", async () => {
  const { capabilityListeners } = await createDeviceStub();

  await assert.rejects(
    () => capabilityListeners.steering_wheel_heater("invalid"),
    /Invalid level/,
  );
});

test("cop_mode capability listener maps off/on/fan_only to setCabinOverheatProtection", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners.cop_mode("off");
  await capabilityListeners.cop_mode("on");
  await capabilityListeners.cop_mode("fan_only");

  assert.deepEqual(apiCalls, [
    { method: "setCabinOverheatProtection", args: [{ on: false, fan_only: false }] },
    { method: "setCabinOverheatProtection", args: [{ on: true, fan_only: false }] },
    { method: "setCabinOverheatProtection", args: [{ on: true, fan_only: true }] },
  ]);
});

test("cop_mode capability listener throws on an invalid mode", async () => {
  const { capabilityListeners } = await createDeviceStub();

  await assert.rejects(
    () => capabilityListeners.cop_mode("invalid"),
    /Invalid cabin overheat protection mode/,
  );
});

test("cop_temperature_limit capability listener maps low/medium/high to setCopTemp", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners.cop_temperature_limit("low");
  await capabilityListeners.cop_temperature_limit("medium");
  await capabilityListeners.cop_temperature_limit("high");

  assert.deepEqual(apiCalls, [
    { method: "setCopTemp", args: [0] },
    { method: "setCopTemp", args: [1] },
    { method: "setCopTemp", args: [2] },
  ]);
});

test("cop_temperature_limit capability listener throws on an invalid limit", async () => {
  const { capabilityListeners } = await createDeviceStub();

  await assert.rejects(
    () => capabilityListeners.cop_temperature_limit("invalid"),
    /Invalid cabin overheat protection temperature limit/,
  );
});

test("cop_temperature_limit capability listener rejects unsupported vehicles", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub({}, {}, false);

  await assert.rejects(
    () => capabilityListeners.cop_temperature_limit("low"),
    /temperature limit is not supported/,
  );
  assert.deepEqual(apiCalls, []);
});

test("cop_temperature_limit flow action rejects when support is absent", async () => {
  const { stub, apiCalls } = await createDeviceStub({}, {}, false);

  await assert.rejects(
    () => stub.flowSetCopTemperatureLimit("high"),
    /temperature limit is not supported/,
  );
  assert.deepEqual(apiCalls, []);
});

test("onoff.sentry capability listener calls setSentryMode", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners["onoff.sentry"](true);

  assert.deepEqual(apiCalls, [{ method: "setSentryMode", args: [true] }]);
});

test("onoff.guest_mode capability listener calls setGuestMode", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners["onoff.guest_mode"](false);

  assert.deepEqual(apiCalls, [{ method: "setGuestMode", args: [false] }]);
});

test("auto climate signals update the three Homey switches", async () => {
  const capabilities = {
    "onoff.auto_seat_climate_left": false,
    "onoff.auto_seat_climate_right": false,
    "onoff.auto_steering_wheel_heat": false,
  };
  const { sse } = await createDeviceStub(capabilities);

  sse.data.emit("AutoSeatClimateLeft", true);
  sse.data.emit("AutoSeatClimateRight", true);
  sse.data.emit("HvacSteeringWheelHeatAuto", true);

  assert.deepEqual(capabilities, {
    "onoff.auto_seat_climate_left": true,
    "onoff.auto_seat_climate_right": true,
    "onoff.auto_steering_wheel_heat": true,
  });
});

test("auto climate switch listeners call the matching vehicle commands", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners["onoff.auto_seat_climate_left"](true);
  await capabilityListeners["onoff.auto_seat_climate_right"](false);
  await capabilityListeners["onoff.auto_steering_wheel_heat"](true);

  assert.deepEqual(apiCalls, [
    { method: "setAutoSeatClimate", args: ["front_left", true] },
    { method: "setAutoSeatClimate", args: ["front_right", false] },
    { method: "setAutoSteeringWheelHeat", args: [true] },
  ]);
});

test("onoff.frunk capability listener actuates the front trunk only when turned on", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners["onoff.frunk"](false);
  assert.deepEqual(apiCalls, [], "no command fired when turned off - frunk cannot be closed remotely");

  await capabilityListeners["onoff.frunk"](true);
  assert.deepEqual(apiCalls, [{ method: "actuateTrunk", args: ["front"] }]);
});

test("onoff.trunk capability listener actuates the rear trunk regardless of value", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners["onoff.trunk"](false);

  assert.deepEqual(apiCalls, [{ method: "actuateTrunk", args: ["rear"] }]);
});

test("windowcoverings_closed.tonneau capability listener sends the closure command's open/close endpoint", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners["windowcoverings_closed.tonneau"](true);
  assert.deepEqual(apiCalls, [{ method: "closure", args: [{ tonneau: "close" }] }]);

  apiCalls.length = 0;
  await capabilityListeners["windowcoverings_closed.tonneau"](false);
  assert.deepEqual(apiCalls, [{ method: "closure", args: [{ tonneau: "open" }] }]);
});

test("windowcoverings_closed.sunroof capability listener sends the sunRoofControl vent/close endpoint", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners["windowcoverings_closed.sunroof"](true);
  assert.deepEqual(apiCalls, [{ method: "sunRoofControl", args: ["close"] }]);

  apiCalls.length = 0;
  await capabilityListeners["windowcoverings_closed.sunroof"](false);
  assert.deepEqual(apiCalls, [{ method: "sunRoofControl", args: ["vent"] }]);
});

test("windowcoverings_closed capability listener uses the cached Location, defaulting to 0/0 when absent", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners.windowcoverings_closed(true);

  assert.deepEqual(apiCalls, [{ method: "windowControl", args: ["close", 0, 0] }]);
});

test("windowcoverings_closed capability listener uses the real cached Location when present", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub({}, {
    Location: { latitude: 12.5, longitude: -3.25 },
  });

  await capabilityListeners.windowcoverings_closed(false);

  assert.deepEqual(apiCalls, [{ method: "windowControl", args: ["vent", 12.5, -3.25] }]);
});

test("button capability listeners fire their respective commands", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners["button.honk"]();
  await capabilityListeners["button.keyless"]();
  await capabilityListeners["button.wakeup"]();
  await capabilityListeners["button.homelink"]();

  assert.deepEqual(
    apiCalls.map((c) => c.method),
    ["honkHorn", "remoteStart", "wakeUp", "triggerHomelink"],
  );
});

test("volume_set capability listener scales the 0-1 value by volumeMax and unmutes", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners.volume_set(0.5);

  assert.deepEqual(apiCalls, [
    { method: "adjustVolume", args: [0.5 * 10.333] },
  ]);
});

test("volume_mute capability listener mutes to 0 and unmute restores the last known volume", async () => {
  const { capabilityListeners, apiCalls, capabilities } = await createDeviceStub({
    volume_set: 0.7,
  });

  await capabilityListeners.volume_mute(true);
  assert.deepEqual(apiCalls, [{ method: "adjustVolume", args: [0] }]);
  assert.equal(capabilities.volume_set, 0);

  apiCalls.length = 0;
  await capabilityListeners.volume_mute(false);
  assert.deepEqual(apiCalls, [{ method: "adjustVolume", args: [0.5 * 10.333] }]);
  assert.equal(capabilities.volume_set, 0.5);
});

test("volume_up/volume_down capability listeners step by the vehicle's own reported increment", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners.volume_up();
  await capabilityListeners.volume_down();

  assert.deepEqual(apiCalls, [
    { method: "adjustVolume", args: [0.5 * 10.333 + 0.333] },
    { method: "adjustVolume", args: [(0.5 * 10.333 + 0.333) - 0.333] },
  ]);
});

test("volume_up/volume_down clamp at the reported max and zero", async () => {
  const { capabilityListeners, apiCalls, sse } = await createDeviceStub();

  sse.data.emit("MediaAudioVolumeMax", 1);
  sse.data.emit("MediaAudioVolumeIncrement", 5);
  sse.data.emit("MediaAudioVolume", 0.9);

  await capabilityListeners.volume_up();
  assert.deepEqual(apiCalls, [{ method: "adjustVolume", args: [1] }]);

  apiCalls.length = 0;
  sse.data.emit("MediaAudioVolume", 0.1);
  await capabilityListeners.volume_down();
  assert.deepEqual(apiCalls, [{ method: "adjustVolume", args: [0] }]);
});

test("volume step retains the absolute volume when the max arrives later", async () => {
  const { capabilityListeners, apiCalls, sse } = await createDeviceStub();

  sse.data.emit("MediaAudioVolume", 5);
  sse.data.emit("MediaAudioVolumeMax", 20);
  sse.data.emit("MediaAudioVolumeIncrement", 1);

  await capabilityListeners.volume_up();

  assert.deepEqual(apiCalls, [{ method: "adjustVolume", args: [6] }]);
});

test("volume step follows a locally requested absolute volume", async () => {
  const { capabilityListeners, apiCalls } = await createDeviceStub();

  await capabilityListeners.volume_set(0.25);
  await capabilityListeners.volume_up();

  assert.deepEqual(apiCalls, [
    { method: "adjustVolume", args: [0.25 * 10.333] },
    { method: "adjustVolume", args: [0.25 * 10.333 + 0.333] },
  ]);
});
