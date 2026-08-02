import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

class FakeVehicleStream extends EventEmitter {
  data = new EventEmitter();
  cache = { data: {} };

  onSignal(field: string, callback: (value: unknown) => void) {
    this.data.on(field, callback);
    return () => this.data.off(field, callback);
  }
}

function createDeviceStub(vin: string) {
  const sse = new FakeVehicleStream();
  const vehicle = {
    sse,
    api: {},
    metadata: { access: true, fleet_telemetry: "fleet_telemetry_config_id", polling: false, config: { rhd: false, can_actuate_trunks: false } },
  };
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [vin]: vehicle } } },
      __: (key: string) => key,
    },
    driver: {
      manifest: { capabilities: [], capabilitiesOptions: {} },
    },
    getData: () => ({ vin, id: vin }),
    getCapabilities: () => [],
    getCapabilityValue: () => undefined,
    setCapabilityOptions: async () => {},
    getStoreValue: () => null,
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });
  return { stub, sse };
}

test("VehicleDevice.onUninit removes exactly the listeners it registered on the shared SSE emitter", async () => {
  const { stub, sse } = createDeviceStub("test-vin");

  await stub.onInit();

  assert.ok(sse.data.eventNames().length > 0, "signal listeners registered");
  assert.equal(sse.listenerCount("state"), 1);
  assert.equal(sse.listenerCount("connectivity"), 1);

  // A listener not owned by this device must survive teardown - proves
  // onUninit no longer does a blanket removeAllListeners().
  const foreignListener = () => {};
  sse.data.on("BatteryLevel", foreignListener);

  await stub.onUninit();

  for (const eventName of sse.data.eventNames()) {
    assert.deepEqual(
      sse.data.listeners(eventName),
      eventName === "BatteryLevel" ? [foreignListener] : [],
      `leftover listeners for ${String(eventName)}`,
    );
  }
  assert.equal(sse.listenerCount("state"), 0);
  assert.equal(sse.listenerCount("connectivity"), 0);

  sse.data.off("BatteryLevel", foreignListener);
});
