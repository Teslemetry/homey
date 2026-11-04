import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import { fakeBluetooth } from "./support/tesla-fleet-api-bluetooth-stub.js";
import {
  BluetoothTimeout,
  BluetoothTransportError,
  NotOnWhitelistFault,
  WhitelistOperationLocalEntityAuthFailedTimedOutWaitingForTap,
} from "./support/tesla-fleet-api-stub.js";

const VIN = "5YJ3E1EA0PF000001";
const DEVICE = { id: "ble-uuid", name: "S1a87a5a75f3df858C" };

function createFakeVehicle(steps: { onCar?: boolean; pair?: () => Promise<void>; find?: () => Promise<unknown> } = {}) {
  const calls: string[] = [];
  fakeBluetooth.vehicle = {
    find_vehicle: async () => {
      calls.push("find_vehicle");
      return steps.find ? steps.find() : DEVICE;
    },
    connect: async () => {
      calls.push("connect");
    },
    handshakeVehicleSecurity: async () => {
      calls.push("handshake");
      if (!steps.onCar) throw new NotOnWhitelistFault();
    },
    pair: async () => {
      calls.push("pair");
      await steps.pair?.();
    },
    disconnect: async () => {
      calls.push("disconnect");
      return true;
    },
  } as never;
  return calls;
}

function createVehicle(store: Record<string, unknown> = {}) {
  const settings: Array<Record<string, unknown>> = [];
  let notified: (excerpt: string) => void = () => {};
  const notification = new Promise<string>((resolve) => {
    notified = resolve;
  });
  const device = Object.assign(new VehicleDevice(), {
    homey: {
      app: { oauth: { getAccessToken: async () => "token" } },
      ble: { name: "homey-ble" },
      notifications: {
        createNotification: async ({ excerpt }: { excerpt: string }) => notified(excerpt),
      },
      __: (key: string, tokens?: { name?: string }) => (tokens?.name ? `${tokens.name}: ${key}` : key),
    },
    getData: () => ({ vin: VIN }),
    getName: () => "Model 3",
    getStoreValue: (key: string) => (key in store ? store[key] : null),
    getSetting: (key: string) => key === "ble_enabled",
    setStoreValue: async (key: string, value: unknown) => {
      store[key] = value;
    },
    unsetStoreValue: async (key: string) => {
      delete store[key];
    },
    setSettings: async (values: Record<string, unknown>) => {
      settings.push(values);
    },
    log: () => {},
    error: () => {},
    destroyed: false,
  });
  return { device, store, settings, notification };
}

const turnOn = { newSettings: { ble_enabled: true }, changedKeys: ["ble_enabled"] };

test.beforeEach(() => {
  fakeBluetooth.created.length = 0;
});

test("turning Bluetooth on asks the car to add a new key and stores the car once a key card is tapped", async () => {
  const calls = createFakeVehicle();
  const { device, store, settings, notification } = createVehicle();

  assert.equal(await device.onSettings(turnOn), "local_vehicle.tap_key_card");
  assert.equal(await notification, "Model 3: local_vehicle.paired");

  assert.deepEqual(calls, ["find_vehicle", "connect", "handshake", "pair", "disconnect"]);
  assert.deepEqual(store.ble_device, DEVICE);
  assert.match(store.ble_key as string, /^[0-9a-f]{64}$/);
  const [{ vin, options, privateKey }] = fakeBluetooth.created as Array<{ vin: string; options: { transport: { ble: unknown }; keepalive_interval_ms: unknown }; privateKey: Buffer }>;
  assert.equal(vin, VIN);
  assert.equal(privateKey.toString("hex"), store.ble_key);
  assert.equal(options.keepalive_interval_ms, null, "pairing never keeps the car awake");
  assert.deepEqual(options.transport.ble, { name: "homey-ble" });
  assert.deepEqual(settings, []);
});

test("a key the car already has needs no key card, and the stored key is reused", async () => {
  const calls = createFakeVehicle({ onCar: true });
  const key = "ab".repeat(32);
  const { device, store, notification } = createVehicle({ ble_key: key });

  await device.onSettings(turnOn);
  assert.equal(await notification, "Model 3: local_vehicle.paired");
  assert.deepEqual(calls, ["find_vehicle", "connect", "handshake", "disconnect"]);
  assert.equal(store.ble_key, key);
});

test("a pairing that fails turns the setting back off and says why", async () => {
  const cases: Array<[Parameters<typeof createFakeVehicle>[0], string]> = [
    [{ find: async () => { throw new BluetoothTransportError(); } }, "local_vehicle.not_found"],
    [{ pair: async () => { throw new WhitelistOperationLocalEntityAuthFailedTimedOutWaitingForTap(); } }, "local_vehicle.tap_timeout"],
    [{ pair: async () => { throw new BluetoothTimeout(); } }, "local_vehicle.tap_timeout"],
  ];
  for (const [steps, message] of cases) {
    createFakeVehicle(steps);
    const { device, store, settings, notification } = createVehicle();
    await device.onSettings(turnOn);
    assert.equal(await notification, `Model 3: ${message}`);
    assert.deepEqual(settings, [{ ble_enabled: false }]);
    assert.equal(store.ble_device, undefined);
  }
});

test("turning Bluetooth off while the car waits for a key card stops the pairing quietly", async () => {
  let release: () => void = () => {};
  let waiting: () => void = () => {};
  const tapRequested = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  createFakeVehicle({
    pair: () => new Promise((resolve) => {
      release = resolve;
      waiting();
    }),
  });
  const { device, store, settings } = createVehicle();
  let notified = false;
  device.homey.notifications.createNotification = async () => {
    notified = true;
  };

  await device.onSettings(turnOn);
  await tapRequested;
  await device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
  release();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(notified, false);
  assert.equal(store.ble_device, undefined);
  assert.deepEqual(settings, []);
});

test("turning Bluetooth off forgets the car, so turning it on again checks the key is still on it", async () => {
  const calls = createFakeVehicle({ onCar: true });
  const { device, store, notification } = createVehicle({ ble_key: "ab".repeat(32), ble_device: DEVICE });

  await device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
  assert.equal(store.ble_device, undefined);

  await device.onSettings(turnOn);
  assert.equal(await notification, "Model 3: local_vehicle.paired");
  assert.deepEqual(calls, ["find_vehicle", "connect", "handshake", "disconnect"]);
  assert.deepEqual(store.ble_device, DEVICE);
});

test("a pairing a restart interrupted turns the setting back off and says so", async () => {
  const { device, settings, notification } = createVehicle({ ble_key: "ab".repeat(32) });
  await device.settleInterruptedPairing();
  assert.deepEqual(settings, [{ ble_enabled: false }]);
  assert.equal(await notification, "Model 3: local_vehicle.failed");

  const paired = createVehicle({ ble_key: "ab".repeat(32), ble_device: DEVICE });
  await paired.device.settleInterruptedPairing();
  assert.deepEqual(paired.settings, [], "a paired car is left alone");
});

test("turning Bluetooth off while the paired car is being stored reports nothing", async () => {
  const calls = createFakeVehicle({ onCar: true });
  const { device, settings } = createVehicle();
  let notified = false;
  device.homey.notifications.createNotification = async () => {
    notified = true;
  };
  // Waits for this pairing's own end, so it can never run on the next test's fake car.
  let turnedOff: () => void = () => {};
  const off = new Promise<void>((resolve) => {
    turnedOff = resolve;
  });
  const store = device.setStoreValue;
  device.setStoreValue = async (key: string, value: unknown) => {
    await store(key, value);
    if (key === "ble_device") {
      await device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
      turnedOff();
    }
  };

  await device.onSettings(turnOn);
  await off;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["find_vehicle", "connect", "handshake", "disconnect"]);
  assert.equal(notified, false);
  assert.deepEqual(settings, []);
});

test("a pairing turned off before it reached the car never touches the radio", async () => {
  const calls = createFakeVehicle({ onCar: true });
  const { device, settings } = createVehicle();
  let notified = false;
  device.homey.notifications.createNotification = async () => {
    notified = true;
  };

  await device.onSettings(turnOn);
  await device.onSettings({ newSettings: { ble_enabled: false }, changedKeys: ["ble_enabled"] });
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, []);
  assert.equal(notified, false);
  assert.deepEqual(settings, []);
});
