import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryDevice from "../.homeybuild/lib/TeslemetryDevice.js";

function createDeviceStub() {
  const errorCalls: unknown[][] = [];
  const stub = Object.assign(new (TeslemetryDevice as any)(), {
    getName: () => "Test Device",
    error: (...args: unknown[]) => {
      errorCalls.push(args);
    },
    homey: { __: (key: string) => key },
    setUnavailable: async () => {},
  });
  return { stub, errorCalls };
}

test("action() resolves once the underlying promise resolves, well within the timeout", async () => {
  const { stub } = createDeviceStub();

  await (stub as any).action(Promise.resolve("ok"));
});

test("action() clears its timeout timer once the command settles first", async () => {
  const { stub } = createDeviceStub();
  const originalClearTimeout = global.clearTimeout;
  const clearedTimers: unknown[] = [];
  global.clearTimeout = ((timer: unknown) => {
    clearedTimers.push(timer);
    return originalClearTimeout(timer as any);
  }) as typeof clearTimeout;

  try {
    await (stub as any).action(Promise.resolve("ok"));
    // Let the .finally() microtask that clears the timer flush.
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    global.clearTimeout = originalClearTimeout;
  }

  assert.equal(clearedTimers.length, 1, "the action timeout timer was cleared exactly once");
});

test("action() lets a rejection through handleApiError before the timeout wins", async () => {
  const { stub, errorCalls } = createDeviceStub();

  await assert.rejects(
    () => (stub as any).action(Promise.reject(new Error("boom"))),
    /boom/,
  );
  assert.ok(errorCalls.some((args) => String(args[0]).includes("API Error")));
});

test("action() resolves via the 9s timeout when the underlying promise never settles, then logs a late rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stub, errorCalls } = createDeviceStub();

  let rejectPromise!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => {
    rejectPromise = reject;
  });

  const actionPromise = (stub as any).action(pending);
  t.mock.timers.tick(9000);
  await actionPromise;

  assert.deepEqual(
    errorCalls.filter((args) => String(args[0]).includes("API Error")),
    [],
    "no error logged yet - the underlying promise hasn't rejected",
  );

  rejectPromise(new Error("late failure"));
  // Let the rejection's .then/.catch microtasks flush.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const lateLog = errorCalls.find((args) =>
    String(args[0]).includes("failed after the 9000ms action timeout"),
  );
  assert.ok(lateLog, "late rejection after timeout is logged");
  assert.ok(String(lateLog![0]).includes("Test Device"));
});

test("handleApiResponse throws a command_failed error when response.result is false", () => {
  const { stub } = createDeviceStub();

  assert.throws(
    () =>
      (stub as any).handleApiResponse({
        response: { result: false, reason: "vehicle asleep" },
      }),
    (error: any) => {
      assert.equal(error.message, "vehicle asleep");
      assert.equal(error.code, "command_failed");
      assert.equal(error.response, null);
      return true;
    },
  );
});

test("handleApiResponse does not throw when response.result is true", () => {
  const { stub } = createDeviceStub();

  assert.doesNotThrow(() =>
    (stub as any).handleApiResponse({ response: { result: true } }),
  );
});

// --- Undoing Homey's optimistic commit after a late failure ---

function createListenerStub(capabilities: Record<string, unknown>) {
  const { stub, errorCalls } = createDeviceStub();
  const listeners: Record<string, (value: unknown) => Promise<void>> = {};
  const pending: Array<(error: Error) => void> = [];
  Object.assign(stub, {
    getCapabilityValue: (c: string) => capabilities[c],
    setCapabilityValue: async (c: string, v: unknown) => {
      capabilities[c] = v;
    },
    registerCapabilityListener: (c: string, l: (value: unknown) => Promise<void>) => {
      listeners[c] = l;
    },
  });
  const command = () =>
    (stub as any).action(
      new Promise<void>((_resolve, reject) => pending.push(reject)),
    );
  (stub as any).registerCommandListener("onoff.sentry", async () => command());
  (stub as any).registerCommandListener("charge_limit", async () => command());
  (stub as any).registerCommandListener("button.honk", async () => command());
  return { listeners, pending, errorCalls };
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("a late failure leaves a value telemetry already changed alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capabilities: Record<string, unknown> = { charge_limit: 0.8 };
  const { listeners, pending } = createListenerStub(capabilities);

  const call = listeners.charge_limit(0.9);
  t.mock.timers.tick(9000);
  await call;
  capabilities.charge_limit = 0.9; // Homey's commit
  capabilities.charge_limit = 0.85; // then telemetry reports another value
  pending[0](new Error("could_not_wake_vehicle"));
  await flush();

  assert.equal(capabilities.charge_limit, 0.85);
});

test("a late failure of a superseded command does not undo the newer one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capabilities: Record<string, unknown> = { "onoff.sentry": false };
  const { listeners, pending } = createListenerStub(capabilities);

  const first = listeners["onoff.sentry"](true);
  t.mock.timers.tick(9000);
  await first;
  capabilities["onoff.sentry"] = true;

  const second = listeners["onoff.sentry"](true);
  t.mock.timers.tick(9000);
  await second;

  pending[0](new Error("could_not_wake_vehicle"));
  await flush();
  assert.equal(capabilities["onoff.sentry"], true, "the newer command is still in flight");

  pending[1](new Error("could_not_wake_vehicle"));
  await flush();
  assert.equal(capabilities["onoff.sentry"], true, "its pre-command value was already true");
});

test("a late failure of a button press writes nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capabilities: Record<string, unknown> = { "button.honk": null };
  const { listeners, pending, errorCalls } = createListenerStub(capabilities);

  const call = listeners["button.honk"](true);
  t.mock.timers.tick(9000);
  await call;
  capabilities["button.honk"] = true;
  pending[0](new Error("could_not_wake_vehicle"));
  await flush();

  assert.equal(capabilities["button.honk"], true);
  assert.ok(
    errorCalls.some((args) => String(args[0]).includes("failed after the 9000ms action timeout")),
  );
});

test("a failure before the timeout rejects the listener and needs no undo", async () => {
  const capabilities: Record<string, unknown> = { "onoff.sentry": false };
  const { listeners, pending } = createListenerStub(capabilities);

  const call = listeners["onoff.sentry"](true);
  pending[0](new Error("vehicle asleep"));
  await assert.rejects(call, /vehicle asleep/);
  assert.equal(capabilities["onoff.sentry"], false);
});
