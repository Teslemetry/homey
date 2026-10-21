import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryApp from "../.homeybuild/app.js";
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import { configureTeslemetryStub } from "./support/teslemetry-api-stub.js";

/**
 * Issue #98's symptom class: one product's data stops while the SSE stream
 * itself stays healthy (keepalives flow, so no "disconnect" ever arms the
 * stream freshness watchdog). The app's 30 s product-silence sweep marks an
 * energy site unavailable after 5 min and warns on a vehicle after 10 min,
 * and the product's next genuine event reverses either.
 */

const SITE_ID = "1689169815425134";
const VIN = "5YJ3E1EA0PF000001";
const SWEEP_MS = 30_000;
const MINUTE = 60_000;
// 2026-10-21 08:05 UTC.
const START = Date.UTC(2026, 9, 21, 8, 5);

class FakeStream extends EventEmitter {
  connect() {}
  close() {}
}

function createFlowStub() {
  const card = { registerRunListener: () => card, trigger: async () => {} };
  return {
    getActionCard: () => card,
    getConditionCard: () => card,
    getDeviceTriggerCard: () => card,
  };
}

const translate = (key: string, tokens?: { time?: string }) =>
  tokens?.time ? `${key} ${tokens.time}` : key;

function createHarness(t: { after: (fn: () => void) => void }) {
  let now = START;
  const realNow = Date.now;
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });

  const drivers: Record<string, { getDevices: () => unknown[] }> = {};
  const timers: Array<{ id: number; callback: () => void; delay: number }> = [];
  let nextId = 1;
  const logs: string[] = [];
  const app = Object.assign(new TeslemetryApp(), {
    homey: {
      __: translate,
      setTimeout: (callback: () => void, delay: number) => {
        const id = nextId++;
        timers.push({ id, callback, delay });
        return id;
      },
      clearTimeout: (id: number) => {
        const index = timers.findIndex((timer) => timer.id === id);
        if (index !== -1) timers.splice(index, 1);
      },
      drivers: { getDrivers: () => drivers },
      flow: createFlowStub(),
      settings: {
        get: () => ({
          access_token: "fake-access",
          refresh_token: "fake-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          expires_at: START + 3600_000,
        }),
        set: () => {},
        unset: () => {},
      },
    },
    log: (...args: unknown[]) => logs.push(args.join(" ")),
    error: () => {},
  });

  /** Advances the clock, running every sweep that comes due on the way. */
  const advance = (ms: number) => {
    const end = now + ms;
    while (now + SWEEP_MS <= end) {
      now += SWEEP_MS;
      const sweep = timers.find((timer) => timer.delay === SWEEP_MS);
      assert.ok(sweep, "a product-silence sweep is scheduled");
      timers.splice(timers.indexOf(sweep), 1);
      sweep.callback();
    }
    now = end;
  };
  return { app, drivers, timers, logs, advance };
}

function createDeviceHomey(app: InstanceType<typeof TeslemetryApp>) {
  return {
    app,
    __: translate,
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay).unref(),
    clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
    clock: { getTimezone: () => "UTC" },
    flow: createFlowStub(),
  };
}

function createAvailabilityRecorder() {
  const state = { available: true, message: null as string | null, warning: null as string | null };
  return {
    state,
    setAvailable: async () => {
      state.available = true;
      state.message = null;
    },
    setUnavailable: async (message: string) => {
      state.available = false;
      state.message = message;
    },
    setWarning: async (message: string) => {
      state.warning = message;
    },
    unsetWarning: async () => {
      state.warning = null;
    },
  };
}

async function setupPowerwall(t: { after: (fn: () => void) => void }) {
  const harness = createHarness(t);
  const recorder = createAvailabilityRecorder();
  const capabilities: Record<string, unknown> = { measure_battery: undefined };
  const device = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: createDeviceHomey(harness.app),
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [device],
    },
    getData: () => ({ id: SITE_ID }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: () => {},
    getStoreValue: () => null,
    setStoreValue: async () => {},
    ...recorder,
    log: () => {},
    error: () => {},
  });
  harness.drivers.battery = { getDevices: () => [device] };

  const site = {
    id: Number(SITE_ID),
    name: "Powerwall",
    api: new Proxy({}, { get: () => () => Promise.resolve() }),
    sse: new EventEmitter(),
    metadata: { access: true },
  };
  let sdk: { sse: FakeStream } | undefined;
  configureTeslemetryStub(() => {
    sdk = { sse: new FakeStream() };
    return { ...sdk, createProducts: async () => ({ vehicles: {}, energySites: { [SITE_ID]: site } }) };
  });

  await harness.app.onInit();
  await device.onInit();
  const emitLive = () => sdk!.sse.emit("live_status", { site_id: Number(SITE_ID) });
  return { ...harness, state: recorder.state, sdk: () => sdk!, emitLive };
}

async function setupVehicle(t: { after: (fn: () => void) => void }) {
  const harness = createHarness(t);
  const recorder = createAvailabilityRecorder();
  const vehicle = {
    vin: VIN,
    sse: { cache: { data: {} }, on: () => {}, off: () => {}, onSignal: () => () => {} },
    api: new Proxy({}, { get: () => async () => ({ response: { result: true } }) }),
    metadata: {
      access: true,
      fleet_telemetry: "fleet_telemetry_config_id",
      polling: false,
      config: { can_actuate_trunks: false },
    },
  };
  const capabilities: Record<string, unknown> = { vehicle_state: undefined };
  const device = Object.assign(new VehicleDevice(), {
    homey: createDeviceHomey(harness.app),
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [device],
    },
    getData: () => ({ vin: VIN }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: () => {},
    getStoreValue: () => null,
    ...recorder,
    log: () => {},
    error: () => {},
  });
  harness.drivers.vehicle = { getDevices: () => [device] };

  let sdk: { sse: FakeStream } | undefined;
  configureTeslemetryStub(() => {
    sdk = { sse: new FakeStream() };
    return { ...sdk, createProducts: async () => ({ vehicles: { [VIN]: vehicle }, energySites: {} }) };
  });

  await harness.app.onInit();
  await device.onInit();
  const emitState = () => sdk!.sse.emit("state", { vin: VIN });
  return { ...harness, state: recorder.state, emitState };
}

const silenceLogs = (logs: string[], what: string) =>
  logs.filter((line) => line.startsWith("Product silence:") && line.includes(what));

test("an energy site silent for 5 min on a healthy stream goes unavailable, and its next genuine event restores it", async (t) => {
  const { state, logs, advance, emitLive } = await setupPowerwall(t);

  emitLive();
  advance(4 * MINUTE + 30_000);
  assert.equal(state.available, true, "still inside the 5 min threshold");

  advance(SWEEP_MS);
  assert.equal(state.available, false);
  assert.equal(state.message, "error.product_silent");
  assert.equal(silenceLogs(logs, "no genuine data").length, 1, "the transition is logged");

  advance(10 * MINUTE);
  assert.equal(silenceLogs(logs, "no genuine data").length, 1, "a continuing silence is logged once");

  emitLive();
  assert.equal(state.available, true, "data resumed");
  assert.equal(silenceLogs(logs, "genuine data again").length, 1, "the recovery is logged");

  emitLive();
  assert.equal(silenceLogs(logs, "genuine data again").length, 1, "the recovery is logged once");
});

test("an energy site that never sends live data is measured from when the generation was published", async (t) => {
  const { state, advance } = await setupPowerwall(t);

  advance(4 * MINUTE);
  assert.equal(state.available, true);
  advance(MINUTE);
  assert.equal(state.available, false);
  assert.equal(state.message, "error.product_silent");
});

test("a cached replay does not count as data for the silence check", async (t) => {
  const { state, advance, sdk } = await setupPowerwall(t);

  advance(5 * MINUTE);
  assert.equal(state.available, false);
  sdk().sse.emit("live_status", { site_id: Number(SITE_ID), isCache: true });
  assert.equal(state.available, false);
});

test("a dropped stream keeps its own message instead of the silence one", async (t) => {
  const { state, advance, sdk, emitLive, timers } = await setupPowerwall(t);

  emitLive();
  advance(MINUTE);
  sdk().sse.emit("disconnect");
  advance(4 * MINUTE + 30_000);
  assert.equal(state.available, true, "the disconnect grace period is still pending");

  timers.find((timer) => timer.delay === 150_000)!.callback();
  assert.equal(state.message, "error.stream_disconnected");
  advance(5 * MINUTE);
  assert.equal(state.message, "error.stream_disconnected", "silence never overwrites another reason");
});

test("a vehicle silent for 10 min stays available with a 'No data since' warning, cleared by its next genuine event", async (t) => {
  const { state, logs, advance, emitState } = await setupVehicle(t);

  emitState();
  advance(9 * MINUTE + 30_000);
  assert.equal(state.warning, null, "still inside the 10 min threshold");

  advance(SWEEP_MS);
  assert.equal(state.available, true, "a silent vehicle is never marked unavailable");
  assert.equal(state.warning, "warning.no_data_since 08:05");
  assert.equal(silenceLogs(logs, "no genuine data").length, 1);

  advance(30 * MINUTE);
  assert.equal(state.warning, "warning.no_data_since 08:05", "the warning keeps the last data time");
  assert.equal(silenceLogs(logs, "no genuine data").length, 1);

  emitState();
  assert.equal(state.warning, null, "data resumed");
  assert.equal(silenceLogs(logs, "genuine data again").length, 1);
});

test("credential teardown stops the silence sweep", async (t) => {
  const { app, timers, advance } = await setupPowerwall(t);

  advance(MINUTE);
  app.disconnectAccount();
  assert.equal(
    timers.filter((timer) => timer.delay === SWEEP_MS).length,
    0,
    "no sweep left scheduled after teardown",
  );
});
