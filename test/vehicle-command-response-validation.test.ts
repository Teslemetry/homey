import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

/**
 * Covers finding 8 (most vehicle commands treated Tesla's explicit
 * `{ response: { result: false, reason } }` as success because only a few
 * temperature/navigation/climate commands ran it through handleApiResponse)
 * and finding 13 (the defrost-exit command was launched without awaiting or
 * catching it, racing the next climate command and risking an unhandled
 * rejection). Every command below now routes through VehicleDevice's private
 * vehicleAction() wrapper, which validates response.result before entering
 * the action() timeout race.
 */

class FakeVehicleStream extends EventEmitter {
  cache: { data: Record<string, unknown> } = { data: {} };

  onSignal(_field: string, _callback: (value: unknown) => void) {
    return () => {};
  }
}

function createCapabilityDeviceStub(
  apiOverrides: Record<string, (...args: unknown[]) => Promise<unknown>> = {},
) {
  const sse = new FakeVehicleStream();
  const apiCalls: Array<{ method: string; args: unknown[] }> = [];
  const defaultHandler =
    (method: string) =>
    (...args: unknown[]) => {
      apiCalls.push({ method, args });
      return Promise.resolve({ response: { result: true } });
    };
  const api = new Proxy(
    {},
    {
      get: (_target, method: string) => {
        if (apiOverrides[method]) {
          return (...args: unknown[]) => {
            apiCalls.push({ method, args });
            return apiOverrides[method](...args);
          };
        }
        return defaultHandler(method);
      },
    },
  );
  const vehicle = {
    sse,
    api,
    metadata: { config: { rhd: false, can_actuate_trunks: false } },
  };
  const capabilityListeners: Record<string, (value: unknown) => Promise<void>> = {};

  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { "test-vin": vehicle } } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: {
      manifest: { capabilities: [], capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin: "test-vin", id: "test-vin" }),
    getStoreValue: () => null,
    getCapabilities: () => [],
    getCapabilityValue: () => undefined,
    setCapabilityValue: async () => {},
    setCapabilityOptions: async () => {},
    registerCapabilityListener: (
      capability: string,
      listener: (value: unknown) => Promise<void>,
    ) => {
      capabilityListeners[capability] = listener;
    },
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });

  return { stub, capabilityListeners, apiCalls };
}

const RESULT_FALSE = () =>
  Promise.resolve({ response: { result: false, reason: "vehicle asleep" } });

const REPRESENTATIVE_CAPABILITY_COMMANDS: Array<{
  family: string;
  capability: string;
  method: string;
  value: unknown;
}> = [
  { family: "lock", capability: "locked", method: "lockDoors", value: true },
  {
    family: "charging",
    capability: "evcharger_charging",
    method: "startCharging",
    value: true,
  },
  {
    family: "charge limit/amps",
    capability: "charge_limit",
    method: "setChargeLimit",
    value: 0.8,
  },
  {
    family: "charge limit/amps",
    capability: "charging_amps",
    method: "setChargingAmps",
    value: 16,
  },
  {
    family: "ports",
    capability: "onoff.charge_port",
    method: "openChargePort",
    value: true,
  },
  {
    family: "trunks",
    capability: "onoff.trunk",
    method: "actuateTrunk",
    value: true,
  },
  {
    family: "sentry/guest",
    capability: "onoff.sentry",
    method: "setSentryMode",
    value: true,
  },
  {
    family: "sentry/guest",
    capability: "onoff.guest_mode",
    method: "setGuestMode",
    value: true,
  },
  {
    family: "lights/horn",
    capability: "button.honk",
    method: "honkHorn",
    value: undefined,
  },
  {
    family: "Homelink",
    capability: "button.homelink",
    method: "triggerHomelink",
    value: undefined,
  },
  {
    family: "media",
    capability: "speaker_playing",
    method: "mediaTogglePlayback",
    value: undefined,
  },
  {
    family: "seat climate",
    capability: "seat_heater.front_left",
    method: "setSeatHeater",
    value: "2",
  },
  {
    family: "steering wheel",
    capability: "steering_wheel_heater",
    method: "setSteeringWheelHeater",
    value: "0",
  },
];

for (const { family, capability, method, value } of REPRESENTATIVE_CAPABILITY_COMMANDS) {
  test(`${capability} capability listener (${family}) surfaces an explicit Tesla result:false as a rejection`, async () => {
    const { stub, capabilityListeners } = createCapabilityDeviceStub({
      [method]: RESULT_FALSE,
    });
    await stub.onInit();

    await assert.rejects(
      () => capabilityListeners[capability](value),
      /vehicle asleep/,
    );
  });
}

test("button.wakeup is exempt from response validation - its response shape has no result field", async () => {
  const { stub, capabilityListeners, apiCalls } = createCapabilityDeviceStub({
    wakeUp: () => Promise.resolve({ response: { state: "online" } }),
  });
  await stub.onInit();

  await assert.doesNotReject(() => capabilityListeners["button.wakeup"]());
  assert.deepEqual(apiCalls, [{ method: "wakeUp", args: [] }]);
});

// --- Flow actions ---

function createFlowDeviceStub(
  apiOverrides: Record<string, (...args: unknown[]) => Promise<unknown>> = {},
  cacheData: Record<string, unknown> = {},
) {
  const apiCalls: Array<{ method: string; args: unknown[] }> = [];
  const defaultHandler =
    (method: string) =>
    (...args: unknown[]) => {
      apiCalls.push({ method, args });
      return Promise.resolve({ response: { result: true } });
    };
  const api = new Proxy(
    {},
    {
      get: (_target, method: string) => {
        if (apiOverrides[method]) {
          return (...args: unknown[]) => {
            apiCalls.push({ method, args });
            return apiOverrides[method](...args);
          };
        }
        return defaultHandler(method);
      },
    },
  );

  // new VehicleDevice(), not Object.create(VehicleDevice.prototype): the
  // latter skips the constructor, leaving handleApiResponse/handleApiError
  // (arrow-function class fields, not prototype methods) undefined, which
  // silently no-ops validation instead of exercising it.
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: { getDevices: () => [] as unknown[] },
    vehicle: { api, sse: { cache: { data: cacheData } } },
    getName: () => "Test Vehicle",
    log: () => {},
    error: () => {},
    getCapabilities: () => [],
    getCapabilityValue: () => undefined,
    setCapabilityValue: async () => {},
  });
  return { stub, apiCalls };
}

test("flowStartCharging surfaces an explicit Tesla result:false as a rejection", async () => {
  const { stub } = createFlowDeviceStub({ startCharging: RESULT_FALSE });

  await assert.rejects(() => stub.flowStartCharging(), /vehicle asleep/);
});

test("flowSetChargeLimit surfaces an explicit Tesla result:false as a rejection", async () => {
  const { stub } = createFlowDeviceStub({ setChargeLimit: RESULT_FALSE });

  await assert.rejects(() => stub.flowSetChargeLimit(80), /vehicle asleep/);
});

test("flowHonkHorn surfaces an explicit Tesla result:false as a rejection", async () => {
  const { stub } = createFlowDeviceStub({ honkHorn: RESULT_FALSE });

  await assert.rejects(() => stub.flowHonkHorn(), /vehicle asleep/);
});

test("flowSetSeatHeater surfaces an explicit Tesla result:false as a rejection", async () => {
  const { stub } = createFlowDeviceStub({ setSeatHeater: RESULT_FALSE });

  await assert.rejects(
    () => stub.flowSetSeatHeater("front_left", "2"),
    /vehicle asleep/,
  );
});

test("flowWakeUp is exempt from response validation - its response shape has no result field", async () => {
  const { stub, apiCalls } = createFlowDeviceStub({
    wakeUp: () => Promise.resolve({ response: { state: "online" } }),
  });

  await assert.doesNotReject(() => stub.flowWakeUp());
  assert.deepEqual(apiCalls, [{ method: "wakeUp", args: [] }]);
});

// --- Defrost mode transition (finding 13) ---

test("setThermostatMode awaits the defrost-exit command before issuing the keeper-mode command", async () => {
  const order: string[] = [];
  const { stub } = createFlowDeviceStub(
    {
      setPreconditioningMax: async () => {
        order.push("setPreconditioningMax:start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("setPreconditioningMax:end");
        return { response: { result: true } };
      },
      setClimateKeeperMode: async () => {
        order.push("setClimateKeeperMode");
        return { response: { result: true } };
      },
    },
    {
      HvacPower: "HvacPowerStateOn",
      DefrostMode: "DefrostModeStateMax",
      ClimateKeeperMode: "ClimateKeeperModeStateOff",
    },
  );

  await (stub as any).setThermostatMode("keep_mode");

  assert.deepEqual(order, [
    "setPreconditioningMax:start",
    "setPreconditioningMax:end",
    "setClimateKeeperMode",
  ]);
});

test("a failed defrost-exit command rejects setThermostatMode and never issues the keeper-mode command", async () => {
  const { stub, apiCalls } = createFlowDeviceStub(
    { setPreconditioningMax: RESULT_FALSE },
    {
      HvacPower: "HvacPowerStateOn",
      DefrostMode: "DefrostModeStateMax",
      ClimateKeeperMode: "ClimateKeeperModeStateOff",
    },
  );

  await assert.rejects(
    () => (stub as any).setThermostatMode("keep_mode"),
    /vehicle asleep/,
  );

  assert.deepEqual(
    apiCalls.map((c) => c.method),
    ["setPreconditioningMax"],
    "the keeper-mode command must not fire after the defrost-exit command failed",
  );
});

test("a failed defrost-exit command propagates through flowSetClimateMode without an unhandled rejection", async () => {
  const { stub } = createFlowDeviceStub(
    { setPreconditioningMax: RESULT_FALSE },
    {
      HvacPower: "HvacPowerStateOn",
      DefrostMode: "DefrostModeStateMax",
      ClimateKeeperMode: "ClimateKeeperModeStateOff",
    },
  );

  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await assert.rejects(
      () => stub.flowSetClimateMode("keep_mode"),
      /vehicle asleep/,
    );
    // Let any stray unhandled-rejection microtask surface before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});
