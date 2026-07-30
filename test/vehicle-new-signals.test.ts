import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

class FakeVehicleStream extends EventEmitter {
  data = new EventEmitter();
  cache = { data: {} as Record<string, unknown> };

  onSignal(field: string, callback: (value: unknown) => void) {
    this.data.on(field, callback);
    return () => this.data.off(field, callback);
  }
}

// VIN position 4 (index 3) is "C" for Cybertruck; the tonneau tests need a
// Cybertruck-shaped VIN so ensureCapabilities() doesn't strip the
// Cybertruck-only tonneau capabilities it's asserting on.
const DEFAULT_VIN = "test-vin";

function createDeviceStub(
  capabilities: Record<string, unknown>,
  vin: string = DEFAULT_VIN,
) {
  const sse = new FakeVehicleStream();
  const vehicle = {
    sse,
    api: {},
    metadata: { config: { rhd: false, can_actuate_trunks: false } },
  };
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [vin]: vehicle } } },
      __: (key: string) => key,
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
    },
    getData: () => ({ vin, id: vin }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });
  return { stub, sse, capabilities };
}

test("MilesSinceReset converts miles to km on measure_distance.since_reset", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "measure_distance.since_reset": undefined,
  });
  await stub.onInit();

  sse.data.emit("MilesSinceReset", 100);

  assert.equal(capabilities["measure_distance.since_reset"], 100 * 1.609344);
});

test("SelfDrivingMilesSinceReset converts miles to km on measure_distance.fsd_since_reset", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "measure_distance.fsd_since_reset": undefined,
  });
  await stub.onInit();

  sse.data.emit("SelfDrivingMilesSinceReset", 50);

  assert.equal(capabilities["measure_distance.fsd_since_reset"], 50 * 1.609344);
});

test("null/undefined MilesSinceReset and SelfDrivingMilesSinceReset are skipped", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "measure_distance.since_reset": 5,
    "measure_distance.fsd_since_reset": 5,
  });
  await stub.onInit();

  sse.data.emit("MilesSinceReset", null);
  sse.data.emit("SelfDrivingMilesSinceReset", undefined);

  assert.equal(capabilities["measure_distance.since_reset"], 5);
  assert.equal(capabilities["measure_distance.fsd_since_reset"], 5);
});

test("LifetimeEnergyGainedRegen passes the native kWh value straight through to meter_power.regen", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "meter_power.regen": undefined,
  });
  await stub.onInit();

  sse.data.emit("LifetimeEnergyGainedRegen", 1234.5);

  assert.equal(capabilities["meter_power.regen"], 1234.5);
});

test("RearDefrostEnabled updates alarm_generic.rear_defrost", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "alarm_generic.rear_defrost": undefined,
  });
  await stub.onInit();

  sse.data.emit("RearDefrostEnabled", true);
  assert.equal(capabilities["alarm_generic.rear_defrost"], true);

  sse.data.emit("RearDefrostEnabled", false);
  assert.equal(capabilities["alarm_generic.rear_defrost"], false);
});

// Tonneau capabilities are Cybertruck-only (see vehicle-model-gating.test.ts),
// so these use a Cybertruck-shaped VIN.
const CYBERTRUCK_VIN = "XYZCTRK0000000001";

test("TonneauPosition maps Closed to true and PartiallyOpen/FullyOpen to false on windowcoverings_closed.tonneau", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { "windowcoverings_closed.tonneau": undefined },
    CYBERTRUCK_VIN,
  );
  await stub.onInit();

  sse.data.emit("TonneauPosition", "TonneauPositionStateClosed");
  assert.equal(capabilities["windowcoverings_closed.tonneau"], true);

  sse.data.emit("TonneauPosition", "TonneauPositionStateFullyOpen");
  assert.equal(capabilities["windowcoverings_closed.tonneau"], false);

  sse.data.emit("TonneauPosition", "TonneauPositionStatePartiallyOpen");
  assert.equal(capabilities["windowcoverings_closed.tonneau"], false);
});

test("TonneauPosition Unknown/Invalid states are skipped (no mapped value)", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { "windowcoverings_closed.tonneau": true },
    CYBERTRUCK_VIN,
  );
  await stub.onInit();

  sse.data.emit("TonneauPosition", "TonneauPositionStateUnknown");

  assert.equal(capabilities["windowcoverings_closed.tonneau"], true);
});

test("TonneauOpenPercent converts 0-100 percent to a 0-1 fraction on windowcoverings_set.tonneau", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { "windowcoverings_set.tonneau": undefined },
    CYBERTRUCK_VIN,
  );
  await stub.onInit();

  sse.data.emit("TonneauOpenPercent", 75);

  assert.equal(capabilities["windowcoverings_set.tonneau"], 0.75);
});

test("TpmsSoftWarnings/TpmsHardWarnings map each wheel to its own alarm_generic subcapability", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "alarm_generic.tpms_soft_fl": undefined,
    "alarm_generic.tpms_soft_fr": undefined,
    "alarm_generic.tpms_soft_rl": undefined,
    "alarm_generic.tpms_soft_rr": undefined,
    "alarm_generic.tpms_hard_fl": undefined,
    "alarm_generic.tpms_hard_fr": undefined,
    "alarm_generic.tpms_hard_rl": undefined,
    "alarm_generic.tpms_hard_rr": undefined,
  });
  await stub.onInit();

  sse.data.emit("TpmsSoftWarnings", {
    front_left: true,
    front_right: false,
    rear_left: false,
    rear_right: false,
  });
  sse.data.emit("TpmsHardWarnings", {
    front_left: false,
    front_right: false,
    rear_left: true,
    rear_right: false,
  });

  assert.equal(capabilities["alarm_generic.tpms_soft_fl"], true);
  assert.equal(capabilities["alarm_generic.tpms_soft_fr"], false);
  assert.equal(capabilities["alarm_generic.tpms_soft_rl"], false);
  assert.equal(capabilities["alarm_generic.tpms_soft_rr"], false);
  assert.equal(capabilities["alarm_generic.tpms_hard_fl"], false);
  assert.equal(capabilities["alarm_generic.tpms_hard_fr"], false);
  assert.equal(capabilities["alarm_generic.tpms_hard_rl"], true);
  assert.equal(capabilities["alarm_generic.tpms_hard_rr"], false);
});

/**
 * Reproduces the buggy encoding TpmsLastSeenPressureTime* actually uses, so
 * tests can construct a raw value that decodes to a known instant without
 * duplicating the fix's own arithmetic (see tpms-timestamp.test.ts for that).
 */
function encodeAsBuggyTpmsTimestamp(targetMs: number): number {
  const offsetParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(targetMs));
  const offsetLabel = offsetParts.find((p) => p.type === "timeZoneName")!.value;
  const match = offsetLabel.match(/GMT([+-]\d{2}):(\d{2})/)!;
  const offsetMs =
    (Number(match[1]) * 60 + Math.sign(Number(match[1])) * Number(match[2])) *
    60 *
    1000;
  return Math.round((targetMs - offsetMs) / 1000);
}

test("TpmsLastSeenPressureTime* marks a wheel stale after 24 hours and clears it again", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "alarm_generic.tpms_stale_fl": undefined,
  });
  await stub.onInit();

  sse.data.emit(
    "TpmsLastSeenPressureTimeFl",
    encodeAsBuggyTpmsTimestamp(Date.now() - 30 * 60 * 60 * 1000),
  );
  assert.equal(capabilities["alarm_generic.tpms_stale_fl"], true);

  sse.data.emit(
    "TpmsLastSeenPressureTimeFl",
    encodeAsBuggyTpmsTimestamp(Date.now()),
  );
  assert.equal(capabilities["alarm_generic.tpms_stale_fl"], false);
});

test("TpmsLastSeenPressureTime* wheels are tracked independently", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "alarm_generic.tpms_stale_fl": undefined,
    "alarm_generic.tpms_stale_fr": undefined,
  });
  await stub.onInit();

  sse.data.emit(
    "TpmsLastSeenPressureTimeFl",
    encodeAsBuggyTpmsTimestamp(Date.now() - 30 * 60 * 60 * 1000),
  );
  sse.data.emit(
    "TpmsLastSeenPressureTimeFr",
    encodeAsBuggyTpmsTimestamp(Date.now()),
  );

  assert.equal(capabilities["alarm_generic.tpms_stale_fl"], true);
  assert.equal(capabilities["alarm_generic.tpms_stale_fr"], false);
});

test("null/undefined TpmsLastSeenPressureTime* readings are skipped", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "alarm_generic.tpms_stale_fl": undefined,
  });
  await stub.onInit();

  sse.data.emit("TpmsLastSeenPressureTimeFl", null);
  sse.data.emit("TpmsLastSeenPressureTimeFl", undefined);

  assert.equal(capabilities["alarm_generic.tpms_stale_fl"], undefined);
});
