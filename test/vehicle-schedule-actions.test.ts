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

function createDeviceStub() {
  const sse = new FakeVehicleStream();
  const vehicle = {
    sse,
    api: {},
    metadata: { access: true, fleet_telemetry: "fleet_telemetry_config_id", polling: false, config: { rhd: false, can_actuate_trunks: false } },
  };
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [DEFAULT_VIN]: vehicle } } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: {
      manifest: { capabilities: [], capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin: DEFAULT_VIN, id: DEFAULT_VIN }),
    getCapabilities: () => [],
    getCapabilityValue: () => undefined,
    setCapabilityValue: async () => {},
    setCapabilityOptions: async () => {},
    getStoreValue: () => null,
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, vehicle };
}

// --- days-of-week conversion ---

test("flowAddChargeSchedule normalizes days-of-week casing/spacing to Tesla's capitalized form", async () => {
  const { stub, vehicle } = createDeviceStub();
  await stub.onInit();

  let body: Record<string, unknown> | undefined;
  (vehicle.api as any).addChargeSchedule = async (b: Record<string, unknown>) => {
    body = b;
    return { response: { result: true } };
  };

  await stub.flowAddChargeSchedule({
    name: "Overnight",
    daysOfWeek: " monday , wednesday ,FRIDAY",
    enabled: true,
    startEnabled: false,
    startTime: "00:00",
    endEnabled: false,
    endTime: "00:00",
    lat: 1,
    lon: 2,
    oneTime: false,
  });

  assert.equal(body?.days_of_week, "Monday,Wednesday,Friday");
});

test("flowAddChargeSchedule passes through the \"All\" and \"Weekdays\" special values", async () => {
  const { stub, vehicle } = createDeviceStub();
  await stub.onInit();

  let body: Record<string, unknown> | undefined;
  (vehicle.api as any).addChargeSchedule = async (b: Record<string, unknown>) => {
    body = b;
    return { response: { result: true } };
  };

  await stub.flowAddChargeSchedule({
    name: "Every day",
    daysOfWeek: "all",
    enabled: true,
    startEnabled: false,
    startTime: "00:00",
    endEnabled: false,
    endTime: "00:00",
    lat: 1,
    lon: 2,
    oneTime: false,
  });
  assert.equal(body?.days_of_week, "All");

  await stub.flowAddChargeSchedule({
    name: "Commute days",
    daysOfWeek: "weekdays",
    enabled: true,
    startEnabled: false,
    startTime: "00:00",
    endEnabled: false,
    endTime: "00:00",
    lat: 1,
    lon: 2,
    oneTime: false,
  });
  assert.equal(body?.days_of_week, "Weekdays");
});

test("flowAddChargeSchedule rejects an unrecognized day token", async () => {
  const { stub } = createDeviceStub();
  await stub.onInit();

  await assert.rejects(
    () =>
      stub.flowAddChargeSchedule({
        name: "Bad",
        daysOfWeek: "Frunkday",
        enabled: true,
        startEnabled: false,
        startTime: "00:00",
        endEnabled: false,
        endTime: "00:00",
        lat: 1,
        lon: 2,
        oneTime: false,
      }),
    (error: unknown) => error instanceof Error && /Frunkday/.test(error.message),
  );
});

test("flowAddChargeSchedule rejects an empty days-of-week arg", async () => {
  const { stub } = createDeviceStub();
  await stub.onInit();

  await assert.rejects(() =>
    stub.flowAddChargeSchedule({
      name: "Empty",
      daysOfWeek: "  , ,",
      enabled: true,
      startEnabled: false,
      startTime: "00:00",
      endEnabled: false,
      endTime: "00:00",
      lat: 1,
      lon: 2,
      oneTime: false,
    }),
  );
});

// --- time conversion + conditional start/end fields ---

test("flowAddChargeSchedule converts start/end HH:mm times to minutes-into-the-day and omits them when disabled", async () => {
  const { stub, vehicle } = createDeviceStub();
  await stub.onInit();

  let body: Record<string, unknown> | undefined;
  (vehicle.api as any).addChargeSchedule = async (b: Record<string, unknown>) => {
    body = b;
    return { response: { result: true } };
  };

  await stub.flowAddChargeSchedule({
    name: "Overnight",
    daysOfWeek: "Monday",
    enabled: true,
    startEnabled: true,
    startTime: "01:05",
    endEnabled: false,
    endTime: "23:59",
    lat: 37.4,
    lon: -122.1,
    oneTime: true,
  });

  assert.deepEqual(body, {
    name: "Overnight",
    days_of_week: "Monday",
    enabled: true,
    start_enabled: true,
    start_time: 65,
    end_enabled: false,
    lat: 37.4,
    lon: -122.1,
    one_time: true,
  });
  assert.equal("end_time" in (body as object), false);
});

test("flowAddChargeSchedule includes end_time only when end_enabled is true", async () => {
  const { stub, vehicle } = createDeviceStub();
  await stub.onInit();

  let body: Record<string, unknown> | undefined;
  (vehicle.api as any).addChargeSchedule = async (b: Record<string, unknown>) => {
    body = b;
    return { response: { result: true } };
  };

  await stub.flowAddChargeSchedule({
    name: "Overnight",
    daysOfWeek: "Monday",
    enabled: true,
    startEnabled: false,
    startTime: "01:05",
    endEnabled: true,
    endTime: "06:30",
    lat: 0,
    lon: 0,
    oneTime: false,
  });

  assert.equal(body?.end_time, 6 * 60 + 30);
  assert.equal("start_time" in (body as object), false);
});

test("flowAddChargeSchedule rejects a malformed start time", async () => {
  const { stub } = createDeviceStub();
  await stub.onInit();

  await assert.rejects(() =>
    stub.flowAddChargeSchedule({
      name: "Bad",
      daysOfWeek: "Monday",
      enabled: true,
      startEnabled: true,
      startTime: "25:99",
      endEnabled: false,
      endTime: "00:00",
      lat: 0,
      lon: 0,
      oneTime: false,
    }),
  );
});

test("flowAddPreconditionSchedule converts precondition_time to minutes-into-the-day", async () => {
  const { stub, vehicle } = createDeviceStub();
  await stub.onInit();

  let body: Record<string, unknown> | undefined;
  (vehicle.api as any).addPreconditionSchedule = async (b: Record<string, unknown>) => {
    body = b;
    return { response: { result: true } };
  };

  await stub.flowAddPreconditionSchedule({
    name: "Warm up",
    daysOfWeek: "tuesday,thursday",
    enabled: true,
    preconditionTime: "08:30",
    lat: 1,
    lon: 2,
    oneTime: false,
  });

  assert.deepEqual(body, {
    name: "Warm up",
    days_of_week: "Tuesday,Thursday",
    enabled: true,
    precondition_time: 8 * 60 + 30,
    lat: 1,
    lon: 2,
    one_time: false,
  });
});

test("flowAddPreconditionSchedule rejects a malformed precondition time", async () => {
  const { stub } = createDeviceStub();
  await stub.onInit();

  await assert.rejects(() =>
    stub.flowAddPreconditionSchedule({
      name: "Bad",
      daysOfWeek: "Monday",
      enabled: true,
      preconditionTime: "not-a-time",
      lat: 0,
      lon: 0,
      oneTime: false,
    }),
  );
});

// --- remove actions ---

test("flowRemoveChargeSchedule forwards the schedule id", async () => {
  const { stub, vehicle } = createDeviceStub();
  await stub.onInit();

  let calledWith: number | undefined;
  (vehicle.api as any).removeChargeSchedule = async (id: number) => {
    calledWith = id;
    return { response: { result: true } };
  };

  await stub.flowRemoveChargeSchedule(42);
  assert.equal(calledWith, 42);
});

test("flowRemovePreconditionSchedule forwards the schedule id", async () => {
  const { stub, vehicle } = createDeviceStub();
  await stub.onInit();

  let calledWith: number | undefined;
  (vehicle.api as any).removePreconditionSchedule = async (id: number) => {
    calledWith = id;
    return { response: { result: true } };
  };

  await stub.flowRemovePreconditionSchedule(7);
  assert.equal(calledWith, 7);
});

test("an explicit provider failure on add_charge_schedule rejects the Flow action", async () => {
  const { stub, vehicle } = createDeviceStub();
  await stub.onInit();

  (vehicle.api as any).addChargeSchedule = async () => ({
    response: { result: false, reason: "invalid_schedule" },
  });

  await assert.rejects(() =>
    stub.flowAddChargeSchedule({
      name: "Bad",
      daysOfWeek: "Monday",
      enabled: true,
      startEnabled: false,
      startTime: "00:00",
      endEnabled: false,
      endTime: "00:00",
      lat: 0,
      lon: 0,
      oneTime: false,
    }),
  );
});

// --- ineligible vehicles ---

function createIneligibleVehicleFixture(metadataOverrides: Record<string, unknown>) {
  return {
    sse: {
      on: () => {},
      off: () => {},
      onSignal: () => () => {},
    },
    api: new Proxy(
      {},
      {
        get: () => () => Promise.resolve({ response: { result: true } }),
      },
    ),
    metadata: {
      access: true,
      fleet_telemetry: "fleet_telemetry_config_id",
      polling: false,
      config: {},
      ...metadataOverrides,
    },
  };
}

test("the schedule Flow actions reject instead of silently succeeding on a present-but-ineligible vehicle", async () => {
  const vin = "VIN-INELIGIBLE";
  const vehicles = { [vin]: createIneligibleVehicleFixture({ access: false }) };
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles } },
      __: (key: string) => key,
    },
    driver: {
      manifest: { capabilities: [], capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin }),
    getCapabilities: () => [],
    setCapabilityOptions: async () => {},
    registerCapabilityListener: () => {},
    getStoreValue: () => null,
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
    setAvailable: async () => {},
  });
  await stub.onInit();

  const scheduleArgs = {
    name: "x",
    daysOfWeek: "Monday",
    enabled: true,
    startEnabled: false,
    startTime: "00:00",
    endEnabled: false,
    endTime: "00:00",
    lat: 0,
    lon: 0,
    oneTime: false,
  };
  const preconditionArgs = {
    name: "x",
    daysOfWeek: "Monday",
    enabled: true,
    preconditionTime: "00:00",
    lat: 0,
    lon: 0,
    oneTime: false,
  };

  await assert.rejects(() => stub.flowAddChargeSchedule(scheduleArgs));
  await assert.rejects(() => stub.flowRemoveChargeSchedule(1));
  await assert.rejects(() => stub.flowAddPreconditionSchedule(preconditionArgs));
  await assert.rejects(() => stub.flowRemovePreconditionSchedule(1));
});
