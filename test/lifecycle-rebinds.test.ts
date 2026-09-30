import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryApp from "../.homeybuild/app.js";
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";
import WallConnecter from "../.homeybuild/drivers/wall-connector/device.js";
import { configureTeslemetryStub } from "./support/teslemetry-api-stub.js";
// The *real* SDK, imported by relative path so the loader's "@teslemetry/api"
// redirect doesn't apply. Only the network (global fetch) is faked below, so
// token refresh, /api/metadata, the SSE connect/reconnect loop, per-product
// emitters and the Wall Connector's REST poller all run for real.
import { Teslemetry } from "../node_modules/@teslemetry/api/dist/index.mjs";

/**
 * Lifecycle regressions around building, rebinding and tearing down a
 * Products generation, each driven end to end through the real SDK:
 * - a boot on an expired access token (the normal case: the stream never
 *   refreshes on its own) built two generations back to back;
 * - a device whose product vanished kept the old product reference, so the
 *   next stream blip replaced "not found" with "Connection lost";
 * - Disconnect left the Wall Connector's 30 s REST poller running;
 * - a rebuild landing while a device was still in onInit() bound it twice,
 *   leaking listeners and a poller that outlived the device;
 * - the stale grace equalled a sleeping car's 90 s state cadence, so one
 *   lost publish flapped the car unavailable;
 * - every rebind blanked the grid tariff rates before anything replaced them.
 */

const VIN = "LRW3E7FS0PC000001";
const VIN2 = "LRW3E7FS0PC000002";
const SITE = "1689169815425134";
const DIN = "1457768-02-G--PGT22000000";

const manifest = JSON.parse(fs.readFileSync(new URL("../app.json", import.meta.url), "utf8"));
const driverManifest = (id: string) => manifest.drivers.find((d: { id: string }) => d.id === id);

/** The captain's real Model 3 config. */
function vehicleMeta() {
  return {
    access: true,
    polling: false,
    proxy: false,
    firmware: "2025.20",
    fleet_telemetry: "1.1.0",
    name: "Car",
    config: { rear_seat_heaters: 1, rhd: true, cop_user_set_temp_supported: false },
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A fake Teslemetry server behind global fetch. */
function createServer() {
  const encoder = new TextEncoder();
  const server = {
    calls: [] as string[],
    sseConns: [] as Array<{
      open: boolean;
      push: (event: string, data: unknown) => void;
      fail: () => void;
    }>,
    metadata: {
      uid: "u",
      region: "EU",
      scopes: [],
      vehicles: {} as Record<string, unknown>,
      energy_sites: {} as Record<string, unknown>,
    },
    liveConn() {
      return server.sseConns.filter((conn) => conn.open).at(-1);
    },
    count(pattern: RegExp) {
      return server.calls.filter((path) => pattern.test(path)).length;
    },
  };
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  const originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const { pathname } = new URL(request.url);
    server.calls.push(pathname);
    if (pathname === "/oauth/token") {
      return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    }
    if (pathname === "/api/metadata") return json(server.metadata);
    if (pathname.startsWith("/api/config/")) return json({ response: { updated_vehicles: 0 } });
    if (pathname.endsWith("/telemetry_history")) return json({ response: { charge_history: [] } });
    if (pathname.startsWith("/sse")) {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      const conn = {
        open: true,
        push(event: string, data: unknown) {
          if (conn.open) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        },
        fail() {
          if (!conn.open) return;
          conn.open = false;
          controller.error(new TypeError("terminated"));
        },
      };
      request.signal.addEventListener("abort", () => {
        if (!conn.open) return;
        conn.open = false;
        controller.error(new DOMException("aborted", "AbortError"));
      });
      server.sseConns.push(conn);
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  }) as typeof fetch;

  return {
    server,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

function token(expiresInMs: number) {
  return {
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_in: 3600,
    token_type: "Bearer",
    expires_at: Date.now() + expiresInMs,
  };
}

type DeviceClass = typeof VehicleDevice | typeof PowerwallDevice | typeof WallConnecter;
type RuntimeDevice = InstanceType<DeviceClass> & {
  capabilities: Record<string, unknown>;
  writes: Array<[string, unknown]>;
  availability: string[];
  message: () => string | null;
};

/**
 * One app plus its drivers on a single virtual clock: node:test's mocked
 * setTimeout/setInterval/Date drive the app's own homey timers, the SDK's
 * reconnect backoff and its REST poller alike.
 */
async function createWorld(t: TestContext, options: { tokenExpiresInMs: number }) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  const { server, restore } = createServer();
  t.after(restore);

  let authenticatedRequests = 0;
  configureTeslemetryStub((accessToken: () => Promise<string>, sdkOptions: unknown) =>
    new Teslemetry(async () => {
      authenticatedRequests++;
      return accessToken();
    }, sdkOptions),
  );

  const settings = new Map<string, unknown>([["teslemetry_oauth2_token", token(options.tokenExpiresInMs)]]);
  const card = {
    registerRunListener: () => card,
    registerArgumentAutocompleteListener: () => card,
    trigger: async () => {},
  };
  const drivers: Record<string, { manifest: unknown; devices: RuntimeDevice[]; getDevices: () => RuntimeDevice[] }> = {};
  const homey = {
    __: (key: string) => key,
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
    setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
    clearInterval: (id: NodeJS.Timeout) => clearInterval(id),
    settings: {
      get: (key: string) => settings.get(key) ?? null,
      set: (key: string, value: unknown) => settings.set(key, structuredClone(value)),
      unset: (key: string) => settings.delete(key),
    },
    drivers: { getDrivers: () => drivers },
    flow: {
      getActionCard: () => card,
      getConditionCard: () => card,
      getDeviceTriggerCard: () => card,
      getTriggerCard: () => card,
    },
    geolocation: { getLatitude: () => 52.1, getLongitude: () => 4.3 },
    app: undefined as unknown,
  };
  const logs: string[] = [];
  const app = Object.assign(new TeslemetryApp(), {
    homey,
    log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
  });
  homey.app = app;
  for (const id of ["vehicle", "battery", "wall-connector"]) {
    const driver = {
      manifest: driverManifest(id),
      devices: [] as RuntimeDevice[],
      getDevices: () => driver.devices,
    };
    drivers[id] = driver;
  }

  /** A real device class instance on a minimal Homey Device runtime. */
  function addDevice(driverId: string, DeviceClass: DeviceClass, data: Record<string, unknown>) {
    const driver = drivers[driverId];
    const capabilities: Record<string, unknown> = {};
    for (const capability of driver.manifest.capabilities as string[]) capabilities[capability] = null;
    const store: Record<string, unknown> = {};
    let unavailableMessage: string | null = null;
    const device = Object.assign(new DeviceClass(), {
      homey,
      driver,
      capabilities,
      writes: [] as Array<[string, unknown]>,
      availability: [] as string[],
      message: () => unavailableMessage,
      getName: () => driverId,
      getId: () => `rt-${driverId}`,
      getData: () => data,
      getCapabilities: () => Object.keys(capabilities),
      hasCapability: (capability: string) => capability in capabilities,
      getCapabilityValue: (capability: string) => capabilities[capability] ?? null,
      setCapabilityValue: async (capability: string, value: unknown) => {
        device.writes.push([capability, value]);
        capabilities[capability] = value;
      },
      addCapability: async (capability: string) => {
        capabilities[capability] = null;
      },
      removeCapability: async (capability: string) => {
        delete capabilities[capability];
      },
      setCapabilityOptions: async () => {},
      registerCapabilityListener: () => {},
      getStoreValue: (key: string) => store[key] ?? null,
      setStoreValue: async (key: string, value: unknown) => {
        store[key] = value;
      },
      unsetStoreValue: async (key: string) => {
        delete store[key];
      },
      setAvailable: async () => {
        unavailableMessage = null;
        device.availability.push("available");
      },
      setUnavailable: async (message: string) => {
        unavailableMessage = message;
        device.availability.push(`unavailable: ${message}`);
      },
      log: () => {},
      error: () => {},
    }) as unknown as RuntimeDevice;
    driver.devices.push(device);
    return device;
  }

  /** Deletes a device the way Homey does: off the driver's list, then onUninit(). */
  async function deleteDevice(device: RuntimeDevice) {
    const driver = device.driver as unknown as { devices: RuntimeDevice[] };
    driver.devices = driver.devices.filter((d) => d !== device);
    await device.onUninit();
  }

  /** Advances the virtual clock in 1 s steps, letting I/O settle between. */
  async function advance(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
      t.mock.timers.tick(Math.min(1000, ms - elapsed));
      await flush();
    }
  }

  t.after(async () => {
    await app.onUninit();
    await flush();
  });

  return {
    app,
    server,
    logs,
    addDevice,
    deleteDevice,
    advance,
    authenticatedRequests: () => authenticatedRequests,
  };
}

test("booting on an expired access token builds one Products generation, not two", async (t) => {
  const world = await createWorld(t, { tokenExpiresInMs: -600_000 });
  world.server.metadata.vehicles = { [VIN]: vehicleMeta() };
  world.server.metadata.energy_sites = { [SITE]: { access: true, name: "Home" } };

  await world.app.onInit();
  const car = world.addDevice("vehicle", VehicleDevice, { vin: VIN });
  const powerwall = world.addDevice("battery", PowerwallDevice, { id: Number(SITE) });
  await car.onInit();
  await powerwall.onInit();
  // Drain anything the boot-time token refresh queued onto the init chain.
  await world.app.initializeTeslemetry();
  await flush();

  assert.equal(world.server.count(/^\/oauth\/token$/), 1, "the expired token was refreshed once");
  assert.equal(world.server.count(/^\/api\/metadata$/), 1, "one metadata fetch");
  assert.equal(world.server.sseConns.length, 1, "one SSE connection, not a second one seconds later");
});

test("a device whose product disappeared keeps saying 'not found' across a stream blip", async (t) => {
  const world = await createWorld(t, { tokenExpiresInMs: 3_600_000 });
  world.server.metadata.vehicles = { [VIN]: vehicleMeta(), [VIN2]: vehicleMeta() };
  world.server.metadata.energy_sites = { [SITE]: { access: true, name: "Home" } };

  await world.app.onInit();
  const car = world.addDevice("vehicle", VehicleDevice, { vin: VIN });
  const powerwall = world.addDevice("battery", PowerwallDevice, { id: Number(SITE) });
  await car.onInit();
  await powerwall.onInit();
  await flush();

  // The car is sold and the site removed from the account; the next
  // generation (a re-authorization, say) no longer lists them.
  world.server.metadata.vehicles = { [VIN2]: vehicleMeta() };
  world.server.metadata.energy_sites = {};
  await world.app.initializeTeslemetry(true);
  await flush();
  assert.equal(car.message(), "error.vehicle_not_found");
  assert.equal(powerwall.message(), "error.energy_site_not_found");
  assert.equal(car.getProductKey(), undefined, "no product reference left to watch");
  assert.equal(powerwall.getProductKey(), undefined, "no product reference left to watch");

  // A routine drop; the SDK reconnects and the account's other car carries on.
  world.server.liveConn()!.fail();
  await world.advance(5_000);
  world.server.liveConn()!.push("state", { vin: VIN2, state: "online", createdAt: new Date().toISOString() });
  await world.advance(300_000);

  assert.equal(car.message(), "error.vehicle_not_found", "the actionable message survives the blip");
  assert.equal(powerwall.message(), "error.energy_site_not_found", "the actionable message survives the blip");
});

test("Disconnect stops the Wall Connector's charge-history polling", async (t) => {
  const world = await createWorld(t, { tokenExpiresInMs: 3_600_000 });
  world.server.metadata.energy_sites = { [SITE]: { access: true, name: "Home" } };

  await world.app.onInit();
  const wallConnector = world.addDevice("wall-connector", WallConnecter, { site: Number(SITE), din: DIN });
  await wallConnector.onInit();
  await world.advance(120_000);
  assert.ok(world.server.count(/telemetry_history$/) >= 4, "precondition: polling every 30 s while connected");

  world.app.disconnectAccount();
  await flush();
  const before = world.authenticatedRequests();
  await world.advance(600_000);

  assert.equal(wallConnector.message(), "error.account_disconnected");
  assert.equal(
    world.authenticatedRequests() - before,
    0,
    "no request is attempted with the credentials the user just removed",
  );
});

test("a rebuild landing while a device is still in onInit() binds it once", async (t) => {
  const world = await createWorld(t, { tokenExpiresInMs: 3_600_000 });
  world.server.metadata.vehicles = { [VIN]: vehicleMeta() };
  world.server.metadata.energy_sites = { [SITE]: { access: true, name: "Home" } };
  await world.app.onInit();

  const devices = [
    world.addDevice("battery", PowerwallDevice, { id: Number(SITE) }),
    world.addDevice("wall-connector", WallConnecter, { site: Number(SITE), din: DIN }),
    world.addDevice("vehicle", VehicleDevice, { vin: VIN }),
  ];
  // An app update added capabilities these devices don't have yet, so
  // ensureCapabilities() is still awaiting Homey when the rebuild lands.
  let releaseAddCapability!: () => void;
  const addCapabilityGate = new Promise<void>((resolve) => {
    releaseAddCapability = resolve;
  });
  for (const device of devices) {
    delete device.capabilities.measure_power;
    const addCapability = device.addCapability.bind(device);
    device.addCapability = async (capability: string) => {
      await addCapabilityGate;
      return addCapability(capability);
    };
  }
  const inits = devices.map((device) => device.onInit());
  await flush();
  await world.app.initializeTeslemetry(true);
  releaseAddCapability();
  await Promise.all(inits);
  await flush();

  const site = world.app.products!.energySites[SITE];
  const vehicle = world.app.products!.vehicles[VIN];
  const count = () => ({
    siteLiveStatusListeners: site.sse.listenerCount("live_status"),
    chargeHistoryPollers: site.api.refreshClients.chargeHistory.size,
    vehicleStateListeners: vehicle.sse.listenerCount("state"),
  });
  assert.deepEqual(
    count(),
    { siteLiveStatusListeners: 2, chargeHistoryPollers: 1, vehicleStateListeners: 1 },
    "Powerwall + Wall Connector, one poller, one car - each bound exactly once",
  );

  for (const device of devices) await world.deleteDevice(device);
  assert.deepEqual(
    count(),
    { siteLiveStatusListeners: 0, chargeHistoryPollers: 0, vehicleStateListeners: 0 },
    "nothing outlives the deleted devices",
  );
  const before = world.server.count(/telemetry_history$/);
  await world.advance(300_000);
  assert.equal(world.server.count(/telemetry_history$/) - before, 0, "no polling after deletion");
});

test("a sleeping car does not flap unavailable when one state publish is lost in a blip", async (t) => {
  const world = await createWorld(t, { tokenExpiresInMs: 3_600_000 });
  world.server.metadata.vehicles = { [VIN]: vehicleMeta() };
  await world.app.onInit();
  const car = world.addDevice("vehicle", VehicleDevice, { vin: VIN });
  await car.onInit();
  await flush();

  // A sleeping car's only genuine events are the server's 90 s state publishes.
  const publishState = () =>
    world.server.liveConn()?.push("state", { vin: VIN, state: "asleep", createdAt: new Date().toISOString() });
  publishState();
  await flush();
  car.availability.length = 0;

  world.server.liveConn()!.fail();
  await world.advance(1_000);
  publishState(); // lost: the SDK is still in its reconnect backoff
  await world.advance(90_000);
  publishState(); // the first publish the new connection sees
  await flush();

  assert.deepEqual(car.availability, [], "no unavailable/available flap");
});

test("a rebind does not blank the grid tariff rates before the replay replaces them", async (t) => {
  const world = await createWorld(t, { tokenExpiresInMs: 3_600_000 });
  world.server.metadata.energy_sites = { [SITE]: { access: true, name: "Home" } };
  await world.app.onInit();
  const powerwall = world.addDevice("battery", PowerwallDevice, { id: Number(SITE) });
  await powerwall.onInit();
  await flush();
  // Rates resolved from an earlier site_info.
  powerwall.capabilities.grid_buy_rate = 0.31;
  powerwall.capabilities.grid_sell_rate = 0.08;
  powerwall.writes.length = 0;

  await world.app.initializeTeslemetry(true);
  await flush();

  assert.deepEqual(
    powerwall.writes.filter(([capability]) => capability.startsWith("grid_")),
    [],
    "no null gap in grid_buy_rate/grid_sell_rate Insights on a rebind",
  );
});
