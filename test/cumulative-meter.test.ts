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

  assert.equal(store["meter_meter_power_offset"], 90);
  assert.equal(capabilities["meter_power"], 100);
});

test("updateCumulativeMeter treats a missing capability value as zero when initializing the offset", async () => {
  const { stub, capabilities, store } = createDeviceStub({
    meter_power: undefined,
  });

  await stub.updateCumulativeMeter("meter_power", 10, "2026-07-23");

  assert.equal(store["meter_meter_power_offset"], -10);
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

  assert.equal(store["meter_meter_power_offset"], 20);
  assert.equal(capabilities["meter_power"], 25);
  assert.equal(store["meter_meter_power_date"], "2026-07-23");
  assert.equal(store["meter_meter_power_last"], 5);
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
  const offsetAfterFirst = store["meter_meter_power_offset"];

  await stub.updateCumulativeMeter("meter_power", 20, "2026-07-23");

  assert.equal(store["meter_meter_power_offset"], offsetAfterFirst);
  assert.equal(capabilities["meter_power"], 10);
});

test("updateCumulativeMeter does not roll over on the very first reading even though lastDate starts null", async () => {
  const { stub, capabilities, store } = createDeviceStub({ meter_power: 0 });

  await stub.updateCumulativeMeter("meter_power", 50, "2026-07-23");

  assert.equal(store["meter_meter_power_offset"], -50);
  assert.equal(capabilities["meter_power"], 0);
});

test("updateCumulativeMeter passes a lower same-day raw reading straight through as a decreasing value", async () => {
  // Documents current behavior: the day-rollover offset only accounts for
  // a date change, so a same-day drop in the raw total is not guarded and
  // reaches setCapabilityValue as a decrease.
  const { stub, capabilities } = createDeviceStub({ meter_power: 0 });

  await stub.updateCumulativeMeter("meter_power", 40, "2026-07-23");
  assert.equal(capabilities["meter_power"], 0);

  await stub.updateCumulativeMeter("meter_power", 25, "2026-07-23");

  assert.equal(capabilities["meter_power"], -15);
});

test("updateCumulativeMeter is a no-op once the device is destroyed", async () => {
  const { stub, capabilities, store } = createDeviceStub({ meter_power: 0 });
  stub.destroyed = true;

  await stub.updateCumulativeMeter("meter_power", 10, "2026-07-23");

  assert.equal(capabilities["meter_power"], 0);
  assert.equal(store["meter_meter_power_offset"], undefined);
});

test("updateCumulativeMeter stops mid-flight if the device is destroyed after offset initialization", async () => {
  const { stub, capabilities, store } = createDeviceStub({ meter_power: 0 });
  const realSetStoreValue = stub.setStoreValue.bind(stub);
  let calls = 0;
  stub.setStoreValue = async (key: string, value: unknown) => {
    calls += 1;
    if (calls === 1) {
      // Simulate onUninit() firing between the offset write and the rest
      // of the update, the same race the `destroyed` guard exists for.
      stub.destroyed = true;
    }
    return realSetStoreValue(key, value);
  };

  await stub.updateCumulativeMeter("meter_power", 10, "2026-07-23");

  assert.equal(store["meter_meter_power_offset"], -10);
  assert.equal(store["meter_meter_power_date"], undefined);
  assert.equal(capabilities["meter_power"], 0);
});
