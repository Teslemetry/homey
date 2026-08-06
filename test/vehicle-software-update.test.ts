import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

// Mirrors the real SDK: cacheData merges every field of an incoming "data"
// event into cache.data *before* the per-field signal listener runs (see
// AGENTS.md's "Device onInit Ordering" section), so recomputeSoftwareUpdateStatus()
// can safely read every field off the cache instead of just the one that
// changed. Tests set cache.data directly to model that merge.
class FakeVehicleStream extends EventEmitter {
  data = new EventEmitter();
  cache: { data: Record<string, unknown> } = { data: {} };

  onSignal(field: string, callback: (value: unknown) => void) {
    this.data.on(field, callback);
    return () => this.data.off(field, callback);
  }
}

const DEFAULT_VIN = "test-vin";

function createDeviceStub(capabilities: Record<string, unknown>) {
  const sse = new FakeVehicleStream();
  const vehicle = {
    sse,
    api: {},
    metadata: { access: true, fleet_telemetry: "fleet_telemetry_config_id", polling: false, config: { rhd: false, can_actuate_trunks: false } },
  };
  const triggeredCards: string[] = [];
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [DEFAULT_VIN]: vehicle } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: (id: string) => ({
          trigger: async () => {
            triggeredCards.push(id);
          },
        }),
      },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin: DEFAULT_VIN, id: DEFAULT_VIN }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    getStoreValue: () => null,
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, sse, capabilities, triggeredCards };
}

test("no update pending: matching Version/SoftwareUpdateVersion yields idle status and no progress", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    software_update_status: undefined,
    software_update_progress: undefined,
  });
  await stub.onInit();

  sse.cache.data.Version = "2024.44.25 abcdef";
  sse.data.emit("Version", sse.cache.data.Version);

  assert.equal(capabilities["software_update_status"], "idle");
  assert.equal(capabilities["software_update_progress"], null);
});

test("a differing SoftwareUpdateVersion marks the update available", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    software_update_status: undefined,
    software_update_progress: undefined,
  });
  await stub.onInit();

  sse.cache.data.Version = "2024.44.25 abcdef";
  sse.cache.data.SoftwareUpdateVersion = "2024.44.30";
  sse.data.emit("SoftwareUpdateVersion", sse.cache.data.SoftwareUpdateVersion);

  assert.equal(capabilities["software_update_status"], "available");
  assert.equal(capabilities["software_update_progress"], null);
});

test("a non-null SoftwareUpdateScheduledStartTime marks the update scheduled", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    software_update_status: undefined,
    software_update_progress: undefined,
  });
  await stub.onInit();

  sse.cache.data.Version = "2024.44.25 abcdef";
  sse.cache.data.SoftwareUpdateVersion = "2024.44.30";
  sse.cache.data.SoftwareUpdateScheduledStartTime = 1700000000;
  sse.data.emit(
    "SoftwareUpdateScheduledStartTime",
    sse.cache.data.SoftwareUpdateScheduledStartTime,
  );

  assert.equal(capabilities["software_update_status"], "scheduled");
});

test("an in-range download percentage marks the update downloading with fractional progress", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    software_update_status: undefined,
    software_update_progress: undefined,
  });
  await stub.onInit();

  sse.cache.data.SoftwareUpdateDownloadPercentComplete = 42;
  sse.data.emit("SoftwareUpdateDownloadPercentComplete", 42);

  assert.equal(capabilities["software_update_status"], "downloading");
  assert.equal(capabilities["software_update_progress"], 0.42);
});

test("an in-range install percentage wins over a simultaneous in-range download percentage", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    software_update_status: undefined,
    software_update_progress: undefined,
  });
  await stub.onInit();

  sse.cache.data.SoftwareUpdateDownloadPercentComplete = 42;
  sse.cache.data.SoftwareUpdateInstallationPercentComplete = 55;
  sse.data.emit("SoftwareUpdateInstallationPercentComplete", 55);

  assert.equal(capabilities["software_update_status"], "installing");
  assert.equal(capabilities["software_update_progress"], 0.55);
});

// recomputeSoftwareUpdateStatus() calls the async update() without awaiting
// it (matching every other signal handler in this device), so the trigger
// fire - which only happens after update()'s internal setCapabilityValue
// await resolves - lands a microtask after emit() returns.
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test("software_update_status_changed fires only on a real transition", async () => {
  const { stub, sse, triggeredCards } = createDeviceStub({
    software_update_status: "idle",
    software_update_progress: undefined,
  });
  await stub.onInit();

  sse.cache.data.SoftwareUpdateVersion = "2024.44.30";
  sse.cache.data.Version = "2024.44.25 abcdef";
  sse.data.emit("SoftwareUpdateVersion", sse.cache.data.SoftwareUpdateVersion);
  await flushMicrotasks();
  assert.equal(triggeredCards.filter((c) => c === "software_update_status_changed").length, 1);

  // Same status recomputed again (e.g. a Version replay) must not re-fire.
  sse.data.emit("Version", sse.cache.data.Version);
  await flushMicrotasks();
  assert.equal(triggeredCards.filter((c) => c === "software_update_status_changed").length, 1);
});

test("software_update_status_changed does not fire on the first-ever reading", async () => {
  const { stub, sse, triggeredCards } = createDeviceStub({
    software_update_status: undefined,
    software_update_progress: undefined,
  });
  await stub.onInit();

  sse.cache.data.SoftwareUpdateVersion = "2024.44.30";
  sse.cache.data.Version = "2024.44.25 abcdef";
  sse.data.emit("SoftwareUpdateVersion", sse.cache.data.SoftwareUpdateVersion);
  await flushMicrotasks();
  assert.equal(triggeredCards.filter((c) => c === "software_update_status_changed").length, 0);
});

test("flowInstallSoftwareUpdate rejects while idle/downloading/installing and succeeds while available/scheduled", async () => {
  const { stub, capabilities } = createDeviceStub({
    software_update_status: "idle",
    software_update_progress: undefined,
  });
  await stub.onInit();

  let scheduleCalls = 0;
  (stub as any).vehicle.api.scheduleSoftwareUpdate = async (offsetSec: number) => {
    scheduleCalls++;
    assert.equal(offsetSec, 0);
    return { response: { result: true } };
  };

  await assert.rejects(() => stub.flowInstallSoftwareUpdate());
  assert.equal(scheduleCalls, 0);

  capabilities.software_update_status = "available";
  await stub.flowInstallSoftwareUpdate();
  assert.equal(scheduleCalls, 1);

  capabilities.software_update_status = "scheduled";
  await stub.flowInstallSoftwareUpdate();
  assert.equal(scheduleCalls, 2);

  capabilities.software_update_status = "downloading";
  await assert.rejects(() => stub.flowInstallSoftwareUpdate());
  assert.equal(scheduleCalls, 2);
});

test("flowCancelSoftwareUpdate rejects while idle/available/installing and succeeds while downloading/scheduled", async () => {
  const { stub, capabilities } = createDeviceStub({
    software_update_status: "idle",
    software_update_progress: undefined,
  });
  await stub.onInit();

  let cancelCalls = 0;
  (stub as any).vehicle.api.cancelSoftwareUpdate = async () => {
    cancelCalls++;
    return { response: { result: true } };
  };

  await assert.rejects(() => stub.flowCancelSoftwareUpdate());
  assert.equal(cancelCalls, 0);

  capabilities.software_update_status = "available";
  await assert.rejects(() => stub.flowCancelSoftwareUpdate());
  assert.equal(cancelCalls, 0);

  capabilities.software_update_status = "downloading";
  await stub.flowCancelSoftwareUpdate();
  assert.equal(cancelCalls, 1);

  capabilities.software_update_status = "scheduled";
  await stub.flowCancelSoftwareUpdate();
  assert.equal(cancelCalls, 2);

  capabilities.software_update_status = "installing";
  await assert.rejects(() => stub.flowCancelSoftwareUpdate());
  assert.equal(cancelCalls, 2);
});
