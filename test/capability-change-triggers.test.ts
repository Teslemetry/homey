import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryDevice from "../.homeybuild/lib/TeslemetryDevice.js";

function createDeviceStub(capabilities: Record<string, unknown>) {
  const triggerCalls: Array<{ cardId: string; tokens: unknown }> = [];
  let currentCardId = "";
  const flowCardStub = {
    trigger: async (_device: unknown, tokens: unknown) => {
      triggerCalls.push({ cardId: currentCardId, tokens });
    },
  };
  const stub = Object.assign(new TeslemetryDevice(), {
    homey: {
      flow: {
        getDeviceTriggerCard: (cardId: string) => {
          currentCardId = cardId;
          return flowCardStub;
        },
      },
    },
    driver: {
      getDevices: () => [] as unknown[],
    },
    error: () => {},
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
  });
  stub.driver.getDevices = () => [stub];
  return { stub, triggerCalls };
}

test("update() fires the matching *_changed trigger card with the new value when it changes", async () => {
  const { stub, triggerCalls } = createDeviceStub({ backup_reserve: 0.2 });

  await stub.update("backup_reserve", 0.35);

  assert.deepEqual(triggerCalls, [
    { cardId: "backup_reserve_changed", tokens: { backup_reserve: 0.35 } },
  ]);
});

test("update() does not fire the trigger card when the value is unchanged", async () => {
  const { stub, triggerCalls } = createDeviceStub({ backup_reserve: 0.2 });

  await stub.update("backup_reserve", 0.2);

  assert.deepEqual(triggerCalls, []);
});

test("update() fires steering_wheel_heater_changed with a string token", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    steering_wheel_heater: "0",
  });

  await stub.update("steering_wheel_heater", "3");

  assert.deepEqual(triggerCalls, [
    {
      cardId: "steering_wheel_heater_changed",
      tokens: { steering_wheel_heater: "3" },
    },
  ]);
});

test("update() fires allow_export_changed with the new value", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    allow_export: "battery_ok",
  });

  await stub.update("allow_export", "pv_only");

  assert.deepEqual(triggerCalls, [
    { cardId: "allow_export_changed", tokens: { allow_export: "pv_only" } },
  ]);
});

test("update() fires operation_mode_changed with the new value", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    operation_mode: "self_consumption",
  });

  await stub.update("operation_mode", "backup");

  assert.deepEqual(triggerCalls, [
    { cardId: "operation_mode_changed", tokens: { operation_mode: "backup" } },
  ]);
});

test("update() does not fire allow_export_changed or operation_mode_changed when unchanged", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    allow_export: "battery_ok",
    operation_mode: "self_consumption",
  });

  await stub.update("allow_export", "battery_ok");
  await stub.update("operation_mode", "self_consumption");

  assert.deepEqual(triggerCalls, []);
});

test("update() does not fire a trigger card for capabilities with no declared *_changed card", async () => {
  const { stub, triggerCalls } = createDeviceStub({ measure_battery: 50 });

  await stub.update("measure_battery", 60);

  assert.deepEqual(triggerCalls, []);
});

test("update() does not fire a trigger after the device is removed during the capability write", async () => {
  let resolveWrite!: () => void;
  const pendingWrite = new Promise<void>((resolve) => {
    resolveWrite = resolve;
  });
  const { stub, triggerCalls } = createDeviceStub({ backup_reserve: 0.2 });
  stub.setCapabilityValue = async () => pendingWrite;

  const updatePromise = stub.update("backup_reserve", 0.35);
  await stub.onUninit();
  resolveWrite();
  await updatePromise;

  assert.deepEqual(triggerCalls, []);
});

test("update() does not fire a trigger when a write settles after the SDK removes the device from the driver map but before onUninit() runs", async () => {
  // Models the actual Apps SDK v3 deletion order (map removal, then
  // _onDeleted()/onUninit()), not a direct early onUninit() call - see
  // device-liveness.test.ts. destroyed is still false in this gap.
  let resolveWrite!: () => void;
  const pendingWrite = new Promise<void>((resolve) => {
    resolveWrite = resolve;
  });
  const { stub, triggerCalls } = createDeviceStub({ backup_reserve: 0.2 });
  stub.setCapabilityValue = async () => pendingWrite;

  const updatePromise = stub.update("backup_reserve", 0.35);
  stub.driver.getDevices = () => [];
  resolveWrite();
  await updatePromise;

  assert.equal(stub.destroyed, false);
  assert.deepEqual(triggerCalls, []);
});

test("update() logs a rejected capability write and does not fire a trigger", async () => {
  const writeError = new Error("Not Found: Device with ID powerwall-1");
  const loggedErrors: unknown[][] = [];
  const { stub, triggerCalls } = createDeviceStub({ backup_reserve: 0.2 });
  stub.setCapabilityValue = async () => {
    throw writeError;
  };
  stub.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };

  await stub.update("backup_reserve", 0.35);

  assert.deepEqual(loggedErrors, [[writeError]]);
  assert.deepEqual(triggerCalls, []);
});
