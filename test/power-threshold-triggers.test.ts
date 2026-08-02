import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import SolarDevice from "../.homeybuild/drivers/solar/device.js";
import GatewayDevice from "../.homeybuild/drivers/gateway/device.js";
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";

function createDeviceStub(
  DeviceClass: { prototype: object },
  capabilities: Record<string, unknown>,
  siteInfoDocument?: Record<string, unknown>,
) {
  const triggerCalls: Array<{ cardId: string; tokens: unknown; state: unknown }> = [];
  const handlers: Record<string, (event: unknown) => void> = {};
  const site = {
    sse: {
      siteInfoDocument,
      on: (event: string, handler: (event: unknown) => void) => {
        handlers[event] = handler;
      },
      off: () => {},
    },
    metadata: { access: true },
  };

  const stub = Object.assign(Object.create(DeviceClass.prototype), {
    homey: {
      app: { products: { energySites: { "site-1": site } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: (cardId: string) => ({
          trigger: async (_device: unknown, tokens: unknown, state?: unknown) => {
            triggerCalls.push({ cardId, tokens, state });
          },
        }),
      },
    },
    driver: {
      manifest: {
        capabilities: Object.keys(capabilities),
        capabilitiesOptions: {},
      },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ id: "site-1" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    registerCapabilityListener: () => {},
    getStoreValue: () => null,
    log: () => {},
    error: () => {},
    destroyed: false,
  });
  stub.driver.getDevices = () => [stub];

  return { stub, capabilities, handlers, triggerCalls };
}

test("SolarDevice fires solar_power_above/below with previous/current state on a real power change", async () => {
  const { stub, handlers, triggerCalls } = createDeviceStub(SolarDevice, {
    measure_power: 1000,
  });
  await stub.onInit();

  handlers["live_status"]({ live_status: { solar_power: 3500 } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    triggerCalls.filter((c) => c.cardId.startsWith("solar_power")),
    [
      {
        cardId: "solar_power_above",
        tokens: { power: 3500 },
        state: { previous: 1000, current: 3500 },
      },
      {
        cardId: "solar_power_below",
        tokens: { power: 3500 },
        state: { previous: 1000, current: 3500 },
      },
    ],
  );
});

test("SolarDevice does not fire solar_power_above/below on the first reading (no previous value)", async () => {
  const { stub, handlers, triggerCalls } = createDeviceStub(SolarDevice, {
    measure_power: undefined,
  });
  await stub.onInit();

  handlers["live_status"]({ live_status: { solar_power: 3500 } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(triggerCalls, []);
});

test("GatewayDevice fires grid_power_above/below and load_power_above/below independently", async () => {
  const { stub, handlers, triggerCalls } = createDeviceStub(GatewayDevice, {
    measure_power: 500,
    "measure_power.load": 2000,
  });
  await stub.onInit();

  handlers["live_status"]({
    live_status: { grid_power: -800, load_power: 2600 },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    triggerCalls.filter((c) => c.cardId.startsWith("grid_power")),
    [
      {
        cardId: "grid_power_above",
        tokens: { power: -800 },
        state: { previous: 500, current: -800 },
      },
      {
        cardId: "grid_power_below",
        tokens: { power: -800 },
        state: { previous: 500, current: -800 },
      },
    ],
  );
  assert.deepEqual(
    triggerCalls.filter((c) => c.cardId.startsWith("load_power")),
    [
      {
        cardId: "load_power_above",
        tokens: { power: 2600 },
        state: { previous: 2000, current: 2600 },
      },
      {
        cardId: "load_power_below",
        tokens: { power: 2600 },
        state: { previous: 2000, current: 2600 },
      },
    ],
  );
});

test("GatewayDevice fires generator_power_above/below when the site has a generator", async () => {
  const { stub, handlers, triggerCalls } = createDeviceStub(
    GatewayDevice,
    { "measure_power.generator": 1200 },
    { components: { generator: true } },
  );
  await stub.onInit();
  handlers["site_info"]({});

  handlers["live_status"]({ live_status: { generator_power: 3500 } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    triggerCalls.filter((c) => c.cardId.startsWith("generator_power")),
    [
      {
        cardId: "generator_power_above",
        tokens: { power: 3500 },
        state: { previous: 1200, current: 3500 },
      },
      {
        cardId: "generator_power_below",
        tokens: { power: 3500 },
        state: { previous: 1200, current: 3500 },
      },
    ],
  );
});

test("PowerwallDevice fires battery_power_above/below using the sign-inverted (discharge-positive) value", async () => {
  const { stub, handlers, triggerCalls, capabilities } = createDeviceStub(
    PowerwallDevice,
    { measure_battery: 50, measure_power: -1000 },
  );
  await stub.onInit();

  // Raw SDK battery_power of 500 (charging) inverts to -500 (Homey convention).
  handlers["live_status"]({
    live_status: { percentage_charged: 55, battery_power: 500 },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(capabilities.measure_power, -500);
  assert.deepEqual(
    triggerCalls.filter((c) => c.cardId.startsWith("battery_power")),
    [
      {
        cardId: "battery_power_above",
        tokens: { power: -500 },
        state: { previous: -1000, current: -500 },
      },
      {
        cardId: "battery_power_below",
        tokens: { power: -500 },
        state: { previous: -1000, current: -500 },
      },
    ],
  );
});
