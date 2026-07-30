import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryDriver from "../.homeybuild/lib/TeslemetryDriver.js";

function createDriverStub(devices: Array<{ getId(): string }>) {
  const errors: unknown[][] = [];
  const stub = Object.assign(new TeslemetryDriver(), {
    id: "battery",
    error: (...args: unknown[]) => {
      errors.push(args);
    },
    getDevices: () => devices,
  });
  return { stub: stub as unknown as { getDeviceById(id: string): unknown }, errors };
}

test("getDeviceById resolves the live runtime instance whose getId() matches, leaving live device paths unchanged", () => {
  const deviceA = { getId: () => "runtime-a" };
  const deviceB = { getId: () => "runtime-b" };
  const { stub, errors } = createDriverStub([deviceA, deviceB]);

  assert.equal(stub.getDeviceById("runtime-b"), deviceB);
  assert.equal(errors.length, 0);
});

test("getDeviceById does not compare against paired deviceData, only the runtime id", () => {
  // A device whose getId() never matches the stale runtime id must not be
  // returned just because some other identifier (e.g. site id) coincides.
  const device = { getId: () => "runtime-current" };
  const { stub } = createDriverStub([device]);

  assert.equal(stub.getDeviceById("runtime-stale"), undefined);
});

test("getDeviceById returns undefined instead of throwing for a stale/removed runtime id", () => {
  const { stub, errors } = createDriverStub([]);

  assert.doesNotThrow(() => {
    const result = stub.getDeviceById("removed-runtime-id");
    assert.equal(result, undefined);
  });
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /removed-runtime-id/);
  assert.match(String(errors[0][0]), /battery/);
});

test("getDeviceById does not flood diagnostics for repeated stale invocations of the same id", () => {
  const { stub, errors } = createDriverStub([]);

  stub.getDeviceById("removed-runtime-id");
  stub.getDeviceById("removed-runtime-id");
  stub.getDeviceById("removed-runtime-id");

  assert.equal(errors.length, 1);
});

test("getDeviceById logs a distinct stale id separately (rate limit is per id, not global)", () => {
  const { stub, errors } = createDriverStub([]);

  stub.getDeviceById("removed-runtime-id-1");
  stub.getDeviceById("removed-runtime-id-2");

  assert.equal(errors.length, 2);
});

test("direct missing-id lookups never throw synchronously, whatever inherited SDK request triggers them (delete/rename/settings/capability)", () => {
  const { stub } = createDriverStub([]);

  for (const id of ["", "unicode-é-id", "a".repeat(200), "removed-runtime-id"]) {
    assert.doesNotThrow(() => stub.getDeviceById(id));
  }
});
