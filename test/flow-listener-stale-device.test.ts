import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryApp from "../.homeybuild/app.js";

type RunListener = (args: any, state?: any) => Promise<unknown>;

function createAppStub() {
  const actionListeners: Record<string, RunListener> = {};
  const conditionListeners: Record<string, RunListener> = {};
  const triggerListeners: Record<string, RunListener> = {};

  const flow = {
    getActionCard: (id: string) => ({
      registerRunListener: (fn: RunListener) => {
        actionListeners[id] = fn;
      },
    }),
    getConditionCard: (id: string) => ({
      registerRunListener: (fn: RunListener) => {
        conditionListeners[id] = fn;
      },
    }),
    getDeviceTriggerCard: (id: string) => ({
      registerRunListener: (fn: RunListener) => {
        triggerListeners[id] = fn;
      },
    }),
  };

  const app = Object.assign(Object.create(TeslemetryApp.prototype), {
    homey: { flow, __: (key: string) => key },
    log: () => {},
  }) as unknown as { registerFlowCards(): void };
  app.registerFlowCards();

  return { app, actionListeners, conditionListeners, triggerListeners };
}

// --- actions: a stale device must reject with a clear, user-actionable error ---

test("an action card rejects with a clear error instead of a silent no-op when the device is a stale/missing runtime reference", async () => {
  const { actionListeners } = createAppStub();

  await assert.rejects(
    () => actionListeners["flash_lights"]({ device: undefined }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "error.device_removed");
      return true;
    },
  );
});

test("every registered action card rejects on a stale device instead of throwing a raw TypeError", async () => {
  const { actionListeners } = createAppStub();

  for (const [id, listener] of Object.entries(actionListeners)) {
    await assert.rejects(
      () => listener({ device: undefined, percentage: 50, level: "1", mode: "backup", amps: 16, address: "x", temperature: 20 }),
      (error: unknown) => error instanceof Error && error.message === "error.device_removed",
      `action card "${id}" did not reject with the stale-device error`,
    );
  }
});

test("an action card proceeds normally when the device is live", async () => {
  const { actionListeners } = createAppStub();
  const calls: string[] = [];
  const device = { flowFlashLights: async () => { calls.push("flowFlashLights"); } };

  await actionListeners["flash_lights"]({ device });

  assert.deepEqual(calls, ["flowFlashLights"]);
});

test("the off-grid vehicle charging reserve action forwards its percentage to the Powerwall", async () => {
  const { actionListeners } = createAppStub();
  const percentages: number[] = [];
  const device = {
    flowSetOffGridVehicleChargingReserve: async (percentage: number) => {
      percentages.push(percentage);
    },
  };

  await actionListeners["set_off_grid_vehicle_charging_reserve"]({
    device,
    percentage: 40,
  });

  assert.deepEqual(percentages, [40]);
});

test("the add_charge_schedule action maps its snake_case args to flowAddChargeSchedule's object arg", async () => {
  const { actionListeners } = createAppStub();
  const calls: unknown[] = [];
  const device = {
    flowAddChargeSchedule: async (args: unknown) => {
      calls.push(args);
    },
  };

  await actionListeners["add_charge_schedule"]({
    device,
    name: "Overnight",
    days_of_week: "Monday",
    enabled: true,
    start_enabled: true,
    start_time: "01:00",
    end_enabled: false,
    end_time: "02:00",
    lat: 1,
    lon: 2,
    one_time: false,
  });

  assert.deepEqual(calls, [
    {
      name: "Overnight",
      daysOfWeek: "Monday",
      enabled: true,
      startEnabled: true,
      startTime: "01:00",
      endEnabled: false,
      endTime: "02:00",
      lat: 1,
      lon: 2,
      oneTime: false,
    },
  ]);
});

test("the add_precondition_schedule action maps its snake_case args to flowAddPreconditionSchedule's object arg", async () => {
  const { actionListeners } = createAppStub();
  const calls: unknown[] = [];
  const device = {
    flowAddPreconditionSchedule: async (args: unknown) => {
      calls.push(args);
    },
  };

  await actionListeners["add_precondition_schedule"]({
    device,
    name: "Warm up",
    days_of_week: "Tuesday",
    enabled: true,
    precondition_time: "08:30",
    lat: 3,
    lon: 4,
    one_time: true,
  });

  assert.deepEqual(calls, [
    {
      name: "Warm up",
      daysOfWeek: "Tuesday",
      enabled: true,
      preconditionTime: "08:30",
      lat: 3,
      lon: 4,
      oneTime: true,
    },
  ]);
});

test("the remove_charge_schedule and remove_precondition_schedule actions forward the schedule id", async () => {
  const { actionListeners } = createAppStub();
  const chargeIds: number[] = [];
  const preconditionIds: number[] = [];
  const device = {
    flowRemoveChargeSchedule: async (id: number) => {
      chargeIds.push(id);
    },
    flowRemovePreconditionSchedule: async (id: number) => {
      preconditionIds.push(id);
    },
  };

  await actionListeners["remove_charge_schedule"]({ device, id: 5 });
  await actionListeners["remove_precondition_schedule"]({ device, id: 6 });

  assert.deepEqual(chargeIds, [5]);
  assert.deepEqual(preconditionIds, [6]);
});

// --- conditions: a stale device must fail closed (false), never true ---

test("a condition card returns false instead of throwing when the device is a stale/missing runtime reference", async () => {
  const { conditionListeners } = createAppStub();

  const result = await conditionListeners["operation_mode_is"]({
    device: undefined,
    mode: "backup",
  });

  assert.equal(result, false);
});

test("every registered condition card returns false on a stale device", async () => {
  const { conditionListeners } = createAppStub();

  for (const [id, listener] of Object.entries(conditionListeners)) {
    const result = await listener({ device: undefined, mode: "backup", percentage: 50, level: "soft" });
    assert.equal(result, false, `condition card "${id}" did not fail closed`);
  }
});

test("a condition card evaluates normally when the device is live", async () => {
  const { conditionListeners } = createAppStub();
  const device = { getCapabilityValue: (cap: string) => (cap === "operation_mode" ? "backup" : undefined) };

  const result = await conditionListeners["operation_mode_is"]({ device, mode: "backup" });

  assert.equal(result, true);
});

test("powershare_status_is matches the Cybertruck's current Powershare status", async () => {
  const { conditionListeners } = createAppStub();
  const device = {
    getCapabilityValue: (cap: string) =>
      cap === "powershare_status" ? "enabled" : undefined,
  };

  assert.equal(
    await conditionListeners["powershare_status_is"]({
      device,
      status: "enabled",
    }),
    true,
  );
  assert.equal(
    await conditionListeners["powershare_status_is"]({
      device,
      status: "stopped",
    }),
    false,
  );
});

test("distance_from_home is true only when the known distance is within the requested radius", async () => {
  const { conditionListeners } = createAppStub();
  const device = {
    getCapabilityValue: (cap: string) =>
      cap === "measure_distance.home" ? 5 : undefined,
  };

  assert.equal(
    await conditionListeners["distance_from_home"]({ device, radius: 10 }),
    true,
  );
  assert.equal(
    await conditionListeners["distance_from_home"]({ device, radius: 1 }),
    false,
  );
});

test("distance_from_home fails closed when the distance is unknown", async () => {
  const { conditionListeners } = createAppStub();
  const device = {
    getCapabilityValue: (cap: string) =>
      cap === "measure_distance.home" ? null : undefined,
  };

  assert.equal(
    await conditionListeners["distance_from_home"]({ device, radius: 1000 }),
    false,
  );
});

// --- device trigger predicates: a stale device must fail closed (false) ---

test("battery_below's trigger predicate returns false instead of throwing when the device is a stale/missing runtime reference", async () => {
  const { triggerListeners } = createAppStub();

  const result = await triggerListeners["battery_below"](
    { device: undefined, percentage: 20 },
    { previous: 25, current: 15 },
  );

  assert.equal(result, false);
});

test("every registered device trigger predicate returns false on a stale device", async () => {
  const { triggerListeners } = createAppStub();

  for (const [id, listener] of Object.entries(triggerListeners)) {
    const result = await listener(
      { device: undefined, percentage: 20, watts: 20, rate: 0.1 },
      { previous: 25, current: 15 },
    );
    assert.equal(result, false, `trigger predicate "${id}" did not fail closed`);
  }
});

test("battery_below's trigger predicate evaluates normally when the device is live", async () => {
  const { triggerListeners } = createAppStub();
  const device = {};

  const result = await triggerListeners["battery_below"](
    { device, percentage: 20 },
    { previous: 25, current: 15 },
  );

  assert.equal(result, true);
});
