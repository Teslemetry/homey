import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

class FakeVehicleStream extends EventEmitter {
  data = new EventEmitter();
  cache = { data: {} as Record<string, unknown> };

  onSignal(field: string, callback: (value: unknown) => void) {
    this.data.on(field, callback);
    return () => this.data.off(field, callback);
  }
}

const MODEL_Y_VIN = "XYZYTRK0000000001";
const CYBERTRUCK_VIN = "XYZCTRK0000000001";

function createDeviceStub(
  capabilities: Record<string, unknown>,
  vin: string = MODEL_Y_VIN,
) {
  const sse = new FakeVehicleStream();
  const vehicle = {
    sse,
    api: {},
    metadata: {
      access: true,
      fleet_telemetry: "fleet_telemetry_config_id",
      polling: false,
      config: { rhd: false, can_actuate_trunks: false },
    },
  };
  const addedCapabilities: string[] = [];
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [vin]: vehicle } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: () => ({
          trigger: async () => {},
        }),
      },
    },
    driver: {
      manifest: {
        capabilities: Object.keys(capabilities),
        capabilitiesOptions: {},
      },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin, id: vin }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    addCapability: async (capability: string) => {
      addedCapabilities.push(capability);
      capabilities[capability] = undefined;
    },
    removeCapability: async (capability: string) => {
      delete capabilities[capability];
    },
    getStoreValue: () => null,
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, sse, capabilities, addedCapabilities };
}

const DETAILED_CHARGE_STATE_MAPPING: Array<[string, string]> = [
  ["DetailedChargeStateDisconnected", "plugged_out"],
  ["DetailedChargeStateNoPower", "plugged_in"],
  ["DetailedChargeStateStarting", "plugged_in_charging"],
  ["DetailedChargeStateCharging", "plugged_in_charging"],
  ["DetailedChargeStateComplete", "plugged_in"],
  ["DetailedChargeStateStopped", "plugged_in_paused"],
];

for (const [detailed, expected] of DETAILED_CHARGE_STATE_MAPPING) {
  test(`DetailedChargeState ${detailed} sets ev_charging_state to ${expected}`, async () => {
    const { stub, sse, capabilities } = createDeviceStub({
      ev_charging_state: undefined,
      evcharger_charging: undefined,
    });
    await stub.onInit();

    sse.data.emit("DetailedChargeState", detailed);

    assert.equal(capabilities["ev_charging_state"], expected);
  });
}

test("DetailedChargeState Unknown keeps the prior ev_charging_state", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    ev_charging_state: "plugged_in_charging",
  });
  await stub.onInit();

  sse.data.emit("DetailedChargeState", "DetailedChargeStateUnknown");

  assert.equal(capabilities["ev_charging_state"], "plugged_in_charging");
});

test("DetailedChargeState null keeps the prior ev_charging_state", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    ev_charging_state: "plugged_in",
  });
  await stub.onInit();

  sse.data.emit("DetailedChargeState", null);

  assert.equal(capabilities["ev_charging_state"], "plugged_in");
});

test("evcharger_charging still follows DetailedChargeState", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    ev_charging_state: undefined,
    evcharger_charging: undefined,
  });
  await stub.onInit();

  sse.data.emit("DetailedChargeState", "DetailedChargeStateCharging");
  assert.equal(capabilities["evcharger_charging"], true);
  assert.equal(capabilities["ev_charging_state"], "plugged_in_charging");

  sse.data.emit("DetailedChargeState", "DetailedChargeStateStopped");
  assert.equal(capabilities["evcharger_charging"], false);
  assert.equal(capabilities["ev_charging_state"], "plugged_in_paused");
});

test("an enabled Powershare session reports plugged_in_discharging, then falls back when it ends", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { ev_charging_state: undefined, powershare_status: undefined },
    CYBERTRUCK_VIN,
  );
  await stub.onInit();

  sse.data.emit("DetailedChargeState", "DetailedChargeStateNoPower");
  assert.equal(capabilities["ev_charging_state"], "plugged_in");

  sse.data.emit("PowershareStatus", "PowershareStateEnabled");
  assert.equal(capabilities["ev_charging_state"], "plugged_in_discharging");

  // A DetailedChargeState update during the session keeps it discharging.
  sse.data.emit("DetailedChargeState", "DetailedChargeStateStopped");
  assert.equal(capabilities["ev_charging_state"], "plugged_in_discharging");

  sse.data.emit("PowershareStatus", "PowershareStateStopped");
  assert.equal(capabilities["ev_charging_state"], "plugged_in_paused");
});

test("Powershare Enabled does not override a Disconnected DetailedChargeState", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { ev_charging_state: undefined, powershare_status: undefined },
    CYBERTRUCK_VIN,
  );
  await stub.onInit();

  sse.data.emit("PowershareStatus", "PowershareStateEnabled");
  sse.data.emit("DetailedChargeState", "DetailedChargeStateDisconnected");

  assert.equal(capabilities["ev_charging_state"], "plugged_out");
});

test("Powershare Enabled writes nothing before any DetailedChargeState arrives", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { ev_charging_state: undefined, powershare_status: undefined },
    CYBERTRUCK_VIN,
  );
  await stub.onInit();

  sse.data.emit("PowershareStatus", "PowershareStateEnabled");

  assert.equal(capabilities["ev_charging_state"], undefined);
});

test("Powershare Unknown keeps the last known Powershare status for ev_charging_state", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { ev_charging_state: undefined, powershare_status: undefined },
    CYBERTRUCK_VIN,
  );
  await stub.onInit();

  sse.data.emit("DetailedChargeState", "DetailedChargeStateNoPower");
  sse.data.emit("PowershareStatus", "PowershareStateEnabled");
  sse.data.emit("PowershareStatus", "PowershareStateUnknown");

  assert.equal(capabilities["ev_charging_state"], "plugged_in_discharging");
});

test("the vehicle driver manifest declares ev_charging_state", () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL("../drivers/vehicle/driver.compose.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(manifest.capabilities.includes("ev_charging_state"));
  assert.ok(manifest.capabilities.includes("evcharger_charging"));
});

test("ensureCapabilities adds ev_charging_state to an already-paired vehicle", async () => {
  const { stub, capabilities, addedCapabilities } = createDeviceStub({
    measure_battery: 50,
    evcharger_charging: false,
  });
  stub.driver.manifest.capabilities = [
    "measure_battery",
    "evcharger_charging",
    "ev_charging_state",
  ];

  await stub.ensureCapabilities();

  assert.deepEqual(addedCapabilities, ["ev_charging_state"]);
  assert.ok("evcharger_charging" in capabilities);
});

test("DetailedChargeState Unknown during an enabled Powershare session keeps the prior ev_charging_state", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { ev_charging_state: "plugged_in", powershare_status: undefined },
    CYBERTRUCK_VIN,
  );
  await stub.onInit();

  sse.data.emit("DetailedChargeState", "DetailedChargeStateUnknown");
  sse.data.emit("PowershareStatus", "PowershareStateEnabled");

  assert.equal(capabilities["ev_charging_state"], "plugged_in");
});
