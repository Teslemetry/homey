import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

/**
 * Mirrors TeslemetryVehicleStream: onSignal replays the last cached value
 * for that field synchronously on subscribe, matching the SDK behavior
 * that triggered the #28-class tariff-throw-during-init regression for
 * PowerwallDevice - here poisoned onto Vehicle's BatteryLevel signal.
 */
class FakeVehicleStream extends EventEmitter {
  data = new EventEmitter();
  cache: { data: Record<string, unknown> } = { data: {} };
  private signalCache = new Map<string, unknown>();

  primeSignal(field: string, value: unknown) {
    this.signalCache.set(field, value);
  }

  onSignal(field: string, callback: (value: unknown) => void) {
    this.data.on(field, callback);
    if (this.signalCache.has(field)) callback(this.signalCache.get(field));
    return () => this.data.off(field, callback);
  }
}

function createDeviceStub(capabilities: Record<string, unknown> = {}) {
  const sse = new FakeVehicleStream();
  sse.primeSignal("BatteryLevel", 50);
  const vehicle = {
    sse,
    api: {},
    metadata: { config: { rhd: false, can_actuate_trunks: false } },
  };
  const capabilityListeners: Record<string, (value: unknown) => Promise<void>> = {};

  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { "test-vin": vehicle } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: () => ({ trigger: async () => {} }),
      },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
    },
    getData: () => ({ vin: "test-vin", id: "test-vin" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => {
      if (capability === "measure_battery") {
        throw new Error("simulated Homey SDK failure reading measure_battery");
      }
      return capabilities[capability];
    },
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: (capability: string, listener: (value: unknown) => Promise<void>) => {
      capabilityListeners[capability] = listener;
    },
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });

  return { stub, sse, capabilityListeners };
}

// Pinned to VehicleDevice's current behavior, not the ideal one: unlike
// PowerwallDevice (see battery-device-init.test.ts), onInit's long signal
// block has no guard against an early cached-signal replay throwing, so a
// throw here aborts every registration after it - including state/
// connectivity SSE listeners and every command capability listener. This
// documents the gap rather than asserting resilience the code doesn't have.
test("VehicleDevice.onInit currently aborts all later registration when an early cached signal replay throws", async () => {
  const { stub, sse, capabilityListeners } = createDeviceStub();

  await assert.rejects(() => stub.onInit(), /simulated Homey SDK failure/);

  assert.equal(sse.listenerCount("state"), 0, "state listener never registered");
  assert.equal(sse.listenerCount("connectivity"), 0, "connectivity listener never registered");
  assert.equal(capabilityListeners.locked, undefined, "locked command listener never registered");
});
