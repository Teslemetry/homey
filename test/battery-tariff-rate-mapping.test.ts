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

function createDeviceStub(
  capabilities: Record<string, unknown> = {},
  opts: { now?: Date } = {},
) {
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
  const triggerCalls: Array<{ cardId: string; tokens: unknown; state: unknown }> = [];
  let currentNow = opts.now ?? new Date("2026-07-30T12:00:00Z");
  const timers: Array<{ id: number; callback: () => void; delay: number }> = [];
  let nextTimerId = 1;
  const stub = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app: { products: { energySites: { "site-1": { api, sse } } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: (cardId: string) => ({
          trigger: async (_device: unknown, tokens: unknown, state?: unknown) => {
            triggerCalls.push({ cardId, tokens, state });
          },
        }),
      },
      setTimeout: (callback: () => void, delay: number) => {
        const timerId = nextTimerId++;
        timers.push({ id: timerId, callback, delay });
        return timerId;
      },
      clearTimeout: (timerId: number) => {
        const index = timers.findIndex((timer) => timer.id === timerId);
        if (index !== -1) timers.splice(index, 1);
      },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ id: "site-1" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: () => {},
    getStoreValue: () => null,
    now: () => currentNow,
    log: () => {},
    error: () => {},
  });
  stub.driver.getDevices = () => [stub];
  const emitSiteInfo = (document: Record<string, unknown>) => {
    siteInfoDocument = document;
    sse.emit("site_info", { site_id: "site-1", site_info: document });
  };
  return {
    stub,
    api,
    sse,
    capabilities,
    emitSiteInfo,
    triggerCalls,
    timers,
    setNow: (date: Date) => {
      currentNow = date;
    },
  };
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

test("PowerwallDevice fires grid_buy_rate/grid_sell_rate_above/below with previous/current state on a real rate change", async () => {
  const { stub, emitSiteInfo, triggerCalls } = createDeviceStub({
    grid_buy_rate: 0.2,
    grid_sell_rate: 0.02,
  });
  await stub.onInit();

  emitSiteInfo({
    installation_time_zone: "UTC",
    tariff_content_v2: SAMPLE_TARIFF,
  });
  // applySiteInfo fires updateWithThresholdTriggers without awaiting it, so
  // let its internal setCapabilityValue/trigger promise chain flush first.
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    triggerCalls.filter((c) => c.cardId.startsWith("grid_buy_rate")),
    [
      {
        cardId: "grid_buy_rate_changed",
        tokens: { grid_buy_rate: 0.3 },
        state: undefined,
      },
      {
        cardId: "grid_buy_rate_above",
        tokens: { grid_buy_rate: 0.3 },
        state: { previous: 0.2, current: 0.3 },
      },
      {
        cardId: "grid_buy_rate_below",
        tokens: { grid_buy_rate: 0.3 },
        state: { previous: 0.2, current: 0.3 },
      },
    ],
  );
  assert.deepEqual(
    triggerCalls.filter((c) => c.cardId.startsWith("grid_sell_rate")),
    [
      {
        cardId: "grid_sell_rate_changed",
        tokens: { grid_sell_rate: 0.05 },
        state: undefined,
      },
      {
        cardId: "grid_sell_rate_above",
        tokens: { grid_sell_rate: 0.05 },
        state: { previous: 0.02, current: 0.05 },
      },
      {
        cardId: "grid_sell_rate_below",
        tokens: { grid_sell_rate: 0.05 },
        state: { previous: 0.02, current: 0.05 },
      },
    ],
  );
});

test("PowerwallDevice clears grid_buy_rate/grid_sell_rate when siteInfo omits the tariff (removed)", async () => {
  const { stub, capabilities, emitSiteInfo, timers } = createDeviceStub({
    grid_buy_rate: 0.3,
    grid_sell_rate: 0.05,
  });
  await stub.onInit();

  emitSiteInfo({
    installation_time_zone: "UTC",
    tariff_content_v2: SAMPLE_TARIFF,
  });
  assert.equal(capabilities.grid_buy_rate, 0.3);
  assert.equal(timers.length, 1, "boundary timer scheduled while tariff resolves");

  emitSiteInfo({});

  assert.equal(capabilities.grid_buy_rate, null);
  assert.equal(capabilities.grid_sell_rate, null);
  assert.equal(timers.length, 0, "boundary timer cleared once the tariff is removed");
});

test("PowerwallDevice clears grid_buy_rate/grid_sell_rate when installation_time_zone is missing (unresolvable)", async () => {
  const { stub, capabilities, emitSiteInfo, timers } = createDeviceStub({
    grid_buy_rate: 0.3,
    grid_sell_rate: 0.05,
  });
  await stub.onInit();

  emitSiteInfo({ tariff_content_v2: SAMPLE_TARIFF });

  assert.equal(capabilities.grid_buy_rate, null);
  assert.equal(capabilities.grid_sell_rate, null);
  assert.equal(timers.length, 0, "no boundary can be scheduled without a timezone");
});

test("PowerwallDevice advances grid_buy_rate/grid_sell_rate at the next tariff period boundary with no new site_info event", async () => {
  const OFF_PEAK_THEN_PEAK = {
    version: 1,
    utility: "Test Utility",
    code: "TEST",
    name: "Test Plan",
    currency: "USD",
    daily_charges: [],
    demand_charges: {},
    energy_charges: { ALL: { rates: { off_peak: 0.1, peak: 0.4 } } },
    seasons: {
      ALL: {
        tou_periods: {
          off_peak: { periods: [{ fromDayOfWeek: 0, toDayOfWeek: 6, fromHour: 0, fromMinute: 0, toHour: 14, toMinute: 0 }] },
          peak: { periods: [{ fromDayOfWeek: 0, toDayOfWeek: 6, fromHour: 14, fromMinute: 0, toHour: 24, toMinute: 0 }] },
        },
      },
    },
  };

  const { stub, capabilities, emitSiteInfo, timers, setNow } = createDeviceStub(
    { grid_buy_rate: null, grid_sell_rate: null },
    { now: new Date("2026-07-30T13:59:00Z") },
  );
  await stub.onInit();

  emitSiteInfo({
    installation_time_zone: "UTC",
    tariff_content_v2: OFF_PEAK_THEN_PEAK,
  });

  assert.equal(capabilities.grid_buy_rate, 0.1, "off-peak rate active before the boundary");
  assert.equal(timers.length, 1, "boundary timer scheduled");
  assert.equal(timers[0].delay, 60_000, "scheduled exactly at the 14:00 boundary");

  // Cross the period boundary with no further site_info/tariff_content_v2 event.
  setNow(new Date("2026-07-30T14:00:05Z"));
  timers[0].callback();

  assert.equal(capabilities.grid_buy_rate, 0.4, "peak rate applied purely from the clock");
  assert.equal(timers.length, 1, "next boundary rescheduled");
});

test("PowerwallDevice.onUninit clears a pending tariff boundary timer", async () => {
  const { stub, emitSiteInfo, timers } = createDeviceStub({
    grid_buy_rate: null,
    grid_sell_rate: null,
  });
  await stub.onInit();

  emitSiteInfo({
    installation_time_zone: "UTC",
    tariff_content_v2: SAMPLE_TARIFF,
  });
  assert.equal(timers.length, 1, "boundary timer scheduled during init");

  await stub.onUninit();

  assert.equal(timers.length, 0, "boundary timer cleared on uninit");
});
