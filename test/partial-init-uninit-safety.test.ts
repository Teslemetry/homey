import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import WallConnecter from "../.homeybuild/drivers/wall-connector/device.js";

/**
 * Finding 12: Vehicle and Wall Connector's onUninit() dereferenced fields
 * (`this.vehicle.sse`, `this.pollingCleanup.forEach`) that a missing-product
 * onInit() never assigns, so deleting/restarting an already-broken device
 * threw a secondary TypeError that masked the original binding failure and
 * could interrupt cleanup. Both must now be safe to uninitialize from every
 * partial-init point - a plain, non-throwing no-op.
 */

test("VehicleDevice.onUninit does not throw after onInit() returns early on a missing vehicle", async () => {
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: {} } },
      __: (key: string) => key,
    },
    driver: { manifest: { capabilities: [], capabilitiesOptions: {} } },
    getData: () => ({ vin: "missing-vin", id: "missing-vin" }),
    getCapabilities: () => [],
    setCapabilityOptions: async () => {},
    getStoreValue: () => null,
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });

  await stub.onInit();

  await assert.doesNotReject(() => stub.onUninit());
});

test("WallConnecter.onUninit does not throw after onInit() returns early on a missing site", async () => {
  const stub = Object.assign(Object.create(WallConnecter.prototype), {
    homey: {
      app: { products: { energySites: {}, vehicles: {} } },
      __: (key: string) => key,
    },
    driver: { manifest: { capabilities: [], capabilitiesOptions: {} } },
    getData: () => ({ site: "missing-site", din: "din-1" }),
    getCapabilities: () => [],
    getStoreValue: () => null,
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });

  await stub.onInit();

  await assert.doesNotReject(() => stub.onUninit());
});

test("WallConnecter.onUninit does not throw when the device was never initialized at all (constructor-only field init)", async () => {
  const stub = new WallConnecter();
  await assert.doesNotReject(() => stub.onUninit());
});
