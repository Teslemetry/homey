import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDevice from "../.homeybuild/drivers/vehicle/device.js";
import isCybertruck from "../.homeybuild/drivers/vehicle/model.js";

const TONNEAU_CAPABILITIES = [
  "windowcoverings_closed.tonneau",
  "windowcoverings_set.tonneau",
];

// VIN position 4 (index 3) is "C" for Cybertruck, matching driver.ts's icon
// lookup and Tesla's own VIN vehicle-line encoding.
const CYBERTRUCK_VIN = "XYZCTRK0000000001";
const MODEL_Y_VIN = "XYZYTRK0000000001";

const SEAT_FEATURE_CAPABILITIES = [
  "seat_heater.rear_left",
  "seat_heater.rear_right",
  "seat_heater.rear_center",
  "seat_cooler.front_left",
  "seat_cooler.front_right",
];

const SUNROOF_CAPABILITIES = ["windowcoverings_closed.sunroof"];

function createDeviceStub(
  vin: string,
  existingCapabilities: string[],
  config?: {
    has_seat_cooling?: boolean;
    rear_seat_heaters?: number;
    sun_roof_installed?: boolean;
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
  ]);

  await stub.ensureCapabilities();

  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
});

test("isCybertruck reads VIN position 4 (index 3)", () => {
  assert.equal(isCybertruck(CYBERTRUCK_VIN), true);
  assert.equal(isCybertruck(MODEL_Y_VIN), false);
  assert.equal(isCybertruck(undefined), false);
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
