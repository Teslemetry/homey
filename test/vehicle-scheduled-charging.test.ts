import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

class FakeVehicleStream extends EventEmitter {
  data = new EventEmitter();
  cache: { data: Record<string, unknown> } = { data: {} };

  onSignal(field: string, callback: (value: unknown) => void) {
    this.data.on(field, callback);
    return () => this.data.off(field, callback);
  }
}

const DEFAULT_VIN = "test-vin";

function createDeviceStub(capabilities: Record<string, unknown>) {
  const sse = new FakeVehicleStream();
  const vehicle = {
    sse,
    api: {},
    metadata: { config: { rhd: false, can_actuate_trunks: false } },
  };
  const triggeredCards: string[] = [];
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [DEFAULT_VIN]: vehicle } } },
      __: (key: string) => key,
      flow: {
        getDeviceTriggerCard: (id: string) => ({
          trigger: async () => {
            triggeredCards.push(id);
          },
        }),
      },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin: DEFAULT_VIN, id: DEFAULT_VIN }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    getStoreValue: () => null,
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, sse, capabilities, triggeredCards };
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test("ScheduledChargingMode maps onto scheduled_charging_mode and fires its changed trigger", async () => {
  const { stub, sse, capabilities, triggeredCards } = createDeviceStub({
    scheduled_charging_mode: "off",
  });
  await stub.onInit();

  sse.cache.data.ScheduledChargingMode = "ScheduledChargingModeDepartBy";
  sse.data.emit("ScheduledChargingMode", sse.cache.data.ScheduledChargingMode);
  await flushMicrotasks();

  assert.equal(capabilities["scheduled_charging_mode"], "depart_by");
  assert.deepEqual(
    triggeredCards.filter((c) => c === "scheduled_charging_mode_changed"),
    ["scheduled_charging_mode_changed"],
  );

  sse.cache.data.ScheduledChargingMode = "ScheduledChargingModeOff";
  sse.data.emit("ScheduledChargingMode", sse.cache.data.ScheduledChargingMode);
  await flushMicrotasks();
  assert.equal(capabilities["scheduled_charging_mode"], "off");
});

test("ScheduledChargingMode does not fire its changed trigger on the first-ever reading", async () => {
  const { stub, sse, capabilities, triggeredCards } = createDeviceStub({
    scheduled_charging_mode: undefined,
  });
  await stub.onInit();

  sse.cache.data.ScheduledChargingMode = "ScheduledChargingModeDepartBy";
  sse.data.emit("ScheduledChargingMode", sse.cache.data.ScheduledChargingMode);
  await flushMicrotasks();

  assert.equal(capabilities["scheduled_charging_mode"], "depart_by");
  assert.deepEqual(
    triggeredCards.filter((c) => c === "scheduled_charging_mode_changed"),
    [],
  );
});

test("an unrecognized ScheduledChargingMode value is not written", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    scheduled_charging_mode: "off",
  });
  await stub.onInit();

  sse.cache.data.ScheduledChargingMode = "ScheduledChargingModeUnknown";
  sse.data.emit("ScheduledChargingMode", sse.cache.data.ScheduledChargingMode);

  assert.equal(capabilities["scheduled_charging_mode"], "off");
});

test("ScheduledChargingPending passes straight through to scheduled_charging_pending", async () => {
  const { stub, sse, capabilities } = createDeviceStub({
    scheduled_charging_pending: undefined,
  });
  await stub.onInit();

  sse.cache.data.ScheduledChargingPending = true;
  sse.data.emit("ScheduledChargingPending", true);

  assert.equal(capabilities["scheduled_charging_pending"], true);
});

test("flowEnableScheduledCharging converts an HH:mm time arg to minutes-into-the-day", async () => {
  const { stub } = createDeviceStub({ scheduled_charging_mode: undefined });
  await stub.onInit();

  let call: [boolean, number] | undefined;
  (stub as any).vehicle.api.setScheduledCharging = async (
    enable: boolean,
    time: number,
  ) => {
    call = [enable, time];
    return { response: { result: true } };
  };

  await stub.flowEnableScheduledCharging("01:05");
  assert.deepEqual(call, [true, 65]);
});

test("flowEnableScheduledCharging rejects a malformed time arg", async () => {
  const { stub } = createDeviceStub({ scheduled_charging_mode: undefined });
  await stub.onInit();

  await assert.rejects(() => stub.flowEnableScheduledCharging("25:99"));
});

test("flowDisableScheduledCharging calls setScheduledCharging(false, 0)", async () => {
  const { stub } = createDeviceStub({ scheduled_charging_mode: undefined });
  await stub.onInit();

  let call: [boolean, number] | undefined;
  (stub as any).vehicle.api.setScheduledCharging = async (
    enable: boolean,
    time: number,
  ) => {
    call = [enable, time];
    return { response: { result: true } };
  };

  await stub.flowDisableScheduledCharging();
  assert.deepEqual(call, [false, 0]);
});

test("flowEnableScheduledDeparture converts both time args and forwards every field", async () => {
  const { stub } = createDeviceStub({ scheduled_charging_mode: undefined });
  await stub.onInit();

  let body: Record<string, unknown> | undefined;
  (stub as any).vehicle.api.setScheduledDeparture = async (
    b: Record<string, unknown>,
  ) => {
    body = b;
    return { response: { result: true } };
  };

  await stub.flowEnableScheduledDeparture({
    departureTime: "08:30",
    preconditioningEnabled: true,
    preconditioningWeekdaysOnly: false,
    offPeakChargingEnabled: true,
    offPeakChargingWeekdaysOnly: true,
    endOffPeakTime: "06:00",
  });

  assert.deepEqual(body, {
    enable: true,
    departure_time: 8 * 60 + 30,
    preconditioning_enabled: true,
    preconditioning_weekdays_only: false,
    off_peak_charging_enabled: true,
    off_peak_charging_weekdays_only: true,
    end_off_peak_time: 6 * 60,
  });
});

test("flowDisableScheduledDeparture calls setScheduledDeparture with enable false", async () => {
  const { stub } = createDeviceStub({ scheduled_charging_mode: undefined });
  await stub.onInit();

  let body: Record<string, unknown> | undefined;
  (stub as any).vehicle.api.setScheduledDeparture = async (
    b: Record<string, unknown>,
  ) => {
    body = b;
    return { response: { result: true } };
  };

  await stub.flowDisableScheduledDeparture();
  assert.deepEqual(body, { enable: false, departure_time: 0 });
});
