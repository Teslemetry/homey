import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
// Imports the built output; see device-oninit-no-product.test.ts for why.
// app.js's `new Teslemetry(...)` resolves to the controllable stub, which
// these tests point at the REAL SDK (imported by relative path, past the
// loader's redirect) so the SDK's own request preparation, error shapes and
// SSE status classification are what the app reacts to - only the network
// behind globalThis.fetch is fake.
import TeslemetryApp from "../.homeybuild/app.js";
import TeslemetryDevice from "../.homeybuild/lib/TeslemetryDevice.js";
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";
import SolarDevice from "../.homeybuild/drivers/solar/device.js";
import GatewayDevice from "../.homeybuild/drivers/gateway/device.js";
import WallConnectorDevice from "../.homeybuild/drivers/wall-connector/device.js";
import VehicleDriver from "../.homeybuild/drivers/vehicle/driver.js";
import { configureTeslemetryStub } from "./support/teslemetry-api-stub.js";
import { Teslemetry as RealTeslemetry } from "../node_modules/@teslemetry/api/dist/index.mjs";

const en = JSON.parse(fs.readFileSync(new URL("../locales/en.json", import.meta.url), "utf8"));
const translate = (key: string) =>
  key.split(".").reduce((node: any, part) => (node ? node[part] : undefined), en) ?? key;

const VIN = "LRW3E7FS0PC000001";
const SITE = "1689169815425134";
const SUBSCRIPTION_REQUIRED = {
  error: "subscription_required",
  error_description: "Active subscription required",
};
const INVALID_REFRESH_TOKEN = {
  error: "invalid_refresh_token",
  error_description: "Invalid refresh token",
};

/**
 * A fake Teslemetry server behind globalThis.fetch, shaped like the real one:
 * /api/metadata and /sse answer 402 {"error":"subscription_required"} for a
 * lapsed subscription, and /oauth/token answers 401
 * {"error":"invalid_refresh_token"} for a dead refresh token.
 */
function createServer() {
  const server = {
    metadata: {
      status: 200,
      json: {
        uid: "u",
        region: "EU",
        scopes: [],
        vehicles: {
          [VIN]: { access: true, polling: false, proxy: false, firmware: "2025.20", fleet_telemetry: "1.1.0", name: "Car", config: {} },
        },
        energy_sites: { [SITE]: { access: true, name: "Home" } },
      } as unknown,
    },
    token: { status: 200, json: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 } as unknown },
    sseStatus: 200,
    sseBody: {} as unknown,
    onMetadata: undefined as (() => void) | undefined,
    calls: [] as string[],
    streams: [] as ReadableStreamDefaultController[],
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const { pathname } = new URL(request.url);
    server.calls.push(pathname);
    if (pathname === "/oauth/token") return json(server.token.status, server.token.json);
    if (pathname === "/api/metadata") {
      server.onMetadata?.();
      return json(server.metadata.status, server.metadata.json);
    }
    if (pathname.startsWith("/sse")) {
      if (server.sseStatus !== 200) {
        return new Response(JSON.stringify(server.sseBody), {
          status: server.sseStatus,
          statusText: String(server.sseStatus),
        });
      }
      const body = new ReadableStream({
        start: (controller) => {
          server.streams.push(controller);
        },
      });
      request.signal?.addEventListener("abort", () => {
        try {
          server.streams.at(-1)?.error(new DOMException("aborted", "AbortError"));
        } catch {}
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return json(404, { error: "not_found", error_description: pathname });
  };
  return { server, fetch };
}

function createFakeTimers() {
  const timers: Array<{ id: number; callback: () => void; delay: number }> = [];
  let nextId = 1;
  return {
    timers,
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextId++;
      timers.push({ id, callback, delay });
      return id;
    },
    clearTimeout: (id: number) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index !== -1) timers.splice(index, 1);
    },
  };
}

/** Runs every homey timer due so far (the stream watchdog's grace period,
 *  a startup retry), as if that much time had passed. */
function fireTimers(timers: ReturnType<typeof createFakeTimers>["timers"]) {
  for (const timer of timers.splice(0)) timer.callback();
}

function createFlowStub() {
  const card = {
    registerRunListener: () => card,
    registerArgumentAutocompleteListener: () => card,
    trigger: async () => {},
  };
  return {
    getActionCard: () => card,
    getConditionCard: () => card,
    getDeviceTriggerCard: () => card,
    getTriggerCard: () => card,
  };
}

/** A real TeslemetryApp through its real onInit() - so the real OAuth2
 *  client and its callbacks are wired exactly as in production - on a
 *  minimal Homey. `settingsStore` survives across "restarts" when reused. */
function createWorld(settingsStore: Map<string, unknown>) {
  const fakeTimers = createFakeTimers();
  const drivers: Record<string, { getDevices: () => unknown[] }> = {};
  const logs: string[] = [];
  const app = Object.assign(new TeslemetryApp(), {
    homey: {
      __: translate,
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
      drivers: { getDrivers: () => drivers },
      flow: createFlowStub(),
      settings: {
        get: (key: string) => settingsStore.get(key) ?? null,
        set: (key: string, value: unknown) => settingsStore.set(key, structuredClone(value)),
        unset: (key: string) => settingsStore.delete(key),
      },
    },
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
  });
  configureTeslemetryStub((accessToken: unknown, options: unknown) => new RealTeslemetry(accessToken, options));
  return { app, timers: fakeTimers.timers, drivers, logs };
}

function storedToken(expiresInMs: number) {
  return new Map<string, unknown>([
    [
      "teslemetry_oauth2_token",
      {
        access_token: "old-access",
        refresh_token: "old-refresh",
        expires_in: 3600,
        token_type: "Bearer",
        expires_at: Date.now() + expiresInMs,
      },
    ],
  ]);
}

/** A bound device as the app's watchdog/teardown sees it: a real
 *  TeslemetryDevice (so markUnavailable/clearAvailabilityReason's reason
 *  gating is real) reporting a fixed product key. */
function createBoundDevice(productKey: string) {
  const messages: unknown[] = [];
  let available = true;
  const device = Object.assign(new TeslemetryDevice(), {
    getProductKey: () => productKey,
    rebindProduct: () => {},
    setAvailable: async () => {
      available = true;
    },
    setUnavailable: async (message: unknown) => {
      available = false;
      messages.push(message);
    },
    error: () => {},
    log: () => {},
  });
  return { device, messages, isAvailable: () => available };
}

/** Each of the five real device classes, initialised against the real app
 *  before any Products generation is ready - its resolveAndBind* "not
 *  ready" branch is the code under test. */
const DEVICE_CLASSES = [
  { name: "vehicle", Device: VehicleDevice, data: { vin: VIN } },
  { name: "battery", Device: PowerwallDevice, data: { id: Number(SITE) } },
  { name: "solar", Device: SolarDevice, data: { id: Number(SITE) } },
  { name: "gateway", Device: GatewayDevice, data: { id: Number(SITE) } },
  { name: "wall-connector", Device: WallConnectorDevice, data: { site: Number(SITE), din: "1734634-02-G--TEST" } },
];

async function initUnboundDevices(app: unknown) {
  const results: Array<{ name: string; messages: unknown[] }> = [];
  for (const { name, Device, data } of DEVICE_CLASSES) {
    const messages: unknown[] = [];
    const device = Object.assign(Object.create(Device.prototype), {
      homey: { app, __: translate, flow: createFlowStub() },
      driver: { manifest: { capabilities: [], capabilitiesOptions: {} }, getDevices: () => [device] },
      getData: () => data,
      getCapabilities: () => [],
      setCapabilityOptions: async () => {},
      getStoreValue: () => null,
      setAvailable: async () => {},
      setUnavailable: async (message: unknown) => {
        messages.push(message);
      },
      log: () => {},
      error: () => {},
    });
    await device.onInit();
    results.push({ name, messages });
  }
  return results;
}

async function waitFor(predicate: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function withFetch(fetch: typeof globalThis.fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("a refresh token the server rejects during the stream's own connect tears credentials down, so every device asks to re-authenticate (H05 running)", async () => {
  const { server, fetch } = createServer();
  const restoreFetch = withFetch(fetch as typeof globalThis.fetch);
  const { app, timers, drivers, logs } = createWorld(storedToken(3600_000));
  const car = createBoundDevice(`vehicle:${VIN}`);
  const powerwall = createBoundDevice(`site:${SITE}`);
  drivers.vehicle = { getDevices: () => [car.device] };
  drivers.battery = { getDevices: () => [powerwall.device] };
  try {
    // By the time the stream (re)connects, the access token is inside its
    // one-minute proactive refresh window and the refresh token has been
    // revoked - so the refresh runs inside the SDK's SSE request preparation,
    // where its failure reaches the stream loop as a status-less error.
    server.onMetadata = () => {
      (app.oauth as any).token.expires_at = Date.now() + 30_000;
      server.token = { status: 401, json: INVALID_REFRESH_TOKEN };
    };
    await app.onInit();
    await waitFor(() => server.calls.includes("/oauth/token"), "the proactive refresh");
    await waitFor(() => !app.oauth.hasValidToken(), "the dead refresh token to be cleared");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Well past the stream watchdog's grace period.
    fireTimers(timers);
    fireTimers(timers);

    for (const { device, messages, isAvailable } of [car, powerwall]) {
      assert.equal(isAvailable(), false);
      assert.match(String(messages.at(-1)), /re-authenticate/, `${device.getProductKey()}: ${messages.join(" | ")}`);
    }
    assert.equal(app.isReady(), false, "the dead generation was torn down");
    assert.ok(!logs.some((line) => line.includes("undefined")), logs.join("\n"));
  } finally {
    await app.onUninit();
    restoreFetch();
  }
});

test("a refresh token the server rejects at boot leaves every device asking to re-authenticate, not 'Connecting' (H05 boot)", async () => {
  const { server, fetch } = createServer();
  const restoreFetch = withFetch(fetch as typeof globalThis.fetch);
  // A restart almost always finds the access token already expired.
  server.token = { status: 401, json: INVALID_REFRESH_TOKEN };
  const { app, timers } = createWorld(storedToken(-600_000));
  try {
    await app.onInit();
    assert.equal(app.oauth.hasValidToken(), false);
    const devices = await initUnboundDevices(app);
    fireTimers(timers);
    for (const { name, messages } of devices) {
      assert.match(String(messages.at(-1)), /re-authenticate/, `${name}: ${messages.join(" | ")}`);
    }
  } finally {
    await app.onUninit();
    restoreFetch();
  }
});

test("a lapsed subscription at boot shows 'Subscription required' on every device and keeps a slow retry that recovers on renewal (H06 boot)", async () => {
  const { server, fetch } = createServer();
  const restoreFetch = withFetch(fetch as typeof globalThis.fetch);
  server.metadata = { status: 402, json: SUBSCRIPTION_REQUIRED };
  const { app, timers, drivers, logs } = createWorld(storedToken(3600_000));
  try {
    await app.onInit();
    const devices = await initUnboundDevices(app);
    for (const { name, messages } of devices) {
      assert.deepEqual(messages, [translate("error.subscription_required")], name);
    }
    assert.ok(!logs.some((line) => line === "undefined"), `no bare 'undefined' log line:\n${logs.join("\n")}`);

    // Still retrying - slowly - so a renewal recovers without a restart.
    assert.equal(timers.length, 1, "one retry pending");
    assert.ok(timers[0].delay >= 300_000, `slow retry, not the 5s transient backoff (got ${timers[0].delay}ms)`);
    fireTimers(timers);
    await app.getProducts().catch(() => {});
    assert.equal(timers.length, 1, "a still-lapsed retry schedules the next one");

    const bound = createBoundDevice(`vehicle:${VIN}`);
    let rebinds = 0;
    bound.device.rebindProduct = () => {
      rebinds++;
    };
    bound.device.markUnavailable("auth", translate("error.subscription_required"));
    drivers.vehicle = { getDevices: () => [bound.device] };
    server.metadata = { status: 200, json: createServer().server.metadata.json };
    fireTimers(timers);
    await app.getProducts();
    assert.equal(app.isReady(), true, "renewal recovered on the slow retry");
    assert.equal(rebinds, 1, "the renewed generation rebinds paired devices");
    (app.teslemetry!.sse as any).emit("state", { vin: VIN, state: "online" });
    assert.equal(bound.isAvailable(), true, "the device's own genuine event clears it");
  } finally {
    await app.onUninit();
    restoreFetch();
  }
});

test("a subscription that lapses while running (SSE 402) shows 'Subscription required' on every device, not 'Connection lost' (H06 running)", async () => {
  const { server, fetch } = createServer();
  const restoreFetch = withFetch(fetch as typeof globalThis.fetch);
  server.sseStatus = 402;
  server.sseBody = SUBSCRIPTION_REQUIRED;
  const { app, timers, drivers } = createWorld(storedToken(3600_000));
  const car = createBoundDevice(`vehicle:${VIN}`);
  const powerwall = createBoundDevice(`site:${SITE}`);
  drivers.vehicle = { getDevices: () => [car.device] };
  drivers.battery = { getDevices: () => [powerwall.device] };
  try {
    await app.onInit();
    await waitFor(() => server.calls.some((path) => path.startsWith("/sse")), "the SSE attempt");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Well past the stream watchdog's grace period.
    fireTimers(timers);
    fireTimers(timers);

    for (const { device, messages } of [car, powerwall]) {
      assert.equal(messages.at(-1), translate("error.subscription_required"), `${device.getProductKey()}: ${messages.join(" | ")}`);
    }

    // Renewal: the SDK's own reconnect gets through and data flows again.
    (app.teslemetry!.sse as any).emit("live_status", { site_id: Number(SITE), live_status: {} });
    assert.equal(powerwall.isAvailable(), true);
    assert.equal(car.isAvailable(), false, "only its own product's genuine event clears a device");
  } finally {
    await app.onUninit();
    restoreFetch();
  }
});

test("pairing while the subscription is lapsed rejects with an Error carrying the message, not a raw object (H06 pairing)", async () => {
  const { server, fetch } = createServer();
  const restoreFetch = withFetch(fetch as typeof globalThis.fetch);
  server.metadata = { status: 402, json: SUBSCRIPTION_REQUIRED };
  const { app } = createWorld(storedToken(3600_000));
  try {
    await app.onInit();
    const driver = Object.assign(new VehicleDriver(), {
      homey: { app, __: translate },
      manifest: { capabilities: [], capabilitiesOptions: {} },
      log: () => {},
      error: () => {},
    });
    const rejection = await driver.onPairListDevices().then(
      () => assert.fail("pairing should reject"),
      (error: unknown) => error,
    );
    assert.ok(rejection instanceof Error, `rejected with ${String(rejection)}`);
    assert.equal(rejection.message, translate("error.subscription_required"));
  } finally {
    await app.onUninit();
    restoreFetch();
  }
});

test("a restart after credential teardown keeps every device on 'account disconnected', not 'Connecting' (H07)", async () => {
  const { fetch } = createServer();
  const restoreFetch = withFetch(fetch as typeof globalThis.fetch);
  const settings = storedToken(3600_000);
  let world = createWorld(settings);
  try {
    await world.app.onInit();
    world.app.disconnectAccount();
    assert.equal(settings.has("teslemetry_oauth2_token"), false);
    await world.app.onUninit();

    // Homey reboot / app auto-update: fresh process, same persisted settings.
    world = createWorld(settings);
    await world.app.onInit();
    const devices = await initUnboundDevices(world.app);
    fireTimers(world.timers);
    for (const { name, messages } of devices) {
      assert.deepEqual(messages, [translate("error.account_disconnected")], name);
    }
  } finally {
    await world.app.onUninit();
    restoreFetch();
  }
});
