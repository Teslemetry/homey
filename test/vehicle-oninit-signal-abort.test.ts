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
  private signalListeners = new Map<string, Set<(value: unknown) => void>>();

  onSignal(field: string, callback: (value: unknown) => void): () => void {
    if (!this.signalListeners.has(field)) {
      this.signalListeners.set(field, new Set());
    }
    this.signalListeners.get(field)!.add(callback);
    if (field in this.cache.data) callback(this.cache.data[field]);
    return () => this.signalListeners.get(field)?.delete(callback);
  }

  signalListenerCount(field: string): number {
    return this.signalListeners.get(field)?.size ?? 0;
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

function createDeviceStub({
  throwOnBatteryLevel = false,
  metadataConfig = {
    rhd: false,
    can_actuate_trunks: false,
    // Matches every seat capability already in COMMAND_CAPABILITIES, so
    // ensureCapabilities() is a no-op and this fixture stays focused on
    // signal-listener registration ordering, not capability gating.
    has_seat_cooling: true,
    rear_seat_heaters: 3,
  } as Record<string, unknown> | undefined,
} = {}) {
  const sse = new FakeVehicleStream();
  if (throwOnBatteryLevel) sse.cache.data.BatteryLevel = 42;

  const apiCalls: Array<{ method: string; args: unknown[] }> = [];
  const api = new Proxy(
    {},
    {
      get: (_target, method: string) => (...args: unknown[]) => {
        apiCalls.push({ method, args });
        return Promise.resolve({ response: { result: true } });
      },
    },
  );
  const vehicle = {
    sse,
    api,
    metadata: {
      access: true,
      fleet_telemetry: "fleet_telemetry_config_id",
      polling: false,
      config: metadataConfig,
    },
  };

  const capabilities: Record<string, unknown> = Object.fromEntries(
    COMMAND_CAPABILITIES.map((cap) => [cap, undefined]),
  );
  capabilities.measure_battery = undefined;
  const capabilityListeners: Record<
    string,
    (value: unknown) => Promise<void>
  > = {};

  const logMessages: unknown[][] = [];

  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { "test-vin": vehicle } } },
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
    getData: () => ({ vin: "test-vin", id: "test-vin" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => {
      if (throwOnBatteryLevel && capability === "measure_battery") {
        throw new Error("simulated malformed cached capability read");
      }
      return capabilities[capability];
    },
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    addCapability: async () => {},
    removeCapability: async () => {},
    getStoreValue: () => null,
    registerCapabilityListener: (
      capability: string,
      listener: (value: unknown) => Promise<void>,
    ) => {
      capabilityListeners[capability] = listener;
    },
    log: (...args: unknown[]) => {
      logMessages.push(args);
    },
    error: () => {},
    setUnavailable: async () => {},
  });

  return {
    stub,
    sse,
    api,
    apiCalls,
    capabilities,
    capabilityListeners,
    logMessages,
  };
}

test("VehicleDevice.onInit registers state/connectivity listeners and every command capability listener even when an early cached signal replay throws", async () => {
  const { stub, sse, apiCalls, capabilityListeners } = createDeviceStub({
    throwOnBatteryLevel: true,
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
  assert.deepEqual(apiCalls, [{ method: "lockDoors", args: [] }]);
});

test("a throwing cached signal replay does not abort registration of signals registered after it", async () => {
  const { stub, sse } = createDeviceStub({ throwOnBatteryLevel: true });

  await assert.doesNotReject(() => stub.onInit());

  assert.equal(
    sse.signalListenerCount("BatteryLevel"),
    1,
    "the throwing signal's own listener is still registered",
  );
  assert.equal(
    sse.signalListenerCount("EstBatteryRange"),
    1,
    "the next signal after the throw is registered",
  );
  assert.equal(
    sse.signalListenerCount("ChargePortLatch"),
    1,
    "a signal further down the registration order is registered",
  );
  assert.equal(
    sse.signalListenerCount("MediaNowPlayingElapsed"),
    1,
    "the last signal in registration order is registered",
  );
});

test("VehicleDevice.onInit logs a degraded-health summary when a signal handler throws during registration", async () => {
  const { stub, logMessages } = createDeviceStub({ throwOnBatteryLevel: true });

  await stub.onInit();

  assert.ok(
    logMessages.some((args) =>
      args.some(
        (arg) => typeof arg === "string" && arg.includes("1 signal handler failure"),
      ),
    ),
    `expected a degraded-health log message, got: ${JSON.stringify(logMessages)}`,
  );
});

test("VehicleDevice.onInit does not log a degraded-health summary on a normal init", async () => {
  const { stub, logMessages } = createDeviceStub();

  await stub.onInit();

  assert.ok(
    !logMessages.some((args) =>
      args.some(
        (arg) => typeof arg === "string" && arg.includes("signal handler failure"),
      ),
    ),
    `expected no degraded-health log message, got: ${JSON.stringify(logMessages)}`,
  );
});

test("missing optional metadata.config.rhd does not throw during registration and falls back to the left-side signal", async () => {
  const { stub, sse } = createDeviceStub({ metadataConfig: {} });

  await assert.doesNotReject(() => stub.onInit());

  assert.equal(
    sse.signalListenerCount("HvacLeftTemperatureRequest"),
    1,
    "falls back to the left-side signal when rhd is absent",
  );
  assert.equal(
    sse.signalListenerCount("HvacRightTemperatureRequest"),
    0,
    "does not register the right-side signal when rhd is absent",
  );
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
  assert.deepEqual(apiCalls, [{ method: "lockDoors", args: [] }]);
});
