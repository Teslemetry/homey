import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

function createDeviceStub(capabilities: Record<string, unknown> = {}) {
  const triggerCalls: Array<{
    cardId: string;
    tokens: unknown;
    state: unknown;
  }> = [];
  const apiCalls: Array<{ method: string; args: unknown[] }> = [];
  let currentCardId = "";
  const flowCardStub = {
    trigger: async (_device: unknown, tokens: unknown, state?: unknown) => {
      triggerCalls.push({ cardId: currentCardId, tokens, state });
    },
  };
  const recordApiCall =
    (method: string) =>
    (...args: unknown[]) => {
      apiCalls.push({ method, args });
      return Promise.resolve({ response: { result: true } });
    };

  const stub = Object.assign(Object.create(VehicleDevice.prototype), {
    homey: {
      flow: {
        getDeviceTriggerCard: (cardId: string) => {
          currentCardId = cardId;
          return flowCardStub;
        },
      },
    },
    vehicle: {
      api: {
        startCharging: recordApiCall("startCharging"),
        stopCharging: recordApiCall("stopCharging"),
        setChargeLimit: recordApiCall("setChargeLimit"),
        setChargingAmps: recordApiCall("setChargingAmps"),
        navigationRequest: recordApiCall("navigationRequest"),
        setTemps: recordApiCall("setTemps"),
        stopAutoConditioning: recordApiCall("stopAutoConditioning"),
        startAutoConditioning: recordApiCall("startAutoConditioning"),
        setPreconditioningMax: recordApiCall("setPreconditioningMax"),
        setClimateKeeperMode: recordApiCall("setClimateKeeperMode"),
        setSeatHeater: recordApiCall("setSeatHeater"),
        setSeatCooler: recordApiCall("setSeatCooler"),
      },
      sse: { cache: { data: {} } },
    },
    getName: () => "Test Vehicle",
    log: () => {},
    error: () => {},
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
  });
  return { stub, triggerCalls, apiCalls, capabilities };
}

// --- charging_started ---

test("charging started fires when DetailedChargeState transitions into an active state", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    evcharger_charging: false,
  });
  (stub as any).handleDetailedChargeState("DetailedChargeStateNoPower");
  triggerCalls.length = 0;

  (stub as any).handleDetailedChargeState("DetailedChargeStateCharging");

  assert.deepEqual(
    triggerCalls.map((c) => c.cardId),
    ["charging_started"],
  );
});

test("charging started does not fire when the state is unchanged", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    evcharger_charging: false,
  });
  (stub as any).handleDetailedChargeState("DetailedChargeStateCharging");
  triggerCalls.length = 0;

  (stub as any).handleDetailedChargeState("DetailedChargeStateCharging");

  assert.deepEqual(triggerCalls, []);
});

test("no trigger fires on the first DetailedChargeState signal ever received", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    evcharger_charging: false,
  });

  (stub as any).handleDetailedChargeState("DetailedChargeStateCharging");

  assert.deepEqual(triggerCalls, []);
});

// --- charging_complete ---

test("charging complete fires when DetailedChargeState becomes Complete", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    evcharger_charging: true,
  });
  (stub as any).handleDetailedChargeState("DetailedChargeStateCharging");
  triggerCalls.length = 0;

  (stub as any).handleDetailedChargeState("DetailedChargeStateComplete");

  assert.deepEqual(
    triggerCalls.map((c) => c.cardId),
    ["charging_complete"],
  );
});

test("charging complete does not fire while still charging", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    evcharger_charging: false,
  });
  (stub as any).handleDetailedChargeState("DetailedChargeStateNoPower");
  triggerCalls.length = 0;

  (stub as any).handleDetailedChargeState("DetailedChargeStateCharging");

  assert.ok(!triggerCalls.some((c) => c.cardId === "charging_complete"));
});

// --- charging_stopped ---

test("charging stopped fires when DetailedChargeState becomes Stopped", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    evcharger_charging: true,
  });
  (stub as any).handleDetailedChargeState("DetailedChargeStateCharging");
  triggerCalls.length = 0;

  (stub as any).handleDetailedChargeState("DetailedChargeStateStopped");

  assert.deepEqual(
    triggerCalls.map((c) => c.cardId),
    ["charging_stopped"],
  );
});

test("charging stopped does not fire when charging completes normally", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    evcharger_charging: true,
  });
  (stub as any).handleDetailedChargeState("DetailedChargeStateCharging");
  triggerCalls.length = 0;

  (stub as any).handleDetailedChargeState("DetailedChargeStateComplete");

  assert.ok(!triggerCalls.some((c) => c.cardId === "charging_stopped"));
});

// --- plugged_in / unplugged ---

test("plugged in fires when DetailedChargeState leaves Disconnected", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    evcharger_charging: false,
  });
  (stub as any).handleDetailedChargeState("DetailedChargeStateDisconnected");
  triggerCalls.length = 0;

  (stub as any).handleDetailedChargeState("DetailedChargeStateNoPower");

  assert.deepEqual(
    triggerCalls.map((c) => c.cardId),
    ["plugged_in"],
  );
});

test("plugged in does not fire while already plugged in", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    evcharger_charging: false,
  });
  (stub as any).handleDetailedChargeState("DetailedChargeStateNoPower");
  triggerCalls.length = 0;

  (stub as any).handleDetailedChargeState("DetailedChargeStateCharging");

  assert.ok(!triggerCalls.some((c) => c.cardId === "plugged_in"));
});

test("unplugged fires when DetailedChargeState becomes Disconnected", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    evcharger_charging: true,
  });
  (stub as any).handleDetailedChargeState("DetailedChargeStateCharging");
  triggerCalls.length = 0;

  (stub as any).handleDetailedChargeState("DetailedChargeStateDisconnected");

  assert.deepEqual(
    triggerCalls.map((c) => c.cardId),
    ["unplugged"],
  );
});

test("unplugged does not fire while already disconnected", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    evcharger_charging: false,
  });
  (stub as any).handleDetailedChargeState("DetailedChargeStateDisconnected");
  triggerCalls.length = 0;

  (stub as any).handleDetailedChargeState("DetailedChargeStateDisconnected");

  assert.deepEqual(triggerCalls, []);
});

// --- battery_below ---

test("battery below fires with the previous/current state on every real battery change", async () => {
  const { stub, triggerCalls } = createDeviceStub({ measure_battery: 50 });

  (stub as any).handleBatteryLevel(45);

  assert.deepEqual(
    triggerCalls.filter((c) => c.cardId === "battery_below"),
    [{ cardId: "battery_below", tokens: { battery: 45 }, state: { previous: 50, current: 45 } }],
  );
});

test("battery below does not fire when the battery level is unchanged", async () => {
  const { stub, triggerCalls } = createDeviceStub({ measure_battery: 50 });

  (stub as any).handleBatteryLevel(50);

  assert.deepEqual(triggerCalls, []);
});

test("no trigger fires on the first BatteryLevel signal ever received", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    measure_battery: undefined,
  });

  (stub as any).handleBatteryLevel(50);

  assert.deepEqual(triggerCalls, []);
});

// --- charge_limit_reached ---

test("charge limit reached fires when battery crosses the charge limit", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    measure_battery: 79,
    charge_limit: 0.8,
  });

  (stub as any).handleBatteryLevel(80);

  assert.deepEqual(
    triggerCalls.filter((c) => c.cardId === "charge_limit_reached"),
    [{ cardId: "charge_limit_reached", tokens: { battery: 80 }, state: undefined }],
  );
});

test("charge limit reached does not fire while still below the limit", async () => {
  const { stub, triggerCalls } = createDeviceStub({
    measure_battery: 60,
    charge_limit: 0.8,
  });

  (stub as any).handleBatteryLevel(70);

  assert.ok(!triggerCalls.some((c) => c.cardId === "charge_limit_reached"));
});

// --- is_plugged_in condition ---

test("isPluggedIn reflects the last known DetailedChargeState", async () => {
  const { stub } = createDeviceStub({ evcharger_charging: false });

  assert.equal(stub.isPluggedIn(), false);

  (stub as any).handleDetailedChargeState("DetailedChargeStateNoPower");
  assert.equal(stub.isPluggedIn(), true);

  (stub as any).handleDetailedChargeState("DetailedChargeStateDisconnected");
  assert.equal(stub.isPluggedIn(), false);
});

// --- is_charging condition (backed by the evcharger_charging capability) ---

test("evcharger_charging capability reflects active charging states for the is_charging condition", async () => {
  const { stub, capabilities } = createDeviceStub({
    evcharger_charging: false,
  });

  (stub as any).handleDetailedChargeState("DetailedChargeStateCharging");
  assert.equal(capabilities.evcharger_charging, true);

  (stub as any).handleDetailedChargeState("DetailedChargeStateComplete");
  assert.equal(capabilities.evcharger_charging, false);
});

// --- actions ---

test("flowStartCharging calls the SDK startCharging command", async () => {
  const { stub, apiCalls } = createDeviceStub();

  await stub.flowStartCharging();

  assert.deepEqual(
    apiCalls.map((c) => c.method),
    ["startCharging"],
  );
});

test("flowStopCharging calls the SDK stopCharging command", async () => {
  const { stub, apiCalls } = createDeviceStub();

  await stub.flowStopCharging();

  assert.deepEqual(
    apiCalls.map((c) => c.method),
    ["stopCharging"],
  );
});

test("flowSetChargeLimit calls the SDK setChargeLimit command with a rounded percentage", async () => {
  const { stub, apiCalls } = createDeviceStub();

  await stub.flowSetChargeLimit(80.4);

  assert.deepEqual(apiCalls, [{ method: "setChargeLimit", args: [80] }]);
});

test("flowSetChargingAmps calls the SDK setChargingAmps command", async () => {
  const { stub, apiCalls } = createDeviceStub();

  await stub.flowSetChargingAmps(16);

  assert.deepEqual(apiCalls, [{ method: "setChargingAmps", args: [16] }]);
});

test("flowNavigateToAddress calls the SDK navigationRequest command with the address", async () => {
  const { stub, apiCalls } = createDeviceStub();

  await stub.flowNavigateToAddress("1 Main St");

  assert.deepEqual(apiCalls, [
    { method: "navigationRequest", args: [{ value: "1 Main St" }] },
  ]);
});

test("flowSetCabinTemperature calls the SDK setTemps command with the same driver/passenger temperature", async () => {
  const { stub, apiCalls } = createDeviceStub();

  await stub.flowSetCabinTemperature(21.5);

  assert.deepEqual(apiCalls, [{ method: "setTemps", args: [21.5, 21.5] }]);
});

test("flowSetClimateMode off calls the SDK stopAutoConditioning command", async () => {
  const { stub, apiCalls } = createDeviceStub();

  await stub.flowSetClimateMode("off");

  assert.deepEqual(apiCalls, [{ method: "stopAutoConditioning", args: [] }]);
});

test("flowSetClimateMode dog_mode calls the SDK setClimateKeeperMode command", async () => {
  const { stub, apiCalls } = createDeviceStub();

  await stub.flowSetClimateMode("dog_mode");

  assert.deepEqual(apiCalls, [{ method: "setClimateKeeperMode", args: [2] }]);
});

test("flowSetSeatHeater calls the SDK setSeatHeater command with the seat position and numeric level", async () => {
  const { stub, apiCalls } = createDeviceStub();

  await stub.flowSetSeatHeater("rear_center", "2");

  assert.deepEqual(apiCalls, [
    { method: "setSeatHeater", args: ["rear_center", 2] },
  ]);
});

test("flowSetSeatCooler calls the SDK setSeatCooler command with the seat position and numeric level", async () => {
  const { stub, apiCalls } = createDeviceStub();

  await stub.flowSetSeatCooler("front_left", "3");

  assert.deepEqual(apiCalls, [
    { method: "setSeatCooler", args: ["front_left", 3] },
  ]);
});
