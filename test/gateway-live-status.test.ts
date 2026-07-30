import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import GatewayDevice from "../.homeybuild/drivers/gateway/device.js";

function createDeviceStub(capabilities: Record<string, unknown>) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const site = {
    sse: {
      on: (event: string, handler: (event: unknown) => void) => {
        handlers[event] = handler;
      },
      off: () => {},
    },
  };
  const store: Record<string, unknown> = {};

  const stub = Object.assign(Object.create(GatewayDevice.prototype), {
    homey: {
      app: { products: { energySites: { "site-1": site } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: () => ({ trigger: async () => {} }),
      },
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
    getStoreValue: (key: string) => (key in store ? store[key] : null),
    setStoreValue: async (key: string, value: unknown) => {
      store[key] = value;
    },
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
    destroyed: false,
  });

  return { stub, site, handlers, capabilities };
}

test("GatewayDevice's live_status handler maps an Active grid_status to alarm_generic.off_grid=false", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    "alarm_generic.off_grid": undefined,
    "alarm_generic.island": undefined,
    measure_power: undefined,
    "measure_power.load": undefined,
  });
  await stub.onInit();

  handlers["live_status"]({
    live_status: { grid_status: "Active", island_status: "on_grid" },
  });

  assert.equal(capabilities["alarm_generic.off_grid"], false);
  assert.equal(capabilities["alarm_generic.island"], false);
});

test("GatewayDevice's live_status handler maps an Inactive grid_status to alarm_generic.off_grid=true", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    "alarm_generic.off_grid": undefined,
    "alarm_generic.island": undefined,
    measure_power: undefined,
    "measure_power.load": undefined,
  });
  await stub.onInit();

  handlers["live_status"]({
    live_status: {
      grid_status: "Inactive",
      island_status: "off_grid_intentional",
    },
  });

  assert.equal(capabilities["alarm_generic.off_grid"], true);
  assert.equal(capabilities["alarm_generic.island"], true);
});

test("GatewayDevice's live_status handler leaves off_grid/island untouched for an unmapped status string", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    "alarm_generic.off_grid": undefined,
    "alarm_generic.island": undefined,
    measure_power: undefined,
    "measure_power.load": undefined,
  });
  await stub.onInit();

  handlers["live_status"]({
    live_status: { grid_status: "SomeNewStatus", island_status: "unmapped" },
  });

  assert.equal(capabilities["alarm_generic.off_grid"], undefined);
  assert.equal(capabilities["alarm_generic.island"], undefined);
});

test("GatewayDevice's live_status handler fires grid and load power thresholds independently", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    "alarm_generic.off_grid": undefined,
    "alarm_generic.island": undefined,
    measure_power: 100,
    "measure_power.load": 50,
  });
  await stub.onInit();

  handlers["live_status"]({
    live_status: { grid_power: 200, load_power: 80 },
  });

  assert.equal(capabilities["measure_power"], 200);
  assert.equal(capabilities["measure_power.load"], 80);
});

test("GatewayDevice's energy_totals handler drives imported/exported cumulative meters", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    "meter_power.imported": 0,
    "meter_power.exported": 0,
  });
  await stub.onInit();

  // The first reading only anchors the monotonic offset to the existing
  // capability value (see updateCumulativeMeter); the running total only
  // reflects new energy from the second reading onward.
  await handlers["energy_totals"]({
    totals: { grid_energy_imported: 5000, total_grid_energy_exported: 2000 },
    createdAt: "2026-07-30T10:00:00Z",
  });
  await handlers["energy_totals"]({
    totals: { grid_energy_imported: 8000, total_grid_energy_exported: 3000 },
    createdAt: "2026-07-30T11:00:00Z",
  });

  assert.equal(capabilities["meter_power.imported"], 3);
  assert.equal(capabilities["meter_power.exported"], 1);
});

test("GatewayDevice's energy_totals handler skips a meter whose total is missing", async () => {
  const { stub, handlers, capabilities } = createDeviceStub({
    "meter_power.imported": 0,
    "meter_power.exported": 0,
  });
  await stub.onInit();

  await handlers["energy_totals"]({
    totals: { grid_energy_imported: null, total_grid_energy_exported: 2000 },
    createdAt: "2026-07-30T10:00:00Z",
  });
  await handlers["energy_totals"]({
    totals: { grid_energy_imported: null, total_grid_energy_exported: 3000 },
    createdAt: "2026-07-30T11:00:00Z",
  });

  assert.equal(capabilities["meter_power.imported"], 0);
  assert.equal(capabilities["meter_power.exported"], 1);
});

test("GatewayDevice.onUninit removes the live_status and energy_totals listeners", async () => {
  const { stub, site } = createDeviceStub({
    "alarm_generic.off_grid": undefined,
    "alarm_generic.island": undefined,
    measure_power: undefined,
    "measure_power.load": undefined,
  });
  const offCalls: Array<string> = [];
  site.sse.off = (event: string) => {
    offCalls.push(event);
  };
  await stub.onInit();

  await stub.onUninit();

  assert.deepEqual(offCalls.sort(), ["energy_totals", "live_status"]);
});
