import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryApp from "../.homeybuild/app.js";
import GatewayDevice from "../.homeybuild/drivers/gateway/device.js";
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";
import { LocalPowerwallSite } from "../.homeybuild/lib/LocalPowerwall.js";
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
  let nextId = 1;
  return {
    intervals,
    setInterval: (callback: () => void) => {
      const id = nextId++;
      intervals.set(id, callback);
      return id;
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
    homey: { setInterval: timers.setInterval, clearInterval: timers.clearInterval },
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
    homey: { app, __: (key: string, tokens?: { host?: string }) => (tokens?.host ? `${key} ${tokens.host}` : key) },
    getData: () => ({ id: SITE_ID }),
    getSetting: (key: string) => opts.settings?.[key],
    getStoreValue: (key: string) => (key in store ? store[key] : null),
    setStoreValue: async (key: string, value: unknown) => {
      store[key] = value;
    },
    log: () => {},
    error: () => {},
  });
  return { device, store, calls };
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

/** A Powerwall device on an enrolled site whose gateway has answered (or not) one poll. */
async function createEnrolledPowerwall(gatewayAnswers: boolean) {
  const { app, timers } = createFeed();
  const cloudCalls: unknown[][] = [];
  fakeCloud.site = {
    backup: async (...args: unknown[]) => cloudCalls.push(["backup", ...args]),
    operation: async (...args: unknown[]) => cloudCalls.push(["operation", ...args]),
    grid_import_export: async (...args: unknown[]) => cloudCalls.push(["grid_import_export", ...args]),
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

test("a Powerwall on a site without a local link keeps every command on the Teslemetry client", async () => {
  const { device, cloudCalls, site } = await createEnrolledPowerwall(true);
  device.homey.app.localPowerwallSites = undefined;

  await device.flowSetBackupReserve(30);
  assert.deepEqual(cloudCalls, [["teslemetry-api", "setBackupReserve"]]);
  assert.deepEqual(fakeGateway.commands, []);
  site.stop();
});
