import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
// app.js's `new Teslemetry(...)` resolves to the controllable stub below
// instead of the real SDK - see test/support/loader.mjs and
// teslemetry-api-stub.js.
import TeslemetryApp from "../.homeybuild/app.js";
import TeslemetryDevice from "../.homeybuild/lib/TeslemetryDevice.js";
import { configureTeslemetryStub } from "./support/teslemetry-api-stub.js";

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

function createFakeOAuth(hasToken = true) {
  let valid = hasToken;
  const refreshCalls: number[] = [];
  return {
    hasValidToken: () => valid,
    getAccessToken: async () => "fake-access-token",
    refreshToken: async () => {
      refreshCalls.push(Date.now());
    },
    clearToken: () => {
      valid = false;
    },
    setValid: (v: boolean) => {
      valid = v;
    },
    refreshCalls,
  };
}

/** A controllable homey.setTimeout/clearTimeout pair capturing scheduled callbacks. */
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

function createAppStub() {
  const fakeTimers = createFakeTimers();
  const drivers: Record<string, { getDevices: () => unknown[] }> = {};
  const logs: unknown[][] = [];
  const errors: unknown[][] = [];

  const app = Object.assign(new TeslemetryApp(), {
    homey: {
      __: (key: string) => key,
      setTimeout: fakeTimers.setTimeout,
      clearTimeout: fakeTimers.clearTimeout,
      drivers: { getDrivers: () => drivers },
    },
    log: (...args: unknown[]) => logs.push(args),
    error: (...args: unknown[]) => errors.push(args),
  });
  app.oauth = createFakeOAuth() as unknown as typeof app.oauth;

  return { app, timers: fakeTimers.timers, drivers, logs, errors };
}

/** A real TeslemetryDevice instance (so markUnavailable/clearAvailabilityReason's
 *  own reason-gating logic runs for real) with just enough stubbed to observe
 *  availability transitions without touching a real Homey runtime. */
function createDeviceStub(productKey: string | undefined) {
  const availableCalls: number[] = [];
  const unavailableCalls: unknown[] = [];
  const device = Object.assign(new TeslemetryDevice(), {
    getProductKey: () => productKey,
    setAvailable: async () => {
      availableCalls.push(1);
    },
    setUnavailable: async (message: unknown) => {
      unavailableCalls.push(message);
    },
    error: () => {},
    log: () => {},
  });
  let reboundCount = 0;
  device.rebindProduct = () => {
    reboundCount++;
  };
  return {
    device,
    availableCalls,
    unavailableCalls,
    getReboundCount: () => reboundCount,
  };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("initializeTeslemetry is single-flight: concurrent callers never split SDK/products across two generations (finding 1)", async () => {
  const { app } = createAppStub();

  let buildCount = 0;
  let resolveCreateProducts!: (value: { vehicles: {}; energySites: {} }) => void;
  const pendingProducts = new Promise((resolve) => {
    resolveCreateProducts = resolve as typeof resolveCreateProducts;
  });
  const sdks: unknown[] = [];
  configureTeslemetryStub(() => {
    buildCount++;
    const sdk = { sse: new FakeStream(), createProducts: () => pendingProducts };
    sdks.push(sdk);
    return sdk;
  });

  const call1 = app.getProducts();
  const call2 = app.getProducts();

  // Let the first build actually start (construct its SDK, call
  // createProducts()) before either resolves.
  await flushMicrotasks();
  assert.equal(buildCount, 1, "only one Teslemetry SDK constructed for two overlapping callers");
  assert.equal(app.teslemetry, undefined, "not published until the build fully succeeds");
  assert.equal(app.products, undefined, "not published until the build fully succeeds");

  resolveCreateProducts({ vehicles: {}, energySites: {} });
  const [products1, products2] = await Promise.all([call1, call2]);

  assert.equal(buildCount, 1, "the second caller joined the in-flight build rather than starting its own");
  assert.strictEqual(products1, products2, "both callers observe the exact same Products generation");
  assert.strictEqual(app.teslemetry, sdks[0], "the published SDK is the one whose Products got published");
  assert.strictEqual(app.products, products1);
});

test("a transient startup failure retries with bounded backoff and rebinds devices once a later attempt succeeds (finding 2)", async () => {
  const { app, timers, drivers } = createAppStub();
  const { device, getReboundCount } = createDeviceStub(undefined);
  drivers.battery = { getDevices: () => [device] };

  let attempt = 0;
  configureTeslemetryStub(() => {
    attempt++;
    return {
      sse: new FakeStream(),
      createProducts: () =>
        attempt === 1
          ? Promise.reject(new Error("network blip"))
          : Promise.resolve({ vehicles: {}, energySites: {} }),
    };
  });

  await app.initializeTeslemetry().catch(() => app.scheduleStartupRetry());

  assert.equal(app.isReady(), false, "the transient failure did not become a successful terminal state");
  assert.equal(timers.length, 1, "a bounded retry was scheduled instead of stranding the app");
  assert.equal(timers[0].delay, 5000, "first retry uses the base backoff delay");
  assert.equal(getReboundCount(), 0);

  // Fire the scheduled retry - this is the exact callback app.ts's own
  // setTimeout would invoke.
  const retryTimer = timers[0];
  timers.length = 0;
  retryTimer.callback();
  await flushMicrotasks();

  assert.equal(app.isReady(), true, "recovered on the retried attempt, not stuck forever");
  assert.equal(getReboundCount(), 1, "the previously-stranded device was rebound once Products became ready");
  assert.equal(timers.length, 0, "no further retry scheduled after success");
});

test("scheduleStartupRetry backs off exponentially across consecutive failures, bounded at the max delay", () => {
  const { app, timers } = createAppStub();

  app.scheduleStartupRetry();
  assert.equal(timers[0].delay, 5000);
  timers.length = 0;

  // scheduleStartupRetry() is a no-op while a timer is already pending;
  // simulate that timer firing and failing again before scheduling the next.
  app.startupRetryTimer = undefined;
  app.scheduleStartupRetry();
  assert.equal(timers[0].delay, 10000, "second attempt doubles the delay");
});

test("a non-auth stream stall marks bound devices unavailable after the grace period, and each recovers independently on its own genuine data (finding 3)", async () => {
  const { app, timers, drivers } = createAppStub();
  const vehicleDevice = createDeviceStub("vehicle:vin-1");
  const siteDevice = createDeviceStub("site:site-1");
  drivers.vehicle = { getDevices: () => [vehicleDevice.device] };
  drivers.battery = { getDevices: () => [siteDevice.device] };

  let sdk: { sse: FakeStream } | undefined;
  configureTeslemetryStub(() => {
    sdk = { sse: new FakeStream() };
    return { ...sdk, createProducts: async () => ({ vehicles: {}, energySites: {} }) };
  });

  await app.initializeTeslemetry();
  assert.ok(sdk);

  // Every failed reconnect attempt fires "disconnect" first, whether or not
  // it's an auth failure - a non-auth outage must not be silently ignored.
  sdk!.sse.emit("disconnect");
  assert.equal(timers.length, 2, "one stale-check grace period scheduled per product");
  assert.equal(timers[0].delay, 90_000);
  assert.equal(vehicleDevice.unavailableCalls.length, 0, "not marked unavailable before the grace period elapses");

  // Grace period elapses with no genuine data.
  const staleTimers = [...timers];
  timers.length = 0;
  for (const timer of staleTimers) timer.callback();

  assert.deepEqual(vehicleDevice.unavailableCalls, ["error.stream_disconnected"]);
  assert.deepEqual(siteDevice.unavailableCalls, ["error.stream_disconnected"]);

  // A cached replay is not evidence of a live connection.
  sdk!.sse.emit("live_status", { site_id: "site-1", isCache: true });
  assert.equal(siteDevice.availableCalls.length, 0, "a cached replay does not restore availability");

  // Only the site's own genuine event restores it - the vehicle stays down.
  sdk!.sse.emit("live_status", { site_id: "site-1" });
  assert.equal(siteDevice.availableCalls.length, 1, "recovered on its own genuine data");
  assert.equal(vehicleDevice.availableCalls.length, 0, "an unrelated product's recovery must not restore this device");

  sdk!.sse.emit("state", { vin: "vin-1" });
  assert.equal(vehicleDevice.availableCalls.length, 1, "recovered once its own product's genuine data arrived");
});

test("one product recovering during the grace period does not cancel stale detection for another product", async () => {
  const { app, timers, drivers } = createAppStub();
  const vehicleDevice = createDeviceStub("vehicle:vin-1");
  const siteDevice = createDeviceStub("site:site-1");
  drivers.vehicle = { getDevices: () => [vehicleDevice.device] };
  drivers.battery = { getDevices: () => [siteDevice.device] };

  let sdk: { sse: FakeStream } | undefined;
  configureTeslemetryStub(() => {
    sdk = { sse: new FakeStream() };
    return { ...sdk, createProducts: async () => ({ vehicles: {}, energySites: {} }) };
  });
  await app.initializeTeslemetry();

  sdk!.sse.emit("disconnect");
  sdk!.sse.emit("live_status", { site_id: "site-1" });
  assert.equal(timers.length, 1, "the other product keeps the watchdog active");

  timers[0].callback();
  assert.deepEqual(siteDevice.unavailableCalls, []);
  assert.deepEqual(vehicleDevice.unavailableCalls, ["error.stream_disconnected"]);
});

test("a failed forced rebuild leaves the active generation's stream handlers effective", async () => {
  const { app, timers, drivers } = createAppStub();
  const device = createDeviceStub("vehicle:vin-1");
  drivers.vehicle = { getDevices: () => [device.device] };

  let activeSdk: { sse: FakeStream } | undefined;
  configureTeslemetryStub(() => {
    activeSdk = { sse: new FakeStream() };
    return { ...activeSdk, createProducts: async () => ({ vehicles: {}, energySites: {} }) };
  });
  await app.initializeTeslemetry();

  configureTeslemetryStub(() => ({
    sse: new FakeStream(),
    createProducts: async () => {
      throw new Error("replacement failed");
    },
  }));
  await assert.rejects(app.initializeTeslemetry(true), /replacement failed/);

  activeSdk!.sse.emit("disconnect");
  assert.equal(timers.length, 1, "the still-published generation continues monitoring disconnects");
  timers[0].callback();
  assert.deepEqual(device.unavailableCalls, ["error.stream_disconnected"]);
});

test("a recovered product receives a fresh watchdog on a later disconnect", async () => {
  const { app, timers, drivers } = createAppStub();
  const deviceA = createDeviceStub("vehicle:vin-a");
  const deviceB = createDeviceStub("vehicle:vin-b");
  drivers.vehicle = { getDevices: () => [deviceA.device, deviceB.device] };

  let sdk: { sse: FakeStream } | undefined;
  configureTeslemetryStub(() => {
    sdk = { sse: new FakeStream() };
    return { ...sdk, createProducts: async () => ({ vehicles: {}, energySites: {} }) };
  });
  await app.initializeTeslemetry();

  sdk!.sse.emit("disconnect");
  const firstTimers = [...timers];
  timers.length = 0;
  for (const timer of firstTimers) timer.callback();
  sdk!.sse.emit("state", { vin: "vin-a" });
  assert.equal(deviceA.availableCalls.length, 1);

  sdk!.sse.emit("disconnect");
  assert.equal(timers.length, 2, "both currently-bound products receive a fresh check");
  const secondTimers = [...timers];
  timers.length = 0;
  for (const timer of secondTimers) timer.callback();
  assert.deepEqual(deviceA.unavailableCalls, [
    "error.stream_disconnected",
    "error.stream_disconnected",
  ]);
});

test("disconnect during an in-flight initialization prevents stale publication", async () => {
  const { app } = createAppStub();
  let resolveProducts!: (products: { vehicles: {}; energySites: {} }) => void;
  const pendingProducts = new Promise<{ vehicles: {}; energySites: {} }>((resolve) => {
    resolveProducts = resolve;
  });
  const stream = new FakeStream();
  configureTeslemetryStub(() => ({
    sse: stream,
    createProducts: () => pendingProducts,
  }));

  const initialization = app.initializeTeslemetry(true);
  await flushMicrotasks();
  app.disconnectAccount();
  resolveProducts({ vehicles: {}, energySites: {} });
  await initialization;

  assert.equal(app.teslemetry, undefined);
  assert.equal(app.products, undefined);
  assert.equal(app.isReady(), false);
  assert.equal(stream.connected, false);
  assert.equal(stream.closed, true);
});

test("partial product recovery never clears another product's stale reason", async () => {
  const { app, timers, drivers } = createAppStub();
  const deviceA = createDeviceStub("vehicle:vin-a");
  const deviceB = createDeviceStub("vehicle:vin-b");
  drivers.vehicle = { getDevices: () => [deviceA.device, deviceB.device] };

  let sdk: { sse: FakeStream } | undefined;
  configureTeslemetryStub(() => {
    sdk = { sse: new FakeStream() };
    return { ...sdk, createProducts: async () => ({ vehicles: {}, energySites: {} }) };
  });
  await app.initializeTeslemetry();
  sdk!.sse.emit("disconnect");
  const staleTimers = [...timers];
  timers.length = 0;
  for (const timer of staleTimers) timer.callback();

  sdk!.sse.emit("state", { vin: "vin-a" });
  sdk!.sse.emit("state", { vin: "vin-a" });
  assert.equal(deviceA.availableCalls.length, 1);
  assert.equal(deviceB.availableCalls.length, 0);
  assert.deepEqual(deviceB.unavailableCalls, ["error.stream_disconnected"]);
});

test("successful generation replacement cancels prior watchdog timers", async () => {
  const { app, timers, drivers } = createAppStub();
  const device = createDeviceStub("vehicle:vin-1");
  drivers.vehicle = { getDevices: () => [device.device] };

  let firstSdk: { sse: FakeStream } | undefined;
  configureTeslemetryStub(() => {
    firstSdk = { sse: new FakeStream() };
    return { ...firstSdk, createProducts: async () => ({ vehicles: {}, energySites: {} }) };
  });
  await app.initializeTeslemetry();
  firstSdk!.sse.emit("disconnect");
  assert.equal(timers.length, 1);

  let secondSdk: { sse: FakeStream } | undefined;
  configureTeslemetryStub(() => {
    secondSdk = { sse: new FakeStream() };
    return { ...secondSdk, createProducts: async () => ({ vehicles: {}, energySites: {} }) };
  });
  await app.initializeTeslemetry(true);
  assert.equal(timers.length, 0, "the superseded generation's timer was cleared");

  secondSdk!.sse.emit("disconnect");
  assert.equal(timers.length, 1);
  const currentTimer = timers[0];
  timers.length = 0;
  currentTimer.callback();
  assert.deepEqual(device.unavailableCalls, ["error.stream_disconnected"]);
});

test("manual Disconnect (api.ts's disconnectAccount) marks every device unavailable and clears the token (finding 6)", async () => {
  const { app, drivers } = createAppStub();
  const deviceA = createDeviceStub("vehicle:vin-1");
  const deviceB = createDeviceStub("site:site-1");
  drivers.vehicle = { getDevices: () => [deviceA.device] };
  drivers.battery = { getDevices: () => [deviceB.device] };

  configureTeslemetryStub(() => ({
    sse: new FakeStream(),
    createProducts: async () => ({ vehicles: {}, energySites: {} }),
  }));
  await app.initializeTeslemetry();
  assert.equal(app.isReady(), true);

  app.disconnectAccount();

  assert.deepEqual(deviceA.unavailableCalls, ["error.account_disconnected"]);
  assert.deepEqual(deviceB.unavailableCalls, ["error.account_disconnected"]);
  assert.equal(app.oauth.hasValidToken(), false, "the token was cleared by the same teardown");
  assert.equal(app.isReady(), false, "the torn-down generation is no longer ready");
});

test("device auth-unavailability clears only on this device's own genuine post-reauth event, never on an unrelated one (finding 9)", async () => {
  const { app, drivers } = createAppStub();
  const authDevice = createDeviceStub("vehicle:vin-1");
  const otherDevice = createDeviceStub("site:site-1");
  drivers.vehicle = { getDevices: () => [authDevice.device] };
  drivers.battery = { getDevices: () => [otherDevice.device] };

  let sdk: { sse: FakeStream } | undefined;
  configureTeslemetryStub(() => {
    sdk = { sse: new FakeStream() };
    return { ...sdk, createProducts: async () => ({ vehicles: {}, energySites: {} }) };
  });
  await app.initializeTeslemetry();

  // The terminal SSE auth_failure path (same as a manual Disconnect) marks
  // every device unavailable with the "auth" reason.
  sdk!.sse.emit("auth_failure", new Error("auth dead"));
  assert.deepEqual(authDevice.unavailableCalls, ["error.invalid_refresh_token"]);
  assert.deepEqual(otherDevice.unavailableCalls, ["error.invalid_refresh_token"]);

  // Reauth completes (a real exchangeCodeForToken() would set a fresh valid
  // token) and fires oauth2:token_saved, which app.ts handles by forcing a
  // rebuild.
  (app.oauth as unknown as ReturnType<typeof createFakeOAuth>).setValid(true);
  let sdk2: { sse: FakeStream } | undefined;
  configureTeslemetryStub(() => {
    sdk2 = { sse: new FakeStream() };
    return { ...sdk2, createProducts: async () => ({ vehicles: {}, energySites: {} }) };
  });
  await app.initializeTeslemetry(true);

  // An unrelated device's genuine event must not clear this device's reason.
  sdk2!.sse.emit("live_status", { site_id: "site-1" });
  assert.equal(otherDevice.availableCalls.length, 1, "the unrelated device recovers on its own evidence");
  assert.equal(authDevice.availableCalls.length, 0, "still down - no evidence for this device yet");

  // This device's own genuine event is the only thing that clears it.
  sdk2!.sse.emit("state", { vin: "vin-1" });
  assert.equal(authDevice.availableCalls.length, 1, "cleared only once its own product proved reauth worked");
});
