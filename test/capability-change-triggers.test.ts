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
    error: () => {},
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
  });
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

test("update() does not fire a trigger card for capabilities with no declared *_changed card", async () => {
  const { stub, triggerCalls } = createDeviceStub({ measure_battery: 50 });

  await stub.update("measure_battery", 60);

  assert.deepEqual(triggerCalls, []);
});
