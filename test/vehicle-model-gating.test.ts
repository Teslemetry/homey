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

function createDeviceStub(vin: string, existingCapabilities: string[]) {
  const added: string[] = [];
  const removed: string[] = [];
  let capabilities = [...existingCapabilities];
  const stub = Object.assign(Object.create(VehicleDevice.prototype), {
    homey: {
      app: { products: {} },
      __: (key: string) => key,
    },
    driver: {
      manifest: {
        capabilities: ["measure_battery", ...TONNEAU_CAPABILITIES],
        capabilitiesOptions: {},
      },
    },
    getData: () => ({ vin, id: vin }),
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
