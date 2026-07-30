import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";

/**
 * Mirrors TeslemetryEnergySiteStream: `.on(event, listener)` replays the
 * last cached payload for that event synchronously, matching the SDK
 * behavior the tariff-throw-during-init regression relies on.
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

function createDeviceStub(siteInfoDocument?: Record<string, unknown>) {
  const apiCalls: Array<[string, unknown[]]> = [];
  const api = new Proxy(
    {},
    {
      get: (_target, method: string) => (...args: unknown[]) => {
        apiCalls.push([method, args]);
        return Promise.resolve();
      },
    },
  );
  const sse = new FakeEnergySiteStream();
  sse.siteInfoDocument = siteInfoDocument;
  if (siteInfoDocument) sse.cacheAndEmit("site_info", siteInfoDocument);

  const capabilities: Record<string, unknown> = {
    backup_reserve: 0.2,
    allow_export: "battery_ok",
    operation_mode: "self_consumption",
    "onoff.charge_grid": true,
    "onoff.storm": false,
    measure_battery: undefined,
    measure_power: undefined,
    grid_buy_rate: undefined,
    grid_sell_rate: undefined,
    "meter_power.charged": 0,
    "meter_power.discharged": 0,
  };
  const capabilityOptions: Array<{ capability: string; options: unknown }> = [];
  const store: Record<string, unknown> = {};
  const capabilityListeners: Record<string, (value: unknown) => Promise<void>> = {};

  const stub = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app: { products: { energySites: { "site-1": { api, sse } } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: () => ({ trigger: async () => {} }),
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
    setCapabilityOptions: async (capability: string, options: unknown) => {
      capabilityOptions.push({ capability, options });
    },
    getStoreValue: (key: string) => (key in store ? store[key] : null),
    setStoreValue: async (key: string, value: unknown) => {
      store[key] = value;
    },
    registerCapabilityListener: (capability: string, listener: (value: unknown) => Promise<void>) => {
      capabilityListeners[capability] = listener;
    },
    setUnavailable: async () => {},
    log: () => {},
    error: () => {},
  });
  stub.driver.getDevices = () => [stub];

  return { stub, sse, api, apiCalls, capabilities, capabilityOptions, capabilityListeners };
}

test("PowerwallDevice's site_info handler maps backup_reserve_percent and default_real_mode", async () => {
  const { stub, capabilities } = createDeviceStub({
    backup_reserve_percent: 35,
    default_real_mode: "backup",
  });
  await stub.onInit();

  assert.equal(capabilities.backup_reserve, 0.35);
  assert.equal(capabilities.operation_mode, "backup");
});

test("PowerwallDevice's site_info handler maps allow_export to the explicit customer_preferred_export_rule when present", async () => {
  const { stub, capabilities } = createDeviceStub({
    components: { customer_preferred_export_rule: "pv_only" },
  });
  await stub.onInit();

  assert.equal(capabilities.allow_export, "pv_only");
});

test("PowerwallDevice's site_info handler falls back allow_export to 'never' when export is disabled and no explicit rule is set", async () => {
  const { stub, capabilities } = createDeviceStub({
    components: { non_export_configured: true },
  });
  await stub.onInit();

  assert.equal(capabilities.allow_export, "never");
});

test("PowerwallDevice's site_info handler defaults allow_export to 'battery_ok' when neither field is present", async () => {
  const { stub, capabilities } = createDeviceStub({ components: {} });
  await stub.onInit();

  assert.equal(capabilities.allow_export, "battery_ok");
});

test("PowerwallDevice's site_info handler inverts disallow_charge_from_grid_with_solar_installed into onoff.charge_grid", async () => {
  const { stub: stubDisallowed, capabilities: disallowed } = createDeviceStub({
    components: { disallow_charge_from_grid_with_solar_installed: true },
  });
  await stubDisallowed.onInit();
  assert.equal(disallowed["onoff.charge_grid"], false);

  const { stub: stubAllowed, capabilities: allowed } = createDeviceStub({
    components: {},
  });
  await stubAllowed.onInit();
  assert.equal(allowed["onoff.charge_grid"], true);
});

test("PowerwallDevice's site_info handler maps user_settings.storm_mode_enabled to onoff.storm", async () => {
  const { stub, capabilities } = createDeviceStub({
    user_settings: { storm_mode_enabled: true },
  });
  await stub.onInit();

  assert.equal(capabilities["onoff.storm"], true);
});

test("PowerwallDevice's tariff resolution updates grid_buy_rate/grid_sell_rate units from the resolved currency", async () => {
  const { stub, capabilityOptions } = createDeviceStub({
    installation_time_zone: "UTC",
    tariff_content_v2: {
      version: 1,
      utility: "Test Utility",
      code: "TEST",
      name: "Test Plan",
      currency: "EUR",
      daily_charges: [],
      demand_charges: {},
      energy_charges: { ALL: { rates: { ALL: 0.3 } } },
      seasons: {
        ALL: {
          tou_periods: {
            ALL: {
              periods: [
                { fromDayOfWeek: 0, toDayOfWeek: 6, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0 },
              ],
            },
          },
        },
      },
      sell_tariff: {
        energy_charges: { ALL: { rates: { ALL: 0.05 } } },
        seasons: {
          ALL: {
            tou_periods: {
              ALL: {
                periods: [
                  { fromDayOfWeek: 0, toDayOfWeek: 6, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0 },
                ],
              },
            },
          },
        },
      },
    },
  });
  await stub.onInit();

  const units = capabilityOptions.map((c) => ({ capability: c.capability, units: (c.options as any).units }));
  assert.deepEqual(units.sort((a, b) => a.capability.localeCompare(b.capability)), [
    { capability: "grid_buy_rate", units: "EUR" },
    { capability: "grid_sell_rate", units: "EUR" },
  ]);
});

test("PowerwallDevice's energy_totals handler drives charged/discharged cumulative meters independently", async () => {
  const { stub, sse, capabilities } = createDeviceStub();
  await stub.onInit();

  const onEnergyTotals = sse.listeners("energy_totals")[0] as (event: unknown) => Promise<void>;

  // The first reading only anchors the monotonic offset to the existing
  // capability value (see updateCumulativeMeter); the running total only
  // reflects new energy from the second reading onward.
  await onEnergyTotals({
    totals: { total_battery_charge: 3000, total_battery_discharge: 1000 },
    createdAt: "2026-07-30T10:00:00Z",
  });
  await onEnergyTotals({
    totals: { total_battery_charge: 4000, total_battery_discharge: 1500 },
    createdAt: "2026-07-30T11:00:00Z",
  });

  assert.equal(capabilities["meter_power.charged"], 1);
  assert.equal(capabilities["meter_power.discharged"], 0.5);
});

test("PowerwallDevice's allow_export command listener calls gridImportExport with the mode and inverted onoff.charge_grid", async () => {
  const { stub, apiCalls, capabilityListeners } = createDeviceStub();
  await stub.onInit();

  await capabilityListeners.allow_export("pv_only");

  assert.deepEqual(apiCalls, [["gridImportExport", ["pv_only", false]]]);
});

test("PowerwallDevice's onoff.charge_grid command listener calls gridImportExport with the current allow_export and inverted value", async () => {
  const { stub, apiCalls, capabilityListeners } = createDeviceStub();
  await stub.onInit();

  await capabilityListeners["onoff.charge_grid"](false);

  assert.deepEqual(apiCalls, [["gridImportExport", ["battery_ok", true]]]);
});

test("PowerwallDevice's onoff.storm command listener calls setStormMode", async () => {
  const { stub, apiCalls, capabilityListeners } = createDeviceStub();
  await stub.onInit();

  await capabilityListeners["onoff.storm"](true);

  assert.deepEqual(apiCalls, [["setStormMode", [true]]]);
});

test("PowerwallDevice.onUninit removes the live_status listener registered in onInit", async () => {
  const { stub, sse } = createDeviceStub();
  await stub.onInit();
  assert.equal(sse.listenerCount("live_status"), 1);

  await stub.onUninit();

  assert.equal(sse.listenerCount("live_status"), 0);
  assert.equal(sse.listenerCount("site_info"), 0);
  assert.equal(sse.listenerCount("tariff_content_v2"), 0);
  assert.equal(sse.listenerCount("energy_totals"), 0);
});
