import test from "node:test";
import assert from "node:assert/strict";
// The *real* SDK stream (see energy-site-live-dispatch.test.ts).
import { TeslemetryStream } from "./support/teslemetry-api-stub.js";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryDevice from "../.homeybuild/lib/TeslemetryDevice.js";
import SolarDevice from "../.homeybuild/drivers/solar/device.js";
import GatewayDevice from "../.homeybuild/drivers/gateway/device.js";

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

test("updateCumulativeMeter recalibrates a pre-v2 (UTC-keyed) stored state from the current value instead of jumping or dropping updates", async () => {
  const { stub, capabilities, store } = createDeviceStub({ meter_power: 100 });
  // A US site upgraded in the evening: v1 keyed the day on createdAt's UTC
  // date, which is already the next day there.
  store["meter_meter_power_state"] = {
    v: 1,
    date: "2026-09-22",
    lastTotal: 1,
    offset: 99,
  };

  await stub.updateCumulativeMeter("meter_power", 30, "2026-09-21");
  assert.equal(capabilities["meter_power"], 100);

  await stub.updateCumulativeMeter("meter_power", 31, "2026-09-21");
  assert.equal(capabilities["meter_power"], 101);

  await stub.updateCumulativeMeter("meter_power", 2, "2026-09-22");
  assert.equal(capabilities["meter_power"], 103);
  assert.equal(
    (store["meter_meter_power_state"] as { v: number }).v,
    2,
  );
});

/*
 * Wire-shaped energy_totals through the real TeslemetryStream into real
 * energy devices. The api publishes one event per 5-minute poll: `date` is
 * the installation-local day the totals cover, `createdAt` the latest
 * bucket's end in UTC, and at local midnight the closed prior day's final
 * is published (its own `date`) before the new day opens.
 */

const SITE_ID = 1689169815425134;
const SITE_KEY = String(SITE_ID);

function createStream() {
  const logger = { info() {}, error() {}, warn() {}, debug() {} };
  const root: Record<string, unknown> = { logger };
  const stream = new TeslemetryStream(root, { cache: true });
  root.sse = stream;
  return stream;
}

function createEnergyDeviceStub(
  DeviceClass: typeof SolarDevice | typeof GatewayDevice,
  siteStream: unknown,
  caps: string[],
) {
  const capabilities: Record<string, unknown> = {};
  for (const c of caps) capabilities[c] = null;
  const store: Record<string, unknown> = {};
  const timers: Array<() => Promise<void>> = [];
  const api = new Proxy({}, { get: () => () => Promise.resolve() });
  const stub = Object.assign(Object.create(DeviceClass.prototype), {
    homey: {
      app: {
        products: {
          energySites: {
            [SITE_KEY]: {
              id: SITE_ID,
              api,
              sse: siteStream,
              metadata: { access: true },
            },
          },
        },
        isReady: () => true,
      },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
      setTimeout: (callback: () => Promise<void>) => timers.push(callback),
      clearTimeout: () => {},
    },
    driver: {
      manifest: { capabilities: caps, capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ id: SITE_ID }),
    getCapabilities: () => caps,
    getCapabilityValue: (c: string) => capabilities[c],
    setCapabilityValue: async (c: string, v: unknown) => {
      capabilities[c] = v;
    },
    setCapabilityOptions: async () => {},
    getStoreValue: (k: string) => (k in store ? store[k] : null),
    setStoreValue: async (k: string, v: unknown) => {
      store[k] = v;
    },
    registerCapabilityListener: () => {},
    setAvailable: async () => {},
    setUnavailable: async () => {},
    log: () => {},
    error: () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, capabilities, timers };
}

const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

/**
 * Simulates `days` local days of 5-minute polls for a fixed-offset site.
 * Clock values are "local ms" (UTC fields read as local wall time).
 * Returns the true delivered kWh and the meter at every hour.
 */
async function simulateSite(opts: {
  DeviceClass: typeof SolarDevice | typeof GatewayDevice;
  caps: string[];
  totalsField: string;
  meterCap: string;
  offsetHours: number;
  days: number;
  powerKw: (minuteOfDay: number, day: number) => number;
}) {
  const stream = createStream();
  const { stub, capabilities } = createEnergyDeviceStub(
    opts.DeviceClass,
    stream.getEnergySite(SITE_KEY),
    opts.caps,
  );
  await stub.onInit();

  const start = Date.UTC(2026, 8, 20);
  let truth = 0;
  let dayTotalWh = 0;
  const samples: Array<{ at: string; truth: number; meter: number }> = [];

  for (let step = 1; step <= opts.days * 288; step++) {
    const bucketEnd = start + step * 300_000;
    const bucketStart = bucketEnd - 300_000;
    const minuteOfDay = Math.floor((bucketStart - start) / 60_000) % 1440;
    const day = Math.floor((bucketStart - start) / 86_400_000);
    const wh = opts.powerKw(minuteOfDay, day) * 1000 * (5 / 60);
    truth += wh / 1000;
    dayTotalWh += wh;
    // The day's last bucket is its final (dated to the closing day); the
    // next poll opens the new day from zero.
    stream._dispatch({
      createdAt: new Date(bucketEnd - opts.offsetHours * 3_600_000).toISOString(),
      id: SITE_ID,
      date: new Date(bucketStart).toISOString().slice(0, 10),
      totals: { [opts.totalsField]: dayTotalWh },
    });
    await flush();
    if (minuteOfDay === 1435) dayTotalWh = 0;
    if (step % 12 === 0) {
      samples.push({
        at: new Date(bucketEnd).toISOString().slice(0, 16),
        truth,
        meter: capabilities[opts.meterCap] as number,
      });
    }
  }
  return samples;
}

function assertMeterTracksTruth(
  samples: Array<{ at: string; truth: number; meter: number }>,
) {
  for (const { at, truth, meter } of samples) {
    assert.ok(
      Math.abs(meter - truth) < 1e-6,
      `at ${at} local: meter ${meter.toFixed(2)} kWh, truth ${truth.toFixed(2)} kWh`,
    );
  }
}

test("Solar meter_power equals the energy produced at every hour for a UTC-7 site across local and UTC midnights", async () => {
  const samples = await simulateSite({
    DeviceClass: SolarDevice,
    caps: ["measure_power", "meter_power", "solar_generation_today"],
    totalsField: "total_solar_generation",
    meterCap: "meter_power",
    offsetHours: -7,
    days: 3,
    // 07:00-18:00 sine, 5 kW peak.
    powerKw: (minuteOfDay) => {
      const h = minuteOfDay / 60;
      return h < 7 || h >= 18 ? 0 : 5 * Math.sin(((h - 7) / 11) * Math.PI);
    },
  });
  assertMeterTracksTruth(samples);
});

test("Gateway meter_power.imported equals the energy imported at every hour for a UTC+10 site with a heavy morning import", async () => {
  const samples = await simulateSite({
    DeviceClass: GatewayDevice,
    caps: ["measure_power", "meter_power.imported", "grid_imported_today"],
    totalsField: "grid_energy_imported",
    meterCap: "meter_power.imported",
    offsetHours: 10,
    days: 3,
    // 2 kWh each evening, except a 1 kW import all morning on day 1.
    powerKw: (minuteOfDay, day) => {
      const h = minuteOfDay / 60;
      if (day === 1) return h < 10 ? 1 : 0;
      return h >= 18 && h < 20 ? 1 : 0;
    },
  });
  assertMeterTracksTruth(samples);
});

test("the prior-day final published after the local-midnight reset leaves solar_generation_today at zero", async () => {
  const stream = createStream();
  const { stub, capabilities, timers } = createEnergyDeviceStub(
    SolarDevice,
    stream.getEnergySite(SITE_KEY),
    ["measure_power", "meter_power", "solar_generation_today"],
  );
  await stub.onInit();
  stream._dispatch({
    createdAt: "2026-09-29T13:50:00.000Z",
    site_id: SITE_ID,
    site_info: { installation_time_zone: "Australia/Brisbane" },
  });
  assert.equal(timers.length, 1);

  // 23:55 local (UTC+10) poll for 09-29.
  stream._dispatch({
    createdAt: "2026-09-29T13:55:00.000Z",
    id: SITE_ID,
    date: "2026-09-29",
    totals: { total_solar_generation: 31000 },
  });
  await flush();
  assert.equal(capabilities.solar_generation_today, 31);

  // The local-midnight timer resets the gauge.
  await timers[0]();
  assert.equal(capabilities.solar_generation_today, 0);

  // ~00:05: the dated 09-29 final, then the 09-30 opener.
  stream._dispatch({
    createdAt: "2026-09-29T14:00:00.000Z",
    id: SITE_ID,
    date: "2026-09-29",
    totals: { total_solar_generation: 31200 },
  });
  await flush();
  assert.equal(capabilities.solar_generation_today, 0);

  stream._dispatch({
    createdAt: "2026-09-29T14:05:00.000Z",
    id: SITE_ID,
    date: "2026-09-30",
    totals: { total_solar_generation: 0 },
  });
  await flush();
  assert.equal(capabilities.solar_generation_today, 0);

  stream._dispatch({
    createdAt: "2026-09-29T22:00:00.000Z",
    id: SITE_ID,
    date: "2026-09-30",
    totals: { total_solar_generation: 1500 },
  });
  await flush();
  assert.equal(capabilities.solar_generation_today, 1.5);
  // The final's last 0.2 kWh still reached the cumulative meter.
  assert.ok(Math.abs((capabilities.meter_power as number) - 1.7) < 1e-9);
});
