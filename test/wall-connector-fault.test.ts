import test from "node:test";
import assert from "node:assert/strict";
// The real SDK stream; see test/support/teslemetry-api-stub.js.
import { TeslemetryStream } from "./support/teslemetry-api-stub.js";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import WallConnecter from "../.homeybuild/drivers/wall-connector/device.js";

function createDeviceStub(
  capabilities: Record<string, unknown>,
  store: Record<string, unknown> = {},
) {
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
    metadata: { access: true },
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
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ site: "site-1", din: "din-1" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    getStoreValue: (key: string) => store[key] ?? null,
    setStoreValue: async (key: string, value: unknown) => {
      store[key] = value;
    },
    log: () => {},
    error: () => {},
    destroyed: false,
  });
  stub.driver.getDevices = () => [stub];

  return { stub, capabilities, handlers, triggerCalls };
}

function liveStatus(faultState: number) {
  return {
    live_status: {
      wall_connectors: [
        {
          din: "din-1",
          wall_connector_state: 1,
          wall_connector_fault_state: faultState,
          wall_connector_power: 0,
        },
      ],
    },
  };
}

test("a change to a nonzero wall_connector_fault_state raises alarm_generic.fault and fires the fault-code trigger", async () => {
  const { stub, handlers, capabilities, triggerCalls } = createDeviceStub({
    "alarm_generic.fault": undefined,
    measure_power: undefined,
    evcharger_charging_state: undefined,
    connected_vehicle: undefined,
  });
  await stub.onInit();

  handlers["live_status"](liveStatus(0));
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
  handlers["live_status"](liveStatus(0));
  handlers["live_status"](event);
  handlers["live_status"](event);

  assert.equal(
    triggerCalls.filter((c) => c.cardId === "wall_connector_fault_code").length,
    1,
  );
});

test("the first fault code ever seen sets the alarm but has no baseline to fire the trigger from", async () => {
  const { stub, handlers, capabilities, triggerCalls } = createDeviceStub({
    "alarm_generic.fault": undefined,
  });
  await stub.onInit();

  handlers["live_status"](liveStatus(3));

  assert.equal(capabilities["alarm_generic.fault"], true);
  assert.deepEqual(triggerCalls, []);
});

test("a fault code that changed while the app was down fires the trigger once on restart", async () => {
  const store: Record<string, unknown> = {};
  const before = createDeviceStub({ "alarm_generic.fault": undefined }, store);
  await before.stub.onInit();
  before.handlers["live_status"](liveStatus(0));
  await before.stub.onUninit();

  const after = createDeviceStub({ "alarm_generic.fault": false }, store);
  await after.stub.onInit();
  after.handlers["live_status"](liveStatus(5));
  after.handlers["live_status"](liveStatus(5));

  assert.equal(after.capabilities["alarm_generic.fault"], true);
  assert.deepEqual(after.triggerCalls, [
    { cardId: "wall_connector_fault_code", tokens: { code: 5 } },
  ]);
});

/**
 * Regression cover for the fault-code trigger re-firing after every app
 * restart. The baseline used to live only in memory, so the live_status the
 * real TeslemetryStream replays from its cache on every site.sse.on()
 * registration counted as a new fault on each fresh device instance. Driven
 * with the captain's real live_status (a healthy, idle Gen 3 Wall Connector
 * reporting wall_connector_fault_state: 2) and a numeric site_id on the wire.
 */
test("a restart's cached live_status replay never fires the fault-code trigger", async () => {
  const SITE_ID = 2533979794926773;
  const DIN = "1529455-02-F--PGT25132049329";
  const logger = { info() {}, error() {}, warn() {}, debug() {} };
  const root: Record<string, unknown> = { logger };
  const stream = new TeslemetryStream(root as never, { cache: true } as never);
  root.sse = stream;
  const site = {
    id: SITE_ID,
    api: { on() {}, off() {}, requestPolling: () => () => {} },
    sse: stream.getEnergySite(String(SITE_ID)),
    metadata: { access: true },
  };
  const store: Record<string, unknown> = {};

  const boot = () => {
    const capabilities: Record<string, unknown> = {
      "alarm_generic.fault": null,
      measure_power: null,
      evcharger_charging_state: null,
      connected_vehicle: null,
    };
    const triggers: Array<{ cardId: string; tokens: unknown }> = [];
    const stub = Object.assign(Object.create(WallConnecter.prototype), {
      pollingCleanup: [],
      homey: {
        app: {
          products: { energySites: { [String(SITE_ID)]: site }, vehicles: {} },
          isReady: () => true,
        },
        __: (key: string) => key,
        flow: {
          getDeviceTriggerCard: (cardId: string) => ({
            trigger: async (_device: unknown, tokens: unknown) => {
              triggers.push({ cardId, tokens });
            },
          }),
        },
      },
      driver: {
        manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
        getDevices: () => [] as unknown[],
      },
      getData: () => ({ site: SITE_ID, din: DIN }),
      getCapabilities: () => Object.keys(capabilities),
      getCapabilityValue: (capability: string) => capabilities[capability],
      setCapabilityValue: async (capability: string, value: unknown) => {
        capabilities[capability] = value;
      },
      getStoreValue: (key: string) => store[key] ?? null,
      setStoreValue: async (key: string, value: unknown) => {
        store[key] = value;
      },
      setAvailable: async () => {},
      setUnavailable: async () => {},
      log: () => {},
      error: () => {},
      destroyed: false,
    });
    stub.driver.getDevices = () => [stub];
    return { stub, capabilities, triggers };
  };

  const first = boot();
  await first.stub.onInit();
  // live_status verbatim from get_energy_live_status.
  stream._dispatch({
    createdAt: "2026-09-30T01:58:58.000Z",
    site_id: SITE_ID,
    live_status: {
      solar_power: 13182,
      percentage_charged: 64.13,
      battery_power: -10858,
      load_power: 1890,
      grid_status: "Active",
      grid_power: -434,
      generator_power: 0,
      wall_connectors: [
        {
          din: DIN,
          wall_connector_state: 2,
          wall_connector_power: 0,
          wall_connector_fault_state: 2,
          ocpp_status: 1,
          powershare_session_state: 1,
        },
      ],
      island_status: "on_grid",
      storm_mode_active: false,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(first.triggers, []);
  await first.stub.onUninit();

  // App restart: a fresh instance whose site.sse.on() replays the cache.
  const second = boot();
  await second.stub.onInit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(second.triggers, []);
});
