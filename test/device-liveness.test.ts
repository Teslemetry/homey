import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import TeslemetryDevice from "../.homeybuild/lib/TeslemetryDevice.js";

function createDeviceStub() {
  let devices: unknown[] = [];
  const stub = Object.assign(new TeslemetryDevice(), {
    driver: { getDevices: () => devices },
  }) as unknown as { isLive(): boolean; destroyed: boolean; onUninit(): Promise<void> };
  return { stub, setDevices: (d: unknown[]) => { devices = d; } };
}

test("isLive() is true while not destroyed and still registered in driver.getDevices()", () => {
  const { stub, setDevices } = createDeviceStub();
  setDevices([stub]);

  assert.equal(stub.isLive(), true);
});

test("isLive() is false once onUninit() has set destroyed", async () => {
  const { stub, setDevices } = createDeviceStub();
  setDevices([stub]);

  await stub.onUninit();

  assert.equal(stub.isLive(), false);
});

test("isLive() is false once the SDK removes this instance from the driver map, even before onUninit() runs", () => {
  // Apps SDK v3's actual deletion order removes the device from the driver's
  // runtime map, then awaits _onDeleted()/onUninit() - destroyed is still
  // false in that gap. Modeling the real ordering (map removal first, not a
  // direct early onUninit() call) is what PR #26's regression test missed.
  const { stub, setDevices } = createDeviceStub();
  setDevices([stub]);
  setDevices([]);

  assert.equal(stub.destroyed, false);
  assert.equal(stub.isLive(), false);
});

test("isLive() does not affect an unrelated live device still in the driver map", () => {
  const { stub: staleStub } = createDeviceStub();
  const liveDevices: unknown[] = [];
  const liveStub = Object.assign(new TeslemetryDevice(), {
    driver: { getDevices: () => liveDevices },
  }) as unknown as { isLive(): boolean };
  liveDevices.push(liveStub);

  assert.equal(liveStub.isLive(), true);
  assert.equal((staleStub as unknown as { isLive(): boolean }).isLive(), false);
});
