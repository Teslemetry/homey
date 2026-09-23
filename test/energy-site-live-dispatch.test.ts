import test from "node:test";
import assert from "node:assert/strict";
// The *real* SDK stream, re-exported by the "@teslemetry/api" test stub via a
// relative path (see test/support/teslemetry-api-stub.js). Constructing one
// performs no I/O - only connect() does - so these tests can drive its real
// _dispatch() routing directly.
import { TeslemetryStream } from "./support/teslemetry-api-stub.js";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";

/**
 * Regression cover for "energy devices update once per app (re)bind, then go
 * permanently silent".
 *
 * `/api/metadata` keys energy sites by a *string* id, so `createProducts()`
 * registers each site's emitter under that string, while the SSE wire sends
 * `site_id`/`totals.id` as a JSON *number*. @teslemetry/api 0.11.x looked the
 * emitter up with the raw numeric value, so `energySites.get(...)` always
 * missed and no energy site ever received a live event. It looked healthy
 * because the SDK's own energy cache is a plain object (numeric keys coerce to
 * strings), so the one cached replay every `site.sse.on(...)` registration
 * performs still delivered a value - one update per bind, then nothing, with
 * no error logged anywhere. Vehicles were unaffected: their emitters are keyed
 * by a VIN, a string on both sides.
 *
 * These tests therefore drive real wire-shaped events (numeric ids) through
 * the real TeslemetryStream into a real PowerwallDevice - a hand-written
 * energy-site emitter would mock away the exact step that was broken.
 */

const SITE_ID = 1689169815425134;
const SITE_KEY = String(SITE_ID);

function createStream() {
  const logger = {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  };
  // TeslemetryEnergySiteStream registers itself on `root.sse`, which is the
  // stream itself - mirrors how the Teslemetry class wires the two together.
  const root: Record<string, unknown> = { logger };
  const stream = new TeslemetryStream(root, { cache: true });
  root.sse = stream;
  return stream;
}

function createDeviceStub(siteStream: unknown) {
  const api = new Proxy(
    {},
    { get: () => () => Promise.resolve() },
  );

  const capabilities: Record<string, unknown> = {
    measure_battery: undefined,
    measure_power: undefined,
    backup_reserve: undefined,
    operation_mode: undefined,
    battery_charged_today: undefined,
    battery_discharged_today: undefined,
    "meter_power.charged": 0,
    "meter_power.discharged": 0,
  };
  const store: Record<string, unknown> = {};

  const stub = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app: {
        products: {
          energySites: {
            // Keyed by the string id /api/metadata hands back, exactly as
            // Teslemetry.createProducts() builds it.
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
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
      setTimeout: () => 1,
      clearTimeout: () => {},
    },
    driver: {
      manifest: {
        capabilities: Object.keys(capabilities),
        capabilitiesOptions: {},
      },
      getDevices: () => [] as unknown[],
    },
    // Energy pairing data keeps the raw numeric EnergyDetails.id; getSiteId()
    // is what canonicalizes it for the string-keyed registry lookup.
    getData: () => ({ id: SITE_ID }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    getStoreValue: (key: string) => (key in store ? store[key] : null),
    setStoreValue: async (key: string, value: unknown) => {
      store[key] = value;
    },
    registerCapabilityListener: () => {},
    setAvailable: async () => {},
    setUnavailable: async () => {},
    log: () => {},
    error: () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, capabilities };
}

test("a live_status event carrying the wire's numeric site_id reaches the bound Powerwall device", async () => {
  const stream = createStream();
  const siteStream = stream.getEnergySite(SITE_KEY);
  const { stub, capabilities } = createDeviceStub(siteStream);

  await stub.onInit();
  assert.equal(
    capabilities.measure_battery,
    undefined,
    "precondition: nothing delivered before the first event",
  );

  stream._dispatch({
    createdAt: "2026-09-23T05:30:00.000Z",
    site_id: SITE_ID,
    live_status: { percentage_charged: 57, battery_power: -2500 },
  });

  assert.equal(capabilities.measure_battery, 57);
  assert.equal(capabilities.measure_power, 2500);
});

test("successive live_status events keep updating the device rather than delivering exactly one value", async () => {
  const stream = createStream();
  const siteStream = stream.getEnergySite(SITE_KEY);
  const { stub, capabilities } = createDeviceStub(siteStream);

  await stub.onInit();

  for (const percentage of [40, 55, 71]) {
    stream._dispatch({
      createdAt: "2026-09-23T05:30:00.000Z",
      site_id: SITE_ID,
      live_status: { percentage_charged: percentage },
    });
  }

  assert.equal(capabilities.measure_battery, 71);
});

test("a device bound after the first live_status still receives every later event, not just the cached replay", async () => {
  const stream = createStream();
  const siteStream = stream.getEnergySite(SITE_KEY);

  // Arrives before the device exists - only reachable through the SDK cache.
  stream._dispatch({
    createdAt: "2026-09-23T05:29:00.000Z",
    site_id: SITE_ID,
    live_status: { percentage_charged: 12 },
  });

  const { stub, capabilities } = createDeviceStub(siteStream);
  await stub.onInit();
  assert.equal(capabilities.measure_battery, 12, "cached replay on bind");

  stream._dispatch({
    createdAt: "2026-09-23T05:31:00.000Z",
    site_id: SITE_ID,
    live_status: { percentage_charged: 34 },
  });

  assert.equal(capabilities.measure_battery, 34);
});

test("a site_info event carrying the wire's numeric site_id reaches the bound Powerwall device", async () => {
  const stream = createStream();
  const siteStream = stream.getEnergySite(SITE_KEY);
  const { stub, capabilities } = createDeviceStub(siteStream);

  await stub.onInit();

  stream._dispatch({
    createdAt: "2026-09-23T05:30:00.000Z",
    site_id: SITE_ID,
    site_info: { backup_reserve_percent: 35, default_real_mode: "backup" },
  });

  assert.equal(capabilities.backup_reserve, 0.35);
  assert.equal(capabilities.operation_mode, "backup");
});

test("an energy_totals event carrying the wire's numeric id reaches the bound Powerwall device", async () => {
  const stream = createStream();
  const siteStream = stream.getEnergySite(SITE_KEY);
  const { stub, capabilities } = createDeviceStub(siteStream);

  await stub.onInit();

  stream._dispatch({
    createdAt: "2026-09-23T05:30:00.000Z",
    id: SITE_ID,
    totals: { total_battery_charge: 4000, total_battery_discharge: 1500 },
  });
  // handleEnergyTotals is async and the emitter doesn't await it.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(capabilities.battery_charged_today, 4);
  assert.equal(capabilities.battery_discharged_today, 1.5);
});
