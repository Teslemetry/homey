import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";
import GatewayDevice from "../.homeybuild/drivers/gateway/device.js";
import SolarDevice from "../.homeybuild/drivers/solar/device.js";
import WallConnecter from "../.homeybuild/drivers/wall-connector/device.js";

/**
 * Covers the S1 fix: a product present in Products but reported ineligible
 * by its own metadata (access revoked, telemetry absent, polling mode, or -
 * for energy sites - access revoked) must not bind, must register zero
 * listeners, and must recover cleanly once a later Products generation
 * reports it eligible again.
 */

const ELIGIBLE_VEHICLE_METADATA = {
  access: true,
  fleet_telemetry: "fleet_telemetry_config_id",
  polling: false,
  config: {},
};

function createVehicleStream() {
  const onCalls: string[] = [];
  const onSignalCalls: string[] = [];
  return {
    onCalls,
    onSignalCalls,
    on: (event: string) => {
      onCalls.push(event);
    },
    off: () => {},
    onSignal: (field: string) => {
      onSignalCalls.push(field);
      return () => {};
    },
  };
}

function createVehicleFixture(metadata: Record<string, unknown>, apiCalls: string[] = []) {
  return {
    sse: createVehicleStream(),
    api: new Proxy({}, {
      get: (_target, property) => () => {
        apiCalls.push(String(property));
        return Promise.resolve({ response: { result: true } });
      },
    }),
    metadata,
  };
}

function createVehicleDeviceStub(vin: string, vehicles: Record<string, unknown>) {
  const unavailableCalls: unknown[] = [];
  let availableCalls = 0;
  const registerCapabilityListenerCalls: string[] = [];
  const capabilityListeners = new Map<string, (value: unknown) => unknown>();
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
    registerCapabilityListener: (capability: string, listener: (value: unknown) => unknown) => {
      registerCapabilityListenerCalls.push(capability);
      capabilityListeners.set(capability, listener);
    },
    getStoreValue: () => null,
    log: () => {},
    error: () => {},
    setUnavailable: async (message: unknown) => {
      unavailableCalls.push(message);
    },
    setAvailable: async () => {
      availableCalls++;
    },
  });
  return {
    stub,
    unavailableCalls,
    registerCapabilityListenerCalls,
    capabilityListeners,
    availableCallCount: () => availableCalls,
  };
}

test("VehicleDevice.onInit marks a present-but-access-revoked vehicle unavailable and registers no listeners", async () => {
  const vin = "VINACCESS";
  const vehicles = {
    [vin]: createVehicleFixture({ ...ELIGIBLE_VEHICLE_METADATA, access: false }),
  };
  const { stub, unavailableCalls, registerCapabilityListenerCalls } =
    createVehicleDeviceStub(vin, vehicles);

  await stub.onInit();

  assert.deepEqual(unavailableCalls, ["error.vehicle_access_required"]);
  assert.deepEqual(registerCapabilityListenerCalls, []);
  assert.deepEqual((vehicles[vin] as any).sse.onCalls, []);
  assert.deepEqual((vehicles[vin] as any).sse.onSignalCalls, []);
});

test("VehicleDevice.onInit marks a present-but-telemetry-absent vehicle unavailable and registers no listeners", async () => {
  const vin = "VINTELEMETRY";
  const vehicles = {
    [vin]: createVehicleFixture({ ...ELIGIBLE_VEHICLE_METADATA, fleet_telemetry: null }),
  };
  const { stub, unavailableCalls, registerCapabilityListenerCalls } =
    createVehicleDeviceStub(vin, vehicles);

  await stub.onInit();

  assert.deepEqual(unavailableCalls, ["error.vehicle_telemetry_unavailable"]);
  assert.deepEqual(registerCapabilityListenerCalls, []);
  assert.deepEqual((vehicles[vin] as any).sse.onCalls, []);
});

test("VehicleDevice.onInit marks a present-but-polling-mode vehicle unavailable and registers no listeners", async () => {
  const vin = "VINPOLLING";
  const vehicles = {
    [vin]: createVehicleFixture({ ...ELIGIBLE_VEHICLE_METADATA, polling: true }),
  };
  const { stub, unavailableCalls, registerCapabilityListenerCalls } =
    createVehicleDeviceStub(vin, vehicles);

  await stub.onInit();

  assert.deepEqual(unavailableCalls, ["error.vehicle_polling_mode"]);
  assert.deepEqual(registerCapabilityListenerCalls, []);
  assert.deepEqual((vehicles[vin] as any).sse.onCalls, []);
});

test("VehicleDevice.rebindProduct recovers once a later Products generation reports the vehicle eligible", async () => {
  const vin = "VINRECOVERS";
  const vehicles: Record<string, unknown> = {
    [vin]: createVehicleFixture({ ...ELIGIBLE_VEHICLE_METADATA, access: false }),
  };
  const { stub, unavailableCalls, availableCallCount } = createVehicleDeviceStub(vin, vehicles);

  await stub.onInit();
  assert.deepEqual(unavailableCalls, ["error.vehicle_access_required"]);
  assert.equal(availableCallCount(), 0);

  vehicles[vin] = createVehicleFixture(ELIGIBLE_VEHICLE_METADATA);
  stub.rebindProduct();

  assert.equal(availableCallCount(), 1);
  assert.deepEqual((vehicles[vin] as any).sse.onCalls.sort(), ["connectivity", "state"]);
});

test("VehicleDevice.rebindProduct clears an eligible vehicle that becomes ineligible", async () => {
  const vin = "VINLOSESACCESS";
  const oldApiCalls: string[] = [];
  const vehicles: Record<string, unknown> = {
    [vin]: createVehicleFixture(ELIGIBLE_VEHICLE_METADATA, oldApiCalls),
  };
  const { stub, capabilityListeners } = createVehicleDeviceStub(vin, vehicles);

  await stub.onInit();
  vehicles[vin] = createVehicleFixture({ ...ELIGIBLE_VEHICLE_METADATA, access: false });
  stub.rebindProduct();

  assert.equal(stub.getProductKey(), undefined);
  await assert.rejects(() => capabilityListeners.get("locked")!(true));
  assert.deepEqual(oldApiCalls, []);
});

function createEnergySite(metadata: Record<string, unknown>) {
  return {
    id: "site-1",
    metadata,
    sse: new EventEmitter(),
    api: Object.assign(new EventEmitter(), {
      requestPolling: () => () => {},
      cache: {} as Record<string, unknown>,
    }),
  };
}

function createEnergyDeviceStub(
  deviceClass: { prototype: object },
  siteId: string,
  energySites: Record<string, unknown>,
  extraData: Record<string, unknown> = {},
) {
  const unavailableCalls: unknown[] = [];
  let availableCalls = 0;
  const stub = Object.assign(Object.create(deviceClass.prototype), {
    homey: {
      app: { products: { energySites, vehicles: {} } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: {
      manifest: { capabilities: [], capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ id: siteId, site: siteId, ...extraData }),
    getCapabilities: () => [],
    setCapabilityOptions: async () => {},
    registerCapabilityListener: () => {},
    getStoreValue: () => null,
    log: () => {},
    error: () => {},
    setUnavailable: async (message: unknown) => {
      unavailableCalls.push(message);
    },
    setAvailable: async () => {
      availableCalls++;
    },
  });
  return { stub, unavailableCalls, availableCallCount: () => availableCalls };
}

for (const [name, DeviceClass] of [
  ["PowerwallDevice", PowerwallDevice],
  ["GatewayDevice", GatewayDevice],
  ["SolarDevice", SolarDevice],
] as const) {
  test(`${name}.onInit marks a present-but-access-revoked site unavailable and registers no listeners`, async () => {
    const energySites: Record<string, unknown> = {
      "site-1": createEnergySite({ access: false }),
    };
    const { stub, unavailableCalls } = createEnergyDeviceStub(
      DeviceClass,
      "site-1",
      energySites,
    );

    await stub.onInit();

    assert.deepEqual(unavailableCalls, ["error.energy_site_access_required"]);
    assert.equal((energySites["site-1"] as EventEmitter & { sse: EventEmitter }).sse.listenerCount("live_status"), 0);
  });

  test(`${name}.rebindProduct recovers once a later Products generation reports the site eligible`, async () => {
    const energySites: Record<string, unknown> = {
      "site-1": createEnergySite({ access: false }),
    };
    const { stub, unavailableCalls, availableCallCount } = createEnergyDeviceStub(
      DeviceClass,
      "site-1",
      energySites,
    );

    await stub.onInit();
    assert.deepEqual(unavailableCalls, ["error.energy_site_access_required"]);
    assert.equal(availableCallCount(), 0);

    energySites["site-1"] = createEnergySite({ access: true });
    stub.rebindProduct();

    assert.equal(availableCallCount(), 1);
  });

  test(`${name}.rebindProduct recovers after an eligible site becomes ineligible`, async () => {
    const energySites: Record<string, unknown> = {
      "site-1": createEnergySite({ access: true }),
    };
    const { stub } = createEnergyDeviceStub(DeviceClass, "site-1", energySites);

    await stub.onInit();
    energySites["site-1"] = createEnergySite({ access: false });
    stub.rebindProduct();

    assert.equal(stub.getProductKey(), undefined);
    await stub.onUninit();

    energySites["site-1"] = createEnergySite({ access: true });
    stub.rebindProduct();

    assert.equal(stub.getProductKey(), "site:site-1");
  });
}

test("WallConnecter.onInit marks a present-but-access-revoked site unavailable and registers no listeners", async () => {
  const energySites: Record<string, unknown> = {
    "site-1": createEnergySite({ access: false }),
  };
  const { stub, unavailableCalls } = createEnergyDeviceStub(
    WallConnecter,
    "site-1",
    energySites,
    { din: "din-1" },
  );

  await stub.onInit();

  assert.deepEqual(unavailableCalls, ["error.energy_site_access_required"]);
  assert.equal((energySites["site-1"] as EventEmitter & { sse: EventEmitter }).sse.listenerCount("live_status"), 0);
});

test("WallConnecter.rebindProduct recovers once a later Products generation reports the site eligible", async () => {
  const energySites: Record<string, unknown> = {
    "site-1": createEnergySite({ access: false }),
  };
  const { stub, unavailableCalls, availableCallCount } = createEnergyDeviceStub(
    WallConnecter,
    "site-1",
    energySites,
    { din: "din-1" },
  );

  await stub.onInit();
  assert.deepEqual(unavailableCalls, ["error.energy_site_access_required"]);
  assert.equal(availableCallCount(), 0);

  energySites["site-1"] = createEnergySite({ access: true });
  stub.rebindProduct();

  assert.equal(availableCallCount(), 1);
});

test("WallConnecter.rebindProduct recovers after an eligible site becomes ineligible", async () => {
  const energySites: Record<string, unknown> = {
    "site-1": createEnergySite({ access: true }),
  };
  const { stub } = createEnergyDeviceStub(
    WallConnecter,
    "site-1",
    energySites,
    { din: "din-1" },
  );

  await stub.onInit();
  energySites["site-1"] = createEnergySite({ access: false });
  stub.rebindProduct();

  assert.equal(stub.getProductKey(), undefined);
  await stub.onUninit();

  energySites["site-1"] = createEnergySite({ access: true });
  stub.rebindProduct();

  assert.equal(stub.getProductKey(), "site:site-1");
});
