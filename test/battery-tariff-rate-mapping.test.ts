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
  // Mirrors TeslemetryEnergySiteStream closely enough for this device:
  // siteInfoDocument merges the cached site_info/tariff_content_v2 pair, and
  // on("site_info"/"tariff_content_v2") replays nothing here (tests emit directly).
  let siteInfoDocument: Record<string, unknown> | undefined;
  const sse = new EventEmitter();
  // Object.assign would evaluate a getter defined via object-literal shorthand
  // immediately and copy its current value instead of the accessor itself, so
  // this is defined directly on the emitter to stay live across emitSiteInfo calls.
  Object.defineProperty(sse, "siteInfoDocument", {
    get: () => siteInfoDocument,
  });
  const stub = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app: { products: { energySites: { "site-1": { api, sse } } } },
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
  const emitSiteInfo = (document: Record<string, unknown>) => {
    siteInfoDocument = document;
    sse.emit("site_info", { site_id: "site-1", site_info: document });
  };
  return { stub, api, sse, capabilities, emitSiteInfo };
}

test("PowerwallDevice resolves grid_buy_rate/grid_sell_rate from siteInfo's tariff_content_v2", async () => {
  const { stub, capabilities, emitSiteInfo } = createDeviceStub({
    grid_buy_rate: null,
    grid_sell_rate: null,
  });
  await stub.onInit();

  emitSiteInfo({
    installation_time_zone: "UTC",
    tariff_content_v2: SAMPLE_TARIFF,
  });

  assert.equal(capabilities.grid_buy_rate, 0.3);
  assert.equal(capabilities.grid_sell_rate, 0.05);
});

test("PowerwallDevice does not touch grid_buy_rate/grid_sell_rate when siteInfo omits the tariff", async () => {
  const { stub, capabilities, emitSiteInfo } = createDeviceStub({
    grid_buy_rate: 0.3,
    grid_sell_rate: 0.05,
  });
  await stub.onInit();

  emitSiteInfo({});

  assert.equal(capabilities.grid_buy_rate, 0.3);
  assert.equal(capabilities.grid_sell_rate, 0.05);
});

test("PowerwallDevice does not touch grid_buy_rate/grid_sell_rate when installation_time_zone is missing", async () => {
  const { stub, capabilities, emitSiteInfo } = createDeviceStub({
    grid_buy_rate: 0.3,
    grid_sell_rate: 0.05,
  });
  await stub.onInit();

  emitSiteInfo({ tariff_content_v2: SAMPLE_TARIFF });

  assert.equal(capabilities.grid_buy_rate, 0.3);
  assert.equal(capabilities.grid_sell_rate, 0.05);
});
