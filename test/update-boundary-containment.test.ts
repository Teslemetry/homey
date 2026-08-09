import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryDevice from "../.homeybuild/lib/TeslemetryDevice.js";

function createDeviceStub(
  capabilities: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  const flowCardStub = {
    trigger: async () => {},
  };
  const stub = Object.assign(new TeslemetryDevice(), {
    homey: {
      flow: {
        getDeviceTriggerCard: () => flowCardStub,
      },
    },
    driver: {
      getDevices: () => [] as unknown[],
    },
    error: () => {},
    log: () => {},
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    ...overrides,
  });
  if (!("driver" in overrides)) {
    stub.driver.getDevices = () => [stub];
  }
  return stub;
}

async function assertNoUnhandledRejection(fn: () => Promise<unknown>) {
  let caught: unknown;
  const onUnhandledRejection = (reason: unknown) => {
    caught = reason;
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    // A rejected update()/updateWithThresholdTriggers() Promise would surface
    // as an unhandledRejection on the next tick if this call site (matching
    // every real SSE signal handler) doesn't await/catch it.
    fn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      caught,
      undefined,
      `expected no unhandledRejection, got: ${String(caught)}`,
    );
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
}

test("update() does not reject and logs when getCapabilities() throws", async () => {
  let logged: unknown;
  const stub = createDeviceStub(
    { measure_power: 0 },
    {
      getCapabilities: () => {
        throw new Error("SDK lookup failure");
      },
      error: (e: unknown) => {
        logged = e;
      },
    },
  );

  await assert.doesNotReject(() => stub.update("measure_power", 5));
  assert.ok(logged instanceof Error);
});

test("update() does not reject and logs when getCapabilityValue() throws for a change-trigger capability", async () => {
  let logged: unknown;
  const stub = createDeviceStub(
    { grid_buy_rate_changed_marker: 0, grid_buy_rate: 0.1 },
    {
      getCapabilities: () => ["grid_buy_rate"],
      getCapabilityValue: () => {
        throw new Error("persisted value lookup failed");
      },
      error: (e: unknown) => {
        logged = e;
      },
    },
  );

  await assert.doesNotReject(() => stub.update("grid_buy_rate", 0.2));
  assert.ok(logged instanceof Error);
});

test("update() does not reject and logs when isLive()'s driver membership check throws", async () => {
  let logged: unknown;
  const stub = createDeviceStub(
    { grid_buy_rate: 0.1 },
    {
      getCapabilities: () => ["grid_buy_rate"],
      driver: {
        getDevices: () => {
          throw new Error("driver registry unavailable");
        },
      },
      error: (e: unknown) => {
        logged = e;
      },
    },
  );

  await assert.doesNotReject(() => stub.update("grid_buy_rate", 0.2));
  assert.ok(logged instanceof Error);
});

test("update() does not reject and logs when getDeviceTriggerCard() throws", async () => {
  let logged: unknown;
  const stub = createDeviceStub(
    { grid_buy_rate: 0.1 },
    {
      getCapabilities: () => ["grid_buy_rate"],
      homey: {
        flow: {
          getDeviceTriggerCard: () => {
            throw new Error("unknown flow card id");
          },
        },
      },
      error: (e: unknown) => {
        logged = e;
      },
    },
  );

  await assert.doesNotReject(() => stub.update("grid_buy_rate", 0.2));
  assert.ok(logged instanceof Error);
});

test("update()'s rejection cannot become a process-level unhandledRejection when discarded like a real SSE handler", async () => {
  const stub = createDeviceStub(
    { measure_power: 0 },
    {
      getCapabilities: () => {
        throw new Error("SDK lookup failure");
      },
    },
  );

  await assertNoUnhandledRejection(() => stub.update("measure_power", 5));
});

test("updateWithThresholdTriggers() does not reject and logs when getDeviceTriggerCard() throws", async () => {
  let logged: unknown;
  const stub = createDeviceStub(
    { measure_power: 100 },
    {
      getCapabilities: () => ["measure_power"],
      homey: {
        flow: {
          getDeviceTriggerCard: () => {
            throw new Error("unknown flow card id");
          },
        },
      },
      error: (e: unknown) => {
        logged = e;
      },
    },
  ) as unknown as {
    updateWithThresholdTriggers(
      capability: string,
      value: number,
      aboveCardId: string,
      belowCardId: string,
      tokenName: string,
    ): Promise<void>;
  };

  await assert.doesNotReject(() =>
    stub.updateWithThresholdTriggers(
      "measure_power",
      150,
      "power_above",
      "power_below",
      "watts",
    ),
  );
  assert.ok(logged instanceof Error);
});

test("updateWithThresholdTriggers() does not fire when the capability update fails", async () => {
  let triggerCount = 0;
  const stub = createDeviceStub(
    { measure_power: 100 },
    {
      getCapabilities: () => {
        throw new Error("SDK lookup failure");
      },
      homey: {
        flow: {
          getDeviceTriggerCard: () => ({
            trigger: async () => {
              triggerCount += 1;
            },
          }),
        },
      },
    },
  ) as unknown as {
    updateWithThresholdTriggers(
      capability: string,
      value: number,
      aboveCardId: string,
      belowCardId: string,
      tokenName: string,
    ): Promise<void>;
  };

  await stub.updateWithThresholdTriggers(
    "measure_power",
    150,
    "power_above",
    "power_below",
    "watts",
  );

  assert.equal(triggerCount, 0);
});

test("updateWithThresholdTriggers()'s rejection cannot become a process-level unhandledRejection when discarded", async () => {
  const stub = createDeviceStub(
    { measure_power: 100 },
    {
      getCapabilities: () => ["measure_power"],
      homey: {
        flow: {
          getDeviceTriggerCard: () => {
            throw new Error("unknown flow card id");
          },
        },
      },
    },
  ) as unknown as {
    updateWithThresholdTriggers(
      capability: string,
      value: number,
      aboveCardId: string,
      belowCardId: string,
      tokenName: string,
    ): Promise<void>;
  };

  await assertNoUnhandledRejection(() =>
    stub.updateWithThresholdTriggers(
      "measure_power",
      150,
      "power_above",
      "power_below",
      "watts",
    ),
  );
});

test("one device's failing update() does not block an unrelated device's update()", async () => {
  const failingStub = createDeviceStub(
    { measure_power: 0 },
    {
      getCapabilities: () => {
        throw new Error("SDK lookup failure on this device only");
      },
    },
  );
  const healthyCapabilities: Record<string, unknown> = { measure_power: 0 };
  const healthyStub = createDeviceStub(healthyCapabilities);

  await Promise.all([
    failingStub.update("measure_power", 999),
    healthyStub.update("measure_power", 42),
  ]);

  assert.equal(healthyCapabilities.measure_power, 42);
});
