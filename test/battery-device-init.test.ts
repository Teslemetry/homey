import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";

const VALID_TARIFF = {
  version: 1,
  utility: "Test Utility",
  code: "TEST",
  name: "Test Plan",
  currency: "USD",
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
};

/**
 * Mirrors TeslemetryEnergySiteStream: `.on(event, listener)` replays the
 * last cached payload for that event synchronously, matching the SDK
 * behavior that triggers the tariff-throw-during-init regression.
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
  };
  const capabilityListeners: Record<string, (value: unknown) => Promise<void>> = {};
  const timers: Array<{ id: number; callback: () => void }> = [];
  let nextTimerId = 1;

  const stub = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app: { products: { energySites: { "site-1": { api, sse } } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: () => ({ trigger: async () => {} }),
      },
      setTimeout: (callback: () => void) => {
        const timerId = nextTimerId++;
        timers.push({ id: timerId, callback });
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
    registerCapabilityListener: (capability: string, listener: (value: unknown) => Promise<void>) => {
      capabilityListeners[capability] = listener;
    },
    getStoreValue: () => null,
    setUnavailable: async () => {},
    log: () => {},
    error: () => {},
  });
  stub.driver.getDevices = () => [stub];

  return { stub, sse, api, apiCalls, capabilities, capabilityListeners, timers };
}

const COMMAND_CAPABILITIES = [
  "backup_reserve",
  "allow_export",
  "operation_mode",
  "onoff.charge_grid",
  "onoff.storm",
];

test("PowerwallDevice.onInit keeps live_status and all five command listeners registered when cached tariff/timezone is malformed", async () => {
  const { stub, sse, apiCalls, capabilityListeners } = createDeviceStub({
    installation_time_zone: "GMT+10", // invalid IANA timezone: Intl.DateTimeFormat throws
    tariff_content_v2: VALID_TARIFF,
    backup_reserve_percent: 25,
  });

  await assert.doesNotReject(() => stub.onInit());

  assert.equal(sse.listenerCount("live_status"), 1, "live_status listener registered");
  for (const capability of COMMAND_CAPABILITIES) {
    assert.equal(
      typeof capabilityListeners[capability],
      "function",
      `${capability} command listener registered`,
    );
  }

  await capabilityListeners.backup_reserve(0.3);
  assert.deepEqual(apiCalls, [["setBackupReserve", [30]]]);
});

test("PowerwallDevice.onInit registers both the live_status listener and all five command listeners on a normal init", async () => {
  const { stub, sse, apiCalls, capabilityListeners } = createDeviceStub({
    installation_time_zone: "UTC",
    tariff_content_v2: VALID_TARIFF,
    backup_reserve_percent: 25,
  });

  await stub.onInit();

  assert.equal(sse.listenerCount("live_status"), 1, "live_status listener registered");
  for (const capability of COMMAND_CAPABILITIES) {
    assert.equal(
      typeof capabilityListeners[capability],
      "function",
      `${capability} command listener registered`,
    );
  }

  await capabilityListeners.operation_mode("backup");
  assert.deepEqual(apiCalls, [["setOperationMode", ["backup"]]]);
});
