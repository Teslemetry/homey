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
    /** Whether Homey hears the car's Bluetooth advertisement (default: it does). */
    heard?: boolean;
    /** A Homey with advertisement subscriptions (`ble-advertisements`). */
    listens?: boolean;
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
  // Homey's BLE manager: find() answers from its advertisement cache; nothing here reaches the car.
  const ble = {
    heard: opts.heard ?? true,
    calls: [] as string[],
    hold: false,
    pending: undefined as ((heard: boolean) => void) | undefined,
    find: async (uuid: string) => {
      ble.calls.push(`find ${uuid}`);
      const heard = ble.hold
        ? await new Promise<boolean>((resolve) => {
          ble.pending = resolve;
        })
        : ble.heard;
      if (!heard) throw new Error(`Peripheral Not Found: ${uuid}`);
      return { uuid, rssi: -60 };
    },
    subscribeToAdvertisements: async (uuid: string) => {
      ble.calls.push(`subscribe ${uuid}`);
    },
    unsubscribeFromAdvertisements: async (uuid: string) => {
      ble.calls.push(`unsubscribe ${uuid}`);
    },
  };
  let notified: (excerpt: string) => void = () => {};
  const notification = new Promise<string>((resolve) => {
    notified = resolve;
  });
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
      ble,
      hasFeature: (feature: string) => opts.listens === true && feature === "ble-advertisements",
      notifications: { createNotification: async ({ excerpt }: { excerpt: string }) => notified(excerpt) },
      setTimeout: (callback: () => void, delay: number) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer: unknown) => {
        const index = timers.indexOf(timer as never);
        if (index >= 0) timers.splice(index, 1);
      },
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
    setStoreValue: async (key: string, value: unknown) => {
      store[key] = value;
    },
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
  return { device, calls, ble, availability, timers, app, notification };
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
const pairingOnCar = () => {
  fakeBluetooth.vehicle = {
    ...(fakeBluetooth.vehicle as object),
    find_vehicle: async () => ({ id: "ble-uuid", name: "S1a87a5a75f3df858C" }),
    connect: async () => {},
    handshakeVehicleSecurity: async () => {},
  } as never;
};

test("a paired car Homey hears stays available when the cloud stream drops, and nothing connects to it", async () => {
  const { device, calls, ble, availability, timers } = await createPairedVehicle();
  device.markStreamStale("error.stream_disconnected");
  await settle();
  assert.equal(availability.available, true);
  assert.deepEqual(ble.calls, ["find ble-uuid"]);
  assert.deepEqual(calls, [], "no link to the car");
  assert.deepEqual(timers.map(({ delay }) => delay), [300_000], "a Homey that has to scan checks again in 5 minutes");
});

test("a paired car Homey does not hear goes unavailable when the cloud stream drops, and recovers once heard", async () => {
  const { device, calls, ble, availability, timers } = await createPairedVehicle({ heard: false });
  device.markStreamStale("error.stream_disconnected");
  await settle();
  assert.equal(availability.available, false);
  assert.equal(availability.message, "error.stream_disconnected");
  assert.deepEqual(timers.map(({ delay }) => delay), [300_000]);

  ble.heard = true;
  timers.shift()!.callback();
  await settle();
  assert.equal(availability.available, true, "the car came back in reach");
  assert.deepEqual(calls, []);
});

test("a Homey with advertisement subscriptions keeps its cache warm, checks every minute, and follows the car within 195 s", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { device, calls, ble, availability, timers } = await createPairedVehicle({ listens: true });
  await settle();
  assert.deepEqual(ble.calls, ["subscribe ble-uuid", "find ble-uuid"]);
  assert.deepEqual(timers.map(({ delay }) => delay), [60_000]);

  device.markStreamStale("error.stream_disconnected");
  assert.equal(availability.available, true, "heard a moment ago, so nothing to scan");
  assert.equal(ble.calls.length, 2);

  ble.heard = false;
  for (let minute = 1; minute <= 3; minute++) {
    t.mock.timers.tick(60_000);
    timers.shift()!.callback();
    await settle();
  }
  assert.equal(availability.available, true, "still inside 195 s of the last advertisement");
  t.mock.timers.tick(60_000);
  timers.shift()!.callback();
  await settle();
  assert.equal(availability.available, false, "not heard for 240 s");
  assert.equal(availability.message, "error.stream_disconnected");

  ble.heard = true;
  t.mock.timers.tick(60_000);
  timers.shift()!.callback();
  await settle();
  assert.equal(availability.available, true);

  await device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
  assert.equal(ble.calls.at(-1), "unsubscribe ble-uuid");
  assert.equal(timers.length, 0);
  assert.deepEqual(calls, ["ble.disconnect"], "nothing but closing the link it never opened");
});

test("with advertisement subscriptions, commands go over Bluetooth only while Homey hears the car, whatever LocatedAtHome says", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { device, calls, ble } = await createPairedVehicle({ listens: true, atHome: false });
  await settle();
  await device.flowFlashLights();
  ble.heard = false;
  t.mock.timers.tick(196_000);
  await device.flowHonkHorn();
  assert.deepEqual(calls, ["ble.flash_lights", "cloud.honk_horn"]);
});

test("cloud data arriving while the car is unavailable on a stream drop stops the checks", async () => {
  const { device, availability, timers } = await createPairedVehicle({ heard: false });
  device.markStreamStale("error.stream_disconnected");
  await settle();
  device.clearProductSilence();
  device.clearAvailabilityReason("stream");
  timers.shift()!.callback();
  await settle();
  assert.equal(availability.available, true);
  assert.equal(timers.length, 0, "a Homey that has to scan stops once the cloud is back");
});

test("a car without Bluetooth goes unavailable when the cloud stream drops, as before", async () => {
  const { device, availability } = await createPairedVehicle({ paired: false });
  device.markStreamStale("error.stream_disconnected");
  assert.equal(availability.available, false);
});

/** A paired car whose presence check waits until the test answers it. */
async function createVehicleAwaitingPresence(opts: Parameters<typeof createPairedVehicle>[0] = {}) {
  const setup = await createPairedVehicle(opts);
  setup.ble.hold = true;
  return { ...setup, answer: (heard: boolean) => setup.ble.pending?.(heard) };
}

test("a presence check still waiting when Bluetooth turns off is ignored, and schedules no other", async () => {
  for (const heard of [false, true]) {
    const { device, availability, timers, answer } = await createVehicleAwaitingPresence();
    device.markStreamStale("error.stream_disconnected");
    await device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
    answer(heard);
    await settle();
    assert.equal(availability.message, "error.stream_disconnected", "the stream is still down");
    assert.equal(timers.length, 0);
  }
});

test("on a Homey that has to scan, a car keeps its state while the check after a stream drop runs", async () => {
  const { device, availability, answer } = await createVehicleAwaitingPresence();
  device.markStreamStale("error.stream_disconnected");
  await settle();
  assert.equal(availability.available, true, "no 10 s blink to unavailable");
  answer(true);
  await settle();
  assert.equal(availability.available, true);
});

test("a presence check still waiting when cloud data resumes cannot mark the car unavailable", async () => {
  const { device, availability, timers, answer } = await createVehicleAwaitingPresence();
  device.markStreamStale("error.stream_disconnected");
  device.clearProductSilence();
  answer(false);
  await settle();
  assert.equal(availability.available, true);
  assert.equal(timers.length, 0);
});

test("after a restart with no internet, a paired car Homey hears binds to its link alone", async () => {
  const { device, calls, availability, timers } = await createPairedVehicle({ offline: true });
  device.rebindProduct();
  assert.equal(availability.available, false, "unavailable until Homey hears the car");
  assert.equal(availability.message, "error.teslemetry_connecting");
  await settle();
  assert.equal(availability.available, true);
  assert.deepEqual(timers.map(({ delay }) => delay), [300_000], "checked again while the cloud is down");

  await device.flowFlashLights();
  await assert.rejects(device.flowStartKeylessDriving(), { message: "error.teslemetry_connecting" });
  assert.deepEqual(calls, ["ble.flash_lights"]);
});

test("after a restart with no internet, a paired car Homey does not hear is checked again until it does", async () => {
  const { device, ble, availability, timers } = await createPairedVehicle({ offline: true, heard: false });
  device.rebindProduct();
  await settle();
  assert.equal(availability.available, false);
  assert.equal(availability.message, "error.teslemetry_connecting");
  assert.deepEqual(timers.map(({ delay }) => delay), [300_000]);

  ble.heard = true;
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

test("a car bound to its Bluetooth link alone moves onto the cloud when it is back, ignoring a late presence check", async () => {
  const { device, availability, timers, app, answer } = await createVehicleAwaitingPresence({ offline: true });
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

test("a startup presence check still waiting when the subscription lapses keeps the account message", async () => {
  const { device, availability, answer } = await createVehicleAwaitingPresence({ offline: true });
  device.rebindProduct();
  device.markUnavailable("auth", "error.subscription_required");
  answer(false);
  await settle();
  assert.equal(availability.message, "error.subscription_required");
});

test("turning Bluetooth on with no internet binds the car to its link once Homey's key is on it", { timeout: 10_000 }, async () => {
  const { device, calls, availability, notification } = await createPairedVehicle({ offline: true, paired: false });
  device.rebindProduct();
  pairingOnCar();
  await device.onSettings({ newSettings: { ble_enabled: true }, changedKeys: ["ble_enabled"] });
  assert.equal(await notification, "local_vehicle.paired");
  await settle();
  assert.equal(availability.available, true);

  await device.flowFlashLights();
  assert.deepEqual(calls.filter((call) => call !== "ble.disconnect"), ["ble.flash_lights"]);
});

test("turning Bluetooth off while the cloud stream is down leaves the car unavailable, whether or not Homey heard it", async () => {
  for (const heard of [true, false]) {
    const { device, availability } = await createPairedVehicle({ heard });
    device.markStreamStale("error.stream_disconnected");
    await settle();
    assert.equal(availability.available, heard);
    await device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
    assert.equal(availability.available, false);
    assert.equal(availability.message, "error.stream_disconnected");
  }
});

test("turning Bluetooth off after cloud data resumed leaves the car available", async () => {
  const { device, availability } = await createPairedVehicle();
  device.markStreamStale("error.stream_disconnected");
  await settle();
  device.clearProductSilence();
  await device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
  assert.equal(availability.available, true);
});

test("turning Bluetooth off while the cloud stream is down keeps a binding error's own message", async () => {
  const { device, availability } = await createPairedVehicle();
  device.markStreamStale("error.stream_disconnected");
  await settle();
  device.markUnavailable("binding", "error.vehicle_not_found");
  await device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
  assert.equal(availability.message, "error.vehicle_not_found");
});

for (const [when, paired] of [["back on", true], ["on after the stream dropped", false]] as const) {
  test(`turning Bluetooth ${when} while the cloud stream is down makes the car available once Homey hears it`, { timeout: 10_000 }, async () => {
    const { device, availability, notification } = await createPairedVehicle({ paired });
    device.markStreamStale("error.stream_disconnected");
    await settle();
    if (paired) await device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
    assert.equal(availability.available, false);

    pairingOnCar();
    await device.onSettings({ newSettings: { ble_enabled: true }, changedKeys: ["ble_enabled"] });
    assert.equal(await notification, "local_vehicle.paired");
    await settle();
    assert.equal(availability.available, true);
  });
}
