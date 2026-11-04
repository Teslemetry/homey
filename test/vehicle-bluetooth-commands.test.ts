import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import { fakeBluetooth } from "./support/tesla-fleet-api-bluetooth-stub.js";
import { BluetoothTransportError, fakeCloud } from "./support/tesla-fleet-api-stub.js";

const VIN = "5YJ3E1EA0PF000001";
const OK = { response: { result: true, reason: "" } };

/** Records every command on one backend, answering OK unless `fail` or `refuse` names it. */
function backend(name: string, calls: string[], fail: Set<string> = new Set(), refuse: Set<string> = new Set()) {
  return new Proxy({}, {
    get: (_target, method) => (method === "then" || typeof method !== "string")
      ? undefined
      : async () => {
        calls.push(`${name}.${method}`);
        if (fail.has(method)) throw new BluetoothTransportError();
        if (refuse.has(method)) return { response: { result: false, reason: "refused" } };
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
  "auto_conditioning_start", "auto_conditioning_stop", "flash_lights", "honk_horn", "wake_up", "disconnect",
  "vehicle_state"];
function fake(name: string, calls: string[], fail?: Set<string>, refuse?: Set<string>) {
  const proxy = backend(name, calls, fail, refuse) as Record<string, unknown>;
  return Object.fromEntries(COMMANDS.map((command) => [command, proxy[command]]));
}

async function createPairedVehicle(
  opts: {
    atHome?: boolean;
    distanceKm?: number | null;
    paired?: boolean;
    bluetoothFails?: string[];
    carRefuses?: string[];
    /** Restarted with no internet: no Products generation, and no product bound yet. */
    offline?: boolean;
  } = {},
) {
  const calls: string[] = [];
  fakeBluetooth.vehicle = fake("ble", calls, new Set(opts.bluetoothFails), new Set(opts.carRefuses)) as never;
  fakeCloud.vehicle = fake("cloud", calls) as never;
  const store: Record<string, unknown> = opts.paired === false ? {} : {
    ble_key: "ab".repeat(32),
    ble_device: { id: "ble-uuid", name: "S1a87a5a75f3df858C" },
  };
  const capabilities: Record<string, unknown> = { "measure_distance.home": opts.distanceKm ?? null };
  const availability = { available: true, message: null as string | null };
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const app = {
    oauth: { getAccessToken: async () => "token" },
    ready: !opts.offline,
    products: undefined as unknown,
    isReady: () => app.ready,
    notReadyAvailability: () => ({ reason: "startup", message: "error.teslemetry_connecting" }),
  };
  const device = Object.assign(new VehicleDevice(), {
    homey: {
      app,
      ble: {},
      setTimeout: (callback: () => void, delay: number) => timers.push({ callback, delay }),
      clearTimeout: () => {},
      __: (key: string) => key,
    },
    vehicle: opts.offline ? undefined : { api: backend("teslemetry-api", calls) },
    driver: { manifest: { capabilitiesOptions: {} } },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: () => {},
    getData: () => ({ vin: VIN }),
    getName: () => "Model 3",
    getSetting: (key: string) => key === "ble_enabled",
    getStoreValue: (key: string) => (key in store ? store[key] : null),
    unsetStoreValue: async (key: string) => {
      delete store[key];
    },
    hasCapability: (capability: string) => capability in capabilities,
    getCapabilityValue: (capability: string) => capabilities[capability],
    setAvailable: async () => {
      availability.available = true;
      availability.message = null;
    },
    setUnavailable: async (message: string) => {
      availability.available = false;
      availability.message = message;
    },
    log: () => {},
    error: () => {},
  });
  // The car's own LocatedAtHome, as handleLocatedAtHome() records it.
  device.previousLocatedAtHome = opts.atHome;
  await device.startBluetooth();
  return { device, calls, availability, timers, app };
}

test.beforeEach(() => {
  fakeBluetooth.created.length = 0;
});

test("a paired car near Homey takes its commands over Bluetooth, with one short connect attempt", async () => {
  const { device, calls } = await createPairedVehicle({ atHome: true });

  await device.flowFlashLights();
  await device.flowSetChargeLimit(80);

  assert.deepEqual(calls, ["ble.flash_lights", "ble.set_charge_limit"]);
  const [{ options }] = fakeBluetooth.created as Array<{ options: Record<string, unknown> }>;
  assert.equal(options.max_connect_attempts, 1);
  assert.equal(options.connect_timeout_ms, 15_000);
  assert.equal(options.keepalive_interval_ms, null);
  assert.deepEqual(options.device, { id: "ble-uuid", name: "S1a87a5a75f3df858C" });
});

test("a paired car away from home goes straight to the cloud", async () => {
  const { device, calls } = await createPairedVehicle({ atHome: false });
  await device.flowStartCharging();
  assert.deepEqual(calls, ["cloud.charge_start"]);
});

test("a car at home uses Bluetooth even when Homey's own location is kilometres off", async () => {
  const { device, calls } = await createPairedVehicle({ atHome: true, distanceKm: 3.89 });
  await device.flowFlashLights();
  assert.deepEqual(calls, ["ble.flash_lights"]);
});

test("a Bluetooth link that fails before the car judged the command falls back to the cloud", async () => {
  const { device, calls } = await createPairedVehicle({ bluetoothFails: ["honk_horn"] });
  await device.flowHonkHorn();
  assert.deepEqual(calls, ["ble.honk_horn", "cloud.honk_horn"]);
});

test("turning Bluetooth off closes the link, and an unpaired car keeps the Teslemetry client", async () => {
  const paired = await createPairedVehicle({ atHome: true });
  await paired.device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
  await paired.device.flowFlashLights();
  assert.deepEqual(paired.calls, ["ble.disconnect", "teslemetry-api.flashLights"]);

  const unpaired = await createPairedVehicle({ paired: false });
  await unpaired.device.flowFlashLights();
  assert.deepEqual(unpaired.calls, ["teslemetry-api.flashLights"]);
  assert.equal(fakeBluetooth.created.length, 1, "only the paired car built a link");
});

test("a command the car refuses over Bluetooth fails and is not sent again on the cloud", async () => {
  const { device, calls } = await createPairedVehicle({ carRefuses: ["honk_horn"] });
  await assert.rejects(device.flowHonkHorn(), { message: "refused" });
  assert.deepEqual(calls, ["ble.honk_horn"]);
});

test("turning Bluetooth off while the link is still starting never installs it", async () => {
  const { device, calls } = await createPairedVehicle({ paired: false });
  device.getStoreValue = (key: string) => ({
    ble_key: "ab".repeat(32),
    ble_device: { id: "ble-uuid", name: "S1a87a5a75f3df858C" },
  })[key] ?? null;
  const starting = device.startBluetooth();
  await device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
  await starting;

  await device.flowFlashLights();
  assert.deepEqual(calls, ["ble.disconnect", "teslemetry-api.flashLights"]);
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a paired car that still answers over Bluetooth stays available when the cloud stream drops", async () => {
  const { device, calls, availability, timers } = await createPairedVehicle();
  device.markStreamStale("error.stream_disconnected");
  await settle();
  assert.deepEqual(calls, ["ble.vehicle_state"]);
  assert.equal(availability.available, true);
  assert.equal(timers.length, 0);
});

test("a paired car out of reach goes unavailable, and is asked again until it answers", async () => {
  const { device, calls, availability, timers } = await createPairedVehicle({ bluetoothFails: ["vehicle_state"] });
  device.markStreamStale("error.stream_disconnected");
  await settle();
  assert.equal(availability.available, false);
  assert.equal(availability.message, "error.stream_disconnected");
  assert.deepEqual(timers.map(({ delay }) => delay), [300_000]);

  fakeBluetooth.vehicle = { ...(fakeBluetooth.vehicle as object), vehicle_state: async () => ({}) } as never;
  await device.startBluetooth();
  timers.shift()!.callback();
  await settle();
  assert.equal(availability.available, true, "the car came back in reach");
  assert.deepEqual(calls, ["ble.vehicle_state"]);
});

test("a car without Bluetooth goes unavailable when the cloud stream drops, as before", async () => {
  const { device, availability } = await createPairedVehicle({ paired: false });
  device.markStreamStale("error.stream_disconnected");
  assert.equal(availability.available, false);
});

/** A paired car whose reach check waits until the test answers it. */
async function createVehicleAwaitingReach(opts: Parameters<typeof createPairedVehicle>[0] = {}) {
  const setup = await createPairedVehicle(opts);
  let answer: (reached: boolean) => void = () => {};
  fakeBluetooth.vehicle = {
    ...(fakeBluetooth.vehicle as object),
    vehicle_state: () => new Promise((resolve, reject) => {
      answer = (reached) => (reached ? resolve({}) : reject(new BluetoothTransportError()));
    }),
  } as never;
  await setup.device.startBluetooth();
  return { ...setup, answer: (reached: boolean) => answer(reached) };
}

test("a reach check still waiting when Bluetooth turns off is ignored, and schedules no retry", async () => {
  const { device, availability, timers, answer } = await createVehicleAwaitingReach();
  device.markStreamStale("error.stream_disconnected");
  await device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
  answer(false);
  await settle();
  assert.equal(availability.available, true);
  assert.equal(timers.length, 0);
});

test("a reach check still waiting when cloud data resumes cannot mark the car unavailable", async () => {
  const { device, availability, timers, answer } = await createVehicleAwaitingReach();
  device.markStreamStale("error.stream_disconnected");
  device.clearProductSilence();
  answer(false);
  await settle();
  assert.equal(availability.available, true);
  assert.equal(timers.length, 0);
});

test("after a restart with no internet, a paired car that answers over Bluetooth binds to its link alone", async () => {
  const { device, calls, availability, timers } = await createPairedVehicle({ offline: true });
  device.rebindProduct();
  assert.equal(availability.available, false, "unavailable until the car answers");
  assert.equal(availability.message, "error.teslemetry_connecting");
  await settle();
  assert.equal(availability.available, true);
  assert.equal(timers.length, 0);

  await device.flowFlashLights();
  await assert.rejects(device.flowStartKeylessDriving(), { message: "error.teslemetry_connecting" });
  assert.deepEqual(calls, ["ble.vehicle_state", "ble.flash_lights"]);
});

test("after a restart with no internet, a paired car out of reach is asked again until it answers", async () => {
  const { device, availability, timers } = await createPairedVehicle({ offline: true, bluetoothFails: ["vehicle_state"] });
  device.rebindProduct();
  await settle();
  assert.equal(availability.available, false);
  assert.equal(availability.message, "error.teslemetry_connecting");
  assert.deepEqual(timers.map(({ delay }) => delay), [300_000]);

  fakeBluetooth.vehicle = { ...(fakeBluetooth.vehicle as object), vehicle_state: async () => ({}) } as never;
  await device.startBluetooth();
  timers.shift()!.callback();
  await settle();
  assert.equal(availability.available, true, "the car came back in reach");
});

test("after a restart with no internet, a car without Bluetooth waits for the cloud, as before", async () => {
  const { device, calls, availability } = await createPairedVehicle({ offline: true, paired: false });
  device.rebindProduct();
  await settle();
  assert.equal(availability.available, false);
  assert.equal(availability.message, "error.teslemetry_connecting");
  assert.deepEqual(calls, []);
});

test("a car bound to its Bluetooth link alone moves onto the cloud when it is back, ignoring a late reach check", async () => {
  const { device, availability, timers, app, answer } = await createVehicleAwaitingReach({ offline: true });
  device.rebindProduct();
  const cloudVehicle = { vin: VIN, api: {}, sse: Object.assign(new EventEmitter(), { cache: {}, onSignal: () => () => {} }), metadata: { access: true, fleet_telemetry: "1", polling: false } };
  app.ready = true;
  app.products = { vehicles: { [VIN]: cloudVehicle } };
  device.rebindProduct();
  answer(false);
  await settle();
  assert.equal(device.vehicle, cloudVehicle);
  assert.equal(availability.available, true);
  assert.equal(timers.length, 0);
});

test("turning Bluetooth off with no internet unbinds a car that was bound to its link alone", async () => {
  const { device, availability } = await createPairedVehicle({ offline: true });
  device.rebindProduct();
  await settle();
  assert.equal(availability.available, true);
  await device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
  assert.equal(availability.available, false);
  assert.equal(availability.message, "error.teslemetry_connecting");
});
