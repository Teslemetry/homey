import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import WallConnecter from "../.homeybuild/drivers/wall-connector/device.js";

function createDeviceStub(capabilities: Record<string, unknown>) {
  const triggerCalls: Array<{ cardId: string; tokens: unknown }> = [];
  const handlers: Record<string, (event: unknown) => void> = {};
  const site = {
    sse: {
      on: (event: string, handler: (event: unknown) => void) => {
        handlers[event] = handler;
      },
      off: () => {},
    },
    api: {
      on: () => {},
      off: () => {},
      requestPolling: () => () => {},
    },
  };

  const stub = Object.assign(Object.create(WallConnecter.prototype), {
    homey: {
      app: { products: { energySites: { "site-1": site }, vehicles: {} } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: (cardId: string) => ({
          trigger: async (_device: unknown, tokens: unknown) => {
            triggerCalls.push({ cardId, tokens });
          },
        }),
      },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
    },
    getData: () => ({ site: "site-1", din: "din-1" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    log: () => {},
    error: () => {},
    destroyed: false,
  });

  return { stub, capabilities, handlers, triggerCalls };
}

test("a nonzero wall_connector_fault_state raises alarm_generic.fault and fires the fault-code trigger", async () => {
  const { stub, handlers, capabilities, triggerCalls } = createDeviceStub({
    "alarm_generic.fault": undefined,
    measure_power: undefined,
    evcharger_charging_state: undefined,
    connected_vehicle: undefined,
  });
  await stub.onInit();

  handlers["live_status"]({
    live_status: {
      wall_connectors: [
        {
          din: "din-1",
          wall_connector_state: 1,
          wall_connector_fault_state: 3,
          wall_connector_power: 0,
        },
      ],
    },
  });

  assert.equal(capabilities["alarm_generic.fault"], true);
  assert.deepEqual(
    triggerCalls.filter((c) => c.cardId === "wall_connector_fault_code"),
    [{ cardId: "wall_connector_fault_code", tokens: { code: 3 } }],
  );
});

test("wall_connector_fault_state returning to 0 clears alarm_generic.fault", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    "alarm_generic.fault": undefined,
    measure_power: undefined,
    evcharger_charging_state: undefined,
    connected_vehicle: undefined,
  });
  await stub.onInit();

  handlers["live_status"]({
    live_status: {
      wall_connectors: [
        {
          din: "din-1",
          wall_connector_state: 1,
          wall_connector_fault_state: 3,
          wall_connector_power: 0,
        },
      ],
    },
  });
  handlers["live_status"]({
    live_status: {
      wall_connectors: [
        {
          din: "din-1",
          wall_connector_state: 1,
          wall_connector_fault_state: 0,
          wall_connector_power: 0,
        },
      ],
    },
  });

  assert.equal(capabilities["alarm_generic.fault"], false);
});

test("an unchanged fault code does not re-fire the fault-code trigger", async () => {
  const { stub, handlers, triggerCalls } = createDeviceStub({
    "alarm_generic.fault": undefined,
    measure_power: undefined,
    evcharger_charging_state: undefined,
    connected_vehicle: undefined,
  });
  await stub.onInit();

  const event = {
    live_status: {
      wall_connectors: [
        {
          din: "din-1",
          wall_connector_state: 1,
          wall_connector_fault_state: 3,
          wall_connector_power: 0,
        },
      ],
    },
  };
  handlers["live_status"](event);
  handlers["live_status"](event);

  assert.equal(
    triggerCalls.filter((c) => c.cardId === "wall_connector_fault_code").length,
    1,
  );
});
