import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output (via `npm run build`) rather than source: the
// source files import the real "homey" SDK package, which only resolves
// to usable classes inside the actual Homey runtime, and driver/type-only
// imports that tsc elides on build but Node's runtime type-stripping
// cannot. test/support/loader.mjs stubs the remaining "homey" import.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";
import GatewayDevice from "../.homeybuild/drivers/gateway/device.js";
import SolarDevice from "../.homeybuild/drivers/solar/device.js";

// Built on the real class's prototype chain (not a plain object) so
// inherited methods like TeslemetryDevice.ensureCapabilities still resolve.
function createDeviceStub(deviceClass: { prototype: object }, id: string) {
  const setUnavailableCalls: unknown[] = [];
  const stub = Object.assign(Object.create(deviceClass.prototype), {
    homey: {
      app: { products: {} },
      __: (key: string) => key,
    },
    driver: {
      manifest: { capabilities: [], capabilitiesOptions: {} },
    },
    getData: () => ({ vin: id, id }),
    getCapabilities: () => [],
    setCapabilityOptions: async () => {},
    log: () => {},
    error: () => {},
    setUnavailable: async (message: unknown) => {
      setUnavailableCalls.push(message);
    },
  });
  return { stub, setUnavailableCalls };
}

test("VehicleDevice.onInit marks the device unavailable with a reauth message when no vehicle is found", async () => {
  const { stub, setUnavailableCalls } = createDeviceStub(
    VehicleDevice,
    "missing-vin",
  );

  await stub.onInit();

  assert.deepEqual(setUnavailableCalls, ["error.invalid_refresh_token"]);
});

test("PowerwallDevice.onInit marks the device unavailable with a reauth message when no site is found", async () => {
  const { stub, setUnavailableCalls } = createDeviceStub(
    PowerwallDevice,
    "missing-site",
  );

  await stub.onInit();

  assert.deepEqual(setUnavailableCalls, ["error.invalid_refresh_token"]);
});

test("GatewayDevice.onInit marks the device unavailable with a reauth message when no site is found", async () => {
  const { stub, setUnavailableCalls } = createDeviceStub(
    GatewayDevice,
    "missing-site",
  );

  await stub.onInit();

  assert.deepEqual(setUnavailableCalls, ["error.invalid_refresh_token"]);
});

test("SolarDevice.onInit marks the device unavailable with a reauth message when no site is found", async () => {
  const { stub, setUnavailableCalls } = createDeviceStub(
    SolarDevice,
    "missing-site",
  );

  await stub.onInit();

  assert.deepEqual(setUnavailableCalls, ["error.invalid_refresh_token"]);
});
