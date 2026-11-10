import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryApp from "../.homeybuild/app.js";
import GatewayDevice from "../.homeybuild/drivers/gateway/device.js";
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";
import { islandRefusal, LocalPowerwallSite } from "../.homeybuild/lib/LocalPowerwall.js";
import toError from "../.homeybuild/lib/toError.js";
import {
  fakeGateway,
  PowerwallAuthenticationError,
  PowerwallCommandError,
  PowerwallConnectionError,
  PowerwallKeyRejectedError,
} from "./support/tesla-fleet-api-powerwall-stub.js";
import {
  AuthorizedClientState,
  EnergyGatewayUnreachable,
  fakeCloud,
  TeslaFleetError,
} from "./support/tesla-fleet-api-stub.js";

const SITE_ID = "1689169815425134";
const GATEWAY = { host: "192.168.1.50", password: "ABCDE" };
// A small key: these tests only need a valid RSA PEM, never a 4096-bit one.
const { privateKey: KEY_PEM, publicKey: PUBLIC_DER } = generateKeyPairSync("rsa", {
  modulusLength: 1024,
  publicKeyEncoding: { type: "pkcs1", format: "der" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const PUBLIC_B64 = PUBLIC_DER.toString("base64");

/** Mirrors TeslemetryEnergySiteStream: `.on` replays the cached payload. */
class FakeEnergySiteStream extends EventEmitter {
  private cache = new Map<string, unknown>();
  siteInfoDocument: Record<string, unknown> | undefined;

  cacheAndEmit(event: string, payload: unknown) {
    this.cache.set(event, payload);
    this.emit(event, payload);
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    super.on(event, listener);
    if (this.cache.has(event)) listener(this.cache.get(event));
    return this;
  }
}

function createIntervals() {
  const intervals = new Map<number, () => void>();
  const delays = new Map<number, number>();
  let nextId = 1;
  return {
    intervals,
    setInterval: (callback: () => void, delay: number) => {
      const id = nextId++;
      intervals.set(id, callback);
      delays.set(id, delay);
      return id;
    },
    /** Runs the intervals of one period once and lets them settle. */
    tickEvery: async (delay: number) => {
      for (const [id, callback] of intervals) if (delays.get(id) === delay) callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
    clearInterval: (id: number) => {
      intervals.delete(id);
    },
    /** Runs every interval once and lets its poll settle. */
    tick: async () => {
      for (const callback of intervals.values()) callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function createFeed() {
  const timers = createIntervals();
  const app = {
    homey: {
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      __: (key: string) => key,
    },
    handleLocalPowerwallRead: () => {},
    handleLocalPowerwallLost: () => {},
    oauth: { getAccessToken: async () => "token" },
    log: () => {},
    error: () => {},
  };
  return { app, timers };
}

test.beforeEach(() => {
  fakeGateway.clients.length = 0;
  fakeGateway.liveStatus = async () => ({ response: {} });
  fakeGateway.verify = async () => {};
  fakeGateway.localConfig = async () => ({});
  fakeGateway.command = async () => {};
  fakeGateway.commands.length = 0;
  fakeCloud.site = {} as never;
  fakeCloud.created.length = 0;
});

test("the local feed overlays the gateway's readings on the cloud live_status, but never island_status", async () => {
  const { app, timers } = createFeed();
  const site = await LocalPowerwallSite.start(app as never, SITE_ID, GATEWAY, KEY_PEM);
  const cloud = new FakeEnergySiteStream();
  cloud.cacheAndEmit("live_status", {
    site_id: Number(SITE_ID),
    live_status: {
      grid_power: 1000,
      battery_power: 0,
      grid_status: "Active",
      island_status: "off_grid_intentional",
      storm_mode_active: true,
    },
  });
  const received: Array<Record<string, unknown>> = [];
  site.attach(cloud as never).on("live_status", (event: { live_status: Record<string, unknown> }) => {
    received.push(event.live_status);
  });

  fakeGateway.liveStatus = async () => ({
    response: { grid_power: -250, battery_power: 0, grid_status: "Inactive", island_status: "off_grid", storm_mode_active: null },
  });
  await timers.tick();

  assert.deepEqual(received.at(-1), {
    grid_power: -250,
    battery_power: 0,
    grid_status: "Inactive",
    island_status: "off_grid_intentional",
    storm_mode_active: true,
  });
  assert.equal(fakeGateway.clients[0].options.host, GATEWAY.host);
  assert.equal(fakeGateway.clients[0].options.gatewayPassword, GATEWAY.password);
});

test("a failed gateway read falls back to the cloud's values", async () => {
  const { app, timers } = createFeed();
  const site = await LocalPowerwallSite.start(app as never, SITE_ID, GATEWAY, KEY_PEM);
  const cloud = new FakeEnergySiteStream();
  cloud.cacheAndEmit("live_status", { live_status: { grid_power: 1000 } });
  const received: unknown[] = [];
  site.attach(cloud as never).on("live_status", (event: { live_status: unknown }) => {
    received.push(event.live_status);
  });

  fakeGateway.liveStatus = async () => ({ response: { grid_power: 400 } });
  await timers.tick();
  fakeGateway.liveStatus = async () => {
    throw new PowerwallConnectionError("unreachable");
  };
  await timers.tick();

  assert.deepEqual(received, [{ grid_power: 1000 }, { grid_power: 400 }, { grid_power: 1000 }]);
});

test("the feed follows a rebuilt generation's stream and stop() releases everything", async () => {
  const { app, timers } = createFeed();
  const site = await LocalPowerwallSite.start(app as never, SITE_ID, GATEWAY, KEY_PEM);
  const oldStream = new FakeEnergySiteStream();
  const newStream = new FakeEnergySiteStream();
  const received: unknown[] = [];
  const listener = (event: { live_status: unknown }) => received.push(event.live_status);
  site.attach(oldStream as never).on("live_status", listener);
  site.attach(newStream as never);

  oldStream.cacheAndEmit("live_status", { live_status: { grid_power: 1 } });
  newStream.cacheAndEmit("live_status", { live_status: { grid_power: 2 } });
  assert.deepEqual(received, [{ grid_power: 2 }]);

  site.stop();
  assert.equal(timers.intervals.size, 0);
  assert.equal(newStream.listenerCount("live_status"), 0);
  assert.equal(fakeGateway.clients[0].closed, true);
});

test("enabling a site's local link moves its Gateway device onto the merged live_status", async () => {
  const timers = createIntervals();
  const sse = new FakeEnergySiteStream();
  sse.cacheAndEmit("live_status", {
    live_status: { grid_power: 1000, grid_status: "Active", island_status: "on_grid" },
  });
  const site = { id: Number(SITE_ID), sse, metadata: { access: true } };
  const capabilities: Record<string, unknown> = {
    measure_power: null,
    "alarm_generic.off_grid": null,
    island_status: null,
  };
  const gateway = Object.assign(Object.create(GatewayDevice.prototype), {
    homey: {} as Record<string, unknown>,
    driver: { manifest: { capabilities: Object.keys(capabilities) }, getDevices: () => [gateway] },
    getData: () => ({ id: SITE_ID }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    log: () => {},
    error: () => {},
    destroyed: false,
  });
  const app = Object.assign(Object.create(TeslemetryApp.prototype), {
    products: { energySites: { [SITE_ID]: site } },
    homey: {
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      drivers: { getDrivers: () => ({ gateway: { getDevices: () => [gateway] } }) },
    },
    oauth: { getAccessToken: async () => "token" },
    log: () => {},
    error: () => {},
  });
  gateway.homey = {
    app,
    __: (key: string) => key,
    flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  gateway.rebindProduct();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capabilities.measure_power, 1000);

  fakeGateway.liveStatus = async () => ({
    response: { grid_power: 0, grid_status: "Inactive", island_status: "off_grid" },
  });
  await app.enableLocalPowerwall(SITE_ID, GATEWAY, KEY_PEM);
  await timers.tick();

  assert.equal(capabilities.measure_power, 0);
  assert.equal(capabilities["alarm_generic.off_grid"], true);
  assert.equal(capabilities.island_status, "on_grid");

  app.disableLocalPowerwall(SITE_ID);
  assert.equal(timers.intervals.size, 0);
  assert.equal(capabilities.measure_power, 1000);
});

function createPowerwall(opts: { store?: Record<string, unknown>; settings?: Record<string, unknown> } = {}) {
  const store: Record<string, unknown> = { local_gateway_key: KEY_PEM, ...opts.store };
  if (store.local_gateway_key === undefined) delete store.local_gateway_key;
  const notifications: string[] = [];
  let notified: (excerpt: string) => void = () => {};
  const notification = new Promise<string>((resolve) => {
    notified = resolve;
  });
  const calls: Array<[string, ...unknown[]]> = [];
  const app = {
    oauth: { getAccessToken: async () => "token" },
    enableLocalPowerwall: async (...args: unknown[]) => {
      calls.push(["enable", ...args]);
    },
    disableLocalPowerwall: (...args: unknown[]) => {
      calls.push(["disable", ...args]);
    },
    log: () => {},
  };
  const device = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app,
      __: (key: string, tokens?: { host?: string }) => (tokens?.host ? `${key} ${tokens.host}` : key),
      notifications: {
        createNotification: async ({ excerpt }: { excerpt: string }) => {
          notifications.push(excerpt);
          notified(excerpt);
        },
      },
    },
    getData: () => ({ id: SITE_ID }),
    getName: () => "Powerwall",
    getSetting: (key: string) => opts.settings?.[key],
    getStoreValue: (key: string) => (key in store ? store[key] : null),
    setStoreValue: async (key: string, value: unknown) => {
      store[key] = value;
    },
    log: () => {},
    error: () => {},
  });
  return { device, store, calls, notifications, notification };
}

function createCloudSite(states: Array<number | null>, address: string | null = GATEWAY.host) {
  const registered: unknown[][] = [];
  let lookups = 0;
  fakeCloud.site = {
    find_authorized_clients: async () => {
      const state = states[Math.min(lookups++, states.length - 1)];
      return { clients: state === null ? [] : [{ public_key: PUBLIC_B64, state }] };
    },
    add_authorized_client: async (...args: unknown[]) => {
      registered.push(args);
      return {};
    },
    find_gateway_address: async () => address,
  } as never;
  return { registered };
}

const enable = (settings: Record<string, unknown> = {}) => ({
  newSettings: { local_enabled: true, local_host: "", local_password: "ABCDE", ...settings },
  changedKeys: ["local_enabled"],
});

test("enrolling registers Homey's key once, then waits for the owner to approve it on the Powerwall", async () => {
  const { device, calls } = createPowerwall();
  const { registered } = createCloudSite([null, AuthorizedClientState.PENDING_VERIFICATION]);

  await assert.rejects(device.onSettings(enable()), { message: "local_powerwall.approve" });
  await assert.rejects(device.onSettings(enable()), { message: "local_powerwall.approve" });

  assert.equal(registered.length, 1);
  const [publicKey, description, keyType, clientType] = registered[0] as [Buffer, string, number, number];
  assert.equal(publicKey.toString("base64"), PUBLIC_B64);
  assert.deepEqual([description, keyType, clientType], ["Homey", 1, 1]);
  assert.deepEqual(fakeCloud.created, [Number(SITE_ID), Number(SITE_ID)]);
  assert.deepEqual(calls, []);
});

test("an approval window that expired registers the key again", async () => {
  const { device } = createPowerwall();
  const { registered } = createCloudSite([AuthorizedClientState.PENDING_VERIFICATION_TIMEOUT]);

  await assert.rejects(device.onSettings(enable()), { message: "local_powerwall.approve" });
  assert.equal(registered.length, 1);
});

test("an approved key with a verified gateway stores the looked-up address and starts the local link", async () => {
  const { device, store, calls } = createPowerwall();
  createCloudSite([AuthorizedClientState.VERIFIED]);

  const message = await device.onSettings(enable());

  assert.equal(message, `local_powerwall.connected ${GATEWAY.host}`);
  assert.deepEqual(store.local_gateway, GATEWAY);
  assert.deepEqual(calls, [["enable", SITE_ID, GATEWAY, KEY_PEM]]);
  assert.equal(fakeGateway.clients[0].options.host, GATEWAY.host);
  assert.equal(fakeGateway.clients[0].closed, true);
});

test("each gateway refusal names what the owner has to fix", async () => {
  const cases: Array<[() => Error, string]> = [
    [() => new PowerwallAuthenticationError("bad password"), "local_powerwall.wrong_password"],
    [() => new PowerwallKeyRejectedError("not approved"), "local_powerwall.approve"],
    [() => new PowerwallConnectionError("timeout"), "local_powerwall.gateway_unreachable"],
  ];
  for (const [refusal, message] of cases) {
    const { device, store, calls } = createPowerwall();
    createCloudSite([AuthorizedClientState.VERIFIED]);
    fakeGateway.verify = async () => {
      throw refusal();
    };
    await assert.rejects(device.onSettings(enable({ local_host: "192.168.1.60" })), { message });
    assert.equal(fakeGateway.clients.at(-1)?.options.host, "192.168.1.60");
    assert.equal(store.local_gateway, undefined);
    assert.deepEqual(calls, []);
  }
});

test("enrolment stops before the gateway when Tesla cannot reach it or no address is known", async () => {
  const unreachable = createPowerwall();
  fakeCloud.site = {
    find_authorized_clients: async () => {
      throw new EnergyGatewayUnreachable();
    },
  } as never;
  await assert.rejects(unreachable.device.onSettings(enable()), { message: "local_powerwall.cloud_unreachable" });

  const noAddress = createPowerwall();
  createCloudSite([AuthorizedClientState.VERIFIED], null);
  await assert.rejects(noAddress.device.onSettings(enable()), { message: "local_powerwall.host_not_found" });
  assert.equal(fakeGateway.clients.length, 0);
});

test("turning local off stops the link this device started, and a restart resumes a verified enrolment", async () => {
  const { device, calls } = createPowerwall({
    store: { local_gateway: GATEWAY },
    settings: { local_enabled: true },
  });
  await device.startLocalLink();
  await device.onSettings({ newSettings: { local_enabled: false }, changedKeys: ["local_enabled"] });

  assert.deepEqual(calls, [
    ["enable", SITE_ID, GATEWAY, KEY_PEM],
    ["disable", SITE_ID],
  ]);
});

test("on Homey Cloud the local connection is refused with a plain reason, and turning it off still works", async () => {
  const { device, store, calls } = createPowerwall({ store: { local_gateway_key: undefined } });
  device.homey.platform = "cloud";
  const { registered } = createCloudSite([null]);

  await assert.rejects(device.onSettings(enable()), { message: "local_powerwall.needs_homey_pro" });
  await device.onSettings({ newSettings: { local_enabled: false }, changedKeys: ["local_enabled"] });

  assert.equal(store.local_gateway_key, undefined, "no key was generated");
  assert.equal(registered.length, 0);
  assert.deepEqual(calls, []);
});

/** A Powerwall device on an enrolled site whose gateway has answered (or not) one poll. */
async function createEnrolledPowerwall(gatewayAnswers: boolean) {
  const { app, timers } = createFeed();
  const cloudCalls: unknown[][] = [];
  fakeCloud.site = {
    backup: async (...args: unknown[]) => cloudCalls.push(["backup", ...args]),
    operation: async (...args: unknown[]) => cloudCalls.push(["operation", ...args]),
    grid_import_export: async (...args: unknown[]) => cloudCalls.push(["grid_import_export", ...args]),
    dispatch_battery_power: async (...args: unknown[]) => cloudCalls.push(["dispatch_battery_power", ...args]),
    resume_battery_operation: async (...args: unknown[]) => cloudCalls.push(["resume_battery_operation", ...args]),
    set_island_mode: async (...args: unknown[]) => cloudCalls.push(["set_island_mode", ...args]),
  } as never;
  const site = await LocalPowerwallSite.start(app as never, SITE_ID, GATEWAY, KEY_PEM);
  fakeGateway.liveStatus = gatewayAnswers
    ? async () => ({ response: {} })
    : async () => {
      throw new PowerwallConnectionError("unreachable");
    };
  await timers.tick();
  const cloudApi = new Proxy({}, { get: (_target, method) => async () => cloudCalls.push(["teslemetry-api", method]) });
  const device = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app: { localPowerwallSites: new Map([[SITE_ID, site]]), products: {} },
      __: (key: string) => key,
    },
    site: { api: cloudApi },
    getData: () => ({ id: SITE_ID }),
    getName: () => "Powerwall",
    log: () => {},
    error: () => {},
  });
  return { device, cloudCalls, site };
}

test("an enrolled Powerwall sends backup reserve, operation mode and grid settings to its gateway", async () => {
  const { device, cloudCalls, site } = await createEnrolledPowerwall(true);

  await device.flowSetBackupReserve(30);
  await device.flowSetOperationMode("backup");
  await device.flowSetAllowExport("never");

  assert.deepEqual(fakeGateway.commands, [
    ["backup", 30],
    ["operation", "backup"],
    ["grid_import_export", null, "never"],
  ]);
  assert.deepEqual(cloudCalls, []);
  site.stop();
});

test("a gateway that is not answering, or fails mid-command, leaves the command to the cloud", async () => {
  const down = await createEnrolledPowerwall(false);
  await down.device.flowSetBackupReserve(30);
  assert.deepEqual(fakeGateway.commands, [], "an unhealthy gateway is not tried at all");
  assert.deepEqual(down.cloudCalls, [["backup", 30]]);
  down.site.stop();

  const flaky = await createEnrolledPowerwall(true);
  fakeGateway.command = async () => {
    throw new PowerwallConnectionError("reset");
  };
  await flaky.device.flowSetOperationMode("self_consumption");
  assert.deepEqual(flaky.cloudCalls, [["operation", "self_consumption"]]);
  flaky.site.stop();
});

test("a command the gateway refuses is not retried on the cloud", async () => {
  const { device, cloudCalls, site } = await createEnrolledPowerwall(true);
  fakeGateway.command = async () => {
    throw new PowerwallCommandError("refused");
  };
  await assert.rejects(device.flowSetBackupReserve(30), PowerwallCommandError);
  assert.deepEqual(fakeGateway.commands, [["backup", 30]]);
  assert.deepEqual(cloudCalls, []);
  site.stop();
});

test("an enrolled Powerwall dispatches and resumes its battery through its gateway", async () => {
  const { device, cloudCalls, site } = await createEnrolledPowerwall(true);

  await device.flowDispatchBatteryPower(-5000, 1800);
  await device.flowResumeBatteryOperation();

  assert.deepEqual(fakeGateway.commands, [
    ["dispatch_battery_power", -5000, 1800],
    ["resume_battery_operation"],
  ]);
  assert.deepEqual(cloudCalls, []);
  site.stop();
});

test("a dispatch to a gateway that is not answering goes to the cloud", async () => {
  const { device, cloudCalls, site } = await createEnrolledPowerwall(false);

  await device.flowDispatchBatteryPower(3000, 60);
  await device.flowResumeBatteryOperation();

  assert.deepEqual(fakeGateway.commands, []);
  assert.deepEqual(cloudCalls, [["dispatch_battery_power", 3000, 60], ["resume_battery_operation"]]);
  site.stop();
});

test("a dispatch on a site without a local link goes to the Teslemetry client", async () => {
  const { device, cloudCalls, site } = await createEnrolledPowerwall(true);
  device.homey.app.localPowerwallSites = undefined;

  await device.flowDispatchBatteryPower(3000, 60);
  await device.flowResumeBatteryOperation();

  assert.deepEqual(cloudCalls, [
    ["teslemetry-api", "dispatchBatteryPower"],
    ["teslemetry-api", "resumeBatteryOperation"],
  ]);
  assert.deepEqual(fakeGateway.commands, []);
  site.stop();
});

test("a cloud fallback the gateway is not paired for says to pair it or use the local connection", async () => {
  const { device, site } = await createEnrolledPowerwall(false);
  const notPaired = new TeslaFleetError(
    { error: "energy_site_not_paired", error_description: "Teslemetry's key is not paired" },
    409,
  );
  (fakeCloud.site as Record<string, unknown>).dispatch_battery_power = async () => {
    throw notPaired;
  };
  (fakeCloud.site as Record<string, unknown>).resume_battery_operation = async () => {
    throw notPaired;
  };

  await assert.rejects(device.flowDispatchBatteryPower(3000, 60), { message: "error.energy_site_not_paired" });
  await assert.rejects(device.flowResumeBatteryOperation(), { message: "error.energy_site_not_paired" });
  site.stop();
});

test("the Teslemetry client's refusal for a gateway it is not paired with says to pair it", () => {
  const en = JSON.parse(readFileSync(new URL("../locales/en.json", import.meta.url), "utf8"));
  // The SDK rejects with the api's parsed error body, not an Error.
  const error = toError(
    { error: "energy_site_not_paired", error_description: "Energy site is not paired" },
    (key: string) => key.split(".").reduce((node, part) => node?.[part], en) ?? key,
  );
  assert.equal(error.message, en.error.energy_site_not_paired);
});

test("a power the gateway refuses as out of range says so, and is not retried on the cloud", async () => {
  const { device, cloudCalls, site } = await createEnrolledPowerwall(true);
  fakeGateway.command = async () => {
    throw new PowerwallCommandError("dispatch_battery_power_request", 11, "OUT_OF_RANGE");
  };

  await assert.rejects(device.flowDispatchBatteryPower(-20000, 60), { message: "error.dispatch_out_of_range" });
  assert.deepEqual(cloudCalls, []);

  fakeGateway.command = async () => {
    throw new PowerwallCommandError("dispatch_battery_power_request", 3, "INVALID_ARGUMENT");
  };
  await assert.rejects(device.flowDispatchBatteryPower(-20000, 60), PowerwallCommandError);
  site.stop();
});

test("a Powerwall on a site without a local link keeps every command on the Teslemetry client", async () => {
  const { device, cloudCalls, site } = await createEnrolledPowerwall(true);
  device.homey.app.localPowerwallSites = undefined;

  await device.flowSetBackupReserve(30);
  assert.deepEqual(cloudCalls, [["teslemetry-api", "setBackupReserve"]]);
  assert.deepEqual(fakeGateway.commands, []);
  site.stop();
});

test("an enrolled site's backup reserve and operation mode come from its gateway, over the cloud's site_info", async () => {
  const { app, timers } = createFeed();
  const site = await LocalPowerwallSite.start(app as never, SITE_ID, GATEWAY, KEY_PEM);
  const cloud = new FakeEnergySiteStream();
  site.attach(cloud as never);
  fakeGateway.localConfig = async () => ({ backup_reserve_percent: 45, default_real_mode: "backup" });
  await timers.tickEvery(30_000);
  assert.equal(site.siteInfoDocument, undefined, "the gateway alone cannot fill site_info");

  let updates = 0;
  site.on("site_info", () => updates++);
  cloud.siteInfoDocument = { backup_reserve_percent: 20, default_real_mode: "self_consumption", installation_time_zone: "Australia/Brisbane" };
  cloud.cacheAndEmit("site_info", {});
  await timers.tickEvery(30_000);

  assert.deepEqual(site.siteInfoDocument, {
    backup_reserve_percent: 45,
    default_real_mode: "backup",
    installation_time_zone: "Australia/Brisbane",
  });
  assert.equal(updates, 2);
  site.stop();
});

test("a command's value survives a config read that started before it", async () => {
  const { app, timers } = createFeed();
  const site = await LocalPowerwallSite.start(app as never, SITE_ID, GATEWAY, KEY_PEM);
  await timers.tick();
  const cloud = new FakeEnergySiteStream();
  cloud.siteInfoDocument = { backup_reserve_percent: 20 };
  cloud.cacheAndEmit("site_info", {});
  site.attach(cloud as never);

  let answer: (config: unknown) => void = () => {};
  fakeGateway.localConfig = () => new Promise((resolve) => {
    answer = resolve;
  });
  await timers.tickEvery(30_000);
  await site.backup(30);
  answer({ backup_reserve_percent: 20 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fakeGateway.commands, [["backup", 30]]);
  assert.equal(site.siteInfoDocument?.backup_reserve_percent, 30);
  site.stop();
});

test("an enrolled Powerwall device shows the gateway's backup reserve, and goes back to the cloud's when local is off", async () => {
  const timers = createIntervals();
  const sse = new FakeEnergySiteStream();
  sse.siteInfoDocument = { backup_reserve_percent: 20, default_real_mode: "self_consumption", components: {} };
  sse.cacheAndEmit("site_info", {});
  const site = { id: Number(SITE_ID), sse, metadata: { access: true }, api: {} };
  const capabilities: Record<string, unknown> = { backup_reserve: null, operation_mode: null };
  const powerwall = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {} as Record<string, unknown>,
    driver: { manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} }, getDevices: () => [powerwall] },
    getData: () => ({ id: SITE_ID }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
    destroyed: false,
  });
  const app = Object.assign(Object.create(TeslemetryApp.prototype), {
    products: { energySites: { [SITE_ID]: site } },
    homey: {
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      drivers: { getDrivers: () => ({ battery: { getDevices: () => [powerwall] } }) },
    },
    oauth: { getAccessToken: async () => "token" },
    log: () => {},
    error: () => {},
  });
  powerwall.homey = { app, __: (key: string) => key, setTimeout: () => 0, clearTimeout: () => {} };

  fakeGateway.localConfig = async () => ({ backup_reserve_percent: 45, default_real_mode: "backup" });
  await app.enableLocalPowerwall(SITE_ID, GATEWAY, KEY_PEM);
  await timers.tickEvery(30_000);
  assert.equal(capabilities.backup_reserve, 0.45);
  assert.equal(capabilities.operation_mode, "backup");

  app.disableLocalPowerwall(SITE_ID);
  assert.equal(capabilities.backup_reserve, 0.2);
  assert.equal(capabilities.operation_mode, "self_consumption");
});

test("a command's held value survives a tariff update, but a refused command is never held", async () => {
  const { app, timers } = createFeed();
  fakeCloud.site = { backup: async () => ({ response: { result: false, reason: "refused" } }) } as never;
  const site = await LocalPowerwallSite.start(app as never, SITE_ID, GATEWAY, KEY_PEM);
  await timers.tick();
  const cloud = new FakeEnergySiteStream();
  cloud.siteInfoDocument = { backup_reserve_percent: 20, tariff_content_v2: { code: "OLD" } };
  cloud.cacheAndEmit("site_info", {});
  site.attach(cloud as never);

  await site.backup(30);
  fakeGateway.localConfig = async () => {
    throw new PowerwallConnectionError("unreachable");
  };
  await timers.tickEvery(30_000);
  cloud.siteInfoDocument = { backup_reserve_percent: 20, tariff_content_v2: { code: "NEW" } };
  cloud.cacheAndEmit("tariff_content_v2", {});
  assert.equal(site.siteInfoDocument?.backup_reserve_percent, 30, "a tariff event is not a reserve report");
  assert.deepEqual(site.siteInfoDocument?.tariff_content_v2, { code: "NEW" });

  // The gateway stops answering, so the next command goes to the cloud, which refuses it.
  fakeGateway.liveStatus = async () => {
    throw new PowerwallConnectionError("unreachable");
  };
  await timers.tick();
  cloud.cacheAndEmit("site_info", {});
  await site.backup(50);
  assert.equal(site.siteInfoDocument?.backup_reserve_percent, 20);
  site.stop();
});

test("the first save does not wait for Homey's new key: it registers it in the background and says when to approve", { timeout: 30_000 }, async () => {
  const { device, store, calls, notifications, notification } = createPowerwall({ store: { local_gateway_key: undefined } });
  const { registered } = createCloudSite([null]);
  // Hold the registration's first cloud read, so a save can land after the key is stored.
  const lookUp = (fakeCloud.site as { find_authorized_clients: () => Promise<unknown> }).find_authorized_clients;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookups = 0;
  (fakeCloud.site as { find_authorized_clients: () => Promise<unknown> }).find_authorized_clients = async () => {
    lookups++;
    await held;
    return lookUp();
  };

  await assert.rejects(device.onSettings(enable()), { message: "local_powerwall.preparing" });
  const deadline = performance.now() + 30_000;
  while (lookups === 0 && performance.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof store.local_gateway_key, "string", "the key is stored before it is registered");
  // Saving again while the key is still registering starts no second pass. Not
  // awaited first: a second pass would wait on the held read and never settle.
  const second = device.onSettings(enable()).then(
    () => "saved",
    (error: Error) => error.message,
  );
  let outcome: string | undefined;
  second.then((value) => {
    outcome = value;
  });
  const settled = performance.now() + 2_000;
  while (outcome === undefined && lookups === 1 && performance.now() < settled) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(lookups, 1);
  assert.equal(outcome, "local_powerwall.preparing");
  release();

  assert.equal(await notification, "Powerwall: local_powerwall.key_ready");
  assert.match(store.local_gateway_key as string, /^-----BEGIN RSA PRIVATE KEY-----/);
  assert.equal(registered.length, 1);
  assert.deepEqual(notifications, ["Powerwall: local_powerwall.key_ready"]);
  assert.deepEqual(calls, [], "nothing is enabled before the owner approves");
});

test("a background registration that fails says why", async () => {
  const { device, notification } = createPowerwall({ store: { local_gateway_key: undefined } });
  fakeCloud.site = {
    find_authorized_clients: async () => {
      throw new EnergyGatewayUnreachable();
    },
  } as never;

  await assert.rejects(device.onSettings(enable()), { message: "local_powerwall.preparing" });
  assert.equal(await notification, "Powerwall: local_powerwall.cloud_unreachable");
});

test("a notification that fails ends the background registration quietly, and the next save carries on", async () => {
  const { device } = createPowerwall({ store: { local_gateway_key: undefined } });
  createCloudSite([null, AuthorizedClientState.PENDING_VERIFICATION]);
  let attempted: () => void = () => {};
  const notifying = new Promise<void>((resolve) => {
    attempted = resolve;
  });
  device.homey.notifications.createNotification = async () => {
    attempted();
    throw new Error("notifications unavailable");
  };

  await assert.rejects(device.onSettings(enable()), { message: "local_powerwall.preparing" });
  await notifying;
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(device.onSettings(enable()), { message: "local_powerwall.approve" });
});

/** A Gateway device on an enrolled site whose gateway has answered (or not) one poll. */
async function createEnrolledGateway(gatewayAnswers: boolean) {
  const { device: powerwall, cloudCalls, site } = await createEnrolledPowerwall(gatewayAnswers);
  const device = Object.assign(Object.create(GatewayDevice.prototype), {
    homey: powerwall.homey,
    site: {
      api: {
        setIslandMode: async (...args: unknown[]) => {
          cloudCalls.push(["teslemetry-api", "setIslandMode", ...args]);
          return { response: { result: 1 } };
        },
      },
    },
    getData: () => ({ id: SITE_ID }),
    getName: () => "Gateway",
    log: () => {},
    error: () => {},
  });
  return { device, cloudCalls, site };
}

test("an enrolled site's Gateway goes off-grid and reconnects through its gateway", async () => {
  const { device, cloudCalls, site } = await createEnrolledGateway(true);

  await device.flowSetIslandMode(true);
  await device.flowSetIslandMode(false);

  assert.deepEqual(fakeGateway.commands, [
    ["set_island_mode", 6, true],
    ["set_island_mode", 1, undefined],
  ]);
  assert.deepEqual(cloudCalls, []);
  site.stop();
});

test("an island command to a gateway that is not answering goes to the cloud", async () => {
  const { device, cloudCalls, site } = await createEnrolledGateway(false);

  await device.flowSetIslandMode(true);

  assert.deepEqual(fakeGateway.commands, []);
  assert.deepEqual(cloudCalls, [["set_island_mode", 6, true]]);
  site.stop();
});

test("an island command on a site without a local link goes to the Teslemetry client", async () => {
  const { device, cloudCalls, site } = await createEnrolledGateway(true);
  device.homey.app.localPowerwallSites = undefined;

  await device.flowSetIslandMode(true);
  await device.flowSetIslandMode(false);

  assert.deepEqual(cloudCalls, [
    ["teslemetry-api", "setIslandMode", 6, true],
    ["teslemetry-api", "setIslandMode", 1, undefined],
  ]);
  assert.deepEqual(fakeGateway.commands, []);
  site.stop();
});

test("the gateway's refusal to go off-grid says why, and is not retried on the cloud", async () => {
  const { device, cloudCalls, site } = await createEnrolledGateway(true);
  fakeGateway.command = async () => {
    throw new PowerwallCommandError("set_island_mode_request", 4, "TEG_SET_ISLAND_MODE_RESULT_REJECTED_LOW_ENERGY");
  };

  await assert.rejects(device.flowSetIslandMode(true), { message: "error.island_low_energy" });
  assert.deepEqual(cloudCalls, []);

  // The same number as a gRPC status is not a refusal reason.
  fakeGateway.command = async () => {
    throw new PowerwallCommandError("set_island_mode_request", 4, "DEADLINE_EXCEEDED");
  };
  await assert.rejects(device.flowSetIslandMode(true), PowerwallCommandError);
  site.stop();
});

test("a cloud fallback's island refusal says why, or to pair the gateway", async () => {
  const { device, site } = await createEnrolledGateway(false);
  const cloud = fakeCloud.site as Record<string, unknown>;

  cloud.set_island_mode = async () => {
    throw new TeslaFleetError({ code: 5, message: "TEG_SET_ISLAND_MODE_RESULT_REJECTED_EXCESSIVE_SOLAR" }, 540);
  };
  await assert.rejects(device.flowSetIslandMode(true), { message: "error.island_excessive_solar" });

  cloud.set_island_mode = async () => {
    throw new TeslaFleetError({ error: "energy_site_not_paired" }, 409);
  };
  await assert.rejects(device.flowSetIslandMode(true), { message: "error.energy_site_not_paired" });
  site.stop();
});

test("a refusal the Teslemetry client resolves with fails the card with the reason", async () => {
  const { device, site } = await createEnrolledGateway(true);
  device.homey.app.localPowerwallSites = undefined;

  for (const [result, message] of [
    [2, "error.island_not_ready_for_islanding"],
    ["TEG_SET_ISLAND_MODE_RESULT_REJECTED_LOAD_DROP_EXPECTED", "error.island_load_drop_expected"],
  ] as const) {
    device.site.api.setIslandMode = async () => ({ response: { result } });
    await assert.rejects(device.flowSetIslandMode(true), { message });
  }

  for (const response of [{ result: "TEG_SET_ISLAND_MODE_RESULT_ACCEPTED" }, { request_id: "1" }, undefined]) {
    device.site.api.setIslandMode = async () => ({ response });
    await device.flowSetIslandMode(true);
  }
  site.stop();
});

test("every island refusal has its message", () => {
  const en = JSON.parse(readFileSync(new URL("../locales/en.json", import.meta.url), "utf8"));
  for (const result of [2, 3, 4, 5]) {
    const key = islandRefusal(result);
    assert.ok(key && en.error[key.slice("error.".length)], String(result));
  }
  for (const result of [0, 1, 6, undefined, "OUT_OF_RANGE"]) assert.equal(islandRefusal(result), undefined);
});
