import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import GatewayDevice from "../.homeybuild/drivers/gateway/device.js";

/**
 * Mirrors TeslemetryEnergySiteStream: `.on(event, listener)` replays the
 * last cached payload for that event synchronously - see
 * solar-generation-today.test.ts for the same pattern on Solar.
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
  capabilities: Record<string, unknown>,
  opts: { siteInfoDocument?: Record<string, unknown>; now?: Date } = {},
) {
  const sse = new FakeEnergySiteStream();
  sse.siteInfoDocument = opts.siteInfoDocument;
  if (opts.siteInfoDocument) sse.cacheAndEmit("site_info", opts.siteInfoDocument);

  const site = { sse, metadata: { access: true } };
  const store: Record<string, unknown> = {};

  let currentNow = opts.now ?? new Date("2026-07-30T12:00:00Z");
  const timers: Array<{ id: number; callback: () => void | Promise<void>; delay: number }> = [];
  let nextTimerId = 1;

  const stub = Object.assign(Object.create(GatewayDevice.prototype), {
    homey: {
      app: { products: { energySites: { "site-1": site } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: () => ({ trigger: async () => {} }),
      },
      setTimeout: (callback: () => void | Promise<void>, delay: number) => {
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
    getStoreValue: (key: string) => (key in store ? store[key] : null),
    setStoreValue: async (key: string, value: unknown) => {
      store[key] = value;
    },
    now: () => currentNow,
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
    destroyed: false,
  });
  stub.driver.getDevices = () => [stub];

  return {
    stub,
    site,
    sse,
    capabilities,
    timers,
    setNow: (date: Date) => {
      currentNow = date;
    },
  };
}

function getListener(sse: FakeEnergySiteStream, event: string) {
  return sse.listeners(event)[0] as (event: unknown) => unknown;
}

test("GatewayDevice's live_status handler maps an Active grid_status to alarm_generic.off_grid=false", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "alarm_generic.off_grid": undefined,
    "alarm_generic.island": undefined,
    measure_power: undefined,
    "measure_power.load": undefined,
  });
  await stub.onInit();

  getListener(sse, "live_status")({
    live_status: { grid_status: "Active", island_status: "on_grid" },
  });

  assert.equal(capabilities["alarm_generic.off_grid"], false);
  assert.equal(capabilities["alarm_generic.island"], false);
});

test("GatewayDevice's live_status handler maps an Inactive grid_status to alarm_generic.off_grid=true", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "alarm_generic.off_grid": undefined,
    "alarm_generic.island": undefined,
    measure_power: undefined,
    "measure_power.load": undefined,
  });
  await stub.onInit();

  getListener(sse, "live_status")({
    live_status: {
      grid_status: "Inactive",
      island_status: "off_grid_intentional",
    },
  });

  assert.equal(capabilities["alarm_generic.off_grid"], true);
  assert.equal(capabilities["alarm_generic.island"], true);
});

test("GatewayDevice's live_status handler leaves off_grid/island untouched for an unmapped status string", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "alarm_generic.off_grid": undefined,
    "alarm_generic.island": undefined,
    island_status: undefined,
    measure_power: undefined,
    "measure_power.load": undefined,
  });
  await stub.onInit();

  getListener(sse, "live_status")({
    live_status: { grid_status: "SomeNewStatus", island_status: "unmapped" },
  });

  assert.equal(capabilities["alarm_generic.off_grid"], undefined);
  assert.equal(capabilities["alarm_generic.island"], undefined);
  assert.equal(capabilities["island_status"], undefined);
});

test("GatewayDevice's live_status handler maps island_status straight through for a known value", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    island_status: undefined,
  });
  await stub.onInit();

  getListener(sse, "live_status")({
    live_status: { island_status: "off_grid_unintentional" },
  });

  assert.equal(capabilities["island_status"], "off_grid_unintentional");
});

test("GatewayDevice's live_status handler closes each island lifecycle when its state is exited", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    island_status: undefined,
  });
  const triggered: string[] = [];
  stub.homey.flow.getDeviceTriggerCard = (id: string) => ({
    trigger: async () => {
      triggered.push(id);
    },
  });
  await stub.onInit();

  const emit = (island_status: string) =>
    getListener(sse, "live_status")({ live_status: { island_status } });

  emit("on_grid");
  emit("off_grid_unintentional");
  emit("off_grid_intentional");
  emit("off_grid_unintentional");
  emit("island_status_unknown");

  assert.deepEqual(triggered, [
    "grid_outage_started",
    "grid_outage_ended",
    "island_test_started",
    "island_test_ended",
    "grid_outage_started",
    "grid_outage_ended",
  ]);
  assert.equal(capabilities["island_status"], "island_status_unknown");
});

test("GatewayDevice's live_status handler fires grid and load power thresholds independently", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "alarm_generic.off_grid": undefined,
    "alarm_generic.island": undefined,
    measure_power: 100,
    "measure_power.load": 50,
  });
  await stub.onInit();

  getListener(sse, "live_status")({
    live_status: { grid_power: 200, load_power: 80 },
  });

  assert.equal(capabilities["measure_power"], 200);
  assert.equal(capabilities["measure_power.load"], 80);
});

test("GatewayDevice's live_status handler wires generator_power only when site_info reports a generator", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    {
      "measure_power.generator": undefined,
    },
    {
      siteInfoDocument: { components: { generator: true } },
    },
  );
  await stub.onInit();

  getListener(sse, "live_status")({
    live_status: { generator_power: 1500 },
  });

  assert.equal(capabilities["measure_power.generator"], 1500);
});

test("GatewayDevice applies cached generator power after cached site_info confirms a generator", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { "measure_power.generator": undefined },
    { siteInfoDocument: { components: { generator: true } } },
  );
  sse.cacheAndEmit("live_status", {
    live_status: { generator_power: 1500 },
  });

  await stub.onInit();

  assert.equal(capabilities["measure_power.generator"], 1500);
});

test("GatewayDevice applies the latest generator power when site_info gains a generator", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { "measure_power.generator": undefined },
    { siteInfoDocument: {} },
  );
  await stub.onInit();
  getListener(sse, "live_status")({
    live_status: { generator_power: 1500 },
  });

  sse.siteInfoDocument = { components: { generator: true } };
  getListener(sse, "site_info")({});

  assert.equal(capabilities["measure_power.generator"], 1500);
});

test("GatewayDevice's live_status handler ignores generator_power when site_info reports no generator", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    {
      "measure_power.generator": undefined,
    },
    {
      siteInfoDocument: {},
    },
  );
  await stub.onInit();

  getListener(sse, "live_status")({
    live_status: { generator_power: 1500 },
  });

  assert.equal(capabilities["measure_power.generator"], undefined);
});

test("GatewayDevice clears measure_power.generator when a later site_info reports the generator is gone", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    {
      "measure_power.generator": undefined,
    },
    {
      siteInfoDocument: { components: { generator: true } },
    },
  );
  await stub.onInit();

  getListener(sse, "live_status")({
    live_status: { generator_power: 1500 },
  });
  assert.equal(capabilities["measure_power.generator"], 1500);

  sse.siteInfoDocument = {};
  getListener(sse, "site_info")({});

  assert.equal(capabilities["measure_power.generator"], null);
});

test("GatewayDevice's energy_totals handler drives imported/exported cumulative meters", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "meter_power.imported": 0,
    "meter_power.exported": 0,
    grid_imported_today: undefined,
    grid_exported_today: undefined,
  });
  await stub.onInit();

  // The first reading only anchors the monotonic offset to the existing
  // capability value (see updateCumulativeMeter); the running total only
  // reflects new energy from the second reading onward.
  await getListener(sse, "energy_totals")({
    totals: { grid_energy_imported: 5000, total_grid_energy_exported: 2000 },
    createdAt: "2026-07-30T10:00:00Z",
  });
  await getListener(sse, "energy_totals")({
    totals: { grid_energy_imported: 8000, total_grid_energy_exported: 3000 },
    createdAt: "2026-07-30T11:00:00Z",
  });

  assert.equal(capabilities["meter_power.imported"], 3);
  assert.equal(capabilities["meter_power.exported"], 1);
});

test("GatewayDevice's energy_totals handler skips a meter whose total is missing", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "meter_power.imported": 0,
    "meter_power.exported": 0,
    grid_imported_today: undefined,
    grid_exported_today: undefined,
  });
  await stub.onInit();

  await getListener(sse, "energy_totals")({
    totals: { grid_energy_imported: null, total_grid_energy_exported: 2000 },
    createdAt: "2026-07-30T10:00:00Z",
  });
  await getListener(sse, "energy_totals")({
    totals: { grid_energy_imported: null, total_grid_energy_exported: 3000 },
    createdAt: "2026-07-30T11:00:00Z",
  });

  assert.equal(capabilities["meter_power.imported"], 0);
  assert.equal(capabilities["meter_power.exported"], 1);
});

test("GatewayDevice's energy_totals handler sets grid_imported_today/grid_exported_today/home_usage_today to today's raw kWh totals", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    grid_imported_today: undefined,
    grid_exported_today: undefined,
    home_usage_today: undefined,
  });
  await stub.onInit();

  await getListener(sse, "energy_totals")({
    totals: {
      grid_energy_imported: 5000,
      total_grid_energy_exported: 2000,
      total_home_usage: 12345,
    },
    createdAt: "2026-07-30T10:00:00Z",
  });

  assert.equal(capabilities["grid_imported_today"], 5);
  assert.equal(capabilities["grid_exported_today"], 2);
  assert.equal(capabilities["home_usage_today"], 12.345);
});

test("GatewayDevice's energy_totals handler leaves home_usage_today untouched when total_home_usage is missing", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    home_usage_today: undefined,
  });
  await stub.onInit();

  await getListener(sse, "energy_totals")({
    totals: { total_home_usage: null },
    createdAt: "2026-07-30T10:00:00Z",
  });

  assert.equal(capabilities["home_usage_today"], undefined);
});

test("GatewayDevice schedules a midnight reset for the today-total capabilities using installation_time_zone from site_info", async () => {
  const { stub, timers } = createDeviceStub(
    {
      grid_imported_today: undefined,
      grid_exported_today: undefined,
      home_usage_today: undefined,
    },
    {
      siteInfoDocument: { installation_time_zone: "America/New_York" },
      now: new Date("2026-07-30T23:59:00-04:00"),
    },
  );

  await stub.onInit();

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 60_000);
});

test("GatewayDevice's midnight reset zeroes grid_imported_today/grid_exported_today/home_usage_today and reschedules", async () => {
  const { stub, sse, capabilities, timers, setNow } = createDeviceStub(
    {
      grid_imported_today: undefined,
      grid_exported_today: undefined,
      home_usage_today: undefined,
    },
    {
      siteInfoDocument: { installation_time_zone: "America/New_York" },
      now: new Date("2026-07-30T23:59:00-04:00"),
    },
  );
  await stub.onInit();

  await getListener(sse, "energy_totals")({
    totals: {
      grid_energy_imported: 5000,
      total_grid_energy_exported: 2000,
      total_home_usage: 9000,
    },
    createdAt: "2026-07-30T20:00:00Z",
  });
  assert.equal(capabilities["grid_imported_today"], 5);
  assert.equal(capabilities["grid_exported_today"], 2);
  assert.equal(capabilities["home_usage_today"], 9);

  setNow(new Date("2026-07-31T00:00:05-04:00"));
  await timers[0].callback();

  assert.equal(capabilities["grid_imported_today"], 0);
  assert.equal(capabilities["grid_exported_today"], 0);
  assert.equal(capabilities["home_usage_today"], 0);
  assert.equal(timers.length, 1, "next midnight reset rescheduled");
});

test("an async rejection inside the midnight reset timer callback does not escape uncaught", async () => {
  const { stub, timers } = createDeviceStub(
    {
      grid_imported_today: undefined,
      grid_exported_today: undefined,
      home_usage_today: undefined,
    },
    {
      siteInfoDocument: { installation_time_zone: "America/New_York" },
      now: new Date("2026-07-30T23:59:00-04:00"),
    },
  );
  await stub.onInit();
  assert.equal(timers.length, 1, "midnight timer scheduled during init");

  stub.update = () =>
    Promise.reject(new Error("simulated failure during midnight reset"));

  await assert.doesNotReject(() => timers[0].callback());
});

test("GatewayDevice.onUninit removes the live_status, energy_totals and site_info listeners, and clears the midnight timer", async () => {
  const { stub, sse, timers } = createDeviceStub(
    {
      "alarm_generic.off_grid": undefined,
      "alarm_generic.island": undefined,
      measure_power: undefined,
      "measure_power.load": undefined,
    },
    { siteInfoDocument: { installation_time_zone: "America/New_York" } },
  );
  await stub.onInit();
  assert.equal(timers.length, 1, "midnight timer scheduled during init");

  await stub.onUninit();

  assert.equal(sse.listenerCount("live_status"), 0);
  assert.equal(sse.listenerCount("energy_totals"), 0);
  assert.equal(sse.listenerCount("site_info"), 0);
  assert.equal(timers.length, 0, "midnight timer cleared on uninit");
});
