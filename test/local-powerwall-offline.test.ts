import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryApp from "../.homeybuild/app.js";
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";
import GatewayDevice from "../.homeybuild/drivers/gateway/device.js";
import SolarDevice from "../.homeybuild/drivers/solar/device.js";
import { configureTeslemetryStub } from "./support/teslemetry-api-stub.js";
import { fakeGateway, PowerwallConnectionError } from "./support/tesla-fleet-api-powerwall-stub.js";
import { fakeCloud } from "./support/tesla-fleet-api-stub.js";

/**
 * A restart during an internet outage: the Products generation cannot be
 * built, so an enrolled site's devices bind to its local Powerwall link alone.
 */

const SITE_ID = "1689169815425134";

function createFlowStub() {
  const card = { registerRunListener: () => card, trigger: async () => {} };
  return { getActionCard: () => card, getConditionCard: () => card, getDeviceTriggerCard: () => card };
}

function createDevice(
  Device: typeof PowerwallDevice | typeof GatewayDevice | typeof SolarDevice,
  homey: Record<string, unknown>,
  capabilities: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const state = { available: true, message: null as string | null };
  const device = Object.assign(Object.create(Device.prototype), {
    homey,
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [device],
    },
    getData: () => ({ id: SITE_ID }),
    getName: () => "device",
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    addCapability: async () => {},
    removeCapability: async () => {},
    setCapabilityOptions: async () => {},
    registerCapabilityListener: () => {},
    getStoreValue: () => null,
    setAvailable: async () => {
      state.available = true;
      state.message = null;
    },
    setUnavailable: async (message: string) => {
      state.available = false;
      state.message = message;
    },
    log: () => {},
    error: () => {},
    ...extra,
  });
  return { device, state };
}

async function setupOfflineBoot(t: { after: (fn: () => void) => void }) {
  const intervals = new Map<number, () => void>();
  let nextId = 1;
  const drivers: Record<string, { getDevices: () => unknown[] }> = {};
  const app = Object.assign(new TeslemetryApp(), {
    homey: {
      __: (key: string) => key,
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: (callback: () => void) => {
        const id = nextId++;
        intervals.set(id, callback);
        return id;
      },
      clearInterval: (id: number) => intervals.delete(id),
      drivers: { getDrivers: () => drivers },
      flow: createFlowStub(),
      settings: {
        get: () => ({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 3600_000 }),
        set: () => {},
        unset: () => {},
      },
    },
    log: () => {},
    error: () => {},
  });
  configureTeslemetryStub(() => ({
    sse: { on: () => {}, close: () => {} },
    createProducts: async () => {
      throw new Error("getaddrinfo ENOTFOUND api.teslemetry.com");
    },
  }));
  fakeCloud.site = {} as never;
  fakeGateway.commands.length = 0;
  fakeGateway.liveStatus = async () => ({ response: { percentage_charged: 64, grid_power: -300, solar_power: 4200 } });
  await app.onInit();
  assert.equal(app.isReady(), false, "no Products generation could be built");

  const deviceHomey = {
    app,
    __: (key: string) => key,
    setTimeout: () => 0,
    clearTimeout: () => {},
    flow: createFlowStub(),
  };
  // The Gateway device happens to start first, before the link exists.
  const gateway = createDevice(GatewayDevice, deviceHomey, { measure_power: null });
  drivers.gateway = { getDevices: () => [gateway.device] };
  await gateway.device.onInit();
  const solar = createDevice(SolarDevice, deviceHomey, { measure_power: null });
  drivers.solar = { getDevices: () => [solar.device] };
  await solar.device.onInit();

  const store: Record<string, unknown> = {
    local_gateway: { host: "192.168.1.50", password: "ABCDE" },
    local_gateway_key: "pem",
  };
  const powerwall = createDevice(PowerwallDevice, deviceHomey, { measure_battery: null }, {
    getSetting: (key: string) => key === "local_enabled",
    getStoreValue: (key: string) => store[key] ?? null,
  });
  drivers.battery = { getDevices: () => [powerwall.device] };
  await powerwall.device.onInit();
  t.after(() => app.disableLocalPowerwall(SITE_ID));

  const pollLocal = async () => {
    for (const callback of intervals.values()) callback();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { app, gateway, solar, powerwall, pollLocal };
}

test("after a restart with no internet, an enrolled site's devices read the gateway and are available while it answers", async (t) => {
  const { gateway, solar, powerwall, pollLocal } = await setupOfflineBoot(t);
  assert.equal(powerwall.state.available, false, "nothing read yet");
  assert.equal(gateway.state.available, false);
  assert.equal(solar.state.available, false);

  await pollLocal();
  assert.equal(powerwall.state.available, true);
  assert.equal(gateway.state.available, true, "the Gateway device bound to the link once it started");
  assert.equal(powerwall.device.getCapabilityValue("measure_battery"), 64);
  assert.equal(gateway.device.getCapabilityValue("measure_power"), -300);
  assert.equal(solar.state.available, true);
  assert.equal(solar.device.getCapabilityValue("measure_power"), 4200);

  fakeGateway.liveStatus = async () => {
    throw new PowerwallConnectionError("unreachable");
  };
  await pollLocal();
  assert.equal(powerwall.state.available, false);
  assert.equal(powerwall.state.message, "error.teslemetry_connecting");
  assert.equal(gateway.state.available, false);
  assert.equal(solar.state.available, false);
  assert.equal(solar.state.message, "error.teslemetry_connecting");
});

test("offline, local commands still reach the gateway and cloud-only ones say Teslemetry is not connected", async (t) => {
  const { powerwall, pollLocal } = await setupOfflineBoot(t);
  await pollLocal();

  await powerwall.device.flowSetBackupReserve(40);
  assert.deepEqual(fakeGateway.commands, [["backup", 40]]);
  await assert.rejects(powerwall.device.flowSetOffGridVehicleChargingReserve(20), {
    message: "error.teslemetry_connecting",
  });
});
