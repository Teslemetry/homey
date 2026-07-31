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
