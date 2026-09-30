import test from "node:test";
import assert from "node:assert/strict";
// The *real* SDK stream, re-exported by the "@teslemetry/api" test stub via a
// relative path (see test/support/teslemetry-api-stub.js). Constructing one
// performs no I/O - only connect() does.
import { TeslemetryStream } from "./support/teslemetry-api-stub.js";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

const VIN = "LRW3F7EK0000000001";

function createStream() {
  const logger = {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  };
  const root: Record<string, unknown> = { logger };
  const stream = new TeslemetryStream(root, { cache: true });
  root.sse = stream;
  const vehicleStream = stream.getVehicle(VIN);
  // onSignal() calls addField(), which batches a streaming-config PATCH to
  // the API unless the field is already configured. Report every field as
  // configured so the test stays network-free.
  vehicleStream.fields = new Proxy({}, { get: () => ({}) });
  return { stream, vehicleStream };
}

function createDeviceStub(vehicleStream: unknown) {
  const vehicle = {
    sse: vehicleStream,
    api: {},
    metadata: {
      access: true,
      fleet_telemetry: "fleet_telemetry_config_id",
      polling: false,
      // The captain's real Model 3 config.
      config: {
        rhd: true,
        rear_seat_heaters: 1,
        cop_user_set_temp_supported: false,
        can_actuate_trunks: true,
      },
    },
  };
  const capabilities: Record<string, unknown> = { thermostat_mode: null };
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [VIN]: vehicle } }, isReady: () => true },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: {
      manifest: {
        capabilities: Object.keys(capabilities),
        capabilitiesOptions: {},
      },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin: VIN, id: VIN }),
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
    setAvailable: async () => {},
    setUnavailable: async () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, capabilities };
}

async function thermostatModeFor(data: Record<string, unknown>) {
  const { stream, vehicleStream } = createStream();
  const { stub, capabilities } = createDeviceStub(vehicleStream);
  await stub.onInit();

  stream._dispatch({ vin: VIN, createdAt: "2026-09-30T06:00:00.000Z", data });
  await new Promise((resolve) => setImmediate(resolve));
  return capabilities.thermostat_mode;
}

test("HvacPower Precondition reads as climate auto, not off", async () => {
  assert.equal(
    await thermostatModeFor({ HvacPower: "HvacPowerStatePrecondition" }),
    "auto",
  );
});

test("HvacPower On still reads as climate auto", async () => {
  assert.equal(
    await thermostatModeFor({ HvacPower: "HvacPowerStateOn" }),
    "auto",
  );
});

test("HvacPower OverheatProtect stays climate off (cabin overheat protection owns it)", async () => {
  assert.equal(
    await thermostatModeFor({ HvacPower: "HvacPowerStateOverheatProtect" }),
    "off",
  );
});

test("HvacPower Off reads as climate off", async () => {
  assert.equal(
    await thermostatModeFor({ HvacPower: "HvacPowerStateOff" }),
    "off",
  );
});
