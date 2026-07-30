import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import SolarDevice from "../.homeybuild/drivers/solar/device.js";

function createDeviceStub(id: string) {
  const capabilities: Record<string, unknown> = {
    measure_power: undefined,
    meter_power: 0,
    solar_generation_today: undefined,
  };
  const store: Record<string, unknown> = {};
  const handlers: Record<string, (event: unknown) => void> = {};
  const offCalls: Array<string> = [];

  const site = {
    sse: {
      on: (event: string, handler: (event: unknown) => void) => {
        handlers[event] = handler;
      },
      off: (event: string) => {
        offCalls.push(event);
      },
    },
  };

  const stub = Object.assign(Object.create(SolarDevice.prototype), {
    homey: {
      app: { products: { energySites: { [id]: site } } },
      __: (key: string) => key,
    },
    driver: {
      manifest: {
        capabilities: Object.keys(capabilities),
        capabilitiesOptions: {},
      },
    },
    getData: () => ({ id }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    addCapability: async (capability: string) => {
      capabilities[capability] = undefined;
    },
    removeCapability: async (capability: string) => {
      delete capabilities[capability];
    },
    setCapabilityOptions: async () => {},
    getStoreValue: (key: string) =>
      key in store ? (store[key] as unknown) : null,
    setStoreValue: async (key: string, value: unknown) => {
      store[key] = value;
    },
    log: () => {},
    error: () => {},
    destroyed: false,
  });

  return { stub, capabilities, handlers, offCalls };
}

test("SolarDevice's energy_totals handler sets solar_generation_today to today's raw kWh total", async () => {
  const { stub, capabilities, handlers } = createDeviceStub("site-1");

  await stub.onInit();
  await handlers["energy_totals"]({
    totals: { total_solar_generation: 724 },
    createdAt: "2026-07-30T10:00:00Z",
  });

  assert.equal(capabilities["solar_generation_today"], 0.724);
});

test("SolarDevice's energy_totals handler leaves solar_generation_today untouched when the total is missing", async () => {
  const { stub, capabilities, handlers } = createDeviceStub("site-1");

  await stub.onInit();
  await handlers["energy_totals"]({
    totals: { total_solar_generation: null },
    createdAt: "2026-07-30T10:00:00Z",
  });

  assert.equal(capabilities["solar_generation_today"], undefined);
});

test("SolarDevice's energy_totals handler still drives the monotonic meter_power counter alongside the new capability", async () => {
  const { stub, capabilities, handlers } = createDeviceStub("site-1");

  await stub.onInit();
  await handlers["energy_totals"]({
    totals: { total_solar_generation: 10000 },
    createdAt: "2026-07-30T10:00:00Z",
  });
  await handlers["energy_totals"]({
    totals: { total_solar_generation: 25000 },
    createdAt: "2026-07-30T11:00:00Z",
  });

  assert.equal(capabilities["solar_generation_today"], 25);
  assert.equal(capabilities["meter_power"], 15);
});

test("SolarDevice.onUninit removes the live_status and energy_totals listeners", async () => {
  const { stub, offCalls } = createDeviceStub("site-1");

  await stub.onInit();
  await stub.onUninit();

  assert.deepEqual(offCalls.sort(), ["energy_totals", "live_status"]);
});
