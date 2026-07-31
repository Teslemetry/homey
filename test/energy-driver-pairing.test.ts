import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import PowerwallDriver from "../.homeybuild/drivers/battery/driver.js";
import SolarDriver from "../.homeybuild/drivers/solar/driver.js";
import GatewayDriver from "../.homeybuild/drivers/gateway/driver.js";
import WallConnectorDriver from "../.homeybuild/drivers/wall-connector/driver.js";

function createSite(
  id: string,
  name: string,
  access: boolean,
  getSiteInfo: () => Promise<unknown>,
) {
  return {
    id,
    name,
    metadata: { access },
    api: { getSiteInfo },
  };
}

function createDriverStub<T>(
  Driver: new () => T,
  sites: ReturnType<typeof createSite>[],
) {
  const energySites: Record<string, unknown> = {};
  for (const site of sites) energySites[site.id] = site;

  const errors: unknown[] = [];
  return {
    driver: Object.assign(new Driver(), {
      homey: {
        app: {
          products: { energySites },
          getProducts: async () => ({ energySites }),
        },
      },
      getDevices: () => [] as unknown[],
      log: () => {},
      error: (message: unknown) => {
        errors.push(message);
      },
    }),
    errors,
  };
}

test("PowerwallDriver.onPairListDevices returns the healthy site when another site's getSiteInfo() rejects", async () => {
  const { driver, errors } = createDriverStub(PowerwallDriver, [
    createSite("site-1", "Home Battery", true, async () => ({
      response: { components: { battery: true } },
    })),
    createSite("site-2", "Broken Site", true, async () => {
      throw new Error("upstream 500");
    }),
  ]);

  const result = await driver.onPairListDevices();

  assert.deepEqual(result, [
    { name: "Home Battery Powerwall", data: { id: "site-1" }, class: "battery" },
  ]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /skipped 1\/2 energy site\(s\)/);
  assert.match(String(errors[0]), /site-2/);
});

test("PowerwallDriver.onPairListDevices excludes an inaccessible site without calling its getSiteInfo()", async () => {
  let calledInaccessible = false;
  const { driver, errors } = createDriverStub(PowerwallDriver, [
    createSite("site-1", "Home Battery", true, async () => ({
      response: { components: { battery: true } },
    })),
    createSite("site-2", "No Access", false, async () => {
      calledInaccessible = true;
      return { response: { components: { battery: true } } };
    }),
  ]);

  const result = await driver.onPairListDevices();

  assert.deepEqual(result, [
    { name: "Home Battery Powerwall", data: { id: "site-1" }, class: "battery" },
  ]);
  assert.equal(calledInaccessible, false);
  assert.equal(errors.length, 0);
});

test("SolarDriver.onPairListDevices isolates a per-site failure and still returns the healthy solar site", async () => {
  const { driver, errors } = createDriverStub(SolarDriver, [
    createSite("site-1", "Broken Site", true, async () => {
      throw new Error("network timeout");
    }),
    createSite("site-2", "Home Solar", true, async () => ({
      response: { components: { solar: true } },
    })),
  ]);

  const result = await driver.onPairListDevices();

  assert.deepEqual(result, [
    { name: "Home Solar Solar", data: { id: "site-2" }, class: "solarpanel" },
  ]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /site-1/);
});

test("GatewayDriver.onPairListDevices isolates a per-site failure and still returns the healthy gateway site", async () => {
  const { driver, errors } = createDriverStub(GatewayDriver, [
    createSite("site-1", "Home Gateway", true, async () => ({ response: {} })),
    createSite("site-2", "Broken Site", true, async () => {
      throw new Error("account revoked");
    }),
  ]);

  const result = await driver.onPairListDevices();

  assert.deepEqual(result, [
    { name: "Home Gateway Gateway", data: { id: "site-1" }, class: "sensor" },
  ]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /site-2/);
});

test("WallConnectorDriver.onPairListDevices isolates a per-site failure and still returns the healthy site's connectors", async () => {
  const { driver, errors } = createDriverStub(WallConnectorDriver, [
    createSite("site-1", "Broken Site", true, async () => {
      throw new Error("insufficient access");
    }),
    createSite("site-2", "Home", true, async () => ({
      response: {
        components: {
          wall_connectors: [{ din: "din-1", part_name: "Wall Connector" }],
        },
      },
    })),
  ]);

  const result = await driver.onPairListDevices();

  assert.deepEqual(result, [
    { name: "Home Wall Connector", data: { site: "site-2", din: "din-1" } },
  ]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /site-1/);
});

test("all four energy drivers return every healthy candidate when every site fails or lacks access", async () => {
  const failingSites = [
    createSite("site-1", "No Access", false, async () => {
      throw new Error("should not be called");
    }),
    createSite("site-2", "Broken Site", true, async () => {
      throw new Error("upstream 500");
    }),
  ];

  for (const Driver of [PowerwallDriver, SolarDriver, GatewayDriver, WallConnectorDriver]) {
    const { driver, errors } = createDriverStub(Driver, failingSites);
    const result = await driver.onPairListDevices();
    assert.deepEqual(result, []);
    assert.equal(errors.length, 1, `${Driver.name} should log exactly one partial-failure diagnostic`);
  }
});
