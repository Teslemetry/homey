import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDriver from "../.homeybuild/drivers/vehicle/driver.js";

const ELIGIBLE_METADATA = {
  access: true,
  fleet_telemetry: "fleet_telemetry_config_id",
  polling: false,
  config: {},
};

function createVehicle(
  vin: string,
  name: string,
  metadata: Record<string, unknown>,
) {
  return { vin, name, metadata };
}

function createDriverStub(vehicles: ReturnType<typeof createVehicle>[]) {
  const errors: unknown[] = [];
  const logs: unknown[] = [];
  return {
    driver: Object.assign(new VehicleDriver(), {
      homey: {
        app: {
          products: {
            vehicles: Object.fromEntries(vehicles.map((v) => [v.vin, v])),
          },
          getProducts: async () => ({
            vehicles: Object.fromEntries(vehicles.map((v) => [v.vin, v])),
          }),
        },
        __: (key: string) => key,
      },
      manifest: {
        capabilities: ["locked", "onoff.frunk", "onoff.trunk"],
        capabilitiesOptions: {
          "onoff.frunk": { title: "Frunk" },
          "onoff.trunk": { title: "Trunk" },
        },
      },
      log: (message: unknown) => {
        logs.push(message);
      },
      error: (message: unknown) => {
        errors.push(message);
      },
    }),
    errors,
    logs,
  };
}

test("VehicleDriver.onPairListDevices returns the eligible vehicle when another is present but lacks Fleet Telemetry", async () => {
  const { driver } = createDriverStub([
    createVehicle("5YJ3E1EA1JF000001", "Eligible Model 3", ELIGIBLE_METADATA),
    createVehicle("5YJ3E1EA1JF000002", "No Telemetry Model 3", {
      ...ELIGIBLE_METADATA,
      fleet_telemetry: null,
    }),
  ]);

  const result = await driver.onPairListDevices();

  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Eligible Model 3");
});

test("VehicleDriver.onPairListDevices throws a diagnosable error instead of an empty list when the only vehicle lacks Fleet Telemetry", async () => {
  const { driver, errors } = createDriverStub([
    createVehicle("5YJ3E1EA1JF000002", "No Telemetry Model 3", {
      ...ELIGIBLE_METADATA,
      fleet_telemetry: null,
    }),
  ]);

  await assert.rejects(
    () => driver.onPairListDevices(),
    /error\.vehicle_telemetry_unavailable/,
  );
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /no eligible vehicles/);
  assert.match(String(errors[0]), /5YJ3E1EA1JF000002 \(telemetry\)/);
});

test("VehicleDriver.onPairListDevices throws an access-specific error when the only vehicle has no Teslemetry access", async () => {
  const { driver } = createDriverStub([
    createVehicle("5YJ3E1EA1JF000003", "No Access Model 3", {
      ...ELIGIBLE_METADATA,
      access: false,
    }),
  ]);

  await assert.rejects(
    () => driver.onPairListDevices(),
    /error\.vehicle_access_required/,
  );
});

test("VehicleDriver.onPairListDevices throws a polling-mode error when the only vehicle is in legacy polling mode", async () => {
  const { driver } = createDriverStub([
    createVehicle("5YJ3E1EA1JF000004", "Polling Model 3", {
      ...ELIGIBLE_METADATA,
      polling: true,
    }),
  ]);

  await assert.rejects(
    () => driver.onPairListDevices(),
    /error\.vehicle_polling_mode/,
  );
});

test("VehicleDriver.onPairListDevices returns an empty list without throwing when the account genuinely has no vehicles", async () => {
  const { driver, errors } = createDriverStub([]);

  const result = await driver.onPairListDevices();

  assert.deepEqual(result, []);
  assert.equal(errors.length, 0);
});
