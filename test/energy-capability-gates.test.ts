import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import PowerwallDriver from "../.homeybuild/drivers/battery/driver.js";
import GatewayDriver from "../.homeybuild/drivers/gateway/driver.js";
import SolarDriver from "../.homeybuild/drivers/solar/driver.js";
import WallConnectorDriver from "../.homeybuild/drivers/wall-connector/driver.js";
import PowerwallDevice from "../.homeybuild/drivers/battery/device.js";

// app.json is the committed, generated manifest (see vehicle-model-gating.test.ts).
const appManifest = JSON.parse(
  readFileSync(new URL("../app.json", import.meta.url), "utf8"),
);
const driverManifest = (id: string) =>
  appManifest.drivers.find((driver: { id: string }) => driver.id === id);
const BATTERY_MANIFEST = driverManifest("battery");

const GATED = [
  "off_grid_vehicle_charging_reserve",
  "allow_export",
  "onoff.charge_grid",
  "onoff.storm",
];

// The captain's real Powerwall 3 site ("Moorinya") site_info components.
const REAL_PW3_COMPONENTS = {
  battery: true,
  battery_type: "ac_powerwall",
  solar: true,
  solar_type: "pv_panel",
  grid: true,
  load_meter: true,
  gateway: "taco",
  storm_mode_capable: true,
  off_grid_vehicle_charging_reserve_supported: false,
  customer_preferred_export_rule: "battery_ok",
  wall_connectors: [],
};
const NO_SOLAR_COMPONENTS = {
  ...REAL_PW3_COMPONENTS,
  solar: false,
  solar_type: undefined,
  off_grid_vehicle_charging_reserve_supported: true,
};
const NOT_STORM_CAPABLE_COMPONENTS = {
  ...REAL_PW3_COMPONENTS,
  storm_mode_capable: false,
};
const WALL_CONNECTOR_ONLY_COMPONENTS = {
  battery: false,
  solar: false,
  grid: false,
  load_meter: false,
  storm_mode_capable: false,
  off_grid_vehicle_charging_reserve_supported: false,
  wall_connectors: [{ din: "1457768-02-G--WC-1", part_name: "Gen 3 Wall Connector" }],
};

function pair<T extends { onPairListDevices(): Promise<unknown[]> }>(
  Driver: new () => T,
  manifestId: string,
  components: Record<string, unknown>,
) {
  // Numeric site id, as on the wire and in EnergyDetails.
  const site = {
    id: 2533979794926773,
    name: "Moorinya",
    metadata: { access: true },
    api: { getSiteInfo: async () => ({ response: { components } }) },
  };
  const driver = Object.assign(new Driver(), {
    manifest: driverManifest(manifestId),
    homey: {
      app: { getProducts: async () => ({ energySites: { [site.id]: site } }) },
    },
    getDevices: () => [] as unknown[],
    log: () => {},
    error: () => {},
  });
  return driver.onPairListDevices() as Promise<
    Array<{ name: string; capabilities?: string[] }>
  >;
}

/** Homey's `$filter`: the card's driver matches and every listed capability is present. */
function visibleBatteryCards(capabilities: string[]) {
  const visible: string[] = [];
  for (const [kind, cards] of Object.entries(appManifest.flow) as Array<
    [string, Array<{ id: string; args?: Array<{ type: string; filter?: string }> }>]
  >) {
    for (const card of cards) {
      const filter = card.args?.find((arg) => arg.type === "device")?.filter;
      if (!filter) continue;
      const params = new URLSearchParams(filter);
      const driverId = params.get("driver_id");
      if (driverId && driverId !== "battery") continue;
      const required = params.get("capabilities")?.split("|");
      if (!driverId && !required) continue;
      if (required && !required.every((cap) => capabilities.includes(cap))) continue;
      visible.push(`${kind}:${card.id}`);
    }
  }
  return visible;
}

test("R5: the real Powerwall 3 site is paired without the off-grid vehicle charging reserve it doesn't support", async () => {
  const [candidate] = await pair(PowerwallDriver, "battery", REAL_PW3_COMPONENTS);

  assert.ok(candidate.capabilities, "pairing sets an explicit capability list");
  assert.deepEqual(
    GATED.filter((cap) => candidate.capabilities!.includes(cap)),
    ["allow_export", "onoff.charge_grid", "onoff.storm"],
  );

  const cards = visibleBatteryCards(candidate.capabilities!);
  assert.ok(!cards.includes("actions:set_off_grid_vehicle_charging_reserve"));
  assert.ok(!cards.includes("triggers:off_grid_vehicle_charging_reserve_changed"));
  assert.ok(cards.includes("actions:set_allow_export"));
  assert.ok(cards.includes("actions:onoff.storm_on"));
});

test("R5: a battery site with no solar is paired without charge-from-grid or the export rule", async () => {
  const [candidate] = await pair(PowerwallDriver, "battery", NO_SOLAR_COMPONENTS);

  assert.deepEqual(
    GATED.filter((cap) => candidate.capabilities!.includes(cap)),
    ["off_grid_vehicle_charging_reserve", "onoff.storm"],
  );
  const cards = visibleBatteryCards(candidate.capabilities!);
  for (const card of [
    "actions:set_allow_export",
    "actions:onoff.charge_grid_on",
    "actions:onoff.charge_grid_off",
    "actions:onoff.charge_grid_toggle",
    "triggers:onoff.charge_grid_true",
    "conditions:onoff.charge_grid",
  ]) {
    assert.ok(!cards.includes(card), `${card} hidden`);
  }
});

test("R5: a site that isn't storm-mode capable is paired without storm mode or its Flow cards", async () => {
  const [candidate] = await pair(PowerwallDriver, "battery", NOT_STORM_CAPABLE_COMPONENTS);

  assert.ok(!candidate.capabilities!.includes("onoff.storm"));
  const cards = visibleBatteryCards(candidate.capabilities!);
  for (const card of ["actions:onoff.storm_on", "actions:onoff.storm_off", "triggers:onoff.storm_true"]) {
    assert.ok(!cards.includes(card), `${card} hidden`);
  }
});

test("R5: every non-gated manifest capability is still offered", async () => {
  const [candidate] = await pair(PowerwallDriver, "battery", NO_SOLAR_COMPONENTS);
  assert.deepEqual(
    candidate.capabilities!.filter((cap) => !GATED.includes(cap)),
    BATTERY_MANIFEST.capabilities.filter((cap: string) => !GATED.includes(cap)),
  );
});

test("R6: a Wall-Connector-only site yields no Gateway, Powerwall or Solar, only its Wall Connector", async () => {
  assert.deepEqual(await pair(GatewayDriver, "gateway", WALL_CONNECTOR_ONLY_COMPONENTS), []);
  assert.deepEqual(await pair(PowerwallDriver, "battery", WALL_CONNECTOR_ONLY_COMPONENTS), []);
  assert.deepEqual(await pair(SolarDriver, "solar", WALL_CONNECTOR_ONLY_COMPONENTS), []);
  assert.equal(
    (await pair(WallConnectorDriver, "wall-connector", WALL_CONNECTOR_ONLY_COMPONENTS)).length,
    1,
  );
});

test("R6: a Gateway is still offered for a battery-only or solar-only site", async () => {
  assert.equal((await pair(GatewayDriver, "gateway", NO_SOLAR_COMPONENTS)).length, 1);
  assert.equal(
    (await pair(GatewayDriver, "gateway", { solar: true, battery: false })).length,
    1,
  );
});

class FakeEnergySiteStream extends EventEmitter {
  siteInfoDocument: Record<string, unknown> | undefined;
}

function createDevice(
  initialCapabilities: string[],
  siteInfoDocument: Record<string, unknown> | undefined,
) {
  const capabilities = new Set(initialCapabilities);
  const added: string[] = [];
  const removed: string[] = [];
  const apiCalls: string[] = [];
  const sse = new FakeEnergySiteStream();
  sse.siteInfoDocument = siteInfoDocument;
  const api = new Proxy(
    {},
    {
      get: (_target, method: string) => () => {
        apiCalls.push(method);
        return Promise.resolve();
      },
    },
  );
  const capabilityListeners: Record<string, (value: unknown) => Promise<void>> = {};
  const device = Object.assign(Object.create(PowerwallDevice.prototype), {
    homey: {
      app: {
        products: {
          energySites: { "2533979794926773": { id: 2533979794926773, api, sse, metadata: { access: true } } },
        },
      },
      __: (key: string) => key,
      flow: { getDeviceTriggerCard: () => ({ trigger: async () => {} }) },
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
    driver: { manifest: BATTERY_MANIFEST, getDevices: () => [device] },
    getData: () => ({ id: 2533979794926773 }),
    getCapabilities: () => [...capabilities],
    hasCapability: (cap: string) => capabilities.has(cap),
    addCapability: async (cap: string) => {
      added.push(cap);
      capabilities.add(cap);
    },
    removeCapability: async (cap: string) => {
      removed.push(cap);
      capabilities.delete(cap);
    },
    getCapabilityValue: () => null,
    setCapabilityValue: async () => {},
    setCapabilityOptions: async () => {},
    registerCapabilityListener: (cap: string, listener: (value: unknown) => Promise<void>) => {
      capabilityListeners[cap] = listener;
    },
    getStoreValue: () => null,
    setStoreValue: async () => {},
    setUnavailable: async () => {},
    setAvailable: async () => {},
    log: () => {},
    error: () => {},
  });
  return { device, added, removed, apiCalls, capabilityListeners };
}

const withoutGated = (except: string[] = []) =>
  BATTERY_MANIFEST.capabilities.filter(
    (cap: string) => !GATED.includes(cap) || except.includes(cap),
  );

test("app start doesn't re-add a capability pairing gated out for this site", async () => {
  const paired = withoutGated(["allow_export", "onoff.charge_grid", "onoff.storm"]);
  const { device, added, removed } = createDevice(paired, {
    components: REAL_PW3_COMPONENTS,
  });

  await device.ensureCapabilities();

  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
});

test("app start doesn't add gated capabilities while the site's components are still unknown", async () => {
  const { device, added } = createDevice(withoutGated(), undefined);

  await device.ensureCapabilities();

  assert.deepEqual(added, []);
});

test("app start adds a gated capability once the site's components say it's supported", async () => {
  const { device, added } = createDevice(withoutGated(), { components: NO_SOLAR_COMPONENTS });

  await device.ensureCapabilities();

  assert.deepEqual(added.sort(), ["off_grid_vehicle_charging_reserve", "onoff.storm"]);
});

test("an already-paired device loses the gated capabilities its site says are unsupported", async () => {
  for (const [components, expected] of [
    [REAL_PW3_COMPONENTS, ["off_grid_vehicle_charging_reserve"]],
    [NO_SOLAR_COMPONENTS, ["allow_export", "onoff.charge_grid"]],
    [NOT_STORM_CAPABLE_COMPONENTS, ["off_grid_vehicle_charging_reserve", "onoff.storm"]],
  ] as const) {
    const { device, added, removed } = createDevice(BATTERY_MANIFEST.capabilities, { components });

    await device.ensureCapabilities();

    assert.deepEqual(removed.sort(), [...expected].sort());
    assert.deepEqual(added, []);
  }
});

test("the real Powerwall 3 site_info, which omits the off-grid reserve flag, removes it", async () => {
  const { off_grid_vehicle_charging_reserve_supported: _, ...components } = REAL_PW3_COMPONENTS;
  const { device, removed } = createDevice(BATTERY_MANIFEST.capabilities, { components });

  await device.ensureCapabilities();

  assert.deepEqual(removed, ["off_grid_vehicle_charging_reserve"]);
});

test("an already-paired device keeps every gated capability while its site's components are unknown", async () => {
  for (const siteInfo of [
    undefined,
    {},
    { components: {} },
    // Every boolean null, as when the server can't read the site (H18's shape).
    { components: { battery: null, solar: null, storm_mode_capable: null, off_grid_vehicle_charging_reserve_supported: null } },
  ]) {
    const { device, added, removed } = createDevice(BATTERY_MANIFEST.capabilities, siteInfo);

    await device.ensureCapabilities();

    assert.deepEqual(removed, [], JSON.stringify(siteInfo));
    assert.deepEqual(added, [], JSON.stringify(siteInfo));
  }
});

test("a device bound before its site_info arrived drops the unsupported capabilities when it does", async () => {
  const { device, removed } = createDevice(BATTERY_MANIFEST.capabilities, undefined);
  await device.onInit();
  assert.deepEqual(removed, []);

  const { sse } = device.homey.app.products.energySites["2533979794926773"];
  sse.siteInfoDocument = { components: REAL_PW3_COMPONENTS };
  sse.emit("site_info", {});
  await device.capabilityReconcile;

  assert.deepEqual(removed, ["off_grid_vehicle_charging_reserve"]);

  // A later identical site_info has nothing left to reconcile.
  sse.emit("site_info", {});
  await device.capabilityReconcile;
  assert.deepEqual(removed, ["off_grid_vehicle_charging_reserve"]);
});

test("an already-paired device rejects commands its site's hardware can't honour, without sending them", async () => {
  const { device, apiCalls, capabilityListeners } = createDevice(BATTERY_MANIFEST.capabilities, {
    components: { ...NO_SOLAR_COMPONENTS, storm_mode_capable: false, off_grid_vehicle_charging_reserve_supported: false },
  });
  await device.onInit();

  for (const [capability, value] of [
    ["off_grid_vehicle_charging_reserve", 0.2],
    ["allow_export", "never"],
    ["onoff.charge_grid", false],
    ["onoff.storm", true],
  ] as const) {
    await assert.rejects(
      () => capabilityListeners[capability](value),
      /error\.energy_site_feature_unsupported/,
      capability,
    );
  }
  await assert.rejects(
    () => device.flowSetOffGridVehicleChargingReserve(20),
    /error\.energy_site_feature_unsupported/,
  );
  await assert.rejects(
    () => device.flowSetAllowExport("never"),
    /error\.energy_site_feature_unsupported/,
  );
  assert.deepEqual(apiCalls, []);

  await capabilityListeners.backup_reserve(0.3);
  assert.deepEqual(apiCalls, ["setBackupReserve"]);
});

test("commands still go through on a site that supports them, and while components are unknown", async () => {
  for (const siteInfo of [{ components: REAL_PW3_COMPONENTS }, undefined]) {
    const { device, apiCalls, capabilityListeners } = createDevice(BATTERY_MANIFEST.capabilities, siteInfo);
    await device.onInit();

    await capabilityListeners["onoff.storm"](true);
    await capabilityListeners.allow_export("never");
    await device.flowSetAllowExport("pv_only");
    assert.deepEqual(apiCalls, ["setStormMode", "gridImportExport", "gridImportExport"]);
  }
});
