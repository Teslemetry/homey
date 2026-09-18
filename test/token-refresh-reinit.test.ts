import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryApp from "../.homeybuild/app.js";
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";
import { configureTeslemetryStub } from "./support/teslemetry-api-stub.js";

/**
 * A Powerwall flow issuing a command an hour after the last one makes the
 * OAuth client refresh its expired access token mid-request. That refresh
 * used to force a whole new Products generation: the SDK, its SSE
 * connection and every per-product emitter were replaced, and the device's
 * live subscription moved to a stream that had to reconnect from scratch.
 * These cover the two halves of that cascade - the needless rebuild, and
 * the duplicate rebuild when two commands refresh at once.
 */

const SITE_ID = "1689169815425134";

/** Mirrors TeslemetryStream: an EventEmitter with connect()/close(). */
class FakeStream extends EventEmitter {
  connected = false;
  closed = false;
  connect() {
    this.connected = true;
  }
  close() {
    this.closed = true;
  }
}

/** Mirrors one Teslemetry generation: a root stream plus its own
 *  per-site emitter, so a rebuild really does orphan the old one. */
function createFakeSdk() {
  const sse = new FakeStream();
  const siteStream = new EventEmitter();
  const site = {
    id: Number(SITE_ID),
    name: "Powerwall",
    api: new Proxy({}, { get: () => () => Promise.resolve() }),
    sse: siteStream,
    metadata: { access: true },
  };
  return {
    sse,
    siteStream,
    createProducts: async () => ({ vehicles: {}, energySites: { [SITE_ID]: site } }),
  };
}

function createFlowStub() {
  const card = { registerRunListener: () => card, trigger: async () => {} };
  return {
    getActionCard: () => card,
    getConditionCard: () => card,
    getDeviceTriggerCard: () => card,
  };
}

function createApp(initialToken: unknown) {
  const drivers: Record<string, { getDevices: () => unknown[] }> = {};
  const settingsStore: Record<string, unknown> = {
    teslemetry_oauth2_token: initialToken,
  };
  const app = Object.assign(new TeslemetryApp(), {
    homey: {
      __: (key: string) => key,
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
      drivers: { getDrivers: () => drivers },
      flow: createFlowStub(),
      settings: {
        get: (key: string) => settingsStore[key],
        set: (key: string, value: unknown) => {
          settingsStore[key] = value;
        },
        unset: (key: string) => {
          delete settingsStore[key];
        },
      },
    },
    log: () => {},
    error: () => {},
  });
  return { app, drivers, settingsStore };
}

/** A real PowerwallDevice exercising its own bind/rebind path. */
function createPowerwallDevice(app: InstanceType<typeof TeslemetryApp>) {
  const capabilities: Record<string, unknown> = { measure_battery: undefined };
  const registrations: string[] = [];
  const device = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app,
      __: (key: string) => key,
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
      flow: createFlowStub(),
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [device],
    },
    getData: () => ({ id: SITE_ID }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: (capability: string) => {
      registrations.push(capability);
    },
    getStoreValue: () => null,
    setStoreValue: async () => {},
    setAvailable: async () => {},
    setUnavailable: async () => {},
    log: () => {},
    error: () => {},
  });
  return { device, capabilities, registrations };
}

function expiringToken() {
  return {
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_in: 3600,
    token_type: "Bearer",
    // Inside getAccessToken()'s 60s refresh-ahead window, exactly as it is
    // when a scheduled flow fires an hour after the previous command.
    expires_at: Date.now() + 30_000,
  };
}

function stubTokenEndpoint(bodies: unknown[]) {
  const originalFetch = global.fetch;
  global.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return {
      ok: true,
      json: async () => ({
        access_token: `refreshed-${bodies.length}`,
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response;
  }) as typeof fetch;
  return () => {
    global.fetch = originalFetch;
  };
}

test("a routine token refresh keeps the device's live subscription on the running stream", async () => {
  const { app, drivers } = createApp(expiringToken());
  const { device, capabilities } = createPowerwallDevice(app);
  drivers.battery = { getDevices: () => [device] };

  const sdks: ReturnType<typeof createFakeSdk>[] = [];
  configureTeslemetryStub(() => {
    const sdk = createFakeSdk();
    sdks.push(sdk);
    return sdk;
  });

  await app.onInit();
  await device.onInit();

  sdks[0].siteStream.emit("live_status", { live_status: { percentage_charged: 40 } });
  assert.equal(capabilities.measure_battery, 40, "live before the refresh");

  const restoreFetch = stubTokenEndpoint([]);
  try {
    // What a Flow command does an hour after the previous one: the SDK asks
    // this client for an access token and gets a refreshed one back.
    await app.oauth.getAccessToken();
    // Drain anything the token save queued onto the init chain.
    await app.initializeTeslemetry();
  } finally {
    restoreFetch();
  }

  assert.equal(sdks.length, 1, "a rotated access token needs no new Products generation");
  assert.equal(sdks[0].sse.closed, false, "the live SSE connection stayed up");

  sdks[0].siteStream.emit("live_status", { live_status: { percentage_charged: 55 } });
  assert.equal(
    capabilities.measure_battery,
    55,
    "the device is still subscribed to the stream that is actually running",
  );
});

test("two commands refreshing at once make one token request and one token save", async () => {
  const { app } = createApp(expiringToken());
  configureTeslemetryStub(() => createFakeSdk());
  await app.onInit();

  const saves: unknown[] = [];
  const onTokenSaved = app.oauth.onTokenSaved!;
  app.oauth.onTokenSaved = (token, reason) => {
    saves.push(reason);
    onTokenSaved(token, reason);
  };

  const bodies: unknown[] = [];
  const restoreFetch = stubTokenEndpoint(bodies);
  try {
    // The 00:00 flow: two energy-site commands microseconds apart, each
    // resolving an access token that is already inside the refresh window.
    await Promise.all([app.oauth.getAccessToken(), app.oauth.getAccessToken()]);
    await app.initializeTeslemetry();
  } finally {
    restoreFetch();
  }

  assert.equal(bodies.length, 1, "the second caller joined the in-flight refresh");
  assert.equal(saves.length, 1, "one refresh, one token save");
});

test("a re-init requested twice before the first one starts builds one generation", async () => {
  const { app } = createApp(expiringToken());
  let buildCount = 0;
  configureTeslemetryStub(() => {
    buildCount++;
    return createFakeSdk();
  });
  await app.onInit();
  assert.equal(buildCount, 1);

  // Two credential changes landing in the same tick, as the overlapping
  // 00:00 re-inits did.
  const first = app.initializeTeslemetry(true);
  const second = app.initializeTeslemetry(true);
  await Promise.all([first, second]);

  assert.equal(buildCount, 2, "the second request joined the queued rebuild");
});

test("a new authorization grant still rebuilds the Products generation", async () => {
  const { app } = createApp(expiringToken());
  let buildCount = 0;
  configureTeslemetryStub(() => {
    buildCount++;
    return createFakeSdk();
  });
  await app.onInit();
  assert.equal(buildCount, 1);

  const originalFetch = global.fetch;
  global.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        access_token: "granted-access",
        refresh_token: "granted-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    }) as unknown as Response) as typeof fetch;
  try {
    await app.oauth.exchangeCodeForToken("code", "verifier");
    await app.initializeTeslemetry();
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(buildCount, 2, "a re-pair points at a possibly different account");
});

test("a rebind does not re-register the device's command capability listeners", async () => {
  const { app, drivers } = createApp(expiringToken());
  const { device, registrations } = createPowerwallDevice(app);
  drivers.battery = { getDevices: () => [device] };

  configureTeslemetryStub(() => createFakeSdk());
  await app.onInit();
  await device.onInit();

  const afterFirstBind = [...registrations];
  assert.ok(afterFirstBind.length > 0, "the first bind registers the command listeners");

  // A re-pair rebuilds the generation and rebinds every paired device.
  await app.initializeTeslemetry(true);

  assert.deepEqual(
    registrations,
    afterFirstBind,
    "Homey keeps one listener per capability; a second registration only warns",
  );
});
