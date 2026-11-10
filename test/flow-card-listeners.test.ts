import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryApp from "../.homeybuild/app.js";

const manifest = JSON.parse(
  readFileSync(new URL("../app.json", import.meta.url), "utf8"),
);

type RunListener = (args: any, state?: any) => Promise<unknown>;

function registerFlowCards() {
  const actions: Record<string, RunListener> = {};
  const conditions: Record<string, RunListener> = {};
  const card = (into: Record<string, RunListener>, id: string) => ({
    registerRunListener: (fn: RunListener) => {
      into[id] = fn;
    },
  });
  const app = Object.assign(Object.create(TeslemetryApp.prototype), {
    manifest,
    homey: {
      __: (key: string) => key,
      flow: {
        getActionCard: (id: string) => card(actions, id),
        getConditionCard: (id: string) => card(conditions, id),
        getDeviceTriggerCard: (id: string) => card({}, id),
      },
    },
    log: () => {},
  }) as unknown as { registerFlowCards(): void };
  app.registerFlowCards();
  return { actions, conditions };
}

/** A device whose capability listener records what a Flow card asked for. */
function fakeDevice(values: Record<string, unknown>) {
  const calls: [string, unknown][] = [];
  return {
    calls,
    getCapabilityValue: (capability: string) => values[capability] ?? null,
    triggerCapabilityListener: async (capability: string, value: unknown) => {
      calls.push([capability, value]);
    },
  };
}

test("every condition and action card in app.json has a run listener", () => {
  const { actions, conditions } = registerFlowCards();
  const ids = (cards: { id: string }[]) => cards.map(({ id }) => id).sort();

  assert.deepEqual(Object.keys(conditions).sort(), ids(manifest.flow.conditions));
  assert.deepEqual(Object.keys(actions).sort(), ids(manifest.flow.actions));
});

test("a subcapability condition reads the capability and fails closed", async () => {
  const { conditions } = registerFlowCards();

  assert.equal(await conditions["onoff.sentry"]({ device: fakeDevice({ "onoff.sentry": true }) }), true);
  assert.equal(await conditions["onoff.sentry"]({ device: fakeDevice({ "onoff.sentry": false }) }), false);
  assert.equal(await conditions["alarm_contact.fl"]({ device: fakeDevice({}) }), false);
  assert.equal(await conditions["alarm_generic.off_grid"]({ device: undefined }), false);
});

test("subcapability actions send the matching value through the capability listener", async () => {
  const { actions } = registerFlowCards();
  const device = fakeDevice({ "onoff.charge_grid": true, "windowcoverings_closed.tonneau": false });

  await actions["onoff.sentry_on"]({ device });
  await actions["onoff.sentry_off"]({ device });
  await actions["onoff.charge_grid_toggle"]({ device });
  await actions["windowcoverings_closed.tonneau_close"]({ device });
  await actions["windowcoverings_closed.sunroof_open"]({ device });
  await actions["windowcoverings_closed.tonneau_toggle"]({ device });

  assert.deepEqual(device.calls, [
    ["onoff.sentry", true],
    ["onoff.sentry", false],
    ["onoff.charge_grid", false],
    ["windowcoverings_closed.tonneau", true],
    ["windowcoverings_closed.sunroof", false],
    ["windowcoverings_closed.tonneau", true],
  ]);
});

test("a subcapability action rejects clearly when its device is gone", async () => {
  const { actions } = registerFlowCards();

  await assert.rejects(
    () => actions["onoff.storm_on"]({ device: undefined }),
    { message: "error.device_removed" },
  );
});

test("a rejected command fails the Flow card", async () => {
  const { actions } = registerFlowCards();
  const device = {
    getCapabilityValue: () => false,
    triggerCapabilityListener: async () => {
      throw new Error("frunk cannot close");
    },
  };

  await assert.rejects(() => actions["onoff.frunk_off"]({ device }), {
    message: "frunk cannot close",
  });
});
