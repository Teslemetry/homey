import test from "node:test";
import assert from "node:assert/strict";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import PowerwallDriver from "../.homeybuild/drivers/battery/driver.js";
import SolarDriver from "../.homeybuild/drivers/solar/driver.js";
import GatewayDriver from "../.homeybuild/drivers/gateway/driver.js";
import WallConnectorDriver from "../.homeybuild/drivers/wall-connector/driver.js";
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";
import SolarDevice from "../.homeybuild/drivers/solar/device.js";
import GatewayDevice from "../.homeybuild/drivers/gateway/device.js";

function createSite(
  id: string | number,
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
  getProducts: () => Promise<unknown> = async () => ({
    energySites: Object.fromEntries(sites.map((site) => [site.id, site])),
  }),
) {
  const energySites: Record<string, unknown> = {};
  for (const site of sites) energySites[site.id] = site;

  const errors: unknown[] = [];
  const logs: unknown[] = [];
  return {
    driver: Object.assign(new Driver(), {
      homey: {
        app: {
          products: { energySites },
          getProducts,
        },
      },
      getDevices: () => [] as unknown[],
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

test("energy-site drivers keep pairing data.id as the SDK's real numeric type, not stringified", async () => {
  // EnergyDetails.id is `number` in @teslemetry/api. Pairing `data` is
  // Homey's immutable device identity - stringifying it here would change
  // an already-paired device's identity shape across an app update, making
  // Homey's pairing dedup treat it as unpaired and offer a duplicate.
  const numericSite = (getSiteInfo: () => Promise<unknown>) =>
    createSite(123, "Numeric Site", true, getSiteInfo);

  const { driver: batteryDriver } = createDriverStub(PowerwallDriver, [
    numericSite(async () => ({ response: { components: { battery: true } } })),
  ]);
  const batteryResult = await batteryDriver.onPairListDevices();
  assert.deepEqual(batteryResult, [
    { name: "Numeric Site Powerwall", data: { id: 123 }, class: "battery" },
  ]);
  assert.equal(typeof batteryResult[0].data.id, "number");

  const { driver: solarDriver } = createDriverStub(SolarDriver, [
    numericSite(async () => ({ response: { components: { solar: true } } })),
  ]);
  const solarResult = await solarDriver.onPairListDevices();
  assert.deepEqual(solarResult, [
    { name: "Numeric Site Solar", data: { id: 123 }, class: "solarpanel" },
  ]);
  assert.equal(typeof solarResult[0].data.id, "number");

  const { driver: gatewayDriver } = createDriverStub(GatewayDriver, [
    numericSite(async () => ({ response: {} })),
  ]);
  const gatewayResult = await gatewayDriver.onPairListDevices();
  assert.deepEqual(gatewayResult, [
    { name: "Numeric Site Gateway", data: { id: 123 }, class: "sensor" },
  ]);
  assert.equal(typeof gatewayResult[0].data.id, "number");

  const { driver: wcDriver } = createDriverStub(WallConnectorDriver, [
    numericSite(async () => ({
      response: { components: { wall_connectors: [{ din: "din-1", part_name: "Wall Connector" }] } },
    })),
  ]);
  const wcResult = await wcDriver.onPairListDevices();
  assert.deepEqual(wcResult, [
    { name: "Numeric Site Wall Connector", data: { site: 123, din: "din-1" } },
  ]);
  assert.equal(typeof wcResult[0].data.site, "number");
});

test("PowerwallDevice.getSiteId always returns a string even when the immutable pairing data holds a numeric id", () => {
  const stub = Object.assign(Object.create(PowerwallDevice.prototype), {
    getData: () => ({ id: 123 }),
  });

  assert.equal(stub.getSiteId(), "123");
  assert.equal(typeof stub.getSiteId(), "string");
});

test("SolarDevice.getSiteId always returns a string even when the immutable pairing data holds a numeric id", () => {
  const stub = Object.assign(Object.create(SolarDevice.prototype), {
    getData: () => ({ id: 123 }),
  });

  assert.equal(stub.getSiteId(), "123");
  assert.equal(typeof stub.getSiteId(), "string");
});

test("GatewayDevice.getSiteId always returns a string even when the immutable pairing data holds a numeric id", () => {
  const stub = Object.assign(Object.create(GatewayDevice.prototype), {
    getData: () => ({ id: 123 }),
  });

  assert.equal(stub.getSiteId(), "123");
  assert.equal(typeof stub.getSiteId(), "string");
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

test("every energy driver tags a missing-products pairing failure with the products_fetch stage", async () => {
  for (const Driver of [PowerwallDriver, SolarDriver, GatewayDriver, WallConnectorDriver]) {
    const { driver, errors } = createDriverStub(Driver, [], async () => undefined);

    await assert.rejects(() => driver.onPairListDevices());
    assert.equal(errors.length, 1, `${Driver.name} should log exactly one products_fetch diagnostic`);
    assert.match(String(errors[0]), /pairing\[stage=products_fetch\]/);
  }
});

test("listEnergySiteCandidates logs a filtering-stage line with the accessible/total site counts", async () => {
  const { driver, logs } = createDriverStub(PowerwallDriver, [
    createSite("site-1", "Home Battery", true, async () => ({
      response: { components: { battery: true } },
    })),
    createSite("site-2", "No Access", false, async () => ({
      response: { components: { battery: true } },
    })),
  ]);

  await driver.onPairListDevices();

  assert.ok(
    logs.some((line) => /pairing\[stage=filtering\]: 1\/2 energy site\(s\) accessible/.test(String(line))),
  );
});

test("TeslemetryDriver.onPair's list_devices handler logs session/products_fetch/render_handoff stages end to end", async () => {
  const { driver, logs, errors } = createDriverStub(PowerwallDriver, [
    createSite("site-1", "Home Battery", true, async () => ({
      response: { components: { battery: true } },
    })),
  ]);

  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const session = {
    setHandler: (name: string, handler: (...args: unknown[]) => unknown) => {
      handlers[name] = handler;
    },
  };

  await driver.onPair(session);
  const result = await handlers["list_devices"]();

  assert.deepEqual(result, [
    { name: "Home Battery Powerwall", data: { id: "site-1" }, class: "battery" },
  ]);
  assert.ok(logs.some((line) => /pairing\[stage=session_start\]/.test(String(line))));
  assert.ok(logs.some((line) => /pairing\[stage=products_fetch\]: list_devices requested/.test(String(line))));
  assert.ok(logs.some((line) => /pairing\[stage=render_handoff\]: returning 1 candidate\(s\)/.test(String(line))));
  assert.equal(errors.length, 0);
});

test("TeslemetryDriver.onPair's list_devices handler logs a list_devices-stage failure when onPairListDevices rejects", async () => {
  const { driver, errors } = createDriverStub(PowerwallDriver, [], async () => undefined);

  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const session = {
    setHandler: (name: string, handler: (...args: unknown[]) => unknown) => {
      handlers[name] = handler;
    },
  };

  await driver.onPair(session);
  await assert.rejects(() => handlers["list_devices"]());

  assert.ok(
    errors.some((line) => /pairing\[stage=list_devices\]: onPairListDevices failed/.test(String(line))),
  );
});
