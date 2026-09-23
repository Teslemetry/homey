import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryApp from "../.homeybuild/app.js";
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import { configureTeslemetryStub } from "./support/teslemetry-api-stub.js";

/**
 * The customer's diagnostic log (issue #98) showed a socket-level SSE drop
 * ("terminated" / "other side closed", Cloudflare) recurring every 1-2.5h -
 * a distinct failure mode from the token-refresh rebuild PR #97 fixed (see
 * token-refresh-reinit.test.ts). The SDK's own `TeslemetryStream._connectLoop`
 * handles that kind of drop internally: it emits "disconnect", retries with
 * backoff, and on success keeps dispatching through the exact same
 * `vehicles`/`energySites` Maps and per-product EventEmitters it already
 * had - `initializeTeslemetry()`/`rebindProduct()` are never called, so
 * there is no new generation and no per-product listener to re-register.
 *
 * These prove that a bare stream disconnect+reconnect, with no rebuild at
 * all, never leaves a live subscription silently orphaned for either
 * product type - closing out the "vehicles survive, energy dies" asymmetry
 * reported in #98 for this specific path.
 */

const SITE_ID = "1689169815425134";
const VIN = "5YJ3E1EA0PF000001";

/** Mirrors TeslemetryStream: an EventEmitter with connect()/close(). */
class FakeStream extends EventEmitter {
  connected = false;
  closed = false;
  connect() {
    this.connected = true;
  }
  close() {
    this.closed = true;
  }
}

function createFlowStub() {
  const card = { registerRunListener: () => card, trigger: async () => {} };
  return {
    getActionCard: () => card,
    getConditionCard: () => card,
    getDeviceTriggerCard: () => card,
  };
}

function createApp() {
  const drivers: Record<string, { getDevices: () => unknown[] }> = {};
  const app = Object.assign(new TeslemetryApp(), {
    homey: {
      __: (key: string) => key,
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
      drivers: { getDrivers: () => drivers },
      flow: createFlowStub(),
      settings: {
        get: () => ({
          access_token: "fake-access",
          refresh_token: "fake-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          expires_at: Date.now() + 3600_000,
        }),
        set: () => {},
        unset: () => {},
      },
    },
    log: () => {},
    error: () => {},
  });
  return { app, drivers };
}

function createPowerwallDevice(app: InstanceType<typeof TeslemetryApp>) {
  const capabilities: Record<string, unknown> = { measure_battery: undefined };
  const device = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app,
      __: (key: string) => key,
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
      flow: createFlowStub(),
    },
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
    setAvailable: async () => {},
    setUnavailable: async () => {},
    log: () => {},
    error: () => {},
  });
  return { device, capabilities };
}

function createFakeVehicle() {
  const stateEmitter = new EventEmitter();
  return {
    sse: {
      cache: { data: {} },
      on: (event: string, listener: (...args: unknown[]) => void) => {
        if (event === "state") stateEmitter.on("state", listener);
      },
      off: (event: string, listener: (...args: unknown[]) => void) => {
        if (event === "state") stateEmitter.off("state", listener);
      },
      onSignal: () => () => {},
      emitState: (value: unknown) => stateEmitter.emit("state", value),
    },
    api: new Proxy({}, { get: () => async () => ({ response: { result: true } }) }),
    metadata: {
      access: true,
      fleet_telemetry: "fleet_telemetry_config_id",
      polling: false,
      config: { can_actuate_trunks: false },
    },
  };
}

function createVehicleDevice(app: InstanceType<typeof TeslemetryApp>, vehicle: ReturnType<typeof createFakeVehicle>) {
  const capabilities: Record<string, unknown> = { vehicle_state: undefined };
  const device = Object.assign(new VehicleDevice(), {
    homey: {
      app,
      __: (key: string) => key,
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
      flow: createFlowStub(),
    },
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
    setAvailable: async () => {},
    setUnavailable: async () => {},
    log: () => {},
    error: () => {},
  });
  app.products = { ...app.products, vehicles: { [VIN]: vehicle } } as never;
  return { device, capabilities };
}

test("PowerwallDevice keeps receiving live updates after a bare SSE disconnect/reconnect with no Products rebuild", async () => {
  const { app, drivers } = createApp();
  const { device, capabilities } = createPowerwallDevice(app);
  drivers.battery = { getDevices: () => [device] };

  const siteStream = new EventEmitter();
  const site = {
    id: Number(SITE_ID),
    name: "Powerwall",
    api: new Proxy({}, { get: () => () => Promise.resolve() }),
    sse: siteStream,
    metadata: { access: true },
  };
  let sdk: { sse: FakeStream } | undefined;
  configureTeslemetryStub(() => {
    sdk = { sse: new FakeStream() };
    return { ...sdk, createProducts: async () => ({ vehicles: {}, energySites: { [SITE_ID]: site } }) };
  });

  await app.onInit();
  await device.onInit();

  siteStream.emit("live_status", { live_status: { percentage_charged: 40 } });
  assert.equal(capabilities.measure_battery, 40, "live before the drop");

  // The socket-level drop the customer's log showed: the SDK's own
  // `_connectLoop` emits "disconnect" and reconnects internally - no
  // generation rebuild, no rebindProduct() call.
  sdk!.sse.emit("disconnect");
  sdk!.sse.emit("connect");

  siteStream.emit("live_status", { live_status: { percentage_charged: 55 } });
  assert.equal(
    capabilities.measure_battery,
    55,
    "still subscribed to the same site stream after a bare disconnect/reconnect",
  );
});

test("VehicleDevice keeps receiving live updates after a bare SSE disconnect/reconnect with no Products rebuild", async () => {
  const { app, drivers } = createApp();
  const vehicle = createFakeVehicle();
  const { device, capabilities } = createVehicleDevice(app, vehicle);
  drivers.vehicle = { getDevices: () => [device] };

  let sdk: { sse: FakeStream } | undefined;
  configureTeslemetryStub(() => {
    sdk = { sse: new FakeStream() };
    return { ...sdk, createProducts: async () => ({ vehicles: { [VIN]: vehicle }, energySites: {} }) };
  });

  await app.onInit();
  await device.onInit();

  vehicle.sse.emitState({ state: "online" });
  assert.equal(capabilities.vehicle_state, "online", "live before the drop");

  sdk!.sse.emit("disconnect");
  sdk!.sse.emit("connect");

  vehicle.sse.emitState({ state: "asleep" });
  assert.equal(
    capabilities.vehicle_state,
    "asleep",
    "still subscribed to the same vehicle stream after a bare disconnect/reconnect",
  );
});
