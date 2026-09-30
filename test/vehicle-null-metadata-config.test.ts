import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
// Real per-VIN routing via the stub's re-export of the SDK's TeslemetryStream.
import { TeslemetryStream } from "./support/teslemetry-api-stub.js";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import VehicleDriver from "../.homeybuild/drivers/vehicle/driver.js";

const require = createRequire(import.meta.url);
const appJson = require("../app.json");
const vehicleManifest = appJson.drivers.find(
  (d: { id: string }) => d.id === "vehicle",
);

const VIN = "LRW3F7EK4NC716336"; // Model 3

/**
 * The shape `/api/metadata` returns when the server cannot read the VIN's
 * vehicle_config (e.g. a new subscriber's car asleep): still an object,
 * every field `null`.
 */
const NULL_CONFIG = {
  can_accept_navigation_requests: null,
  can_actuate_trunks: null,
  cop_user_set_temp_supported: null,
  dashcam_clip_save_supported: null,
  has_seat_cooling: null,
  rear_seat_heaters: null,
  rhd: null,
  sun_roof_installed: null,
  third_row_seats: null,
};

const METADATA_GATED = [
  "seat_cooler.front_left",
  "seat_cooler.front_right",
  "seat_heater.rear_left",
  "seat_heater.rear_right",
  "seat_heater.rear_center",
  "windowcoverings_closed.sunroof",
  "cop_temperature_limit",
];

function createStream() {
  const logger = { info() {}, error() {}, warn() {}, debug() {} };
  const root: Record<string, unknown> = { logger };
  const stream = new TeslemetryStream(root as never, { cache: true } as never);
  root.sse = stream;
  return stream as unknown as {
    _dispatch(event: unknown): void;
    getVehicle(vin: string): unknown;
  };
}

function createDevice(
  config: Record<string, unknown>,
  existing: string[] = vehicleManifest.capabilities,
) {
  const stream = createStream();
  const capabilities: Record<string, unknown> = Object.fromEntries(
    existing.map((c) => [c, null]),
  );
  const removed: string[] = [];
  const options: Array<[string, Record<string, unknown>]> = [];
  const vehicle = {
    vin: VIN,
    name: "Sonic",
    api: {},
    sse: stream.getVehicle(VIN),
    metadata: { access: true, fleet_telemetry: "1.0", polling: false, config },
  };
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [VIN]: vehicle } }, isReady: () => true },
      __: (k: string) => k,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
      geolocation: {
        getLatitude: () => undefined,
        getLongitude: () => undefined,
      },
    },
    driver: { manifest: vehicleManifest, getDevices: () => [] as unknown[] },
    getData: () => ({ vin: VIN }),
    getName: () => "Sonic",
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (c: string) => capabilities[c],
    setCapabilityValue: async (c: string, v: unknown) => {
      capabilities[c] = v;
    },
    setCapabilityOptions: async (c: string, o: Record<string, unknown>) => {
      options.push([c, o]);
    },
    addCapability: async (c: string) => {
      capabilities[c] = null;
    },
    removeCapability: async (c: string) => {
      removed.push(c);
      delete capabilities[c];
    },
    getStoreValue: () => null,
    registerCapabilityListener: () => {},
    setAvailable: async () => {},
    setUnavailable: async () => {},
    log: () => {},
    error: () => {},
  });
  stub.driver.getDevices = () => [stub];

  const dispatch = async (data: Record<string, unknown>) => {
    stream._dispatch({ createdAt: new Date().toISOString(), vin: VIN, data });
    await new Promise((r) => setImmediate(r));
  };
  return { stub, capabilities, removed, options, dispatch };
}

test("an all-null metadata config removes no metadata-gated capability and leaves frunk/trunk settability alone", async () => {
  const { stub, capabilities, removed, options } = createDevice(NULL_CONFIG);

  await stub.onInit();

  assert.deepEqual(
    removed.filter((c) => METADATA_GATED.includes(c)),
    [],
    "unknown config must preserve what the device already has",
  );
  for (const cap of METADATA_GATED) assert.ok(cap in capabilities, cap);
  assert.deepEqual(
    options.filter(([c]) => c === "onoff.frunk" || c === "onoff.trunk"),
    [],
    "unknown can_actuate_trunks must not write setable:false",
  );
});

test("each null config key is unknown only for its own capability", async () => {
  const { stub, capabilities, removed } = createDevice({
    ...NULL_CONFIG,
    has_seat_cooling: false,
    cop_user_set_temp_supported: false,
  });

  await stub.onInit();

  assert.deepEqual(
    removed.filter((c) => METADATA_GATED.includes(c)).sort(),
    ["cop_temperature_limit", "seat_cooler.front_left", "seat_cooler.front_right"],
  );
  for (const cap of [
    "seat_heater.rear_left",
    "seat_heater.rear_right",
    "seat_heater.rear_center",
    "windowcoverings_closed.sunroof",
  ]) {
    assert.ok(cap in capabilities, `${cap} preserved while its key is null`);
  }
});

test("an all-null config does not add metadata-gated capabilities the device lacks", async () => {
  const existing = vehicleManifest.capabilities.filter(
    (c: string) => !METADATA_GATED.includes(c),
  );
  const { stub, capabilities } = createDevice(NULL_CONFIG, existing);

  await stub.onInit();

  for (const cap of METADATA_GATED) assert.ok(!(cap in capabilities), cap);
});

test("a known can_actuate_trunks still drives frunk/trunk settability", async () => {
  const { stub, options } = createDevice({
    ...NULL_CONFIG,
    can_actuate_trunks: false,
  });

  await stub.onInit();

  assert.deepEqual(
    options
      .filter(([c]) => c === "onoff.frunk" || c === "onoff.trunk")
      .map(([c, o]) => [c, o.setable]),
    [
      ["onoff.frunk", false],
      ["onoff.trunk", false],
    ],
  );
});

test("target_temperature follows the streamed RightHandDrive when config.rhd is unknown", async () => {
  const { stub, capabilities, dispatch } = createDevice(NULL_CONFIG);
  await stub.onInit();

  await dispatch({
    HvacLeftTemperatureRequest: 19,
    HvacRightTemperatureRequest: 21,
  });
  assert.equal(capabilities.target_temperature, 19, "left until RHD is known");

  await dispatch({ RightHandDrive: true });
  assert.equal(capabilities.target_temperature, 21, "driver side is right");

  await dispatch({ HvacLeftTemperatureRequest: 17 });
  assert.equal(
    capabilities.target_temperature,
    21,
    "passenger-side change does not move the driver setpoint",
  );

  await dispatch({ HvacRightTemperatureRequest: 22.5 });
  assert.equal(capabilities.target_temperature, 22.5);
});

test("target_temperature uses config.rhd before RightHandDrive streams, and a null RightHandDrive keeps it", async () => {
  const { stub, capabilities, dispatch } = createDevice({
    ...NULL_CONFIG,
    rhd: true,
  });
  await stub.onInit();

  await dispatch({
    HvacLeftTemperatureRequest: 19,
    HvacRightTemperatureRequest: 21,
  });
  assert.equal(capabilities.target_temperature, 21);

  await dispatch({ RightHandDrive: null });
  assert.equal(capabilities.target_temperature, 21);
});

test("pairing with an all-null config writes no setable:null and adds no metadata-gated capability", async () => {
  const driver = Object.assign(Object.create(VehicleDriver.prototype), {
    manifest: vehicleManifest,
    homey: {
      app: {
        getProducts: async () => ({
          vehicles: {
            [VIN]: {
              vin: VIN,
              name: "Sonic",
              metadata: {
                access: true,
                fleet_telemetry: "1.0",
                polling: false,
                config: NULL_CONFIG,
              },
            },
          },
          energySites: {},
        }),
      },
      __: (k: string) => k,
      error: () => {},
    },
    log: () => {},
    error: () => {},
  });

  const [candidate] = await driver.onPairListDevices();

  for (const cap of ["onoff.frunk", "onoff.trunk"]) {
    assert.ok(
      !("setable" in candidate.capabilitiesOptions[cap]),
      `${cap} keeps the manifest's settability`,
    );
  }
  for (const cap of METADATA_GATED) {
    assert.ok(!candidate.capabilities.includes(cap), cap);
  }
});
