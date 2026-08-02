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
  config: Record<string, unknown> = {},
) {
  const sse = new FakeVehicleStream();
  const vehicle = {
    sse,
    api: {},
    metadata: { config: { rhd: false, can_actuate_trunks: false, ...config } },
  };
  const capabilityOptionCalls: Array<{ capability: string; options: unknown }> = [];
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [vin]: vehicle } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: () => ({
          trigger: async () => {},
        }),
      },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin, id: vin }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async (capability: string, options: unknown) => {
      capabilityOptionCalls.push({ capability, options });
    },
    getStoreValue: () => null,
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, sse, capabilities, capabilityOptionCalls };
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

test("HV battery diagnostic signals update their voltage and temperature capabilities", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    "measure_voltage.brick_max": undefined,
    "measure_voltage.brick_min": undefined,
    "measure_temperature.module_max": undefined,
    "measure_temperature.module_min": undefined,
  });
  await stub.onInit();

  sse.data.emit("BrickVoltageMax", 4.18);
  sse.data.emit("BrickVoltageMin", 3.91);
  sse.data.emit("ModuleTempMax", 42.5);
  sse.data.emit("ModuleTempMin", 28.25);

  assert.deepEqual(capabilities, {
    "measure_voltage.brick_max": 4.18,
    "measure_voltage.brick_min": 3.91,
    "measure_temperature.module_max": 42.5,
    "measure_temperature.module_min": 28.25,
  });
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

test("PowershareStatus maps its known states onto powershare_status", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { powershare_status: undefined },
    CYBERTRUCK_VIN,
  );
  await stub.onInit();

  sse.data.emit("PowershareStatus", "PowershareStateEnabled");
  assert.equal(capabilities["powershare_status"], "enabled");

  sse.data.emit("PowershareStatus", "PowershareStateStopped");
  assert.equal(capabilities["powershare_status"], "stopped");
});

test("PowershareStatus Unknown is skipped (no mapped value)", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { powershare_status: "enabled" },
    CYBERTRUCK_VIN,
  );
  await stub.onInit();

  sse.data.emit("PowershareStatus", "PowershareStateUnknown");

  assert.equal(capabilities["powershare_status"], "enabled");
});

test("PowershareStopReason maps its known reasons onto powershare_stop_reason", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { powershare_stop_reason: undefined },
    CYBERTRUCK_VIN,
  );
  await stub.onInit();

  sse.data.emit("PowershareStopReason", "PowershareStopReasonStatusSOCTooLow");

  assert.equal(capabilities["powershare_stop_reason"], "soc_too_low");
});

test("PowershareType maps its known types onto powershare_type", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { powershare_type: undefined },
    CYBERTRUCK_VIN,
  );
  await stub.onInit();

  sse.data.emit("PowershareType", "PowershareTypeStatusHome");

  assert.equal(capabilities["powershare_type"], "home");
});

test("PowershareHoursLeft passes the native hours value straight through to powershare_hours_left", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { powershare_hours_left: undefined },
    CYBERTRUCK_VIN,
  );
  await stub.onInit();

  sse.data.emit("PowershareHoursLeft", 4.5);

  assert.equal(capabilities["powershare_hours_left"], 4.5);
});

test("PowershareInstantaneousPowerKW converts kW to W on measure_power.powershare", async () => {
  const { stub, sse, capabilities } = createDeviceStub(
    { "measure_power.powershare": undefined },
    CYBERTRUCK_VIN,
  );
  await stub.onInit();

  sse.data.emit("PowershareInstantaneousPowerKW", 3.2);

  assert.equal(capabilities["measure_power.powershare"], 3200);
});

test("TpmsSoftWarnings/TpmsHardWarnings aggregate into a single off/soft/hard tpms_warning", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    tpms_warning: undefined,
  });
  await stub.onInit();

  sse.data.emit("TpmsSoftWarnings", {
    front_left: false,
    front_right: false,
    rear_left: false,
    rear_right: false,
  });
  assert.equal(capabilities["tpms_warning"], "off");

  sse.data.emit("TpmsSoftWarnings", {
    front_left: true,
    front_right: false,
    rear_left: false,
    rear_right: false,
  });
  assert.equal(capabilities["tpms_warning"], "soft");

  sse.data.emit("TpmsHardWarnings", {
    front_left: false,
    front_right: false,
    rear_left: true,
    rear_right: false,
  });
  assert.equal(capabilities["tpms_warning"], "hard");
});

test("a hard warning on any tire wins over a soft warning on another tire", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    tpms_warning: undefined,
  });
  await stub.onInit();

  sse.data.emit("TpmsHardWarnings", {
    front_left: false,
    front_right: false,
    rear_left: false,
    rear_right: true,
  });
  sse.data.emit("TpmsSoftWarnings", {
    front_left: true,
    front_right: false,
    rear_left: false,
    rear_right: false,
  });

  assert.equal(capabilities["tpms_warning"], "hard");
});

test("tpms_warning returns to off once every warning clears", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    tpms_warning: undefined,
  });
  await stub.onInit();

  sse.data.emit("TpmsHardWarnings", {
    front_left: true,
    front_right: false,
    rear_left: false,
    rear_right: false,
  });
  assert.equal(capabilities["tpms_warning"], "hard");

  sse.data.emit("TpmsHardWarnings", {
    front_left: false,
    front_right: false,
    rear_left: false,
    rear_right: false,
  });
  assert.equal(capabilities["tpms_warning"], "off");
});

test("CabinOverheatProtectionMode maps Off/On/FanOnly to cop_mode", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    cop_mode: undefined,
  });
  await stub.onInit();

  sse.data.emit("CabinOverheatProtectionMode", "CabinOverheatProtectionModeStateOn");
  assert.equal(capabilities["cop_mode"], "on");

  sse.data.emit("CabinOverheatProtectionMode", "CabinOverheatProtectionModeStateFanOnly");
  assert.equal(capabilities["cop_mode"], "fan_only");

  sse.data.emit("CabinOverheatProtectionMode", "CabinOverheatProtectionModeStateOff");
  assert.equal(capabilities["cop_mode"], "off");
});

test("CabinOverheatProtectionMode Unknown state is skipped (no mapped value)", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    cop_mode: "on",
  });
  await stub.onInit();

  sse.data.emit(
    "CabinOverheatProtectionMode",
    "CabinOverheatProtectionModeStateUnknown",
  );

  assert.equal(capabilities["cop_mode"], "on");
});

test("CabinOverheatProtectionTemperatureLimit maps Low/Medium/High to cop_temperature_limit", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    cop_temperature_limit: undefined,
  });
  await stub.onInit();

  sse.data.emit(
    "CabinOverheatProtectionTemperatureLimit",
    "ClimateOverheatProtectionTempLimitLow",
  );
  assert.equal(capabilities["cop_temperature_limit"], "low");

  sse.data.emit(
    "CabinOverheatProtectionTemperatureLimit",
    "ClimateOverheatProtectionTempLimitMedium",
  );
  assert.equal(capabilities["cop_temperature_limit"], "medium");

  sse.data.emit(
    "CabinOverheatProtectionTemperatureLimit",
    "ClimateOverheatProtectionTempLimitHigh",
  );
  assert.equal(capabilities["cop_temperature_limit"], "high");
});

test("cop_temperature_limit is only setable when cop_user_set_temp_supported is true", async () => {
  const { stub, capabilityOptionCalls } = createDeviceStub(
    { cop_temperature_limit: undefined },
    DEFAULT_VIN,
    { cop_user_set_temp_supported: true },
  );
  await stub.onInit();

  const call = capabilityOptionCalls.find(
    (c) => c.capability === "cop_temperature_limit",
  );
  assert.equal((call?.options as { setable?: boolean })?.setable, true);
});

test("cop_temperature_limit is not setable when cop_user_set_temp_supported is false/absent", async () => {
  const { stub, capabilityOptionCalls } = createDeviceStub(
    { cop_temperature_limit: undefined },
    DEFAULT_VIN,
  );
  await stub.onInit();

  const call = capabilityOptionCalls.find(
    (c) => c.capability === "cop_temperature_limit",
  );
  assert.equal((call?.options as { setable?: boolean })?.setable, false);
});

test("a null TpmsSoftWarnings/TpmsHardWarnings reading is treated as no warning on those tires", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    tpms_warning: undefined,
  });
  await stub.onInit();

  sse.data.emit("TpmsHardWarnings", {
    front_left: true,
    front_right: false,
    rear_left: false,
    rear_right: false,
  });
  assert.equal(capabilities["tpms_warning"], "hard");

  sse.data.emit("TpmsHardWarnings", null);
  assert.equal(capabilities["tpms_warning"], "off");
});
