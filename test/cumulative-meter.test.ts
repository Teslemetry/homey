import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryDevice from "../.homeybuild/lib/TeslemetryDevice.js";

function createDeviceStub(capabilities: Record<string, unknown>) {
  const store: Record<string, unknown> = {};
  const stub = Object.assign(new TeslemetryDevice(), {
    destroyed: false,
    error: () => {},
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    getStoreValue: (key: string) =>
      key in store ? (store[key] as unknown) : null,
    setStoreValue: async (key: string, value: unknown) => {
      store[key] = value;
    },
  });
  return { stub, capabilities, store };
}

test("updateCumulativeMeter initializes the offset from the existing capability value on first reading", async () => {
  const { stub, capabilities, store } = createDeviceStub({ meter_power: 100 });

  await stub.updateCumulativeMeter("meter_power", 10, "2026-07-23");

  assert.equal(
    (store["meter_meter_power_state"] as { offset: number }).offset,
    90,
  );
  assert.equal(capabilities["meter_power"], 100);
});

test("updateCumulativeMeter treats a missing capability value as zero when initializing the offset", async () => {
  const { stub, capabilities, store } = createDeviceStub({
    meter_power: undefined,
  });

  await stub.updateCumulativeMeter("meter_power", 10, "2026-07-23");

  assert.equal(
    (store["meter_meter_power_state"] as { offset: number }).offset,
    -10,
  );
  assert.equal(capabilities["meter_power"], 0);
});

test("updateCumulativeMeter accumulates monotonically across successive same-day readings", async () => {
  const { stub, capabilities } = createDeviceStub({ meter_power: 0 });

  // The first reading only establishes the offset, so the capability
  // starts back at its pre-existing value (0 here) rather than jumping
  // straight to the raw reading.
  await stub.updateCumulativeMeter("meter_power", 10, "2026-07-23");
  assert.equal(capabilities["meter_power"], 0);

  await stub.updateCumulativeMeter("meter_power", 25, "2026-07-23");
  assert.equal(capabilities["meter_power"], 15);

  await stub.updateCumulativeMeter("meter_power", 40, "2026-07-23");
  assert.equal(capabilities["meter_power"], 30);
});

test("updateCumulativeMeter carries the prior day's total into the offset on day rollover", async () => {
  const { stub, capabilities, store } = createDeviceStub({ meter_power: 0 });

  await stub.updateCumulativeMeter("meter_power", 10, "2026-07-22");
  await stub.updateCumulativeMeter("meter_power", 30, "2026-07-22");
  assert.equal(capabilities["meter_power"], 20);

  // New day starts back near zero (a fresh daily total from the API).
  await stub.updateCumulativeMeter("meter_power", 5, "2026-07-23");

  const state = store["meter_meter_power_state"] as {
    offset: number;
    date: string;
    lastTotal: number;
  };
  assert.equal(state.offset, 20);
  assert.equal(capabilities["meter_power"], 25);
  assert.equal(state.date, "2026-07-23");
  assert.equal(state.lastTotal, 5);
});

test("updateCumulativeMeter continues accumulating across multiple day rollovers", async () => {
  const { stub, capabilities } = createDeviceStub({ meter_power: 0 });

  await stub.updateCumulativeMeter("meter_power", 10, "2026-07-21");
  await stub.updateCumulativeMeter("meter_power", 20, "2026-07-21");
  await stub.updateCumulativeMeter("meter_power", 5, "2026-07-22");
  await stub.updateCumulativeMeter("meter_power", 15, "2026-07-22");
  await stub.updateCumulativeMeter("meter_power", 3, "2026-07-23");

  assert.equal(capabilities["meter_power"], 28);
});

test("updateCumulativeMeter does not roll over the offset when the date is unchanged", async () => {
  const { stub, capabilities, store } = createDeviceStub({ meter_power: 0 });

  await stub.updateCumulativeMeter("meter_power", 10, "2026-07-23");
  const offsetAfterFirst = (
    store["meter_meter_power_state"] as { offset: number }
  ).offset;

  await stub.updateCumulativeMeter("meter_power", 20, "2026-07-23");

  assert.equal(
    (store["meter_meter_power_state"] as { offset: number }).offset,
    offsetAfterFirst,
  );
  assert.equal(capabilities["meter_power"], 10);
});

test("updateCumulativeMeter does not roll over on the very first reading even though no state is stored yet", async () => {
  const { stub, capabilities, store } = createDeviceStub({ meter_power: 0 });

  await stub.updateCumulativeMeter("meter_power", 50, "2026-07-23");

  assert.equal(
    (store["meter_meter_power_state"] as { offset: number }).offset,
    -50,
  );
  assert.equal(capabilities["meter_power"], 0);
});

test("updateCumulativeMeter clamps a lower same-day raw reading instead of writing a decrease", async () => {
  const { stub, capabilities, store } = createDeviceStub({ meter_power: 0 });

  await stub.updateCumulativeMeter("meter_power", 40, "2026-07-23");
  assert.equal(capabilities["meter_power"], 0);
  const stateAfterFirst = store["meter_meter_power_state"];

  await stub.updateCumulativeMeter("meter_power", 25, "2026-07-23");

  assert.equal(capabilities["meter_power"], 0);
  assert.deepEqual(store["meter_meter_power_state"], stateAfterFirst);
});

test("updateCumulativeMeter ignores an event whose date is older than the last-applied event", async () => {
  const { stub, capabilities, store } = createDeviceStub({ meter_power: 0 });

  await stub.updateCumulativeMeter("meter_power", 10, "2026-07-22");
  await stub.updateCumulativeMeter("meter_power", 30, "2026-07-22");
  await stub.updateCumulativeMeter("meter_power", 5, "2026-07-23"); // rollover
  assert.equal(capabilities["meter_power"], 25);
  const stateAfterRollover = store["meter_meter_power_state"];

  // A stale event for the already-superseded day arrives late.
  await stub.updateCumulativeMeter("meter_power", 999, "2026-07-22");

  assert.equal(capabilities["meter_power"], 25);
  assert.deepEqual(store["meter_meter_power_state"], stateAfterRollover);
});

test("updateCumulativeMeter never decreases the capability across a mixed sequence of rollovers, a regression, and a stale event", async () => {
  const { stub, capabilities } = createDeviceStub({ meter_power: 0 });
  const sequence: Array<[string, number]> = [
    ["2026-07-23", 10],
    ["2026-07-23", 25],
    ["2026-07-23", 20], // same-day regression, must clamp
    ["2026-07-23", 40],
    ["2026-07-24", 3], // rollover
    ["2026-07-22", 999], // stale/out-of-order, must be ignored
    ["2026-07-24", 12],
  ];

  const observed: number[] = [];
  for (const [dateKey, total] of sequence) {
    await stub.updateCumulativeMeter("meter_power", total, dateKey);
    observed.push(capabilities["meter_power"] as number);
  }

  for (let i = 1; i < observed.length; i++) {
    assert.ok(
      observed[i] >= observed[i - 1],
      `capability decreased at step ${i}: ${observed[i - 1]} -> ${observed[i]}`,
    );
  }
});

test("updateCumulativeMeter serializes overlapping calls for the same capability so they cannot interleave", async () => {
  const { stub, capabilities } = createDeviceStub({ meter_power: 0 });
  const realSetStoreValue = stub.setStoreValue.bind(stub);
  stub.setStoreValue = async (key: string, value: unknown) => {
    // Yield, opening a window where an unserialized second call could read
    // the same pre-write state this call just read.
    await Promise.resolve();
    return realSetStoreValue(key, value);
  };

  const first = stub.updateCumulativeMeter("meter_power", 10, "2026-07-23");
  const second = stub.updateCumulativeMeter("meter_power", 25, "2026-07-23");
  await Promise.all([first, second]);

  // Applied in call order: the first call establishes the offset, the
  // second accumulates on top of it - not two independent "first runs".
  assert.equal(capabilities["meter_power"], 15);
});

test("updateCumulativeMeter is a no-op once the device is destroyed", async () => {
  const { stub, capabilities, store } = createDeviceStub({ meter_power: 0 });
  stub.destroyed = true;

  await stub.updateCumulativeMeter("meter_power", 10, "2026-07-23");

  assert.equal(capabilities["meter_power"], 0);
  assert.equal(store["meter_meter_power_state"], undefined);
});

test("updateCumulativeMeter writes nothing if the device is destroyed mid-write, and never surfaces the partial state", async () => {
  const { stub, capabilities, store } = createDeviceStub({ meter_power: 0 });
  stub.setStoreValue = async () => {
    // Mirrors setStoreValue on a real deleted device: it throws instead of
    // succeeding once the device is gone.
    stub.destroyed = true;
    throw new Error("Not Found: Device with ID ...");
  };

  await stub.updateCumulativeMeter("meter_power", 10, "2026-07-23");

  assert.equal(store["meter_meter_power_state"], undefined);
  assert.equal(capabilities["meter_power"], 0);
});

test("updateCumulativeMeter recovers cleanly after a store-write failure without corrupting state", async () => {
  const { stub, capabilities, store } = createDeviceStub({ meter_power: 0 });
  const realSetStoreValue = stub.setStoreValue.bind(stub);
  let failNext = true;
  stub.setStoreValue = async (key: string, value: unknown) => {
    if (failNext) {
      failNext = false;
      throw new Error("simulated store failure");
    }
    return realSetStoreValue(key, value);
  };

  await stub.updateCumulativeMeter("meter_power", 10, "2026-07-23");
  // The single atomic write failed, so nothing was persisted or applied -
  // no partial offset/date/lastTotal state to recover from.
  assert.equal(store["meter_meter_power_state"], undefined);
  assert.equal(capabilities["meter_power"], 0);

  await stub.updateCumulativeMeter("meter_power", 25, "2026-07-23");
  // Recovery treats this as a fresh first-run recalibration off the
  // untouched capability value - no jump, no lost accumulation.
  assert.equal(capabilities["meter_power"], 0);
  assert.equal(
    (store["meter_meter_power_state"] as { offset: number }).offset,
    -25,
  );
});
