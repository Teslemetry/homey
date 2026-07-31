import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import SolarDevice from "../.homeybuild/drivers/solar/device.js";

/**
 * Mirrors TeslemetryEnergySiteStream: `.on(event, listener)` replays the
 * last cached payload for that event synchronously, matching the SDK
 * behavior exercised by the site_info-driven timezone lookup below (see
 * battery-device-init.test.ts for the same pattern on Powerwall).
 */
class FakeEnergySiteStream extends EventEmitter {
  private cache = new Map<string, unknown>();
  siteInfoDocument: Record<string, unknown> | undefined;

  cacheAndEmit(event: string, payload: unknown) {
    this.cache.set(event, payload);
    this.emit(event, payload);
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    if (this.cache.has(event)) listener(this.cache.get(event));
    return this;
  }
}

function createDeviceStub(
  id: string,
  opts: { siteInfoDocument?: Record<string, unknown>; now?: Date } = {},
) {
  const capabilities: Record<string, unknown> = {
    measure_power: undefined,
    meter_power: 0,
    solar_generation_today: undefined,
  };
  const store: Record<string, unknown> = {};

  const sse = new FakeEnergySiteStream();
  sse.siteInfoDocument = opts.siteInfoDocument;
  if (opts.siteInfoDocument) sse.cacheAndEmit("site_info", opts.siteInfoDocument);

  const site = { sse };

  let currentNow = opts.now ?? new Date("2026-07-30T12:00:00Z");
  const timers: Array<{ id: number; callback: () => void; delay: number }> = [];
  let nextTimerId = 1;

  const stub = Object.assign(Object.create(SolarDevice.prototype), {
    homey: {
      app: { products: { energySites: { [id]: site } } },
      __: (key: string) => key,
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
    now: () => currentNow,
    log: () => {},
    error: () => {},
    destroyed: false,
  });

  return {
    stub,
    capabilities,
    sse,
    timers,
    setNow: (date: Date) => {
      currentNow = date;
    },
  };
}

function getListener(sse: FakeEnergySiteStream, event: string) {
  return sse.listeners(event)[0] as (event: unknown) => unknown;
}

test("SolarDevice's energy_totals handler sets solar_generation_today to today's raw kWh total", async () => {
  const { stub, capabilities, sse } = createDeviceStub("site-1");

  await stub.onInit();
  await getListener(sse, "energy_totals")({
    totals: { total_solar_generation: 724 },
    createdAt: "2026-07-30T10:00:00Z",
  });

  assert.equal(capabilities["solar_generation_today"], 0.724);
});

test("SolarDevice's energy_totals handler leaves solar_generation_today untouched when the total is missing", async () => {
  const { stub, capabilities, sse } = createDeviceStub("site-1");

  await stub.onInit();
  await getListener(sse, "energy_totals")({
    totals: { total_solar_generation: null },
    createdAt: "2026-07-30T10:00:00Z",
  });

  assert.equal(capabilities["solar_generation_today"], undefined);
});

test("SolarDevice's energy_totals handler still drives the monotonic meter_power counter alongside the new capability", async () => {
  const { stub, capabilities, sse } = createDeviceStub("site-1");

  await stub.onInit();
  await getListener(sse, "energy_totals")({
    totals: { total_solar_generation: 10000 },
    createdAt: "2026-07-30T10:00:00Z",
  });
  await getListener(sse, "energy_totals")({
    totals: { total_solar_generation: 25000 },
    createdAt: "2026-07-30T11:00:00Z",
  });

  assert.equal(capabilities["solar_generation_today"], 25);
  assert.equal(capabilities["meter_power"], 15);
});

test("SolarDevice.onUninit removes the live_status, energy_totals and site_info listeners, and clears the midnight timer", async () => {
  const { stub, sse, timers } = createDeviceStub("site-1", {
    siteInfoDocument: { installation_time_zone: "America/New_York" },
  });

  await stub.onInit();
  assert.equal(timers.length, 1, "midnight timer scheduled during init");

  await stub.onUninit();

  assert.equal(sse.listenerCount("live_status"), 0);
  assert.equal(sse.listenerCount("energy_totals"), 0);
  assert.equal(sse.listenerCount("site_info"), 0);
  assert.equal(timers.length, 0, "midnight timer cleared on uninit");
});

test("SolarDevice schedules a reset at the site's local midnight, using installation_time_zone from site_info", async () => {
  // 23:59:00 America/New_York (EDT, UTC-4 in July) - one minute to local midnight.
  const { stub, timers } = createDeviceStub("site-1", {
    siteInfoDocument: { installation_time_zone: "America/New_York" },
    now: new Date("2026-07-30T23:59:00-04:00"),
  });

  await stub.onInit();

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 60_000);
});

test("SolarDevice does not schedule a midnight reset when site_info has no installation_time_zone yet", async () => {
  const { stub, timers } = createDeviceStub("site-1", {
    siteInfoDocument: {},
  });

  await stub.onInit();

  assert.equal(timers.length, 0);
});

test("SolarDevice.onInit tolerates a malformed installation_time_zone without losing live_status/energy_totals registration", async () => {
  const { stub, sse, timers } = createDeviceStub("site-1", {
    // Invalid IANA timezone: Intl.DateTimeFormat throws.
    siteInfoDocument: { installation_time_zone: "GMT+10" },
  });

  await assert.doesNotReject(() => stub.onInit());

  assert.equal(sse.listenerCount("live_status"), 1);
  assert.equal(sse.listenerCount("energy_totals"), 1);
  assert.equal(timers.length, 0, "malformed timezone must not schedule a timer");
});

test("solar_generation_today resets to 0 exactly at local midnight and accumulates again from the day's first sample - not on first-sample-of-day", async () => {
  const { stub, capabilities, sse, timers, setNow } = createDeviceStub("site-1", {
    siteInfoDocument: { installation_time_zone: "America/New_York" },
    now: new Date("2026-07-30T23:59:00-04:00"),
  });

  await stub.onInit();

  // Yesterday's accumulated total, as it would sit unchanged overnight since
  // energy_totals only pushes on a change and nothing changes while the sun
  // is down.
  await getListener(sse, "energy_totals")({
    totals: { total_solar_generation: 12500 },
    createdAt: "2026-07-30T20:00:00Z",
  });
  assert.equal(capabilities["solar_generation_today"], 12.5);
  assert.equal(timers.length, 1, "midnight timer pending");

  // Cross local midnight: fire the scheduled reset with no new SSE event.
  setNow(new Date("2026-07-31T00:00:05-04:00"));
  timers[0].callback();

  assert.equal(
    capabilities["solar_generation_today"],
    0,
    "reset at the midnight boundary itself, before any new generation",
  );
  assert.equal(timers.length, 1, "next midnight reset rescheduled");
  assert.ok(
    timers[0].delay > 23 * 60 * 60 * 1000,
    "rescheduled roughly a full day out",
  );

  // The day's first real sample arrives once the sun comes up.
  await getListener(sse, "energy_totals")({
    totals: { total_solar_generation: 500 },
    createdAt: "2026-07-31T13:00:00Z",
  });
  assert.equal(capabilities["solar_generation_today"], 0.5);
});
