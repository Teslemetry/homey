import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";

function createDeviceStub(capabilities: Record<string, unknown> = {}) {
  const api = Object.assign(new EventEmitter(), {
    requestPolling: () => () => {},
  });
  const stub = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app: { products: { energySites: { "site-1": { api } } } },
      __: (key: string) => key,
    },
    driver: {
      manifest: { capabilities: Object.keys(capabilities), capabilitiesOptions: {} },
    },
    getData: () => ({ id: "site-1" }),
    getCapabilities: () => Object.keys(capabilities),
    getCapabilityValue: (capability: string) => capabilities[capability],
    setCapabilityValue: async (capability: string, value: unknown) => {
      capabilities[capability] = value;
    },
    setCapabilityOptions: async () => {},
    registerCapabilityListener: () => {},
    log: () => {},
    error: () => {},
  });
  return { stub, api, capabilities };
}

test("PowerwallDevice maps siteInfo tariff_id onto the tariff_plan capability", async () => {
  const { stub, api, capabilities } = createDeviceStub({ tariff_plan: null });
  await stub.onInit();

  api.emit("siteInfo", { response: { tariff_id: "PGE-EV2-A" } });

  assert.equal(capabilities.tariff_plan, "PGE-EV2-A");
});

test("PowerwallDevice does not overwrite tariff_plan when siteInfo omits tariff_id", async () => {
  const { stub, api, capabilities } = createDeviceStub({
    tariff_plan: "PGE-EV2-A",
  });
  await stub.onInit();

  api.emit("siteInfo", { response: {} });

  assert.equal(capabilities.tariff_plan, "PGE-EV2-A");
});
