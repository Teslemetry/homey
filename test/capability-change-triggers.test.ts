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

test("update() fires off_grid_vehicle_charging_reserve_changed with the new reserve", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    off_grid_vehicle_charging_reserve: 0.2,
  });

  await stub.update("off_grid_vehicle_charging_reserve", 0.4);

  assert.deepEqual(triggerCalls, [
    {
      cardId: "off_grid_vehicle_charging_reserve_changed",
      tokens: { off_grid_vehicle_charging_reserve: 0.4 },
    },
  ]);
});

test("update() does not fire the trigger card when the value is unchanged", async () => {
  const { stub, triggerCalls } = createDeviceStub({ backup_reserve: 0.2 });

  await stub.update("backup_reserve", 0.2);

  assert.deepEqual(triggerCalls, []);
});

test("update() does not fire the trigger card on the first-ever reading (no prior value)", async () => {
  const { stub, triggerCalls } = createDeviceStub({ backup_reserve: null });

  await stub.update("backup_reserve", 0.35);

  assert.equal(stub.getCapabilityValue("backup_reserve"), 0.35);
  assert.deepEqual(triggerCalls, []);
});

test("update() does not fire the trigger card when the persisted value is unchanged across a restart", async () => {
  // getCapabilityValue reads Homey's persisted value, which survives an app
  // restart - an in-memory baseline would instead read undefined here and
  // spuriously treat this as a change.
  const { stub, triggerCalls } = createDeviceStub({ operation_mode: "backup" });

  await stub.update("operation_mode", "backup");

  assert.deepEqual(triggerCalls, []);
});

test("update() fires the trigger card when a persisted prior value genuinely changes", async () => {
  const { stub, triggerCalls } = createDeviceStub({ operation_mode: "backup" });

  await stub.update("operation_mode", "self_consumption");

  assert.deepEqual(triggerCalls, [
    {
      cardId: "operation_mode_changed",
      tokens: { operation_mode: "self_consumption" },
    },
  ]);
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

test("update() fires powershare_status_changed with the new value", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    powershare_status: "inactive",
  });

  await stub.update("powershare_status", "enabled");

  assert.deepEqual(triggerCalls, [
    { cardId: "powershare_status_changed", tokens: { powershare_status: "enabled" } },
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

test("update() clears grid_buy_rate to null without firing the numeric changed trigger", async () => {
  const { stub, triggerCalls } = createDeviceStub({ grid_buy_rate: 0.25 });

  await stub.update("grid_buy_rate", null);

  assert.equal(stub.getCapabilityValue("grid_buy_rate"), null);
  assert.deepEqual(triggerCalls, []);
});

test("update() still fires grid_sell_rate_changed for a real numeric change", async () => {
  const { stub, triggerCalls } = createDeviceStub({ grid_sell_rate: 0.1 });

  await stub.update("grid_sell_rate", 0.2);

  assert.deepEqual(triggerCalls, [
    { cardId: "grid_sell_rate_changed", tokens: { grid_sell_rate: 0.2 } },
  ]);
});

test("update() does not fire backup_reserve_changed with a non-finite numeric value", async () => {
  const { stub, triggerCalls } = createDeviceStub({ backup_reserve: 0.2 });

  await stub.update("backup_reserve", NaN);

  assert.equal(Number.isNaN(stub.getCapabilityValue("backup_reserve") as number), true);
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

test("update() fires gear_changed with the new gear on a real transition", async () => {
  const { stub, triggerCalls } = createDeviceStub({ gear: "P" });

  await stub.update("gear", "D");

  assert.deepEqual(triggerCalls, [
    { cardId: "gear_changed", tokens: { gear: "D" } },
  ]);
});

// --- Tier 3 capabilities: cheap <capability>_changed triggers, no
// threshold plumbing. Booleans and strings carry their value straight
// through as the token; charging_amps is numeric, so it also lives in
// NUMERIC_CHANGE_TRIGGER_CAPABILITIES and must suppress a non-finite token.

test("update() fires the connectivity/occupancy/destination changed triggers with their new value", async () => {
  for (const [capability, previous, next] of [
    ["wifi_connected", true, false],
    ["cellular_connected", false, true],
    ["driver_seat_occupied", false, true],
    ["connected_vehicle", "disconnected", "Model 3"],
    ["navigation_destination", "Home", "Work"],
    ["charging_amps", 16, 32],
  ] as Array<[string, unknown, unknown]>) {
    const { stub, triggerCalls } = createDeviceStub({ [capability]: previous });

    await stub.update(capability, next);

    assert.deepEqual(
      triggerCalls,
      [{ cardId: `${capability}_changed`, tokens: { [capability]: next } }],
      `${capability} did not fire its changed trigger`,
    );
  }
});

test("update() does not fire the new changed triggers on a first reading or an unchanged value", async () => {
  for (const capability of [
    "wifi_connected",
    "cellular_connected",
    "driver_seat_occupied",
    "connected_vehicle",
    "navigation_destination",
    "charging_amps",
  ]) {
    const first = createDeviceStub({ [capability]: null });
    await first.stub.update(capability, false);
    assert.deepEqual(first.triggerCalls, [], `${capability} fired on a baseline`);

    const same = createDeviceStub({ [capability]: "x" });
    await same.stub.update(capability, "x");
    assert.deepEqual(same.triggerCalls, [], `${capability} fired when unchanged`);
  }
});

test("update() writes charging_amps but suppresses its numeric trigger for a non-finite value", async () => {
  const { stub, triggerCalls } = createDeviceStub({ charging_amps: 16 });

  await stub.update("charging_amps", Number.NaN);

  assert.ok(Number.isNaN(stub.getCapabilityValue("charging_amps") as number));
  assert.deepEqual(triggerCalls, []);
});

test("update() clears navigation_destination to an empty string and fires the change", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    navigation_destination: "Work",
  });

  // VehicleDevice maps a cleared destination to "" - a real, meaningful
  // transition ("navigation ended"), not a suppressed null.
  await stub.update("navigation_destination", "");

  assert.deepEqual(triggerCalls, [
    {
      cardId: "navigation_destination_changed",
      tokens: { navigation_destination: "" },
    },
  ]);
});
