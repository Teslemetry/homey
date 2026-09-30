import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
// The real SDK by relative path (the "@teslemetry/api" specifier is
// redirected to a stub, see test/support/loader.mjs), pointed at a local
// server, so every command below goes through the real generated client's
// response parsing - including what it throws for non-JSON and empty bodies.
import { Teslemetry } from "../node_modules/@teslemetry/api/dist/index.mjs";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

/**
 * The command-result path: Tesla's benign `result:false` reasons, blank
 * error messages from non-JSON/empty/description-less failures, and the
 * optimistic value Homey commits when the 9s action timeout reports success
 * for a command that later fails.
 */

type Route = { status: number; body: string; type?: string; delayMs?: number };
let routes: Record<string, Route> = {};

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const key = Object.keys(routes).find((k) => req.url?.includes(k));
    const route = key ? routes[key] : { status: 404, body: "{}" };
    setTimeout(() => {
      res.writeHead(route.status, { "content-type": route.type ?? "application/json" });
      res.end(route.body);
    }, route.delayMs ?? 0);
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as { port: number };
test.after(() => server.close());

class FakeVehicleStream extends EventEmitter {
  data = new EventEmitter();
  cache: { data: Record<string, unknown> } = { data: {} };
  onSignal(field: string, callback: (value: unknown) => void) {
    this.data.on(field, callback);
    return () => this.data.off(field, callback);
  }
}

async function vehicleDevice(capabilities: Record<string, unknown> = {}) {
  const sdk = new Teslemetry(async () => "token", {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  sdk.client.setConfig({ baseUrl: `http://127.0.0.1:${port}` });
  const sse = new FakeVehicleStream();
  // The captain's real Model 3 config.
  const vehicle = {
    vin: "VIN1",
    sse,
    api: sdk.api.getVehicle("VIN1"),
    metadata: {
      access: true,
      fleet_telemetry: "x",
      polling: false,
      config: { rear_seat_heaters: 1, rhd: true, cop_user_set_temp_supported: false },
    },
  };
  const listeners: Record<string, (value: unknown) => Promise<void>> = {};
  const errors: unknown[][] = [];
  const device = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { VIN1: vehicle } } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
      geolocation: { getLatitude: () => 0, getLongitude: () => 0 },
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
      getDevices: () => [device],
    },
    getName: () => "Car",
    getData: () => ({ vin: "VIN1" }),
    getStoreValue: () => null,
    getCapabilities: () => Object.keys(capabilities),
    hasCapability: (c: string) => c in capabilities,
    getCapabilityValue: (c: string) => capabilities[c],
    setCapabilityValue: async (c: string, v: unknown) => {
      capabilities[c] = v;
    },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: (c: string, l: (value: unknown) => Promise<void>) => {
      listeners[c] = l;
    },
    log: () => {},
    error: (...args: unknown[]) => errors.push(args),
    setUnavailable: async () => {},
    setAvailable: async () => {},
  });
  await device.onInit();
  return { device, listeners, capabilities, errors };
}

/**
 * Stands in for Homey itself: runs the capability listener and, only if it
 * resolves, commits the requested value the way the Apps SDK does.
 */
async function setFromHomey(
  listeners: Record<string, (value: unknown) => Promise<void>>,
  capabilities: Record<string, unknown>,
  capability: string,
  value: unknown,
) {
  await listeners[capability](value);
  capabilities[capability] = value;
}

test("already_set, not_charging and requested are success, as in HA", async () => {
  const { device } = await vehicleDevice();
  routes = {
    "/command/set_charge_limit": { status: 200, body: '{"response":{"result":false,"reason":"already_set"}}' },
    "/command/charge_stop": { status: 200, body: '{"response":{"result":false,"reason":"not_charging"}}' },
    "/command/charge_start": { status: 200, body: '{"response":{"result":false,"reason":"requested"}}' },
  };
  await device.flowSetChargeLimit(80);
  await device.flowStopCharging();
  await device.flowStartCharging();
});

test("any other result:false reason still rejects with that reason", async () => {
  const { device } = await vehicleDevice();
  routes = {
    "/command/charge_start": { status: 200, body: '{"response":{"result":false,"reason":"is_charging"}}' },
  };
  await assert.rejects(device.flowStartCharging(), (e: Error) => e.message === "is_charging");
});

test("every failure shape surfaces a non-empty Error message", async () => {
  const { device } = await vehicleDevice();
  const cases: Array<[string, Route, string]> = [
    [
      "cloudflare 502 html",
      {
        status: 502,
        type: "text/html",
        body: "<html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html>",
      },
      "502 Bad Gateway",
    ],
    ["empty 504 body", { status: 504, type: "text/plain", body: "" }, "Teslemetry request failed"],
    [
      "tesla passthrough, empty description",
      { status: 422, body: '{"response":null,"error":"vehicle rejected","error_description":""}' },
      "vehicle rejected",
    ],
    [
      "200 result:false with no reason",
      { status: 200, body: '{"response":{"result":false}}' },
      "error.command_no_result",
    ],
  ];
  for (const [label, route, expected] of cases) {
    routes = { "/command/flash_lights": route };
    await assert.rejects(
      device.flowFlashLights(),
      (e: unknown) => e instanceof Error && e.message === expected,
      label,
    );
  }
});

test("a command that fails after the 9s timeout restores the pre-command value", async () => {
  const { listeners, errors, capabilities } = await vehicleDevice({ locked: false });
  routes = {
    "/command/door_lock": {
      status: 408,
      delayMs: 9_600,
      body: '{"response":null,"error":"could_not_wake_vehicle","error_description":"Could not wake vehicle"}',
    },
  };
  const started = Date.now();
  await setFromHomey(listeners, capabilities, "locked", true);
  const resolvedAfter = Date.now() - started;
  assert.ok(resolvedAfter >= 9_000 && resolvedAfter < 9_500, `resolved after ${resolvedAfter}ms`);
  assert.equal(capabilities.locked, true, "Homey committed the optimistic value");

  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.ok(
    errors.some((args) => /failed after the 9000ms action timeout/.test(String(args[0]))),
    "the late failure is still logged",
  );
  assert.equal(capabilities.locked, false);
});
