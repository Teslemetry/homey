import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
// The real SDK, by relative path: the bare "@teslemetry/api" specifier is
// redirected to the test stub (see support/loader.mjs). Commands go over
// real HTTP to a local server, so the test sees exactly what reaches the
// wire - Tesla's actuate_trunk and media_toggle_playback are toggles, so a
// request sent in the wrong state moves the trunk or starts playback.
import { Teslemetry } from "../node_modules/@teslemetry/api/dist/index.mjs";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";

const requests: string[] = [];
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const command = (req.url ?? "").split("?")[0].split("/command/")[1];
    requests.push(command);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"response":{"result":true,"reason":""}}');
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

const CLOSED_DOORS = {
  DriverFront: false,
  DriverRear: false,
  PassengerFront: false,
  PassengerRear: false,
  TrunkFront: false,
  TrunkRear: false,
};

async function createDevice(cacheData: Record<string, unknown>) {
  const sdk = new Teslemetry(async () => "token", {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  sdk.client.setConfig({ baseUrl: `http://127.0.0.1:${port}` });
  const sse = new FakeVehicleStream();
  sse.cache.data = cacheData;
  const capabilities: Record<string, unknown> = {
    "onoff.trunk": null,
    "onoff.frunk": null,
    speaker_playing: null,
  };
  const vehicle = {
    vin: "VIN1",
    sse,
    api: sdk.api.getVehicle("VIN1"),
    metadata: {
      access: true,
      fleet_telemetry: "fleet_telemetry_config_id",
      polling: false,
      // The captain's real Model 3 config shape.
      config: {
        can_actuate_trunks: true,
        rear_seat_heaters: 1,
        rhd: true,
        cop_user_set_temp_supported: false,
      },
    },
  };
  const listeners: Record<string, (value: unknown) => Promise<unknown>> = {};
  const device = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { VIN1: vehicle } } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: {
      manifest: {
        capabilities: Object.keys(capabilities),
        capabilitiesOptions: {},
      },
    },
    getData: () => ({ vin: "VIN1", id: "VIN1" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    getStoreValue: () => null,
    registerCapabilityListener: (
      capability: string,
      listener: (value: unknown) => Promise<unknown>,
    ) => {
      listeners[capability] = listener;
    },
    log: () => {},
    error: () => {},
    setUnavailable: async () => {},
  });
  await device.onInit();
  requests.length = 0;
  return listeners;
}

test("closing an already-closed trunk sends nothing", async () => {
  const listeners = await createDevice({ DoorState: CLOSED_DOORS });

  await listeners["onoff.trunk"](false);

  assert.deepEqual(requests, []);
});

test("opening an already-open trunk sends nothing", async () => {
  const listeners = await createDevice({
    DoorState: { ...CLOSED_DOORS, TrunkRear: true },
  });

  await listeners["onoff.trunk"](true);

  assert.deepEqual(requests, []);
});

test("the trunk is actuated when it is not in the requested state", async () => {
  const listeners = await createDevice({ DoorState: CLOSED_DOORS });

  await listeners["onoff.trunk"](true);

  assert.deepEqual(requests, ["actuate_trunk"]);
});

test("an unknown trunk state still actuates the trunk (pending HA call F41)", async () => {
  for (const cacheData of [{}, { DoorState: null }]) {
    const listeners = await createDevice(cacheData);

    await listeners["onoff.trunk"](false);

    assert.deepEqual(requests, ["actuate_trunk"]);
  }
});

test("closing the frunk rejects instead of reporting success", async () => {
  const listeners = await createDevice({
    DoorState: { ...CLOSED_DOORS, TrunkFront: true },
  });

  await assert.rejects(listeners["onoff.frunk"](false), {
    message: "error.frunk_cannot_close",
  });
  assert.deepEqual(requests, []);
});

test("opening the frunk actuates it", async () => {
  const listeners = await createDevice({ DoorState: CLOSED_DOORS });

  await listeners["onoff.frunk"](true);

  assert.deepEqual(requests, ["actuate_trunk"]);
});

test("pause while paused and play while playing send nothing", async () => {
  let listeners = await createDevice({
    MediaPlaybackStatus: "MediaStatusPaused",
  });
  await listeners.speaker_playing(false);

  listeners = await createDevice({ MediaPlaybackStatus: "MediaStatusPlaying" });
  await listeners.speaker_playing(true);

  assert.deepEqual(requests, []);
});

test("play and pause toggle playback when the state differs", async () => {
  let listeners = await createDevice({
    MediaPlaybackStatus: "MediaStatusStopped",
  });
  await listeners.speaker_playing(true);
  assert.deepEqual(requests, ["media_toggle_playback"]);

  listeners = await createDevice({ MediaPlaybackStatus: "MediaStatusPlaying" });
  await listeners.speaker_playing(false);
  assert.deepEqual(requests, ["media_toggle_playback"]);
});

test("with unknown playback, play sends and pause does not (HA parity)", async () => {
  let listeners = await createDevice({});
  await listeners.speaker_playing(false);
  assert.deepEqual(requests, []);

  listeners = await createDevice({ MediaPlaybackStatus: "MediaStatusUnknown" });
  await listeners.speaker_playing(true);
  assert.deepEqual(requests, ["media_toggle_playback"]);
});
