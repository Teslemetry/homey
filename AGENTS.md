## Project Overview

Homey app for Teslemetry. Provides real-time control and monitoring of Tesla vehicles and energy products (Powerwall, Solar, Wall Connector, Gateway) using Server-Sent Events (no polling).

## Commands

```bash
npm run build           # Compile TypeScript to .homeybuild/
npm test                # Build, then run test/*.test.ts with Node's built-in test runner
npm run lint            # oxlint check (see .oxlintrc.json)
npm run dev             # Run app on local Homey
npm run app:validate    # Validate app (required before commit)
```

Always run `npm run app:validate` before committing changes.

### Testing

`npm test` runs against the **compiled output** in `.homeybuild/`, not the
TypeScript sources directly - Node's native TS support strips types but
doesn't resolve TS-style `.js`-extension imports to their `.ts` source or
elide type-only named imports the way `tsc` does, so it can't load the
source files' full import graph. `test/support/loader.mjs` stubs the
`homey` SDK import (it only resolves to real classes inside the actual
Homey runtime) so device/driver classes can be exercised directly via
their prototypes without a live Homey instance.

## Architecture

### Core Files

- `app.ts` - Main entry point. Initializes OAuth2 client and Teslemetry SDK connection. Manages `Products` instance containing all vehicles/energy sites.
- `api.ts` - OAuth status and token revocation endpoints
- `lib/TeslemetryOAuth2Client.ts` - PKCE OAuth2 flow, token storage/refresh
- `lib/TeslemetryDriver.ts` - Base driver class with OAuth2 pairing/repair flow
- `lib/TeslemetryDevice.ts` - Base device class with capability sync

### Driver Pattern

Each device type (vehicle, battery, solar, gateway, wall-connector) follows the same structure:
- `drivers/<type>/driver.ts` - Extends `TeslemetryDriver`, implements `onPairListDevices()`
- `drivers/<type>/device.ts` - Extends `TeslemetryDevice`, registers signal handlers and capability listeners

### Data Flow

1. `TeslemetryApp` creates `Products` from `@teslemetry/api`
2. Devices get their product instance (e.g., `this.homey.app.products.vehicles[vin]`)
3. Incoming data: `vehicle.sse.onSignal("SignalName", callback)` → `this.update(capability, value)`
4. Outgoing commands: `registerCapabilityListener` → `vehicle.api.methodName()`

### Homey Compose

Configuration lives in `.homeycompose/` - this generates `app.json` at build time:
- `.homeycompose/app.json` - Base app manifest (edit this, not `app.json`)
- `.homeycompose/capabilities/` - Custom capability definitions (base capabilities only, NOT subcapabilities)
- `.homeycompose/flow/` - Flow card definitions (triggers, actions)
- `.homeycompose/drivers/` - Driver capability configurations
- `drivers/<type>/driver.flow.compose.json` - Driver-specific flow cards (triggers, conditions, actions)

### Subcapability Flow Cards

Homey does **not** auto-generate flow cards for subcapabilities (e.g., `alarm_generic.off_grid`, `onoff.charge_grid`). You must define them manually in `drivers/<type>/driver.flow.compose.json`. Do **not** create files like `.homeycompose/capabilities/alarm_generic.off_grid.json` — the `.` in capability names is reserved and will fail validation.

Use the subcapability ID in the flow card ID following the pattern `<capability>.<sub>_<state>`:

```json
{
  "triggers": [
    {
      "id": "alarm_generic.off_grid_true",
      "title": { "en": "Grid power lost" }
    },
    {
      "id": "alarm_generic.off_grid_false",
      "title": { "en": "Grid power restored" }
    }
  ],
  "actions": [
    {
      "id": "onoff.charge_grid_on",
      "title": { "en": "Enable charge from grid" }
    }
  ]
}
```

ID patterns by capability type:
- **Boolean triggers** (`alarm_generic`, `onoff`): `<cap>.<sub>_true`, `<cap>.<sub>_false`
- **On/off actions**: `<cap>.<sub>_on`, `<cap>.<sub>_off`, `<cap>.<sub>_toggle`

### Flow Card Device Filters

All app-level flow cards in `.homeycompose/flow/` **must** include an `args` entry with a device `filter` so cards only appear for users who have a device with the relevant capability. Without this, energy-only users see vehicle cards and vice versa. Verified apps also require `titleFormatted`.

```json
{
  "title": { "en": "Steering wheel heater changed" },
  "titleFormatted": { "en": "Steering wheel heater changed on [[device]]" },
  "args": [
    {
      "type": "device",
      "name": "device",
      "filter": "capabilities=steering_wheel_heater",
      "title": { "en": "Device" }
    }
  ]
}
```

### App-Level vs Driver-Scoped Flow Cards

A capability ID is not unique across drivers (`measure_power` exists on Solar,
Gateway, and Powerwall). An app-level card's device `filter` matches by
capability ID alone, so `capabilities=measure_power` would show a Solar
threshold card on Gateway and Powerwall devices too. When a card must be
scoped to one exact driver/capability pair, define it in that driver's
`driver.flow.compose.json` instead - Homey Compose auto-unshifts a `device`
arg filtered by `driver_id` (see `HomeyCompose.js`'s driver `$flow` merge),
so the source JSON must not declare its own `device` arg. That auto-injected
device arg carries no `title`, so a driver-scoped card's `titleFormatted`
must not reference `[[device]]` (`homey app validate` rejects it) - word the
sentence around the other args only, e.g. `"Rises above [[watts]] W"`.
`titleFormatted` is otherwise required by the verified level for any card
with args beyond `device`, even at driver scope. Capability IDs unique to one
driver (`grid_buy_rate`, `backup_reserve`) can safely stay app-level with a
capability filter, matching the existing convention in `.homeycompose/flow/`.

## Key Patterns

### Capability Listeners

**Do not await vehicle SDK actions in `registerCapabilityListener`** - they can take up to a minute. Use `.catch()` instead:

```typescript
// Correct
this.registerCapabilityListener("locked", async (value) => {
  value
    ? this.vehicle.api.lockDoors().catch(this.handleApiError)
    : this.vehicle.api.unlockDoors().catch(this.handleApiError);
});

// Wrong - blocks the listener and will likely hit 10 second timeout
this.registerCapabilityListener("locked", async (value) => {
  await this.vehicle.api.lockDoors();  // Don't do this
});
```

### API Error Handling

Use the inherited `handleApiError` and `handleApiResponse` methods:

```typescript
this.vehicle.api.someCommand()
  .then(this.handleApiResponse)
  .catch(this.handleApiError);
```

### Action Timeout (`TeslemetryDevice.action()`)

`action()` races every API command against a fixed 9s `ACTION_TIMEOUT` so flow
cards don't hang past Homey's own ~10s flow-card timeout. **Do not raise
`ACTION_TIMEOUT`** — it's deliberately kept just under Homey's built-in cap;
that's a separate, deferred investigation, not something to tweak in passing.

When the timeout wins the race, the flow card reports success even though the
real command is still in flight. If that command later rejects, `action()`
logs it via `this.error(...)` (tagged with the device name and the timeout
value) instead of discarding it — this is the only trace of a command that
silently "succeeded" but actually failed, so don't remove or downgrade that
log when touching this method.

### Signal-to-Capability Mapping

Some SSE signals use enum strings that need mapping:

```typescript
const chargePortLatchMap = new Map([
  ["ChargePortLatchEngaged", true],
  ["ChargePortLatchDisengaged", false],
]);

this.vehicle.sse.onSignal("ChargePortLatch", (value) =>
  this.update("locked.charge_latch", chargePortLatchMap.get(value))
);
```

### Cumulative Energy Meters

Homey's energy tab uses `cumulative: true` meter capabilities (`meter_power.*`) to calculate energy flow arrows and history. These values **must be monotonically increasing** (like a utility meter that never resets). If a cumulative meter value decreases, Homey's energy tracking and flow visualization break.

The `energy_totals` SSE event carries per-type daily totals (midnight to now, already summed server-side - not a `time_series` to sum client-side). Use `updateCumulativeMeter()` in `TeslemetryDevice` to convert those daily totals into monotonically increasing values. It tracks a persistent offset across day boundaries using Homey's device store, detecting day rollover by comparing the date derived from the event's `createdAt` (UTC, since `energy_totals` carries no per-site local timestamp).

### Grid Tariff Rate (`grid_buy_rate` / `grid_sell_rate`)

The Powerwall driver resolves the live buy/sell grid rate via `getTariffPeriods`
from the `tesla-fleet-api` package, called from `PowerwallDevice.updateTariffRates`.
The SSE protocol splits `tariff_content_v2` out of a now-slim `site_info` event
(a `null` body means the tariff was removed), so `PowerwallDevice` subscribes to
both `site.sse` `site_info` and `tariff_content_v2` events and, on either, re-reads
`site.sse.siteInfoDocument` - the SDK's merged view of the last-cached `site_info`
plus the last-cached `tariff_content_v2` - rather than trying to reassemble the two
itself.

- `tesla-fleet-api` is pinned to a commit SHA via a `github:` dependency
  (`Teslemetry/node-tesla-fleet-api`), not a published npm version - as of this
  writing npm has a `0.2.0` release, but it's behind the pinned commit (missing
  `tariff.ts`, `commands.ts`, the `signing/` module) so it can't be swapped in
  yet. Check `npm view tesla-fleet-api versions` and compare the release's
  `gitHead` (`npm view tesla-fleet-api@<version> gitHead`) against the pinned
  SHA before bumping; switch to a real semver range once a release catches up.
- Because it's a `github:` dependency, its own `dist/` is built by its
  `prepare` script (`tsc`), which `npm install`/`npm ci` normally run
  automatically. The Homey app-publish action (`athombv/github-action-homey-app-publish`)
  runs `npm ci --ignore-scripts`, which skips that script for every installed
  package, so `dist/` never gets built there and every import from
  `tesla-fleet-api` fails to resolve during `tsc`. `scripts/build-tesla-fleet-api.mjs`
  (invoked from the `build` npm script, ahead of `tsc`) compiles it explicitly
  as an ordinary build step, which runs regardless of `--ignore-scripts`; it's a
  no-op once `dist/` already exists (e.g. under a normal `npm install`).
- `tesla-fleet-api`'s public entry point does not re-export the `TariffContentV2`
  input type `getTariffPeriods` requires, so it's imported from the package's
  internal `tesla-fleet-api/dist/types/site_info.js` path instead; `@teslemetry/api`
  types both the merged `siteInfoDocument` and the raw `live_status`/`site_info` SSE
  payloads as opaque `Record<string, unknown>`, so each device declares a local
  interface for the fields it actually reads and casts to it, and tariff data still
  needs an `as unknown as TariffContentV2` cast on top for `getTariffPeriods`.
- Surfaced as two plain (non-dotted) custom capabilities, `grid_buy_rate` /
  `grid_sell_rate` - a base capability name may not contain a `.` at all (that's
  reserved for subcapabilities of an existing base), so this can't reuse the
  `<capability>.<sub>` pattern from the subcapability section above. There is no
  Homey system capability for pricing (`measure_price` does not exist despite
  looking plausible - `homey app validate` is the source of truth, not
  intuition about what "should" be a standard capability).
- Currency varies per site and isn't known at compose time, so `units` isn't
  set in the `.homeycompose/capabilities/*.json` files; `updateTariffRates`
  sets it at runtime via `setCapabilityOptions` once `getTariffPeriods` reports
  `currency`, the same runtime-options pattern `VehicleDevice.onInit` uses for
  `onoff.frunk`/`onoff.trunk`'s `setable`.

### Capability Updates

Use the `update()` method which safely handles unsupported capabilities:

```typescript
this.update("measure_battery", value);  // No-op if capability not present
```

### Firing Flow Trigger Cards

Homey does not reliably auto-fire trigger cards for this app's capabilities,
so every trigger card is fired explicitly from device code - always guarded
by comparing the old value to the new one, never firing on the first signal
received (no baseline to compare against) or on a repeated identical value.

- **Simple 1:1 capability-changed cards** (`<capability>_changed`, one card
  per capability, token name matches the capability): add the capability to
  `TeslemetryDevice.CHANGE_TRIGGER_CAPABILITIES`. `update()` then fires it
  automatically whenever `setCapabilityValue` actually changes the value; see
  `test/capability-change-triggers.test.ts` for the test shape.
- **Value-specific branching** (a raw signal fans out to several differently
  named cards depending on the transition, e.g. `charging_started` vs
  `charging_complete` vs `plugged_in` off the same `DetailedChargeState`
  signal): track the previous raw value in a private device field and branch
  in a dedicated handler method, calling
  `this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens).catch(this.error)`
  directly. See `VehicleDevice.handleDetailedChargeState`.
- **Threshold/argument-gated cards** (a trigger with a per-flow-card numeric
  argument, e.g. "battery drops below `[[percentage]]`%"): fire on every real
  value change with a `state` object (`{ previous, current }`) as the third
  `.trigger()` argument, then register a `registerRunListener` in
  `app.ts`'s `registerFlowCards()` that compares `args` (the card's
  configured argument) against `state` to decide whether *that* card's
  threshold was actually crossed. See `VehicleDevice.handleBatteryLevel` /
  the `battery_below` listener in `app.ts`. For a numeric *capability* (not
  a raw signal needing device-specific branching) that needs a paired
  `<cap>_above`/`<cap>_below` trigger plus a `<cap>` condition, use
  `TeslemetryDevice.updateWithThresholdTriggers()` instead of writing this by
  hand per device - it combines `update()` with firing both cards, and
  `app.ts`'s `registerThresholdCards()` registers the above/below/condition
  run listeners for a `(cardPrefix, capability, argName)` triple. See the
  solar/grid/load/battery power and buy/sell tariff rate cards for the
  pattern end to end.
- **Boolean `alarm_generic.<sub>` capabilities** are the one exception to the
  "not reliably auto-fired" rule above: Homey's platform auto-fires the
  `<cap>_true`/`<cap>_false` triggers and auto-implements the plain `<cap>`
  is/isn't condition whenever `update()` changes the value - no
  `registerRunListener` or explicit `.trigger()` call needed, only the manual
  card definitions (subcapabilities still don't get cards generated for you).
  See `alarm_generic.off_grid`/`.island`/`.rear_defrost`/the per-wheel TPMS
  warning and freshness alarms/`.fault` on Wall Connector. If a trigger also
  needs a custom token (e.g. a fault code), don't try to attach it to this
  auto-fired card - define a separate, explicitly-fired trigger instead (see
  `wall_connector_fault_code`), since firing the same card manually on top of
  Homey's automatic firing would double-run any flow built on it.

### TPMS Freshness (`TpmsLastSeenPressureTime*`)

`TpmsLastSeenPressureTimeFl/Fr/Rl/Rr` report a Unix timestamp that is wrong
when read directly - formatting it in Pacific Time instead yields the
vehicle's true local wall-clock reading time (an upstream Tesla API defect).
`drivers/vehicle/tpms.ts`'s `correctTpmsTimestampMs()` reinterprets those
wall-clock digits as UTC to recover a value comparable to `Date.now()`, which
`VehicleDevice` uses to drive the per-wheel `alarm_generic.tpms_stale_*`
alarms. Staleness must also be re-evaluated on a timer, not only when a new
signal arrives, since a wheel going quiet is itself the stale condition - the
timer is `unref()`'d so it doesn't keep the process (or a test run) alive.

### SSE Auth-Failure Handling (`app.ts`)

As of `@teslemetry/api` 0.7.0, the SDK's `TeslemetryStream` owns 401/403
detection, the exponential backoff for transient failures, and the
stop-loss policy for persistent auth failure — that used to all live in
this repo as a `logger.error("SSE error:", ...)` string-sniffing hack
(dead code against the SDK versions it shipped against, since inner
retries never surfaced that log line for a 401). It now emits two typed
events on `teslemetry.sse` that `app.ts` subscribes to instead:

- `stream_error: { error, status?, retries }` — fires on every failed
  reconnect attempt, transient or not. `app.ts` only acts when
  `status` is `401`/`403`: it forces `oauth.refreshToken()` so the SDK's
  own single same-attempt retry (it re-resolves the auth callback per
  attempt) gets a token that's actually fresh, covering a token revoked
  early enough that our proactive expiry-based refresh wouldn't have
  caught it. If that refresh itself finds the refresh token dead, `app.ts`
  doesn't wait for a second consecutive failure — it surfaces reauth
  immediately.
- `auth_failure` — the SDK's terminal event: it fires once two consecutive
  401/403s occur and the SDK has already stopped reconnecting
  (`active = false`). `app.ts` responds by stopping its own state
  (`cleanup()`), clearing the token, and marking every device unavailable
  via `error.invalid_refresh_token`, which surfaces through Homey's
  existing repair flow (same mechanism as
  `TeslemetryDevice.handleApiError`'s `invalid_token`/`subscription_required`
  handling).

Device availability is restored on the SDK's `state`/`data`/`connectivity`/
`live_status` events, **not** on `connect` — `TeslemetryStream` still emits
`connect` optimistically, before the underlying HTTP request even completes
(it fires right after constructing the SSE generator, not after the first
byte), so it fires on every reconnect attempt regardless of whether that
attempt goes on to fail. `live_status` is included so this also fires for
accounts with energy sites but no vehicles.

### SSE Topic Selection (`app.ts`)

`Teslemetry`'s `stream.topics` option (added in `@teslemetry/api` 0.10.0)
selects an exact allowlist of wire events instead of receiving every topic
the account is eligible for. `app.ts` passes exactly the topics this app's
devices consume: `state`/`data`/`connectivity` for vehicles (see
`drivers/vehicle/device.ts`) and `live_status`/`site_info`/
`tariff_content_v2`/`energy_totals` for energy sites (see
`drivers/battery|solar|gateway|wall-connector/device.ts`). Adding a signal
or event the app didn't previously consume from an already-selected topic
needs no change here; consuming a wire event not in that list does.

### Lint (oxlint)

`npm run lint` runs [oxlint](https://oxc.rs) (native Rust/TS parser, no `tsc`
bridge) instead of ESLint. `.oxlintrc.json` mirrors the rule set and options
that `eslint-config-athom` actually enforced (verified rule-for-rule against a
zero-finding baseline before the swap). Two categories of prior ESLint
coverage have no oxlint equivalent and are not enforced today:
- Pure formatting rules (`comma-dangle`, `semi`, `quote-props`, spacing rules,
  etc.) — oxlint deliberately excludes these and expects a formatter (e.g.
  Prettier) to own them; none is currently installed.
- A handful of non-formatting rules with no oxlint port: `no-restricted-syntax`
  (custom for-in/labeled-statement ban), `import/no-extraneous-dependencies`,
  `import/order`, and most of `eslint-plugin-node`'s CJS-require-focused
  rules (`node/no-missing-require`, `node/no-deprecated-api`, etc.) — lower
  impact here since the app is ESM-only.

`@typescript-eslint/recommended` and `eslint-plugin-homey-app`'s rules were
never actually active pre-migration either: `.eslintrc.json` extended
`"athom"`, which resolves to `eslint-config-athom`'s `index.js`, not
`homey-app.js` (the config that adds those). Not a regression from this
migration.

### TypeScript version

On TypeScript 7, `tsconfig.json` sets `compilerOptions.types` explicitly to
`["node", "homey"]`. TS7 dropped automatic inclusion of everything under
`@types/*` - without this, ambient globals from `@types/node` and
`@types/homey` (the Homey app SDK types) stop resolving and the build fails.
If you add a package whose types are only used ambiently (not via an
explicit `import`), add it to this list.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
