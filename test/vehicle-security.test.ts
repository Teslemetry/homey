import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

function createDeviceStub({
  initialVehicleState = null,
}: {
  initialVehicleState?: string | null;
} = {}) {
  const capabilities: Record<string, unknown> = {
    vehicle_state: initialVehicleState,
    "alarm_generic.pin_to_drive": null,
    "alarm_generic.valet_mode": null,
  };
  const triggerCalls: string[] = [];
  let currentCardId = "";
  const flowCardStub = {
    trigger: async () => {
      triggerCalls.push(currentCardId);
    },
  };

  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      flow: {
        getDeviceTriggerCard: (cardId: string) => {
          currentCardId = cardId;
          return flowCardStub;
        },
      },
    },
    driver: { getDevices: () => [] as unknown[] },
    getName: () => "Test Vehicle",
    log: () => {},
    error: () => {},
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
  });
  stub.driver.getDevices = () => [stub];
  return { stub, capabilities, triggerCalls };
}

// --- handleVehicleState (woke/slept) ---

test("no trigger fires on the first vehicle_state signal ever received", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub();

  (stub as any).handleVehicleState({ state: "online" });

  assert.equal(capabilities.vehicle_state, "online");
  assert.deepEqual(triggerCalls, []);
});

test("vehicle_woke_up fires when the vehicle transitions from asleep to online", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub({
    initialVehicleState: "asleep",
  });
  (stub as any).handleVehicleState({ state: "asleep" });
  triggerCalls.length = 0;

  (stub as any).handleVehicleState({ state: "online" });

  assert.equal(capabilities.vehicle_state, "online");
  assert.deepEqual(triggerCalls, ["vehicle_woke_up"]);
});

test("vehicle_woke_up fires when the vehicle transitions from asleep to offline (state exited, not entered, decides the trigger)", () => {
  const { stub, triggerCalls } = createDeviceStub({
    initialVehicleState: "asleep",
  });
  (stub as any).handleVehicleState({ state: "asleep" });
  triggerCalls.length = 0;

  (stub as any).handleVehicleState({ state: "offline" });

  assert.deepEqual(triggerCalls, ["vehicle_woke_up"]);
});

test("vehicle_went_to_sleep fires when the vehicle transitions from online to asleep", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub({
    initialVehicleState: "online",
  });
  (stub as any).handleVehicleState({ state: "online" });
  triggerCalls.length = 0;

  (stub as any).handleVehicleState({ state: "asleep" });

  assert.equal(capabilities.vehicle_state, "asleep");
  assert.deepEqual(triggerCalls, ["vehicle_went_to_sleep"]);
});

test("no wake/sleep trigger fires for an online <-> offline transition", () => {
  const { stub, triggerCalls } = createDeviceStub({
    initialVehicleState: "online",
  });
  (stub as any).handleVehicleState({ state: "online" });
  triggerCalls.length = 0;

  (stub as any).handleVehicleState({ state: "offline" });
  (stub as any).handleVehicleState({ state: "online" });

  assert.deepEqual(triggerCalls, []);
});

test("no trigger re-fires while vehicle_state stays asleep", () => {
  const { stub, triggerCalls } = createDeviceStub({
    initialVehicleState: "online",
  });
  (stub as any).handleVehicleState({ state: "asleep" });
  triggerCalls.length = 0;

  (stub as any).handleVehicleState({ state: "asleep" });

  assert.deepEqual(triggerCalls, []);
});

test("a missing state field is ignored without throwing or updating the capability", () => {
  const { stub, capabilities, triggerCalls } = createDeviceStub({
    initialVehicleState: "online",
  });

  assert.doesNotThrow(() => (stub as any).handleVehicleState({}));
  assert.doesNotThrow(() => (stub as any).handleVehicleState(undefined));

  assert.equal(capabilities.vehicle_state, "online");
  assert.deepEqual(triggerCalls, []);
});

// --- PinToDriveEnabled / ValetModeEnabled signal mapping ---
// Both are plain onSignal() mappings straight onto their alarm_generic
// subcapability - Homey auto-fires their _true/_false/condition cards, so
// there's no explicit triggerFlow() call to test here.

test("registerSignalListeners maps PinToDriveEnabled/ValetModeEnabled onto their alarm_generic subcapabilities", () => {
  const { capabilities } = createDeviceStub();
  const handlers: Record<string, (value: unknown) => void> = {};
  const stub = Object.assign(new VehicleDevice(), {
    onSignal: (field: string, callback: (value: unknown) => void) => {
      handlers[field] = callback;
    },
    update: (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    vehicle: {
      sse: { cache: { data: {} } },
      metadata: { config: { rhd: false } },
    },
  });

  (stub as any).registerSignalListeners();
  handlers["PinToDriveEnabled"](true);
  handlers["ValetModeEnabled"](true);

  assert.equal(capabilities["alarm_generic.pin_to_drive"], true);
  assert.equal(capabilities["alarm_generic.valet_mode"], true);

  handlers["PinToDriveEnabled"](null);
  handlers["ValetModeEnabled"](undefined);

  assert.equal(
    capabilities["alarm_generic.pin_to_drive"],
    true,
    "a null reading must not overwrite the last-known value",
  );
  assert.equal(
    capabilities["alarm_generic.valet_mode"],
    true,
    "an undefined reading must not overwrite the last-known value",
  );
});
