import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

/**
 * Mirrors TeslemetryVehicleStream: `.onSignal(field, listener)` replays the
 * last cached value for that signal synchronously, matching the SDK
 * behavior that triggers the battery-throw-during-init regression.
 */
class FakeVehicleStream extends EventEmitter {
  cache: { data: Record<string, unknown> } = { data: {} };
  private signalCache = new Map<string, unknown>();
  private signalListenerCounts = new Map<string, number>();

  cacheSignal(field: string, value: unknown) {
    this.signalCache.set(field, value);
    this.cache.data[field] = value;
  }

  onSignal(field: string, listener: (value: unknown) => void): () => void {
    this.signalListenerCounts.set(
      field,
      (this.signalListenerCounts.get(field) ?? 0) + 1,
    );
    if (this.signalCache.has(field)) listener(this.signalCache.get(field));
    return () => {
      this.signalListenerCounts.set(
        field,
        (this.signalListenerCounts.get(field) ?? 1) - 1,
      );
    };
  }

  signalListenerCount(field: string): number {
    return this.signalListenerCounts.get(field) ?? 0;
  }
}

const COMMAND_CAPABILITIES = [
  "locked",
  "thermostat_mode",
  "target_temperature",
  "steering_wheel_heater",
  "seat_heater.front_left",
  "seat_heater.front_right",
  "seat_heater.rear_left",
  "seat_heater.rear_right",
  "seat_heater.rear_center",
  "seat_cooler.front_left",
  "seat_cooler.front_right",
  "evcharger_charging",
  "charge_limit",
  "charging_amps",
  "onoff.charge_port",
  "onoff.sentry",
  "onoff.guest_mode",
  "onoff.frunk",
  "onoff.trunk",
  "windowcoverings_closed",
  "button.flash",
  "button.honk",
  "button.keyless",
  "button.homelink",
  "button.wakeup",
  "speaker_playing",
  "speaker_next",
  "speaker_prev",
  "volume_set",
  "volume_mute",
];

function createDeviceStub({ throwingBatteryLevel = false } = {}) {
  const apiCalls: Array<[string, unknown[]]> = [];
  const api = new Proxy(
    {},
    {
      get: (_target, method: string) => (...args: unknown[]) => {
        apiCalls.push([method, args]);
        return Promise.resolve({ response: { result: true } });
      },
    },
  );
  const sse = new FakeVehicleStream();
  if (throwingBatteryLevel) sse.cacheSignal("BatteryLevel", 42);

  const capabilities: Record<string, unknown> = Object.fromEntries(
    COMMAND_CAPABILITIES.map((cap) => [cap, undefined]),
  );
  capabilities.measure_battery = undefined;

  const capabilityListeners: Record<
    string,
    (value: unknown) => Promise<void>
  > = {};

  const stub = Object.assign(Object.create(VehicleDevice.prototype), {
    homey: {
      app: {
        products: { vehicles: { "vin-1": { metadata: { config: { rhd: false } }, api, sse } } },
      },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: () => ({ trigger: async () => {} }),
      },
    },
    driver: {
      manifest: {
        capabilities: Object.keys(capabilities),
        capabilitiesOptions: {},
      },
    },
    getData: () => ({ vin: "vin-1" }),
    getName: () => "Test Vehicle",
    getCapabilities: () => Object.keys(capabilities),
    addCapability: async () => {},
    removeCapability: async () => {},
    getCapabilityValue: (capability: string) => {
      if (throwingBatteryLevel && capability === "measure_battery") {
        throw new Error("simulated malformed cached capability read");
      }
      return capabilities[capability];
    },
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: (
      capability: string,
      listener: (value: unknown) => Promise<void>,
    ) => {
      capabilityListeners[capability] = listener;
    },
    setUnavailable: async () => {},
    log: () => {},
    error: () => {},
    // Normally class-field arrow functions bound in the constructor; the
    // stub bypasses the constructor via Object.create, so supply them here.
    handleVehicleState: () => {},
    handleConnectivity: () => {},
    sseCleanup: [] as Array<() => void>,
    onSignal(field: string, callback: (value: unknown) => void) {
      const off = sse.onSignal(field, callback);
      (this as any).sseCleanup.push(off);
      return off;
    },
  });

  return { stub, sse, api, apiCalls, capabilities, capabilityListeners };
}

test("VehicleDevice.onInit keeps state/connectivity and all command listeners registered when a cached signal throws during replay", async () => {
  const { stub, sse, capabilityListeners } = createDeviceStub({
    throwingBatteryLevel: true,
  });

  await assert.doesNotReject(() => stub.onInit());

  assert.equal(sse.listenerCount("state"), 1, "state listener registered");
  assert.equal(
    sse.listenerCount("connectivity"),
    1,
    "connectivity listener registered",
  );
  for (const capability of COMMAND_CAPABILITIES) {
    assert.equal(
      typeof capabilityListeners[capability],
      "function",
      `${capability} command listener registered`,
    );
  }

  await capabilityListeners.locked(true);
  assert.equal(sse.signalListenerCount("BatteryLevel"), 1);
});

test("VehicleDevice.onInit registers state/connectivity and all command listeners on a normal init", async () => {
  const { stub, sse, apiCalls, capabilityListeners } = createDeviceStub();

  await stub.onInit();

  assert.equal(sse.listenerCount("state"), 1, "state listener registered");
  assert.equal(
    sse.listenerCount("connectivity"),
    1,
    "connectivity listener registered",
  );
  for (const capability of COMMAND_CAPABILITIES) {
    assert.equal(
      typeof capabilityListeners[capability],
      "function",
      `${capability} command listener registered`,
    );
  }

  await capabilityListeners.locked(true);
  assert.deepEqual(apiCalls, [["lockDoors", []]]);
});
