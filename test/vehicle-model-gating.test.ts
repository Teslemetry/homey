import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import isCybertruck, {
  isModelSorX,
} from "../.homeybuild/drivers/vehicle/model.js";

const TONNEAU_CAPABILITIES = [
  "windowcoverings_closed.tonneau",
  "windowcoverings_set.tonneau",
];

const BIOWEAPON_CAPABILITIES = ["button.bioweapon"];

// VIN position 4 (index 3) is "C" for Cybertruck, matching driver.ts's icon
// lookup and Tesla's own VIN vehicle-line encoding.
const CYBERTRUCK_VIN = "XYZCTRK0000000001";
const MODEL_Y_VIN = "XYZYTRK0000000001";
const CYBERCAB_VIN = "XYZACAB0000000001";
const MODEL_S_VIN = "XYZSTRK0000000001";
const MODEL_X_VIN = "XYZXTRK0000000001";

const SEAT_FEATURE_CAPABILITIES = [
  "seat_heater.rear_left",
  "seat_heater.rear_right",
  "seat_heater.rear_center",
  "seat_cooler.front_left",
  "seat_cooler.front_right",
];

const SUNROOF_CAPABILITIES = ["windowcoverings_closed.sunroof"];

const COP_TEMPERATURE_LIMIT_CAPABILITIES = ["cop_temperature_limit"];

const POWERSHARE_CAPABILITIES = [
  "powershare_status",
  "powershare_type",
  "powershare_stop_reason",
  "powershare_hours_left",
  "measure_power.powershare",
];

function createDeviceStub(
  vin: string,
  existingCapabilities: string[],
  config?: {
    has_seat_cooling?: boolean;
    rear_seat_heaters?: number;
    sun_roof_installed?: boolean;
    cop_user_set_temp_supported?: boolean;
  },
) {
  const added: string[] = [];
  const removed: string[] = [];
  let capabilities = [...existingCapabilities];
  const stub = Object.assign(Object.create(VehicleDevice.prototype), {
    homey: {
      app: {
        products: config
          ? { vehicles: { [vin]: { metadata: { config } } } }
          : {},
      },
      __: (key: string) => key,
    },
    driver: {
      manifest: {
        capabilities: [
          "measure_battery",
          ...TONNEAU_CAPABILITIES,
          ...SEAT_FEATURE_CAPABILITIES,
          ...SUNROOF_CAPABILITIES,
          ...COP_TEMPERATURE_LIMIT_CAPABILITIES,
          ...POWERSHARE_CAPABILITIES,
          ...BIOWEAPON_CAPABILITIES,
        ],
        capabilitiesOptions: {},
      },
    },
    getData: () => ({ vin, id: vin }),
    getStoreValue: () => null,
    getCapabilities: () => capabilities,
    addCapability: async (capability: string) => {
      added.push(capability);
      capabilities.push(capability);
    },
    removeCapability: async (capability: string) => {
      removed.push(capability);
      capabilities = capabilities.filter((c) => c !== capability);
    },
    log: () => {},
    error: () => {},
  });
  return { stub, added, removed };
}

test("ensureCapabilities adds the tonneau capabilities for a Cybertruck VIN", async () => {
  const { stub, added, removed } = createDeviceStub(CYBERTRUCK_VIN, [
    "measure_battery",
    ...POWERSHARE_CAPABILITIES,
  ]);

  await stub.ensureCapabilities();

  assert.deepEqual(new Set(added), new Set(TONNEAU_CAPABILITIES));
  assert.deepEqual(removed, []);
});

test("ensureCapabilities does not add the tonneau capabilities for a non-Cybertruck VIN", async () => {
  const { stub, added } = createDeviceStub(MODEL_Y_VIN, ["measure_battery"]);

  await stub.ensureCapabilities();

  assert.deepEqual(
    added.filter((cap) => TONNEAU_CAPABILITIES.includes(cap)),
    [],
  );
});

test("ensureCapabilities removes tonneau capabilities already present on a non-Cybertruck device", async () => {
  const { stub, removed } = createDeviceStub(MODEL_Y_VIN, [
    "measure_battery",
    ...TONNEAU_CAPABILITIES,
  ]);

  await stub.ensureCapabilities();

  assert.deepEqual(new Set(removed), new Set(TONNEAU_CAPABILITIES));
});

test("ensureCapabilities leaves tonneau capabilities alone on a Cybertruck device that already has them", async () => {
  const { stub, added, removed } = createDeviceStub(CYBERTRUCK_VIN, [
    "measure_battery",
    ...TONNEAU_CAPABILITIES,
    ...POWERSHARE_CAPABILITIES,
  ]);

  await stub.ensureCapabilities();

  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
});

test("ensureCapabilities adds the Powershare capabilities for a Cybertruck VIN", async () => {
  const { stub, added, removed } = createDeviceStub(CYBERTRUCK_VIN, [
    "measure_battery",
  ]);

  await stub.ensureCapabilities();

  assert.deepEqual(
    new Set(added.filter((cap) => POWERSHARE_CAPABILITIES.includes(cap))),
    new Set(POWERSHARE_CAPABILITIES),
  );
  assert.deepEqual(removed, []);
});

test("ensureCapabilities does not add the Powershare capabilities for a non-Cybertruck VIN", async () => {
  const { stub, added } = createDeviceStub(MODEL_Y_VIN, ["measure_battery"]);

  await stub.ensureCapabilities();

  assert.deepEqual(
    added.filter((cap) => POWERSHARE_CAPABILITIES.includes(cap)),
    [],
  );
});

test("ensureCapabilities removes Powershare capabilities already present on a non-Cybertruck device", async () => {
  const { stub, removed } = createDeviceStub(MODEL_Y_VIN, [
    "measure_battery",
    ...POWERSHARE_CAPABILITIES,
  ]);

  await stub.ensureCapabilities();

  assert.deepEqual(new Set(removed), new Set(POWERSHARE_CAPABILITIES));
});

test("isCybertruck reads VIN position 4 (index 3)", () => {
  assert.equal(isCybertruck(CYBERTRUCK_VIN), true);
  assert.equal(isCybertruck(MODEL_Y_VIN), false);
  assert.equal(isCybertruck(undefined), false);
  // Cybercab ("A") is a distinct model, not a Cybertruck.
  assert.equal(isCybertruck(CYBERCAB_VIN), false);
});

test("isModelSorX reads VIN position 4 (index 3)", () => {
  assert.equal(isModelSorX(MODEL_S_VIN), true);
  assert.equal(isModelSorX(MODEL_X_VIN), true);
  assert.equal(isModelSorX(MODEL_Y_VIN), false);
  assert.equal(isModelSorX(CYBERTRUCK_VIN), false);
  assert.equal(isModelSorX(undefined), false);
});

test("ensureCapabilities adds the bioweapon capability for a Model S VIN", async () => {
  const { stub, added, removed } = createDeviceStub(MODEL_S_VIN, [
    "measure_battery",
  ]);

  await stub.ensureCapabilities();

  assert.deepEqual(new Set(added), new Set(BIOWEAPON_CAPABILITIES));
  assert.deepEqual(removed, []);
});

test("ensureCapabilities adds the bioweapon capability for a Model X VIN", async () => {
  const { stub, added } = createDeviceStub(MODEL_X_VIN, ["measure_battery"]);

  await stub.ensureCapabilities();

  assert.deepEqual(new Set(added), new Set(BIOWEAPON_CAPABILITIES));
});

test("ensureCapabilities does not add the bioweapon capability for a non-S/X VIN", async () => {
  const { stub, added } = createDeviceStub(MODEL_Y_VIN, ["measure_battery"]);

  await stub.ensureCapabilities();

  assert.deepEqual(
    added.filter((cap) => BIOWEAPON_CAPABILITIES.includes(cap)),
    [],
  );
});

test("ensureCapabilities removes the bioweapon capability already present on a non-S/X device", async () => {
  const { stub, removed } = createDeviceStub(MODEL_Y_VIN, [
    "measure_battery",
    ...BIOWEAPON_CAPABILITIES,
  ]);

  await stub.ensureCapabilities();

  assert.deepEqual(new Set(removed), new Set(BIOWEAPON_CAPABILITIES));
});

test("ensureCapabilities leaves the bioweapon capability alone on a Model S device that already has it", async () => {
  const { stub, added, removed } = createDeviceStub(MODEL_S_VIN, [
    "measure_battery",
    ...BIOWEAPON_CAPABILITIES,
  ]);

  await stub.ensureCapabilities();

  assert.deepEqual(
    added.filter((cap) => BIOWEAPON_CAPABILITIES.includes(cap)),
    [],
  );
  assert.deepEqual(
    removed.filter((cap) => BIOWEAPON_CAPABILITIES.includes(cap)),
    [],
  );
});

test("ensureCapabilities still filters the bioweapon capability by VIN when metadata is absent", async () => {
  const { stub, added } = createDeviceStub(MODEL_Y_VIN, ["measure_battery"]);

  await stub.ensureCapabilities();

  assert.deepEqual(
    added.filter((cap) => BIOWEAPON_CAPABILITIES.includes(cap)),
    [],
  );
});

test("ensureCapabilities does not add rear-heater/seat-cooler capabilities for a no-feature vehicle", async () => {
  const { stub, added } = createDeviceStub(MODEL_Y_VIN, ["measure_battery"], {
    has_seat_cooling: false,
    rear_seat_heaters: 0,
  });

  await stub.ensureCapabilities();

  assert.deepEqual(
    added.filter((cap) => SEAT_FEATURE_CAPABILITIES.includes(cap)),
    [],
  );
});

test("ensureCapabilities removes rear-heater/seat-cooler capabilities already present on a no-feature vehicle", async () => {
  const { stub, removed } = createDeviceStub(
    MODEL_Y_VIN,
    ["measure_battery", ...SEAT_FEATURE_CAPABILITIES],
    { has_seat_cooling: false, rear_seat_heaters: 0 },
  );

  await stub.ensureCapabilities();

  assert.deepEqual(new Set(removed), new Set(SEAT_FEATURE_CAPABILITIES));
});

test("ensureCapabilities adds rear-heater/seat-cooler capabilities for a fully-equipped vehicle", async () => {
  const { stub, added } = createDeviceStub(MODEL_Y_VIN, ["measure_battery"], {
    has_seat_cooling: true,
    rear_seat_heaters: 3,
  });

  await stub.ensureCapabilities();

  assert.deepEqual(new Set(added), new Set(SEAT_FEATURE_CAPABILITIES));
});

test("ensureCapabilities gates rear_left/rear_right on 2+ rear seat heaters but rear_center on 3", async () => {
  const { stub, added } = createDeviceStub(MODEL_Y_VIN, ["measure_battery"], {
    has_seat_cooling: false,
    rear_seat_heaters: 2,
  });

  await stub.ensureCapabilities();

  assert.deepEqual(
    new Set(added),
    new Set(["seat_heater.rear_left", "seat_heater.rear_right"]),
  );
});

test("ensureCapabilities leaves a fully-equipped vehicle's seat capabilities alone when it already has them", async () => {
  const { stub, added, removed } = createDeviceStub(
    MODEL_Y_VIN,
    ["measure_battery", ...SEAT_FEATURE_CAPABILITIES],
    { has_seat_cooling: true, rear_seat_heaters: 3 },
  );

  await stub.ensureCapabilities();

  assert.deepEqual(
    added.filter((cap) => SEAT_FEATURE_CAPABILITIES.includes(cap)),
    [],
  );
  assert.deepEqual(
    removed.filter((cap) => SEAT_FEATURE_CAPABILITIES.includes(cap)),
    [],
  );
});

test("ensureCapabilities preserves the paired seat-feature set (no widening) when vehicle metadata is temporarily absent", async () => {
  // No `config` passed: homey.app.products has no vehicles entry, matching a
  // device whose product hasn't resolved yet (e.g. still starting up).
  const { stub, added, removed } = createDeviceStub(MODEL_Y_VIN, [
    "measure_battery",
    "seat_heater.rear_left",
    "seat_heater.rear_right",
  ]);

  await stub.ensureCapabilities();

  // Already-paired rear heaters must not be removed...
  assert.deepEqual(
    removed.filter((cap) => SEAT_FEATURE_CAPABILITIES.includes(cap)),
    [],
  );
  // ...and capabilities the device never had must not be widened back in.
  assert.deepEqual(
    added.filter((cap) => SEAT_FEATURE_CAPABILITIES.includes(cap)),
    [],
  );
});

test("ensureCapabilities still filters Cybertruck tonneau capabilities by VIN when metadata is absent", async () => {
  const { stub, added } = createDeviceStub(MODEL_Y_VIN, ["measure_battery"]);

  await stub.ensureCapabilities();

  assert.deepEqual(
    added.filter((cap) => TONNEAU_CAPABILITIES.includes(cap)),
    [],
  );
});

test("ensureCapabilities adds the sunroof capability for a vehicle with sun_roof_installed", async () => {
  const { stub, added } = createDeviceStub(MODEL_Y_VIN, ["measure_battery"], {
    sun_roof_installed: true,
  });

  await stub.ensureCapabilities();

  assert.deepEqual(new Set(added), new Set(SUNROOF_CAPABILITIES));
});

test("ensureCapabilities does not add the sunroof capability for a vehicle without one", async () => {
  const { stub, added } = createDeviceStub(MODEL_Y_VIN, ["measure_battery"], {
    sun_roof_installed: false,
  });

  await stub.ensureCapabilities();

  assert.deepEqual(
    added.filter((cap) => SUNROOF_CAPABILITIES.includes(cap)),
    [],
  );
});

test("ensureCapabilities removes the sunroof capability already present on a vehicle without one", async () => {
  const { stub, removed } = createDeviceStub(
    MODEL_Y_VIN,
    ["measure_battery", ...SUNROOF_CAPABILITIES],
    { sun_roof_installed: false },
  );

  await stub.ensureCapabilities();

  assert.deepEqual(new Set(removed), new Set(SUNROOF_CAPABILITIES));
});

test("ensureCapabilities preserves the sunroof capability (no widening) when vehicle metadata is temporarily absent", async () => {
  const { stub, added, removed } = createDeviceStub(MODEL_Y_VIN, [
    "measure_battery",
    ...SUNROOF_CAPABILITIES,
  ]);

  await stub.ensureCapabilities();

  assert.deepEqual(
    removed.filter((cap) => SUNROOF_CAPABILITIES.includes(cap)),
    [],
  );
  assert.deepEqual(
    added.filter((cap) => SUNROOF_CAPABILITIES.includes(cap)),
    [],
  );
});

test("ensureCapabilities adds the cop_temperature_limit capability for a vehicle with cop_user_set_temp_supported", async () => {
  const { stub, added } = createDeviceStub(MODEL_Y_VIN, ["measure_battery"], {
    cop_user_set_temp_supported: true,
  });

  await stub.ensureCapabilities();

  assert.deepEqual(new Set(added), new Set(COP_TEMPERATURE_LIMIT_CAPABILITIES));
});

test("ensureCapabilities does not add the cop_temperature_limit capability for a vehicle without cop_user_set_temp_supported", async () => {
  const { stub, added } = createDeviceStub(MODEL_Y_VIN, ["measure_battery"], {
    cop_user_set_temp_supported: false,
  });

  await stub.ensureCapabilities();

  assert.deepEqual(
    added.filter((cap) => COP_TEMPERATURE_LIMIT_CAPABILITIES.includes(cap)),
    [],
  );
});

test("ensureCapabilities removes the cop_temperature_limit capability already present on a vehicle without cop_user_set_temp_supported", async () => {
  const { stub, removed } = createDeviceStub(
    MODEL_Y_VIN,
    ["measure_battery", ...COP_TEMPERATURE_LIMIT_CAPABILITIES],
    { cop_user_set_temp_supported: false },
  );

  await stub.ensureCapabilities();

  assert.deepEqual(new Set(removed), new Set(COP_TEMPERATURE_LIMIT_CAPABILITIES));
});

test("ensureCapabilities preserves the cop_temperature_limit capability (no widening) when vehicle metadata is temporarily absent", async () => {
  const { stub, added, removed } = createDeviceStub(MODEL_Y_VIN, [
    "measure_battery",
    ...COP_TEMPERATURE_LIMIT_CAPABILITIES,
  ]);

  await stub.ensureCapabilities();

  assert.deepEqual(
    removed.filter((cap) => COP_TEMPERATURE_LIMIT_CAPABILITIES.includes(cap)),
    [],
  );
  assert.deepEqual(
    added.filter((cap) => COP_TEMPERATURE_LIMIT_CAPABILITIES.includes(cap)),
    [],
  );
});

// Seat action cards are driver-scoped (drivers/vehicle/driver.flow.compose.json),
// so Homey Compose auto-injects their device arg's filter from each card's
// "$filter" - see the "App-Level vs Driver-Scoped Flow Cards" note in
// AGENTS.md. app.json is the committed, generated manifest these compile
// into, kept in sync by the developer on every compose change (not
// regenerated by `npm test`, which only runs tsc).
const SEAT_ACTION_CARD_CAPABILITIES: Record<string, string> = {
  "seat_heater.front_left_set": "seat_heater.front_left",
  "seat_heater.front_right_set": "seat_heater.front_right",
  "seat_heater.rear_left_set": "seat_heater.rear_left",
  "seat_heater.rear_right_set": "seat_heater.rear_right",
  "seat_heater.rear_center_set": "seat_heater.rear_center",
  "seat_cooler.front_left_set": "seat_cooler.front_left",
  "seat_cooler.front_right_set": "seat_cooler.front_right",
};

test("every seat heater/cooler action card filters its device argument by the matching capability", () => {
  const appManifest = JSON.parse(
    readFileSync(new URL("../app.json", import.meta.url), "utf8"),
  );

  for (const [cardId, capability] of Object.entries(
    SEAT_ACTION_CARD_CAPABILITIES,
  )) {
    const card = appManifest.flow.actions.find(
      (c: { id: string }) => c.id === cardId,
    );
    assert.ok(card, `missing flow action card ${cardId}`);
    const deviceArg = card.args.find(
      (a: { type: string }) => a.type === "device",
    );
    assert.ok(
      deviceArg?.filter?.includes(`capabilities=${capability}`),
      `${cardId} device filter "${deviceArg?.filter}" is missing capabilities=${capability}`,
    );
  }
});

// Mirrors vehicle-new-signals.test.ts's stub shape (a real onInit() run is
// needed so registerSignalListeners() actually wires up the seat signal
// handlers), with a log spy added to assert on the "not supported" line.
class FakeVehicleStream extends EventEmitter {
  data = new EventEmitter();

  onSignal(field: string, callback: (value: unknown) => void) {
    this.data.on(field, callback);
    return () => this.data.off(field, callback);
  }
}

function createSignalDeviceStub(
  capabilities: Record<string, unknown>,
  config: Record<string, unknown>,
) {
  const vin = MODEL_Y_VIN;
  const sse = new FakeVehicleStream();
  const vehicle = {
    sse,
    api: {},
    metadata: {
      access: true,
      fleet_telemetry: "fleet_telemetry_config_id",
      polling: false,
      config: { rhd: false, can_actuate_trunks: false, ...config },
    },
  };
  const logs: string[] = [];
  const stub = Object.assign(new VehicleDevice(), {
    homey: {
      app: { products: { vehicles: { [vin]: vehicle } } },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
    },
    driver: {
      manifest: {
        capabilities: Object.keys(capabilities),
        capabilitiesOptions: {},
      },
      getDevices: () => [] as unknown[],
    },
    getData: () => ({ vin, id: vin }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    getStoreValue: () => null,
    registerCapabilityListener: () => {},
    log: (message: string) => logs.push(message),
    error: () => {},
    setUnavailable: async () => {},
  });
  stub.driver.getDevices = () => [stub];
  return { stub, sse, capabilities, logs };
}

test("a seat signal for a capability this device does not expose neither logs 'not supported' nor writes a value", async () => {
  const { stub, sse, capabilities, logs } = createSignalDeviceStub(
    { measure_battery: undefined },
    { has_seat_cooling: false, rear_seat_heaters: 0 },
  );
  await stub.onInit();

  sse.data.emit("SeatHeaterRearLeft", 1);

  assert.equal(capabilities["seat_heater.rear_left"], undefined);
  assert.ok(
    !logs.some((line) =>
      line.includes("Capability seat_heater.rear_left is not supported"),
    ),
  );
});

test("a seat signal for a capability this device does expose still updates it", async () => {
  const { stub, sse, capabilities, logs } = createSignalDeviceStub(
    { measure_battery: undefined, "seat_heater.rear_left": undefined },
    { has_seat_cooling: false, rear_seat_heaters: 2 },
  );
  await stub.onInit();

  sse.data.emit("SeatHeaterRearLeft", 1);

  assert.equal(capabilities["seat_heater.rear_left"], "1");
  assert.ok(
    !logs.some((line) =>
      line.includes("Capability seat_heater.rear_left is not supported"),
    ),
  );
});
