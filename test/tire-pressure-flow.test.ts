import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryApp from "../.homeybuild/app.js";

type RunListener = (args: any, state?: any) => Promise<unknown>;

function createAppStub() {
  const conditionListeners: Record<string, RunListener> = {};
  const triggerListeners: Record<string, RunListener> = {};
  const flow = {
    getActionCard: () => ({ registerRunListener: () => {} }),
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
  return { conditionListeners, triggerListeners };
}

const deviceWith = (pressures: Record<string, number | null>) => ({
  getCapabilityValue: (capability: string) =>
    capability in pressures ? pressures[capability] : null,
});

test("tire_pressure_below fires only for the flow whose own threshold the crossing passed", async () => {
  const { triggerListeners } = createAppStub();
  const device = deviceWith({});
  const state = { previous: 2.5, current: 2.1 };

  assert.equal(
    await triggerListeners["tire_pressure_below"]({ device, bar: 2.2 }, state),
    true,
  );
  // 2.5 -> 2.1 never crosses 2.0, so a flow watching 2.0 must not run.
  assert.equal(
    await triggerListeners["tire_pressure_below"]({ device, bar: 2.0 }, state),
    false,
  );
  // Nor may a rise back through the threshold fire the "below" card.
  assert.equal(
    await triggerListeners["tire_pressure_below"](
      { device, bar: 2.2 },
      { previous: 2.1, current: 2.5 },
    ),
    false,
  );
});

test("tire_pressure is true when any single tire is below the threshold", async () => {
  const { conditionListeners } = createAppStub();

  const oneLow = deviceWith({
    "measure_pressure.fl": 2.6,
    "measure_pressure.fr": 2.6,
    "measure_pressure.rl": 2.6,
    "measure_pressure.rr": 2.1,
  });
  assert.equal(await conditionListeners["tire_pressure"]({ device: oneLow, bar: 2.3 }), true);
  assert.equal(await conditionListeners["tire_pressure"]({ device: oneLow, bar: 2.0 }), false);
});

test("tire_pressure ignores tires that have not reported a pressure yet", async () => {
  const { conditionListeners } = createAppStub();

  // An unreported tire is unknown, not low - it must not satisfy the condition.
  const partial = deviceWith({
    "measure_pressure.fl": 2.6,
    "measure_pressure.fr": null,
    "measure_pressure.rl": null,
    "measure_pressure.rr": null,
  });
  assert.equal(
    await conditionListeners["tire_pressure"]({ device: partial, bar: 2.3 }),
    false,
  );
});

test("tire_pressure and tire_pressure_below fail closed on a stale device reference", async () => {
  const { conditionListeners, triggerListeners } = createAppStub();

  assert.equal(
    await conditionListeners["tire_pressure"]({ device: undefined, bar: 2.3 }),
    false,
  );
  assert.equal(
    await triggerListeners["tire_pressure_below"](
      { device: undefined, bar: 2.3 },
      { previous: 2.5, current: 2.1 },
    ),
    false,
  );
});
