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
Homey runtime) so device/driver/app classes can be exercised directly via
their prototypes without a live Homey instance; `test/support/homey-stub.js`
holds the stand-in `Device`/`Driver`/`App` base classes.

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

### Non-Cumulative "Today" Totals (`solar_generation_today`)

Unlike the cumulative meters above, `solar_generation_today` is a plain (non-`cumulative`) gauge that should read 0 from local midnight until the day's first generation. `energy_totals` only pushes when a value actually changes, so once solar output stops for the night the event goes silent and the last-received total (yesterday's) just sits there - it does not get zeroed by a late-night event. `SolarDevice` compensates with its own timer, scheduled via `msUntilNextLocalMidnight()` (`lib/localMidnight.ts`) off the site's `installation_time_zone` (read from `site_info`/`siteInfoDocument`, the same source `PowerwallDevice` trusts for tariff resolution below - not `this.homey.clock.getTimezone()`, which is the Homey box's own location and may differ from the site's), that force-resets the capability at the actual local-midnight boundary and reschedules itself for the next one. See `test/solar-generation-today.test.ts` for the time-controlled repro (a stubbed `now()` plus a fake `homey.setTimeout`/`clearTimeout` capturing the scheduled callback, so the boundary crossing is asserted without waiting real time) and `test/local-midnight.test.ts` for the boundary-math unit tests.

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

### Device `onInit` Ordering ("registered but dead")

Every device stream (`site.sse`/`vehicle.sse` `.on`/`onSignal`) replays the
last cached payload for that event *synchronously* the moment a listener is
registered. If a handler throws while processing that replay and nothing
catches it, the throw propagates out of the still-synchronous portion of
`onInit`, rejecting its promise before any registration after that point
runs - the device ends up paired in Homey but permanently unresponsive (no
data updates, no commands). Register the essential listeners (state/
connectivity/live SSE listeners and all `registerCapabilityListener` command
listeners) before anything that replays a less-trusted cached value, and
guard the fallible replay so it can't undo that registration - see
`PowerwallDevice.onInit` (guards `updateTariffRates`, a plain non-`async`
method) and `VehicleDevice.onInit` (splits essential registration into
`registerCommandCapabilityListeners()`, run first, and wraps the fallible
`registerSignalListeners()` call in `try`/`catch`).

This only protects against a handler that throws *synchronously*. A handler
that is itself `async` never throws synchronously - JS converts any error
inside it into a rejected Promise before the call returns, so wrapping the
call site in `try`/`catch` silently does nothing and the rejection surfaces
later as an unhandled rejection instead. `updateWithThresholdTriggers()`
(`lib/TeslemetryDevice.ts`) is `async` for exactly this reason: Solar's and
Gateway's `onLiveStatus` handlers call it directly and were audited for this
bug, but since the call can't throw synchronously, it can't block their
`energy_totals` listener from registering either - not vulnerable, and nothing
to guard.

### Powerwall Missing-Site Repair (`PowerwallDevice`/`PowerwallDriver`)

A saved Powerwall's site id (`getData().id`) can stop resolving in
`products.energySites` (e.g. the underlying site binding goes stale). Per
the "registered but dead" pattern above, `PowerwallDevice.onInit` returns
early in that case - `error.energy_site_not_found`, zero SSE listeners, zero
command listeners. Fixing this without losing the device's identity (its
runtime id, capability history, and Flow bindings, all keyed off the paired
device instance, not the site id) needs the site binding to be mutable
independently of the immutable Homey pairing `data`:

- `PowerwallDevice.getSiteId()` resolves the site id from a store value
  (`energySiteId`) if one has been set, falling back to `getData().id`
  otherwise. All site lookups go through this method, not `getData().id`
  directly.
- `PowerwallDevice.repairSite(siteId)` is the only way to change that store
  value. It validates the target site exists, then calls the same
  `bindSite()` internals `onInit` uses to register SSE/command listeners, so
  a repaired device ends up identical to one that resolved correctly on
  first init.
- `PowerwallDriver.onRepair` exposes this through a driver-specific custom
  repair view (`drivers/battery/repair/repair_site.html`, wired via
  `driver.compose.json`'s own `repair` array, which overrides the shared
  `teslemetry` template's array for this driver only - see
  `HomeyCompose.js`'s driver-json merge, where a driver's own top-level key
  fully replaces the same key inherited via `$extends`, not merges with it).
  The view only ever offers a relink when `findRepairCandidate()` finds
  exactly one battery-capable energy site not already bound to another live
  Powerwall device; zero or multiple candidates get an explanatory
  dead-end, never a guess. `Homey.createDevice()` is unavailable in repair
  views by design, which is why this rebinds the existing device via a
  store value instead of any list-devices/add-devices flow.

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
  See `alarm_generic.off_grid`/`.island`/`.rear_defrost`/`.fault` on Wall
  Connector. If a trigger also needs a custom token (e.g. a fault code),
  don't try to attach it to this auto-fired card - define a separate,
  explicitly-fired trigger instead (see `wall_connector_fault_code`), since
  firing the same card manually on top of Homey's automatic firing would
  double-run any flow built on it.

### TPMS Warning Level (`tpms_warning`)

`TpmsSoftWarnings`/`TpmsHardWarnings` are per-tire boolean objects
(`front_left`/`front_right`/`rear_left`/`rear_right`); `VehicleDevice`
aggregates both across every tire into a single custom enum capability,
`tpms_warning` (`off`/`soft`/`hard`, hard beating soft beating off), rather
than exposing eight separate per-wheel alarms. It's a plain
`CHANGE_TRIGGER_CAPABILITIES` entry (see `tpms_warning_changed`), not an
`alarm_generic` subcapability, since it has three states, not two.
`TpmsLastSeenPressureTimeFl/Fr/Rl/Rr` (a per-tire last-seen timestamp with a
documented timezone defect - it reports as though the reading time were
Pacific Time regardless of the vehicle's real timezone) are not currently
surfaced by this capability or any other.

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

### Reinitialize Product Rebinding (`app.ts`, `TeslemetryDevice.rebindProduct`)

`initializeTeslemetry()` can run more than once per app process - via
`reinitialize()` (currently unreachable in production: see the note below)
or lazily via `getTeslemetry()`/`getProducts()` after `stopSseAndSurfaceReauth()`
recovers. Each run builds a brand new `Products` object with brand new
per-site/per-vehicle stream objects. Every device captures its own
`site`/`vehicle` reference and registers SSE listeners on it during its own
`onInit()`; without rebinding, an already-paired device keeps listening on
the old, now-dead stream forever - it stays `available`, its capability
values simply stop changing, silently, with no error anywhere. This is a
**distinct freeze mode from the missing-site one** (see "Stale Device
References" below): it does not survive a full app/process restart (a fresh
process re-runs every device's `onInit()` against the current `Products`
from scratch), but does persist across an in-process reconnect/recovery
that never restarts the app.

`initializeTeslemetry()` calls `rebindAllDeviceProducts()` after building
`products`, which walks every driver's `getDevices()` and calls
`TeslemetryDevice.rebindProduct()` (default no-op) on each. Subclasses that
hold a product reference - `PowerwallDevice`, `SolarDevice`, `GatewayDevice`,
`WallConnecter`, `VehicleDevice` - override it to tear down their existing
listeners (the same cleanup `onUninit()` uses) and re-run their own
bind-and-register logic against the freshly resolved product. This runs
unconditionally on every `initializeTeslemetry()` call, including the very
first one at boot - a harmless no-op there, since no devices are paired yet
at that point in Homey's own startup ordering.

Separately: `TeslemetryOAuth2Client.saveToken()` emits `oauth2:token_saved`
on `this.app.homey` (the SDK's `Homey` instance), but `app.ts`'s own
`onInit()` listens via `this.on(...)` on the `App` instance itself - a
different `EventEmitter` with no bridging for custom events (SDK's
`_initApp` only forwards `__log`/`__error`/`__debug`). That listener is
therefore dead code today; a normal token refresh never calls
`reinitialize()` in production at all. Not fixed here - flagged for a
future pass, since fixing it only matters once `reinitialize()` itself is
safe to call, which is what this section's rebinding fix establishes.

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

### Stale Device References (Flow cards)

A saved Flow action/condition/trigger can outlive its device: removing and
re-pairing the same Tesla site (Powerwall, vehicle, etc.) gives Homey a new
runtime device ID while this app returns the same `deviceData.id`, so the old
Flow argument still points at a runtime ID no driver instance has anymore.
Deserializing that argument calls the Apps SDK's private
`Driver.getDeviceById`, which throws synchronously *before* any app code
runs - an uncaught exception at that point can crash the whole `com.teslemetry`
process, not just fail one Flow card.

Two coordinated guards close this:

- `TeslemetryDriver.getDeviceById` is overridden to resolve by scanning
  `getDevices()` and comparing runtime `getId()` (not `getDevice({id})`,
  which compares pairing `deviceData`, not the runtime ID being deserialized
  here) and returns `undefined` instead of throwing on a miss, rate-limited
  per missing ID. This is a workaround for an undeclared/private SDK method,
  not a supported contract - see the comment on the override for the
  version it targets and re-verify after any Apps SDK bump.
- Every app-owned Flow run listener in `app.ts` must treat `args.device` as
  possibly `undefined`: actions call `requireFlowDevice()` to reject with a
  clear, user-actionable error; conditions and device-trigger predicates
  return `false`. Never let a stale device silently no-op an action or match
  a condition/trigger by accident (an undefined check that's skipped reads
  as success).

Separately, `TeslemetryDevice.isLive()` (`!destroyed` AND still present in
`driver.getDevices()`) must be checked immediately before every
`.trigger(this, ...)` call this app makes itself. `destroyed` alone isn't
enough: the Apps SDK removes a deleted device from the driver's runtime map
*before* calling `onUninit()`, so a capability write already in flight can
resume in that gap with `destroyed` still `false`. See
`test/device-liveness.test.ts` for the real SDK deletion-ordering model (map
removal first, not a direct early `onUninit()` call).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
