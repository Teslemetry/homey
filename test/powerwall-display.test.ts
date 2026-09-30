import test from "node:test";
import assert from "node:assert/strict";
import { TeslemetryStream } from "./support/teslemetry-api-stub.js";
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";

/**
 * Real wire-shaped events (numeric site_id) through the real
 * TeslemetryStream into a real PowerwallDevice; only site.api and the Homey
 * runtime are stubbed.
 */

const SITE_ID = 1689169815425134;
const SITE_KEY = String(SITE_ID);

function createStream() {
  const logger = { info() {}, error() {}, warn() {}, debug() {} };
  const root: Record<string, unknown> = { logger };
  const stream = new TeslemetryStream(root, { cache: true });
  root.sse = stream;
  return stream;
}

function createPowerwall(siteStream: unknown) {
  const caps = [
    "measure_battery",
    "measure_power",
    "operation_mode",
    "backup_reserve",
    "off_grid_vehicle_charging_reserve",
    "onoff.charge_grid",
    "allow_export",
    "onoff.storm",
    "alarm_generic.storm",
    "grid_buy_rate",
    "grid_sell_rate",
    "meter_power.charged",
    "meter_power.discharged",
    "battery_charged_today",
    "battery_discharged_today",
  ];
  const capabilities: Record<string, unknown> = {};
  for (const c of caps) capabilities[c] = null;
  const api = new Proxy(
    {},
    {
      get: () => () =>
        Promise.resolve({ response: { code: 201, message: "Updated" } }),
    },
  );
  const triggerCalls: Array<{ cardId: string; tokens: unknown }> = [];
  const stub = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app: {
        products: {
          energySites: {
            [SITE_KEY]: {
              id: SITE_ID,
              api,
              sse: siteStream,
              metadata: { access: true },
            },
          },
        },
        isReady: () => true,
      },
      __: (k: string) => k,
      flow: {
        getDeviceTriggerCard: (cardId: string) => ({
          trigger: async (_d: unknown, tokens: unknown) => {
            triggerCalls.push({ cardId, tokens });
          },
        }),
      },
      setTimeout: () => 1,
      clearTimeout: () => {},
    },
    driver: {
      manifest: { capabilities: caps, capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ id: SITE_ID }),
    getName: () => "Powerwall",
    getCapabilities: () => caps,
    getCapabilityValue: (c: string) => capabilities[c],
    setCapabilityValue: async (c: string, v: unknown) => {
      capabilities[c] = v;
    },
    setCapabilityOptions: async () => {},
    getStoreValue: () => null,
    setStoreValue: async () => {},
    registerCapabilityListener: () => {},
    setAvailable: async () => {},
    setUnavailable: async () => {},
    log: () => {},
    error: () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, capabilities, triggerCalls };
}

const flush = () => new Promise((r) => setImmediate(r));

test("backup_reserve_changed / off_grid_vehicle_charging_reserve_changed carry the reserve as a percentage", async () => {
  const stream = createStream();
  const { stub, capabilities, triggerCalls } = createPowerwall(
    stream.getEnergySite(SITE_KEY),
  );
  await stub.onInit();
  const siteInfo = (backup: number, offGrid: number) =>
    stream._dispatch({
      createdAt: new Date().toISOString(),
      site_id: SITE_ID,
      site_info: {
        backup_reserve_percent: backup,
        off_grid_vehicle_charging_reserve_percent: offGrid,
        components: { off_grid_vehicle_charging_reserve_supported: true },
      },
    });

  siteInfo(20, 30);
  await flush();
  siteInfo(35, 45);
  await flush();

  // The capability itself stays a 0-1 fraction (Homey's % slider).
  assert.equal(capabilities.backup_reserve, 0.35);
  assert.equal(capabilities.off_grid_vehicle_charging_reserve, 0.45);
  assert.deepEqual(
    triggerCalls.filter((c) => c.cardId.endsWith("_changed")),
    [
      { cardId: "backup_reserve_changed", tokens: { backup_reserve: 35 } },
      {
        cardId: "off_grid_vehicle_charging_reserve_changed",
        tokens: { off_grid_vehicle_charging_reserve: 45 },
      },
    ],
  );
});

const ALL_DAY = [
  {
    fromDayOfWeek: 0,
    toDayOfWeek: 6,
    fromHour: 0,
    fromMinute: 0,
    toHour: 24,
    toMinute: 0,
  },
];
const tariff = (withSell: boolean) => ({
  version: 1,
  utility: "U",
  code: "C",
  name: "N",
  currency: "AUD",
  daily_charges: [],
  demand_charges: {},
  energy_charges: { ALL: { rates: { ALL: 0.3 } } },
  seasons: { ALL: { tou_periods: { ALL: { periods: ALL_DAY } } } },
  ...(withSell
    ? {
        sell_tariff: {
          energy_charges: { ALL: { rates: { ALL: 0.05 } } },
          seasons: { ALL: { tou_periods: { ALL: { periods: ALL_DAY } } } },
        },
      }
    : {}),
});

test("removing just the sell tariff clears grid_sell_rate instead of leaving the old feed-in price", async () => {
  const stream = createStream();
  const { stub, capabilities, triggerCalls } = createPowerwall(
    stream.getEnergySite(SITE_KEY),
  );
  await stub.onInit();
  stream._dispatch({
    createdAt: new Date().toISOString(),
    site_id: SITE_ID,
    site_info: { installation_time_zone: "Australia/Brisbane" },
  });
  stream._dispatch({
    createdAt: new Date().toISOString(),
    site_id: SITE_ID,
    tariff_content_v2: tariff(true),
  });
  await flush();
  assert.equal(capabilities.grid_buy_rate, 0.3);
  assert.equal(capabilities.grid_sell_rate, 0.05);

  triggerCalls.length = 0;
  stream._dispatch({
    createdAt: new Date().toISOString(),
    site_id: SITE_ID,
    tariff_content_v2: tariff(false),
  });
  await flush();

  assert.equal(capabilities.grid_buy_rate, 0.3);
  assert.equal(capabilities.grid_sell_rate, null);
  // A null rate is not a price: no change or threshold card may fire on it.
  assert.deepEqual(
    triggerCalls.filter((c) => c.cardId.startsWith("grid_sell_rate")),
    [],
  );
});
