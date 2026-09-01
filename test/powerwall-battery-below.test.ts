import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";

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

function createDeviceStub() {
  const sse = new FakeEnergySiteStream();
  const api = new Proxy({}, { get: () => () => Promise.resolve() });
  const capabilities: Record<string, unknown> = {
    measure_battery: undefined,
    measure_power: undefined,
    "alarm_generic.storm": undefined,
  };
  const triggerCalls: Array<{ cardId: string; tokens: unknown; state: unknown }> = [];
  let currentCardId = "";

  const stub = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app: {
        products: {
          energySites: { "site-1": { api, sse, metadata: { access: true } } },
        },
      },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: (cardId: string) => {
          currentCardId = cardId;
          return {
            trigger: async (_d: unknown, tokens: unknown, state?: unknown) => {
              triggerCalls.push({ cardId: currentCardId, tokens, state });
            },
          };
        },
      },
      setTimeout: () => 1,
      clearTimeout: () => {},
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
    getStoreValue: () => null,
    setStoreValue: async () => {},
    registerCapabilityListener: () => {},
    setUnavailable: async () => {},
    log: () => {},
    error: () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, sse, capabilities, triggerCalls };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const liveStatus = (percentage_charged: number) => ({
  live_status: { percentage_charged, battery_power: 0 },
});

test("a Powerwall's state of charge fires battery_below - the card is not vehicle-only", async () => {
  const { stub, sse, capabilities, triggerCalls } = createDeviceStub();
  await stub.onInit();

  sse.cacheAndEmit("live_status", liveStatus(80));
  await flush();
  assert.equal(capabilities.measure_battery, 80);
  // First reading is only a baseline - nothing to compare against yet.
  assert.deepEqual(triggerCalls, []);

  sse.cacheAndEmit("live_status", liveStatus(15));
  await flush();
  assert.equal(capabilities.measure_battery, 15);
  assert.deepEqual(
    triggerCalls.map((c) => c.cardId),
    ["battery_below"],
  );
  assert.deepEqual(triggerCalls[0].tokens, { battery: 15 });
  assert.deepEqual(triggerCalls[0].state, { previous: 80, current: 15 });
});

test("an unchanged Powerwall state of charge does not re-fire battery_below", async () => {
  const { stub, sse, triggerCalls } = createDeviceStub();
  await stub.onInit();

  sse.cacheAndEmit("live_status", liveStatus(50));
  sse.cacheAndEmit("live_status", liveStatus(50));
  sse.cacheAndEmit("live_status", liveStatus(50));
  await flush();

  assert.deepEqual(triggerCalls, []);
});

test("a missing percentage_charged neither writes nor triggers", async () => {
  const { stub, sse, capabilities, triggerCalls } = createDeviceStub();
  await stub.onInit();

  sse.cacheAndEmit("live_status", liveStatus(60));
  await flush();
  sse.cacheAndEmit("live_status", { live_status: { battery_power: 0 } });
  await flush();

  assert.equal(capabilities.measure_battery, 60);
  assert.deepEqual(triggerCalls, []);
});
