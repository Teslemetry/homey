import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

const PIN = "1974";

function createFlowDeviceStub(
  apiOverrides: Record<string, (...args: unknown[]) => Promise<unknown>> = {},
) {
  const apiCalls: Array<{ method: string; args: unknown[] }> = [];
  const logCalls: unknown[] = [];
  const defaultHandler =
    (method: string) =>
    (...args: unknown[]) => {
      apiCalls.push({ method, args });
      return Promise.resolve({ response: { result: true } });
    };
  const api = new Proxy(
    {},
    {
      get: (_target, method: string) => {
        if (apiOverrides[method]) {
          return (...args: unknown[]) => {
            apiCalls.push({ method, args });
            return apiOverrides[method](...args);
          };
        }
        return defaultHandler(method);
      },
    },
  );

  // new VehicleDevice(), not Object.create(VehicleDevice.prototype): the
  // latter skips the constructor, leaving handleApiResponse/handleApiError
  // (arrow-function class fields, not prototype methods) undefined.
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: { getDevices: () => [] as unknown[] },
    vehicle: { api, sse: { cache: { data: {} } } },
    getName: () => "Test Vehicle",
    log: (...args: unknown[]) => logCalls.push(args),
    error: (...args: unknown[]) => logCalls.push(args),
    getCapabilities: () => [],
    getCapabilityValue: () => undefined,
    setCapabilityValue: async () => {},
  });
  return { stub, apiCalls, logCalls };
}

const RESULT_FALSE = () =>
  Promise.resolve({ response: { result: false, reason: "vehicle asleep" } });

// --- Valet mode ---

test("flowEnableValetMode calls setValetMode(true, pin)", async () => {
  const { stub, apiCalls } = createFlowDeviceStub();

  await stub.flowEnableValetMode(PIN);

  assert.deepEqual(apiCalls, [{ method: "setValetMode", args: [true, PIN] }]);
});

test("flowDisableValetMode calls setValetMode(false, pin)", async () => {
  const { stub, apiCalls } = createFlowDeviceStub();

  await stub.flowDisableValetMode(PIN);

  assert.deepEqual(apiCalls, [{ method: "setValetMode", args: [false, PIN] }]);
});

test("flowEnableValetMode surfaces an explicit Tesla result:false as a rejection", async () => {
  const { stub } = createFlowDeviceStub({ setValetMode: RESULT_FALSE });

  await assert.rejects(() => stub.flowEnableValetMode(PIN), /vehicle asleep/);
});

test("flowDisableValetMode surfaces an explicit Tesla result:false as a rejection", async () => {
  const { stub } = createFlowDeviceStub({ setValetMode: RESULT_FALSE });

  await assert.rejects(() => stub.flowDisableValetMode(PIN), /vehicle asleep/);
});

// --- Speed limit ---

test("flowActivateSpeedLimit calls speedLimitActivate(pin)", async () => {
  const { stub, apiCalls } = createFlowDeviceStub();

  await stub.flowActivateSpeedLimit(PIN);

  assert.deepEqual(apiCalls, [{ method: "speedLimitActivate", args: [PIN] }]);
});

test("flowDeactivateSpeedLimit calls speedLimitDeactivate(pin)", async () => {
  const { stub, apiCalls } = createFlowDeviceStub();

  await stub.flowDeactivateSpeedLimit(PIN);

  assert.deepEqual(apiCalls, [
    { method: "speedLimitDeactivate", args: [PIN] },
  ]);
});

test("flowActivateSpeedLimit surfaces an explicit Tesla result:false as a rejection", async () => {
  const { stub } = createFlowDeviceStub({ speedLimitActivate: RESULT_FALSE });

  await assert.rejects(
    () => stub.flowActivateSpeedLimit(PIN),
    /vehicle asleep/,
  );
});

test("flowDeactivateSpeedLimit surfaces an explicit Tesla result:false as a rejection", async () => {
  const { stub } = createFlowDeviceStub({
    speedLimitDeactivate: RESULT_FALSE,
  });

  await assert.rejects(
    () => stub.flowDeactivateSpeedLimit(PIN),
    /vehicle asleep/,
  );
});

// --- PIN redaction: the PIN must never reach this.log/this.error, on
// either the success or the command-failure path. ---

const PIN_METHODS: Array<{
  name: string;
  run: (stub: VehicleDevice) => Promise<void>;
  apiMethod: string;
}> = [
  {
    name: "flowEnableValetMode",
    run: (stub) => stub.flowEnableValetMode(PIN),
    apiMethod: "setValetMode",
  },
  {
    name: "flowDisableValetMode",
    run: (stub) => stub.flowDisableValetMode(PIN),
    apiMethod: "setValetMode",
  },
  {
    name: "flowActivateSpeedLimit",
    run: (stub) => stub.flowActivateSpeedLimit(PIN),
    apiMethod: "speedLimitActivate",
  },
  {
    name: "flowDeactivateSpeedLimit",
    run: (stub) => stub.flowDeactivateSpeedLimit(PIN),
    apiMethod: "speedLimitDeactivate",
  },
];

for (const { name, run, apiMethod } of PIN_METHODS) {
  test(`${name} never logs the PIN on success`, async () => {
    const { stub, logCalls } = createFlowDeviceStub();

    await run(stub);

    for (const call of logCalls) {
      assert.doesNotMatch(JSON.stringify(call), new RegExp(PIN));
    }
  });

  test(`${name} never logs the PIN when the command fails`, async () => {
    const { stub, logCalls } = createFlowDeviceStub({
      [apiMethod]: RESULT_FALSE,
    });

    await assert.rejects(() => run(stub));

    for (const call of logCalls) {
      assert.doesNotMatch(JSON.stringify(call), new RegExp(PIN));
    }
  });

  test(`${name} never logs the PIN when the SDK call itself rejects`, async () => {
    // A rejected promise (network error, etc., not a { result: false }
    // response) goes through handleApiError's plain-Error branch - a
    // separate code path from the result:false case above that must
    // equally never fold the PIN into its this.error(...) call.
    const { stub, logCalls } = createFlowDeviceStub({
      [apiMethod]: () => Promise.reject(new Error("network error")),
    });

    await assert.rejects(() => run(stub));

    for (const call of logCalls) {
      assert.doesNotMatch(JSON.stringify(call), new RegExp(PIN));
    }
  });
}
