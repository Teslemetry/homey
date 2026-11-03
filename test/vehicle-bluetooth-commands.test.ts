import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import { fakeBluetooth } from "./support/tesla-fleet-api-bluetooth-stub.js";
import { BluetoothTransportError, fakeCloud } from "./support/tesla-fleet-api-stub.js";

const VIN = "5YJ3E1EA0PF000001";
const OK = { response: { result: true, reason: "" } };

/** Records every command on one backend, answering OK unless `fail` names it. */
function backend(name: string, calls: string[], fail: Set<string> = new Set()) {
  return new Proxy({}, {
    get: (_target, method) => (method === "then" || typeof method !== "string")
      ? undefined
      : async () => {
        calls.push(`${name}.${method}`);
        if (fail.has(method)) throw new BluetoothTransportError();
        return OK;
      },
  });
}

/**
 * The router finds a backend's methods on its prototype chain, so the fakes
 * are plain objects listing exactly the commands both backends have.
 */
const COMMANDS = ["door_lock", "door_unlock", "charge_start", "charge_stop", "set_charge_limit",
  "set_charging_amps", "charge_port_door_open", "charge_port_door_close", "actuate_trunk",
  "auto_conditioning_start", "auto_conditioning_stop", "flash_lights", "honk_horn", "wake_up", "disconnect"];
function fake(name: string, calls: string[], fail?: Set<string>) {
  const proxy = backend(name, calls, fail) as Record<string, unknown>;
  return Object.fromEntries(COMMANDS.map((command) => [command, proxy[command]]));
}

async function createPairedVehicle(opts: { distanceKm?: number | null; paired?: boolean; bluetoothFails?: string[] } = {}) {
  const calls: string[] = [];
  fakeBluetooth.vehicle = fake("ble", calls, new Set(opts.bluetoothFails)) as never;
  fakeCloud.vehicle = fake("cloud", calls) as never;
  const store: Record<string, unknown> = opts.paired === false ? {} : {
    ble_key: "ab".repeat(32),
    ble_device: { id: "ble-uuid", name: "S1a87a5a75f3df858C" },
  };
  const capabilities: Record<string, unknown> = { "measure_distance.home": opts.distanceKm ?? null };
  const device = Object.assign(Object.create(VehicleDevice.prototype), {
    homey: {
      app: { oauth: { getAccessToken: async () => "token" } },
      ble: {},
      setTimeout: (callback: () => void) => setImmediate(callback),
      __: (key: string) => key,
    },
    vehicle: { api: backend("teslemetry-api", calls) },
    getData: () => ({ vin: VIN }),
    getName: () => "Model 3",
    getSetting: (key: string) => key === "ble_enabled",
    getStoreValue: (key: string) => (key in store ? store[key] : null),
    unsetStoreValue: async (key: string) => {
      delete store[key];
    },
    hasCapability: (capability: string) => capability in capabilities,
    getCapabilityValue: (capability: string) => capabilities[capability],
    log: () => {},
    error: () => {},
  });
  await device.startBluetooth();
  return { device, calls };
}

test.beforeEach(() => {
  fakeBluetooth.created.length = 0;
});

test("a paired car near Homey takes its commands over Bluetooth, with one short connect attempt", async () => {
  const { device, calls } = await createPairedVehicle({ distanceKm: 0.02 });

  await device.flowFlashLights();
  await device.flowSetChargeLimit(80);

  assert.deepEqual(calls, ["ble.flash_lights", "ble.set_charge_limit"]);
  const [{ options }] = fakeBluetooth.created as Array<{ options: Record<string, unknown> }>;
  assert.equal(options.max_connect_attempts, 1);
  assert.equal(options.connect_timeout_ms, 4000);
  assert.equal(options.keepalive_interval_ms, null);
  assert.deepEqual(options.device, { id: "ble-uuid", name: "S1a87a5a75f3df858C" });
});

test("a paired car away from home goes straight to the cloud", async () => {
  const { device, calls } = await createPairedVehicle({ distanceKm: 3 });
  await device.flowStartCharging();
  assert.deepEqual(calls, ["cloud.charge_start"]);
});

test("a Bluetooth link that fails before the car judged the command falls back to the cloud", async () => {
  const { device, calls } = await createPairedVehicle({ bluetoothFails: ["honk_horn"] });
  await device.flowHonkHorn();
  assert.deepEqual(calls, ["ble.honk_horn", "cloud.honk_horn"]);
});

test("turning Bluetooth off closes the link, and an unpaired car keeps the Teslemetry client", async () => {
  const paired = await createPairedVehicle({ distanceKm: 0 });
  await paired.device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
  await paired.device.flowFlashLights();
  assert.deepEqual(paired.calls, ["ble.disconnect", "teslemetry-api.flashLights"]);

  const unpaired = await createPairedVehicle({ paired: false });
  await unpaired.device.flowFlashLights();
  assert.deepEqual(unpaired.calls, ["teslemetry-api.flashLights"]);
  assert.equal(fakeBluetooth.created.length, 1, "only the paired car built a link");
});
