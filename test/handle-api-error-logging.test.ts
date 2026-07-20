import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryDevice from "../.homeybuild/lib/TeslemetryDevice.js";

function createDeviceStub() {
  const loggedErrors: unknown[][] = [];
  // handleApiError is an arrow-function class field, so it's only assigned
  // by the real constructor - a bare Object.create(prototype) stub (as
  // used elsewhere for prototype methods) wouldn't have it.
  const stub = Object.assign(new TeslemetryDevice(), {
    homey: { __: (key: string) => key },
    error: (...args: unknown[]) => {
      loggedErrors.push(args);
    },
    setUnavailable: async () => {},
  });
  return { stub, loggedErrors };
}

test("JSON.stringify(Error) is '{}' and error_description is undefined (reproduces the bug)", () => {
  const err = new Error("boom");
  assert.equal(JSON.stringify(err), "{}");
  assert.equal((err as unknown as { error_description?: string }).error_description, undefined);
  assert.equal(new Error(undefined).message, "");
});

test("handleApiError logs a plain Error's name and message instead of '{}'", () => {
  const { stub, loggedErrors } = createDeviceStub();
  const err = new Error("network unreachable");

  assert.throws(() => stub.handleApiError(err), err);

  assert.equal(loggedErrors.length, 1);
  const [message] = loggedErrors[0];
  assert.equal(message, "API Error: Error: network unreachable");
});

test("handleApiError rethrows the same Error instance instead of a blank-message wrapper", () => {
  const { stub } = createDeviceStub();
  const err = new Error("network unreachable");

  try {
    stub.handleApiError(err);
    assert.fail("expected handleApiError to throw");
  } catch (thrown) {
    assert.equal(thrown, err);
    assert.equal((thrown as Error).message, "network unreachable");
  }
});

test("handleApiError still logs the server error shape correctly", () => {
  const { stub, loggedErrors } = createDeviceStub();
  const apiError = {
    response: null,
    error: "invalid_refresh_token",
    error_description: "Invalid refresh token",
  };

  assert.throws(() => stub.handleApiError(apiError));

  const [message, payload] = loggedErrors[0];
  assert.equal(message, "API Error:");
  assert.equal(payload, JSON.stringify(apiError));
});
