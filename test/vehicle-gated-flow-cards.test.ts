import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// Imports the built output; see device-oninit-no-product.test.ts for why.
import VehicleDriver from "../.homeybuild/drivers/vehicle/driver.js";

// app.json is the committed, generated manifest the driver-scoped cards in
// drivers/vehicle/driver.flow.compose.json compile into (see the note in
// vehicle-model-gating.test.ts).
const appManifest = JSON.parse(
  readFileSync(new URL("../app.json", import.meta.url), "utf8"),
);
const vehicleManifest = appManifest.drivers.find(
  (d: { id: string }) => d.id === "vehicle",
);

const TONNEAU_CARDS = [
  "trigger:windowcoverings_closed.tonneau_true",
  "trigger:windowcoverings_closed.tonneau_false",
  "condition:windowcoverings_closed.tonneau",
  "action:windowcoverings_closed.tonneau_close",
  "action:windowcoverings_closed.tonneau_open",
  "action:windowcoverings_closed.tonneau_toggle",
];
const SUNROOF_CARDS = TONNEAU_CARDS.map((card) =>
  card.replace("tonneau", "sunroof"),
);

// Real /api/metadata config for a Model 3 (no tonneau, no sunroof).
const MODEL_3_CONFIG = {
  can_accept_navigation_requests: true,
  can_actuate_trunks: true,
  cop_user_set_temp_supported: false,
  dashcam_clip_save_supported: true,
  has_seat_cooling: false,
  rear_seat_heaters: 1,
  rhd: true,
  sun_roof_installed: false,
  third_row_seats: false,
};

async function pairCandidate(vin: string, config: Record<string, unknown>) {
  const vehicles = {
    [vin]: {
      vin,
      name: "Test vehicle",
      metadata: {
        access: true,
        fleet_telemetry: "fleet_telemetry_config_id",
        polling: false,
        config,
      },
    },
  };
  const driver = Object.assign(new VehicleDriver(), {
    homey: {
      app: { products: { vehicles }, getProducts: async () => ({ vehicles }) },
      __: (key: string) => key,
    },
    manifest: vehicleManifest,
    log: () => {},
    error: () => {},
  });
  const [candidate] = await driver.onPairListDevices();
  return candidate as { capabilities: string[] };
}

// Homey's documented device-arg filter semantics: every `&`-joined clause
// must match, and a `|`-separated clause value matches if any alternative
// does. Only the clauses this app uses (driver_id, capabilities) are modelled.
function filterMatches(
  filter: string,
  driverId: string,
  capabilities: string[],
): boolean {
  return filter.split("&").every((clause) => {
    const [key, value] = clause.split("=");
    const alternatives = value.split("|");
    if (key === "driver_id") return alternatives.includes(driverId);
    if (key === "capabilities") {
      return alternatives.some((cap) => capabilities.includes(cap));
    }
    throw new Error(`unmodelled filter clause ${clause}`);
  });
}

function visibleGatedCards(capabilities: string[]): string[] {
  const visible: string[] = [];
  for (const [kind, cards] of [
    ["trigger", appManifest.flow.triggers],
    ["condition", appManifest.flow.conditions],
    ["action", appManifest.flow.actions],
  ] as const) {
    for (const card of cards as {
      id: string;
      args?: { type: string; filter?: string }[];
    }[]) {
      const key = `${kind}:${card.id}`;
      if (!TONNEAU_CARDS.includes(key) && !SUNROOF_CARDS.includes(key)) {
        continue;
      }
      const deviceArg = card.args?.find((a) => a.type === "device");
      assert.ok(deviceArg?.filter, `${key} has no device filter`);
      if (filterMatches(deviceArg.filter, "vehicle", capabilities)) {
        visible.push(key);
      }
    }
  }
  return visible;
}

test("a Model 3 without tonneau or sunroof is offered none of the tonneau/sunroof Flow cards", async () => {
  const candidate = await pairCandidate("LRW3F7EK4NC000001", MODEL_3_CONFIG);

  assert.deepEqual(visibleGatedCards(candidate.capabilities), []);
});

test("a Cybertruck is offered the tonneau Flow cards but not the sunroof ones", async () => {
  const candidate = await pairCandidate("7G2CEHED0RA000001", {
    ...MODEL_3_CONFIG,
    sun_roof_installed: false,
  });

  assert.deepEqual(
    visibleGatedCards(candidate.capabilities).sort(),
    [...TONNEAU_CARDS].sort(),
  );
});

test("a vehicle with a sunroof is offered the sunroof Flow cards but not the tonneau ones", async () => {
  const candidate = await pairCandidate("5YJSA1E2XJF000001", {
    ...MODEL_3_CONFIG,
    sun_roof_installed: true,
  });

  assert.deepEqual(
    visibleGatedCards(candidate.capabilities).sort(),
    [...SUNROOF_CARDS].sort(),
  );
});
