import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";
import SolarDevice from "../.homeybuild/drivers/solar/device.js";
import GatewayDevice from "../.homeybuild/drivers/gateway/device.js";
import WallConnecter from "../.homeybuild/drivers/wall-connector/device.js";
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

/**
 * These cover TeslemetryApp.rebindAllDeviceProducts(): after
 * `initializeTeslemetry()` tears down and recreates `products` (a stream
 * reconnect recovering from auth failure, or any other re-init), every
 * already-paired device must drop its listeners on the old, now-dead
 * per-product stream and re-register on the new one - otherwise it stays
 * "available" but silently stops receiving live data forever, exactly the
 * "frozen for a month" symptom. Each test proves recovery from a device
 * that is *already* in that stale-listener state (bound to product A, A's
 * stream now dead), not just a single fresh reinit.
 */

function createEnergySite(): { api: unknown; sse: EventEmitter } {
  const api = new Proxy(
    {},
    { get: () => () => Promise.resolve() },
  );
  return { api, sse: new EventEmitter() };
}

test("PowerwallDevice.rebindProduct recovers a device stuck on an orphaned site stream", async () => {
  const siteA = createEnergySite();
  const siteB = createEnergySite();
  const capabilities: Record<string, unknown> = { measure_battery: undefined };

  const stub = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app: { products: { energySites: { "site-a": siteA, "site-b": siteB } } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ id: "site-a" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: () => {},
    getStoreValue: () => null,
    setUnavailable: async () => {},
    log: () => {},
    error: () => {},
  });

  await stub.onInit();
  siteA.sse.emit("live_status", { live_status: { percentage_charged: 40 } });
  assert.equal(capabilities.measure_battery, 40, "live on the original site");

  // Simulate app.ts's rebindAllDeviceProducts() after a reinitialize().
  stub.homey.app.products.energySites["site-a"] = undefined;
  Object.assign(stub, { getData: () => ({ id: "site-b" }) });
  stub.rebindProduct();

  // The orphaned stream must be well and truly abandoned - a later event on
  // it must not still reach this device (proves the old listener was torn
  // down, not just shadowed).
  assert.equal(siteA.sse.listenerCount("live_status"), 0, "old stream listener removed");
  siteA.sse.emit("live_status", { live_status: { percentage_charged: 99 } });
  assert.equal(capabilities.measure_battery, 40, "orphaned site can no longer update the device");

  siteB.sse.emit("live_status", { live_status: { percentage_charged: 75 } });
  assert.equal(capabilities.measure_battery, 75, "recovered: live again on the new site");
});

test("SolarDevice.rebindProduct recovers a device stuck on an orphaned site stream", async () => {
  const siteA = createEnergySite();
  const siteB = createEnergySite();
  const capabilities: Record<string, unknown> = { measure_power: undefined };

  const stub = Object.assign(Object.create(SolarDevice.prototype), {
    homey: {
      app: { products: { energySites: { "site-a": siteA, "site-b": siteB } } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ id: "site-a" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });

  await stub.onInit();
  siteA.sse.emit("live_status", { live_status: { solar_power: 1000 } });
  assert.equal(capabilities.measure_power, 1000);

  stub.homey.app.products.energySites["site-a"] = undefined;
  Object.assign(stub, { getData: () => ({ id: "site-b" }) });
  stub.rebindProduct();

  assert.equal(siteA.sse.listenerCount("live_status"), 0, "old stream listener removed");
  siteA.sse.emit("live_status", { live_status: { solar_power: 9999 } });
  assert.equal(capabilities.measure_power, 1000, "orphaned site can no longer update the device");

  siteB.sse.emit("live_status", { live_status: { solar_power: 2500 } });
  assert.equal(capabilities.measure_power, 2500, "recovered: live again on the new site");
});

test("GatewayDevice.rebindProduct recovers a device stuck on an orphaned site stream", async () => {
  const siteA = createEnergySite();
  const siteB = createEnergySite();
  const capabilities: Record<string, unknown> = { measure_power: undefined };

  const stub = Object.assign(Object.create(GatewayDevice.prototype), {
    homey: {
      app: { products: { energySites: { "site-a": siteA, "site-b": siteB } } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ id: "site-a" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });

  await stub.onInit();
  siteA.sse.emit("live_status", { live_status: { grid_power: 300 } });
  assert.equal(capabilities.measure_power, 300);

  stub.homey.app.products.energySites["site-a"] = undefined;
  Object.assign(stub, { getData: () => ({ id: "site-b" }) });
  stub.rebindProduct();

  assert.equal(siteA.sse.listenerCount("live_status"), 0, "old stream listener removed");
  siteA.sse.emit("live_status", { live_status: { grid_power: 9999 } });
  assert.equal(capabilities.measure_power, 300, "orphaned site can no longer update the device");

  siteB.sse.emit("live_status", { live_status: { grid_power: 450 } });
  assert.equal(capabilities.measure_power, 450, "recovered: live again on the new site");
});

test("WallConnecter.rebindProduct recovers a device stuck on an orphaned site stream", async () => {
  function createWcSite(): { api: EventEmitter & { requestPolling: () => () => void }; sse: EventEmitter } {
    const api = Object.assign(new EventEmitter(), { requestPolling: () => () => {} });
    return { api, sse: new EventEmitter() };
  }
  const siteA = createWcSite();
  const siteB = createWcSite();
  const capabilities: Record<string, unknown> = { measure_power: undefined };

  const stub = Object.assign(Object.create(WallConnecter.prototype), {
    homey: {
      app: { products: { energySites: { "site-a": siteA, "site-b": siteB }, vehicles: {} } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ site: "site-a", din: "din-1" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    log: () => {},
    error: () => {},
  });

  await stub.onInit();
  siteA.sse.emit("live_status", {
    live_status: { wall_connectors: [{ din: "din-1", wall_connector_state: 1, wall_connector_power: 500 }] },
  });
  assert.equal(capabilities.measure_power, 500);

  stub.homey.app.products.energySites["site-a"] = undefined;
  Object.assign(stub, { getData: () => ({ site: "site-b", din: "din-1" }) });
  stub.rebindProduct();

  assert.equal(siteA.sse.listenerCount("live_status"), 0, "old stream listener removed");
  siteA.sse.emit("live_status", {
    live_status: { wall_connectors: [{ din: "din-1", wall_connector_state: 1, wall_connector_power: 9999 }] },
  });
  assert.equal(capabilities.measure_power, 500, "orphaned site can no longer update the device");

  siteB.sse.emit("live_status", {
    live_status: { wall_connectors: [{ din: "din-1", wall_connector_state: 1, wall_connector_power: 750 }] },
  });
  assert.equal(capabilities.measure_power, 750, "recovered: live again on the new site");
});

test("VehicleDevice.rebindProduct recovers a device stuck on an orphaned vehicle stream, and commands use the new vehicle's API", async () => {
  function createFakeVehicle() {
    const stateEmitter = new EventEmitter();
    const apiCalls: string[] = [];
    return {
      sse: {
        cache: { data: {} },
        on: (event: string, listener: (...args: unknown[]) => void) => {
          if (event === "state") stateEmitter.on("state", listener);
          else if (event === "connectivity") {
            /* not exercised here */
          }
        },
        off: (event: string, listener: (...args: unknown[]) => void) => {
          if (event === "state") stateEmitter.off("state", listener);
        },
        onSignal: () => () => {},
        emitState: (value: unknown) => stateEmitter.emit("state", value),
      },
      api: {
        lockDoors: async () => {
          apiCalls.push("lockDoors");
          return { response: { result: true } };
        },
      },
      apiCalls,
      metadata: { config: { can_actuate_trunks: false } },
    };
  }

  const vehicleA = createFakeVehicle();
  const vehicleB = createFakeVehicle();
  const capabilities: Record<string, unknown> = { vehicle_state: undefined };
  const capabilityListeners: Record<string, (value: unknown) => Promise<void>> = {};

  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { "vin-a": vehicleA, "vin-b": vehicleB } } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin: "vin-a", id: "vin-a" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: (capability: string, listener: (value: unknown) => Promise<void>) => {
      capabilityListeners[capability] = listener;
    },
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });

  await stub.onInit();
  vehicleA.sse.emitState({ state: "online" });
  assert.equal(capabilities.vehicle_state, "online");

  Object.assign(stub, { getData: () => ({ vin: "vin-b", id: "vin-b" }) });
  stub.rebindProduct();

  vehicleA.sse.emitState({ state: "asleep" });
  assert.equal(capabilities.vehicle_state, "online", "orphaned vehicle can no longer update the device");

  vehicleB.sse.emitState({ state: "online" });
  assert.equal(capabilities.vehicle_state, "online");
  vehicleB.sse.emitState({ state: "asleep" });
  assert.equal(capabilities.vehicle_state, "asleep", "recovered: live again on the new vehicle");

  await capabilityListeners.locked(true);
  assert.deepEqual(vehicleA.apiCalls, [], "the old vehicle's API is never called after rebind");
  assert.deepEqual(vehicleB.apiCalls, ["lockDoors"], "commands now reach the new vehicle's API");
});
