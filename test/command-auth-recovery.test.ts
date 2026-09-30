import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryApp from "../.homeybuild/app.js";
import TeslemetryOAuth2Client from "../.homeybuild/lib/TeslemetryOAuth2Client.js";
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import VehicleDriver from "../.homeybuild/drivers/vehicle/driver.js";
import {
  configureTeslemetryStub,
  RealTeslemetry,
} from "./support/teslemetry-api-stub.js";

/**
 * An access token the server stops accepting before its own expiry (revoked
 * server-side, or Homey's clock running behind) while the refresh token is
 * still good. Every test here drives the real OAuth2 client, and where a
 * request is involved the real @teslemetry/api SDK over a stubbed fetch, so
 * the token each request actually carried is what gets asserted.
 *
 * - A command rejected with `invalid_token` used to mark the device
 *   unavailable and do nothing else: no refresh, so every later command
 *   failed the same way while the stream's next event marked the device
 *   available again.
 * - Repair skipped the OAuth login whenever any token was stored, so the
 *   user could not re-authenticate from the device either.
 * - An SSE 401 started a forced refresh, but the SDK retries at once and
 *   getAccessToken() handed that retry the rejected token instead of waiting
 *   for the refresh; the second 401 tore every credential down.
 */

const VIN = "LRW3E7FS0PC000001";

const INVALID_TOKEN_BODY = {
  error: "invalid_token",
  error_description: "Invalid authentication token",
};

function initialToken() {
  return {
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_in: 3600,
    token_type: "Bearer",
    expires_at: Date.now() + 3600_000,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Route = (request: Request) => Promise<Response> | Response;

/** Routes every fetch - the SDK's (a Request) and the OAuth2 client's
 *  (url + init) alike - by URL path substring, recording each request. */
function stubFetch(routes: Array<[string, Route]>) {
  const originalFetch = global.fetch;
  const requests: Request[] = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    const path = new URL(request.url).pathname;
    const route = routes.find(([fragment]) => path.includes(fragment));
    if (!route) throw new Error(`unrouted fetch: ${path}`);
    return route[1](request);
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

function tokenRequests(requests: Request[]) {
  return requests.filter((request) => request.url.endsWith("/oauth/token"));
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The minimal app surface TeslemetryOAuth2Client needs, backed by a real
 *  settings store so the persisted token can be asserted. */
function createOAuthHost() {
  const settingsStore: Record<string, unknown> = {
    teslemetry_oauth2_token: initialToken(),
  };
  const errors: unknown[][] = [];
  const host = {
    homey: {
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
    handleApiError: (apiError: { error_description?: string }) => {
      throw new Error(apiError.error_description ?? "token request failed");
    },
    error: (...args: unknown[]) => errors.push(args),
  };
  const oauth = new TeslemetryOAuth2Client(host as never);
  return { oauth, settingsStore, errors };
}

const silentLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

class FakeVehicleStream extends EventEmitter {
  cache: { data: Record<string, unknown> } = { data: {} };

  onSignal(_field: string, _callback: (value: unknown) => void) {
    return () => {};
  }
}

/** A real VehicleDevice whose vehicle API is the real SDK's, authenticated
 *  through the real OAuth2 client. */
async function createVehicleDevice(oauth: TeslemetryOAuth2Client) {
  const sdk = new RealTeslemetry(oauth.getAccessToken, { logger: silentLogger });
  const vehicle = {
    sse: new FakeVehicleStream(),
    api: sdk.api.getVehicle(VIN),
    metadata: {
      access: true,
      fleet_telemetry: "fleet_telemetry_config_id",
      polling: false,
      // The captain's real Model 3.
      config: { rhd: true, rear_seat_heaters: 1, cop_user_set_temp_supported: false },
    },
  };
  const capabilityListeners: Record<string, (value: unknown) => Promise<void>> = {};
  const unavailable: unknown[] = [];
  const device = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [VIN]: vehicle } }, oauth },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
      geolocation: { getLatitude: () => 51.5, getLongitude: () => -0.12 },
    },
    driver: {
      manifest: { capabilities: [], capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin: VIN, id: VIN }),
    getStoreValue: () => null,
    getCapabilities: () => [],
    getCapabilityValue: () => undefined,
    setCapabilityValue: async () => {},
    setCapabilityOptions: async () => {},
    registerCapabilityListener: (
      capability: string,
      listener: (value: unknown) => Promise<void>,
    ) => {
      capabilityListeners[capability] = listener;
    },
    log: () => {},
    error: () => {},
    setUnavailable: async (message: unknown) => {
      unavailable.push(message);
    },
    setAvailable: async () => {},
  });
  await device.onInit();
  return { device, capabilityListeners, unavailable };
}

test("a command rejected with invalid_token refreshes the access token once, so the next command succeeds", async () => {
  const { oauth, settingsStore } = createOAuthHost();
  const fetchStub = stubFetch([
    [
      "/command/",
      (request) =>
        request.headers.get("authorization") === "Bearer old-access"
          ? jsonResponse(401, INVALID_TOKEN_BODY)
          : jsonResponse(200, { response: { result: true, reason: "" } }),
    ],
    [
      "/oauth/token",
      () =>
        jsonResponse(200, {
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        }),
    ],
  ]);

  try {
    const { capabilityListeners, unavailable } = await createVehicleDevice(oauth);

    await assert.rejects(() => capabilityListeners.locked(true), /Invalid authentication token/);
    assert.deepEqual(unavailable, ["Invalid authentication token"]);

    await waitFor(() => tokenRequests(fetchStub.requests).length > 0);
    await waitFor(
      () => (settingsStore.teslemetry_oauth2_token as { access_token: string }).access_token === "new-access",
    );
    const refreshes = tokenRequests(fetchStub.requests);
    assert.equal(refreshes.length, 1, "exactly one refresh for the rejected command");
    assert.equal(JSON.parse(await refreshes[0].clone().text()).grant_type, "refresh_token");
    assert.equal(
      (settingsStore.teslemetry_oauth2_token as { access_token: string }).access_token,
      "new-access",
    );

    await assert.doesNotReject(() => capabilityListeners.locked(true));
    const commandAuth = fetchStub.requests
      .filter((request) => request.url.includes("/command/"))
      .map((request) => request.headers.get("authorization"));
    assert.deepEqual(commandAuth, ["Bearer old-access", "Bearer new-access"]);
    assert.equal(tokenRequests(fetchStub.requests).length, 1, "a successful command does not refresh");
  } finally {
    fetchStub.restore();
  }
});

test("a command invalid_token whose refresh the server rejects tears credentials down", async () => {
  const { oauth } = createOAuthHost();
  let credentialsRejected = 0;
  oauth.onCredentialsRejected = () => {
    credentialsRejected++;
  };
  const fetchStub = stubFetch([
    ["/command/", () => jsonResponse(401, INVALID_TOKEN_BODY)],
    [
      "/oauth/token",
      () => jsonResponse(401, { error: "invalid_refresh_token", error_description: "Invalid refresh token" }),
    ],
  ]);

  try {
    const { capabilityListeners } = await createVehicleDevice(oauth);

    await assert.rejects(() => capabilityListeners.locked(true), /Invalid authentication token/);
    await waitFor(() => credentialsRejected > 0);

    assert.equal(tokenRequests(fetchStub.requests).length, 1);
    assert.equal(credentialsRejected, 1, "P04's teardown trigger fired");
    assert.equal(oauth.hasValidToken(), false);
  } finally {
    fetchStub.restore();
  }
});

test("a command failing for any other reason does not refresh the token", async () => {
  const { oauth } = createOAuthHost();
  const fetchStub = stubFetch([
    ["/command/", () => jsonResponse(402, { error: "subscription_required", error_description: "Subscription required" })],
  ]);

  try {
    const { capabilityListeners } = await createVehicleDevice(oauth);
    await assert.rejects(() => capabilityListeners.locked(true), /Subscription required/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(tokenRequests(fetchStub.requests).length, 0);
  } finally {
    fetchStub.restore();
  }
});

function createDriverSession(oauth: TeslemetryOAuth2Client) {
  const openedUrls: string[] = [];
  const callback = new EventEmitter();
  const driver = Object.assign(new VehicleDriver(), {
    homey: {
      app: { oauth },
      __: (key: string) => key,
      cloud: {
        createOAuth2Callback: async (url: string) => {
          openedUrls.push(url);
          return callback;
        },
      },
    },
    log: () => {},
    error: () => {},
  });
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  const emitted: Array<[string, unknown]> = [];
  const session = {
    setHandler: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers[name] = handler;
    },
    emit: (name: string, value?: unknown) => {
      emitted.push([name, value]);
    },
  };
  return { driver, session, handlers, emitted, openedUrls, callback };
}

test("Repair runs the OAuth login even while a token is stored", async () => {
  const { oauth, settingsStore } = createOAuthHost();
  const tokenSaves: string[] = [];
  oauth.onTokenSaved = (_token, reason) => tokenSaves.push(reason);
  const { driver, session, handlers, emitted, openedUrls, callback } = createDriverSession(oauth);
  const fetchStub = stubFetch([
    [
      "/oauth/token",
      () =>
        jsonResponse(200, {
          access_token: "granted-access",
          refresh_token: "granted-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        }),
    ],
  ]);

  try {
    assert.equal(oauth.hasValidToken(), true, "precondition: a token is stored");
    await driver.onRepair(session, {});
    await handlers.showView("login_oauth2");

    assert.equal(openedUrls.length, 1, "the OAuth window opened");
    assert.match(openedUrls[0], /^https:\/\/teslemetry\.com\/connect\?/);
    assert.deepEqual(emitted, [], "not waved through as already authorized");

    callback.emit("code", "auth-code");
    await waitFor(() => emitted.length > 0);
    assert.deepEqual(emitted, [["authorized", undefined]]);
    assert.deepEqual(tokenSaves, ["grant"], "a new grant, which rebuilds the connection");
    assert.equal(
      (settingsStore.teslemetry_oauth2_token as { access_token: string }).access_token,
      "granted-access",
    );
  } finally {
    fetchStub.restore();
  }
});

test("pairing still skips the OAuth login while a token is stored", async () => {
  const { oauth } = createOAuthHost();
  const { driver, session, handlers, emitted, openedUrls } = createDriverSession(oauth);

  await driver.onPair(session);
  await handlers.showView("login_oauth2");

  assert.equal(openedUrls.length, 0);
  assert.deepEqual(emitted, [["authorized", undefined]]);
});

test("getAccessToken() waits for an in-flight forced refresh instead of handing out the token it replaces", async () => {
  const { oauth } = createOAuthHost();
  let releaseRefresh!: () => void;
  const fetchStub = stubFetch([
    [
      "/oauth/token",
      () =>
        new Promise<Response>((resolve) => {
          releaseRefresh = () =>
            resolve(
              jsonResponse(200, {
                access_token: "new-access",
                expires_in: 3600,
                token_type: "Bearer",
              }),
            );
        }),
    ],
  ]);

  try {
    const refresh = oauth.refreshToken();
    const accessToken = oauth.getAccessToken();
    await waitFor(() => releaseRefresh !== undefined);
    releaseRefresh();
    await refresh;
    assert.equal(await accessToken, "new-access");
    assert.equal(tokenRequests(fetchStub.requests).length, 1, "joined, not a second refresh");
  } finally {
    fetchStub.restore();
  }
});

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimeout: (callback: () => void) => {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
  };
}

function createFlowStub() {
  const card = { registerRunListener: () => card };
  return {
    getActionCard: () => card,
    getConditionCard: () => card,
    getDeviceTriggerCard: () => card,
  };
}

/** An SSE body that delivers one state event, then stays open until the
 *  client aborts - a healthy, connected stream. */
function openSseResponse(): Response {
  const encoder = new TextEncoder();
  const event = { vin: VIN, state: "online", createdAt: new Date().toISOString() };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

test("an SSE 401 while the refresh token is still good reconnects with the refreshed token instead of tearing down", async () => {
  const settingsStore: Record<string, unknown> = {
    teslemetry_oauth2_token: initialToken(),
  };
  const errors: unknown[][] = [];
  const fakeTimers = createFakeTimers();
  const app = Object.assign(new TeslemetryApp(), {
    homey: {
      __: (key: string) => key,
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
      drivers: { getDrivers: () => ({}) },
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
    error: (...args: unknown[]) => errors.push(args),
  });

  let builds = 0;
  configureTeslemetryStub((accessTokenFn: () => Promise<string>, options: object) => {
    builds++;
    return new RealTeslemetry(accessTokenFn, { ...options, logger: silentLogger });
  });

  const fetchStub = stubFetch([
    ["/api/metadata", () => jsonResponse(200, { vehicles: {}, energy_sites: {} })],
    [
      // The server invalidated "old-access" early; the client still
      // believes it has most of an hour left.
      "/sse/",
      (request) =>
        request.headers.get("authorization") === "Bearer old-access"
          ? jsonResponse(401, INVALID_TOKEN_BODY)
          : openSseResponse(),
    ],
    [
      "/oauth/token",
      async () => {
        // A realistic round trip, so the SDK's immediate retry races it.
        await new Promise((resolve) => setTimeout(resolve, 30));
        return jsonResponse(200, {
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        });
      },
    ],
  ]);

  const sseAuth = () =>
    fetchStub.requests
      .filter((request) => request.url.includes("/sse/"))
      .map((request) => request.headers.get("authorization"));

  try {
    await app.onInit();
    await waitFor(() => sseAuth().length >= 2 && tokenRequests(fetchStub.requests).length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(sseAuth(), ["Bearer old-access", "Bearer new-access"]);
    assert.equal(tokenRequests(fetchStub.requests).length, 1);
    assert.equal(app.oauth.hasValidToken(), true, "credentials survived");
    assert.equal(
      (settingsStore.teslemetry_oauth2_token as { access_token: string }).access_token,
      "new-access",
    );
    assert.equal(
      errors.some((args) => args.includes("OAuth credentials are being removed")),
      false,
      "no credential teardown",
    );
    assert.equal(builds, 1, "no teardown-and-rebuild");
    assert.equal(app.isReady(), true);
  } finally {
    await app.onUninit();
    fetchStub.restore();
  }
});
