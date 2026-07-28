import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";

// A single "ALL" season/period covering every day and hour, so the resolved
// rate is deterministic regardless of the real wall-clock time the test runs at.
const ALL_DAY_PERIOD = [{ fromDayOfWeek: 0, toDayOfWeek: 6, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0 }];

const SAMPLE_TARIFF = {
  version: 1,
  utility: "Test Utility",
  code: "TEST",
  name: "Test Plan",
  currency: "USD",
  daily_charges: [],
  demand_charges: {},
  energy_charges: { ALL: { rates: { ALL: 0.3 } } },
  seasons: { ALL: { tou_periods: { ALL: { periods: ALL_DAY_PERIOD } } } },
  sell_tariff: {
    energy_charges: { ALL: { rates: { ALL: 0.05 } } },
    seasons: { ALL: { tou_periods: { ALL: { periods: ALL_DAY_PERIOD } } } },
  },
};

function createDeviceStub(capabilities: Record<string, unknown> = {}) {
  const api = Object.assign(new EventEmitter(), {
    requestPolling: () => () => {},
  });
  const stub = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app: { products: { energySites: { "site-1": { api } } } },
      __: (key: string) => key,
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
    },
    getData: () => ({ id: "site-1" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
  });
  return { stub, api, capabilities };
}

test("PowerwallDevice resolves grid_buy_rate/grid_sell_rate from siteInfo's tariff_content_v2", async () => {
  const { stub, api, capabilities } = createDeviceStub({
    grid_buy_rate: null,
    grid_sell_rate: null,
  });
  await stub.onInit();

  api.emit("siteInfo", {
    response: {
      installation_time_zone: "UTC",
      tariff_content_v2: SAMPLE_TARIFF,
    },
  });

  assert.equal(capabilities.grid_buy_rate, 0.3);
  assert.equal(capabilities.grid_sell_rate, 0.05);
});

test("PowerwallDevice does not touch grid_buy_rate/grid_sell_rate when siteInfo omits the tariff", async () => {
  const { stub, api, capabilities } = createDeviceStub({
    grid_buy_rate: 0.3,
    grid_sell_rate: 0.05,
  });
  await stub.onInit();

  api.emit("siteInfo", { response: {} });

  assert.equal(capabilities.grid_buy_rate, 0.3);
  assert.equal(capabilities.grid_sell_rate, 0.05);
});

test("PowerwallDevice does not touch grid_buy_rate/grid_sell_rate when installation_time_zone is missing", async () => {
  const { stub, api, capabilities } = createDeviceStub({
    grid_buy_rate: 0.3,
    grid_sell_rate: 0.05,
  });
  await stub.onInit();

  api.emit("siteInfo", { response: { tariff_content_v2: SAMPLE_TARIFF } });

  assert.equal(capabilities.grid_buy_rate, 0.3);
  assert.equal(capabilities.grid_sell_rate, 0.05);
});
