import test from "node:test";
import assert from "node:assert/strict";
// The *real* SDK, imported by relative path so the loader's "@teslemetry/api"
// redirect does not replace it: the request body gridImportExport() actually
// serializes is the thing under test. Only fetch is replaced.
import { Teslemetry } from "../node_modules/@teslemetry/api/dist/index.mjs";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";

/**
 * Charge From Grid and Allow Export are two fields of one Tesla endpoint
 * (grid_import_export). Each must send only the field the user changed - as
 * HA does (switch.py / select.py) - never re-send the other from a derived,
 * possibly-null or app-invented capability value. On a VPP site Tesla omits
 * the export rule entirely, so re-sending it writes a rule the user never
 * touched, which can outlive the VPP programme.
 */

const SITE_ID = 1689169815425134;

function createPowerwall(capabilityOverrides: Record<string, unknown> = {}) {
  const logger = { info() {}, error() {}, warn() {}, debug() {} };
  const sdk = new Teslemetry(async () => "token", { logger });
  const bodies: Array<Record<string, unknown>> = [];
  sdk.client.setConfig({
    fetch: async (request: Request) => {
      bodies.push(JSON.parse(await request.text()));
      return new Response('{"response":{"code":201,"message":"Updated"}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const site = sdk.getEnergySite(SITE_ID);

  const capabilities: Record<string, unknown> = {
    measure_battery: null,
    measure_power: null,
    backup_reserve: null,
    operation_mode: null,
    allow_export: null,
    "onoff.charge_grid": null,
    "onoff.storm": null,
    ...capabilityOverrides,
  };
  const listeners: Record<string, (value: unknown) => Promise<unknown>> = {};
  const stub = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app: {
        products: {
          energySites: { [String(SITE_ID)]: { ...site, metadata: { access: true } } },
        },
        isReady: () => true,
      },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
      setTimeout: () => 1,
      clearTimeout: () => {},
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ id: SITE_ID }),
    getName: () => "Powerwall",
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    getStoreValue: () => null,
    setStoreValue: async () => {},
    registerCapabilityListener: (capability: string, listener: (value: unknown) => Promise<unknown>) => {
      listeners[capability] = listener;
    },
    setAvailable: async () => {},
    setUnavailable: async () => {},
    log: () => {},
    error: () => {},
  });
  stub.driver.getDevices = () => [stub];

  // Wire-shaped site_info: numeric site_id, routed by the real stream.
  const siteInfo = (site_info: Record<string, unknown>) =>
    sdk.sse._dispatch({ createdAt: new Date().toISOString(), site_id: SITE_ID, site_info });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  return { stub, capabilities, listeners, bodies, siteInfo, flush };
}

test("toggling Charge From Grid on a VPP site sends only the grid-charging field, never a derived export rule", async () => {
  const { stub, capabilities, listeners, bodies, siteInfo, flush } = createPowerwall();
  await stub.onInit();
  // VPP / utility no-export site: Tesla reports no customer_preferred_export_rule.
  siteInfo({ components: { non_export_configured: true, battery: true, solar: true } });
  await flush();
  assert.equal(capabilities.allow_export, "never");

  await listeners["onoff.charge_grid"](true);
  await listeners["onoff.charge_grid"](false);

  assert.deepEqual(bodies, [
    { disallow_charge_from_grid_with_solar_installed: false },
    { disallow_charge_from_grid_with_solar_installed: true },
  ]);
});

test("a site that reports no export rule shows allow_export unknown, not an invented 'battery_ok'", async () => {
  const { stub, capabilities, listeners, bodies, siteInfo, flush } = createPowerwall();
  await stub.onInit();
  siteInfo({ components: { battery: true, solar: false } });
  await flush();

  assert.equal(capabilities.allow_export, null);
  await listeners["onoff.charge_grid"](false);
  assert.deepEqual(bodies, [{ disallow_charge_from_grid_with_solar_installed: true }]);
});

test("setting Allow Export before any site_info sends only the export rule and leaves grid charging untouched", async () => {
  const { stub, capabilities, listeners, bodies } = createPowerwall();
  await stub.onInit();
  assert.equal(capabilities["onoff.charge_grid"], null);

  await listeners.allow_export("pv_only");
  await stub.flowSetAllowExport("battery_ok");

  assert.deepEqual(bodies, [
    { customer_preferred_export_rule: "pv_only" },
    { customer_preferred_export_rule: "battery_ok" },
  ]);
});

test("a null value is refused rather than sent to the site", async () => {
  const { stub, listeners, bodies } = createPowerwall();
  await stub.onInit();

  await assert.rejects(listeners.allow_export(null));
  await assert.rejects(listeners["onoff.charge_grid"](null));
  assert.deepEqual(bodies, []);
});
