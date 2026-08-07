## Project Overview

Homey app for Teslemetry. Provides real-time control and monitoring of Tesla vehicles and energy products (Powerwall, Solar, Wall Connector, Gateway) using Server-Sent Events (no polling).

## Commands

```bash
npm run build           # Compile TypeScript to .homeybuild/
npm test                # Build, then run test/*.test.ts with Node's built-in test runner
npm run lint            # oxlint check (see .oxlintrc.json)
npm run dev             # Run app on local Homey
npm run app:validate    # Validate app (required before commit)
npm run smoke:packaged-build  # Verify every driver actually loads out of a real .homeybuild bundle
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
holds the stand-in `Device`/`Driver`/`App` base classes. The same loader
also redirects `@teslemetry/api` to `test/support/teslemetry-api-stub.js` -
the compiled runtime imports are `Teslemetry` in `app.js` and the pure
`getTariffPeriods` helper in the Powerwall device. Constructing the real
`Teslemetry` class would issue live network calls, while the stub safely
re-exports the real tariff helper for its tests. Each test calls the stub's
`configureTeslemetryStub(factory)` before triggering a build to control
`createProducts()` timing/outcome and drive the returned `sse` EventEmitter
directly - see `test/app-connection-lifecycle.test.ts`.

`npm test`'s module resolution (Node's own `node_modules` upward search) always
falls back to this repo's own root `node_modules`, which always has every
dependency built - so it can't catch a dependency missing specifically from
the *packaged* `.homeybuild/` bundle Homey actually uploads and runs on-device.
`npm run smoke:packaged-build` (`scripts/smoke-test-packaged-build.mjs`) closes
that gap: it runs the real `homey app build`, copies the result to an isolated
directory with no such ancestor `node_modules` to fall back to, and imports
every compiled `app.js`/`api.js`/`driver.js`/`device.js` from there (stubbing
only the Homey runtime, so packaged dependencies such as `@teslemetry/api`
must resolve for real) to confirm each one still resolves every import with
nothing else available - a general safety net for any dependency that resolves
fine from this repo's own `node_modules` but is missing or incomplete in the
packaged bundle.

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
- **Other boolean capabilities' own action ids**: Homey auto-wires a manually-defined subcapability action card whenever its id is `<cap>.<sub>_<action>`, where `<action>` is one of the base capability's own `$flow.actions` ids (`assets/capability/capabilities/<cap>.json` in the installed `homey-lib` package) - not always `on`/`off`. `windowcoverings_closed`'s own actions are `close`/`open`/`toggle`, so its tonneau subcapability actions are `windowcoverings_closed.tonneau_close`/`_open`/`_toggle` (see `VehicleDevice`'s tonneau `registerCapabilityListener`). Check that file before naming a new subcapability action card.

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

A driver-scoped card that also needs a capability filter (e.g. an action only
some vehicles in that driver support) still must not declare its own `device`
arg - add `"$filter": "capabilities=<capability>"` to the card instead;
`HomeyCompose.js` appends it to the auto-injected `device` arg's filter as
`driver_id=<id>&capabilities=<capability>`. See the seat heater/cooler action
cards in `drivers/vehicle/driver.flow.compose.json` for the pattern, gated on
the same `capabilityGating.ts` predicate the device capabilities use - one
predicate, so pairing and Flow-card visibility can't disagree about which
vehicles have a given seat feature.

## Key Patterns

### Checking HA Parity

The capability-expansion work in this app is repeatedly required to mirror the
Teslemetry Home Assistant integration's own capability choice, units, and
semantics rather than inventing a shape from the raw `@teslemetry/api` field.
A local checkout of `home-assistant/core` is available at
`~/firstmate/projects/hass-teslemetry` - grep
`homeassistant/components/teslemetry/{sensor,binary_sensor,switch,number}.py`
and `strings.json` there for the field/entity in question before designing a
new Homey capability; a field with no HA entity there generally belongs in
the PR body's skip list, not invented as a Homey-only shape.

### Capability Listeners

**Do not await vehicle SDK actions directly in `registerCapabilityListener`** - they
can take up to a minute. Return the `action()`/`vehicleAction()` call (see below)
instead, which internally races a 9s timeout so the listener still settles well
within Homey's ~10s flow-card timeout:

```typescript
// Correct
this.registerCapabilityListener("locked", async (value) => {
  return this.vehicleAction(
    value ? this.vehicle.api.lockDoors() : this.vehicle.api.unlockDoors(),
  );
});

// Wrong - blocks the listener on the raw SDK promise, no timeout race
this.registerCapabilityListener("locked", async (value) => {
  await this.vehicle.api.lockDoors();  // Don't do this
});
```

### Vehicle Command Response Validation (`VehicleDevice.vehicleAction()`)

Every vehicle SDK command resolves `{ response: { result: boolean, reason?:
string } }` **except** `wakeUp()`, whose response is the vehicle's own state
payload. Homey only observes whether a listener/Flow promise resolves or
rejects - it has no idea what `result: false` means - so every vehicle command
(capability listener and Flow action alike) must route through
`VehicleDevice.vehicleAction()`, not the base `TeslemetryDevice.action()`
directly:

```typescript
return this.vehicleAction(this.vehicle.api.someCommand(args));
```

`vehicleAction()` validates `response.result` via `handleApiResponse` before
handing the promise to `action()`'s timeout race; its generic constraint
requires the resolved type to include `response.result`, so passing
`wakeUp()`'s promise won't compile - call `this.action(this.vehicle.api.wakeUp())`
directly for that one exemption. Do not hand-roll
`.then(this.handleApiResponse)` per call site again; that's exactly the
ad-hoc pattern that let most commands report Tesla's explicit failures as
Homey successes before this wrapper existed. Energy-site commands
(Powerwall/Solar/Gateway/Wall Connector, via `this.site.api...`) have a
different, less consistent response shape and still call the base
`action()` directly - `vehicleAction()` is vehicle-only.

### API Error Handling

`handleApiResponse` (thrown into a rejection on `result: false`) and
`handleApiError` (translates/logs a rejected API error, and marks the device
`"auth"`-unavailable on `invalid_token`/`subscription_required`) are inherited
from `TeslemetryDevice` and used internally by `action()`/`vehicleAction()`.
Call them directly only for a command that bypasses those wrappers.

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

`updateCumulativeMeter()` serializes updates per device/capability and atomically persists one versioned state object under `meter_<capability>_state`. Callers must pass a zero-padded ISO `YYYY-MM-DD` date: same-day regressions are clamped, later dates roll over once, and stale earlier dates are ignored. See `test/cumulative-meter.test.ts` for the behavioral contract.

### Non-Cumulative "Today" Totals (Insight gauges)

Unlike the cumulative meters above, each `*_today` capability is a plain (non-`cumulative`) gauge with `insights: true` that should read 0 from local midnight until the day's first activity. `energy_totals` only pushes when a value actually changes, so once the underlying activity stops for a stretch the event goes silent and the last-received total just sits there - it does not get zeroed by a late-night/quiet-period event. Every device with a `*_today` capability compensates with its own timer, scheduled via `msUntilNextLocalMidnight()` (`lib/localMidnight.ts`) off the site's `installation_time_zone` (read from `site_info`/`siteInfoDocument`, the same source `PowerwallDevice` trusts for tariff resolution below - not `this.homey.clock.getTimezone()`, which is the Homey box's own location and may differ from the site's), that force-resets the capability(ies) at the actual local-midnight boundary and reschedules itself for the next one. `GatewayDevice`/`PowerwallDevice` each hand-roll their own copy of this timer (matching this codebase's existing per-device duplication convention rather than a shared base-class helper), resetting every `*_today` capability on that device in one callback. See `test/solar-generation-today.test.ts` for the time-controlled repro pattern (a stubbed `now()` plus a fake `homey.setTimeout`/`clearTimeout` capturing the scheduled callback, so the boundary crossing is asserted without waiting real time), `test/gateway-live-status.test.ts`/`test/battery-site-info.test.ts` for the same pattern applied to Gateway/Powerwall, and `test/local-midnight.test.ts` for the boundary-math unit tests.

Every recurring `homey.setTimeout` reschedule body (this one and `PowerwallDevice`'s `tariffTimer` below) must wrap its own callback in `try`/`catch`, exactly like the guarded cached-SSE-replay handlers elsewhere in this file - a raw `setTimeout` callback has no caller to catch a synchronous throw, so an unguarded one crashes the whole app process on its next scheduled fire, not just this device. The three midnight-reset test files above verify that callback failures do not escape uncaught.

These gauges exist to mirror the Home Assistant teslemetry integration's default-enabled energy-history sensors (`ENERGY_HISTORY_FIELDS` in `home-assistant/core`'s `homeassistant/components/teslemetry/const.py`, filtered to `entity_registry_enabled_default` in `sensor.py`: every `total_*`-prefixed key plus `grid_energy_imported`) as Homey Insights, driven from the same server-side `energy_totals` SSE push already consumed for the cumulative meters above - not HA's separate REST-polled history coordinator. The exact `@teslemetry/api` `SseEnergyTotals.totals` field names (`node_modules/@teslemetry/api/dist/index.d.mts`, `ENERGY_HISTORY_TOTAL_FIELDS`) mirror HA's list field-for-field:

| Capability | Device | `energy_totals` field | HA entity translation key (`strings.json`) |
| --- | --- | --- | --- |
| `solar_generation_today` | Solar | `total_solar_generation` | `sensor.total_solar_generation` ("Solar generated") |
| `grid_imported_today` | Gateway | `grid_energy_imported` (no `total_` prefix - matches HA/the SDK exactly) | `sensor.grid_energy_imported` ("Grid imported") |
| `grid_exported_today` | Gateway | `total_grid_energy_exported` | `sensor.total_grid_energy_exported` ("Grid exported") |
| `home_usage_today` | Gateway | `total_home_usage` | `sensor.total_home_usage` ("Home usage") |
| `battery_charged_today` | Powerwall | `total_battery_charge` | `sensor.total_battery_charge` ("Battery charged") |
| `battery_discharged_today` | Powerwall | `total_battery_discharge` | `sensor.total_battery_discharge` ("Battery discharged") |

The remaining `ENERGY_HISTORY_FIELDS` (per-source breakdowns like `battery_energy_imported_from_solar`, `consumer_energy_imported_from_grid`, `grid_services_energy_imported`, generator fields, etc.) are disabled by default in HA too and are deliberately not surfaced here - only the main totals are. These `*_today` gauges are purely additive Insight surfaces; they do not replace or alter the `meter_power*` cumulative-meter path above, which every `*_today`-producing `handleEnergyTotals` handler still updates unchanged alongside the new gauge.

### Grid Tariff Rate (`grid_buy_rate` / `grid_sell_rate`)

The Powerwall driver resolves the live buy/sell grid rate via `getTariffPeriods`
from `@teslemetry/api`, called from `PowerwallDevice.recomputeTariffRates`.
The SSE protocol splits `tariff_content_v2` out of a now-slim `site_info` event
(a `null` body means the tariff was removed), so `PowerwallDevice` subscribes to
both `site.sse` `site_info` and `tariff_content_v2` events and, on either, re-reads
`site.sse.siteInfoDocument` - the SDK's merged view of the last-cached `site_info`
plus the last-cached `tariff_content_v2` - rather than trying to reassemble the two
itself.

A period boundary arrives with the clock, not with a new SSE event, so
`recomputeTariffRates` retains the last-seen tariff document/timezone on the
device instance and schedules a Homey timeout at `getTariffPeriods`' own
`resolution.nextChange` instant; the timeout recomputes and reschedules
itself, so rates advance correctly with no further config event required.
Every call clears any previously scheduled timer first (matching
`SolarDevice.scheduleMidnightReset`'s pattern), so a fresh `site_info`/
`tariff_content_v2` event - including a timezone change - always wins over a
stale boundary. When the tariff is absent (removed, `null`) or otherwise
unresolvable (no timezone, or `getTariffPeriods` finds no matching season),
`clearTariffRates` unsets both rate capabilities and their currency `units`
rather than leaving a stale price in place; the boundary timer is cleaned up
in `onUninit` via the same `pollingCleanup` array every other listener uses.

- `getTariffPeriods`/`TariffContentV2` are imported directly from
  `@teslemetry/api` (>= 0.11.0, which vendors and re-exports them from
  `tesla-fleet-api`) - no separate `tesla-fleet-api` dependency or custom
  build step is needed. `@teslemetry/api` types both the merged
  `siteInfoDocument` and the raw `live_status`/`site_info` SSE payloads as
  opaque `Record<string, unknown>`, so each device still declares a local
  interface for the fields it actually reads and casts to it, and tariff
  data still needs an `as unknown as TariffContentV2` cast on top for
  `getTariffPeriods`.
- `test/support/teslemetry-api-stub.js` (the redirect target every
  `@teslemetry/api` import resolves to under test - see the Testing section
  above) re-exports the real `getTariffPeriods` via a relative path into
  `node_modules/@teslemetry/api/dist/index.mjs`, bypassing both the test
  loader's redirect (a bare `"@teslemetry/api"` re-import there would just
  recurse into itself) and the package's `exports` map (which doesn't
  declare that subpath for package-name imports). This keeps the tariff
  tests exercising real tariff-window math instead of a hand-rolled fake.
- Surfaced as two plain (non-dotted) custom capabilities, `grid_buy_rate` /
  `grid_sell_rate` - a base capability name may not contain a `.` at all (that's
  reserved for subcapabilities of an existing base), so this can't reuse the
  `<capability>.<sub>` pattern from the subcapability section above. There is no
  Homey system capability for pricing (`measure_price` does not exist despite
  looking plausible - `homey app validate` is the source of truth, not
  intuition about what "should" be a standard capability).
- Currency varies per site and isn't known at compose time, so `units` isn't
  set in the `.homeycompose/capabilities/*.json` files; `recomputeTariffRates`
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
`PowerwallDevice.onInit` (guards `recomputeTariffRates`, a plain non-`async`
method) and `VehicleDevice.onInit` (splits essential registration into
`registerCommandCapabilityListeners()`, run first, and wraps the fallible
`registerSignalListeners()` call in `try`/`catch`). Within
`registerSignalListeners()`, `VehicleDevice`'s private `onSignal()` wrapper
goes one step further and isolates each individual signal: it catches a
throw from one signal's callback (replay-time or later) so that failure
can't also abort every signal registered after it in the same function -
see `signalHandlerFailures` for the resulting degraded-health log line.

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

### Missing-Product Honest Unavailability (all five drivers)

A saved device's product id (energy site id, vehicle VIN, wall connector
DIN) can stop resolving in `products` (e.g. the underlying binding goes
stale, or a physical connector is replaced). Per the "registered but dead"
pattern above, every driver's device `onInit` returns early in that case -
an accurate `error.<x>_not_found` message (never the misleading
`error.invalid_refresh_token`), zero SSE listeners, zero command listeners.
There is no product-binding repair/rebind flow: the device stays honestly
unavailable and the user deletes and re-pairs it, getting fresh pairing
`data`. Do not add mutable store-backed binding overrides, driver-specific
identity-repair views, or repair-candidate matching; Homey's generic OAuth
repair flow remains responsible only for restoring account authorization.

`<Device>.getSiteId()` / `getVin()` (Vehicle) / `getSiteId()`+`getDin()`
(Wall Connector) resolve the product id from the immutable pairing `data`.
All product lookups go through these methods, never `getData()` directly.
`EnergyDetails.id` (`@teslemetry/api`) is `number`, not `string`. Pairing
`data.id` (or Wall Connector's `data.site`) keeps that raw numeric id - not
stringified - so an already-paired device's immutable identity never changes
shape across an app update (Homey's pairing dedup compares `data` verbatim;
changing its type would make an existing device look unpaired and offer it
again as a duplicate). `getSiteId()` still canonicalizes: it wraps its
resolved value in `String(...)` on every call, so normal product-registry
lookups (keyed by string) match a numeric pairing `data.id`/`data.site`. See
`test/energy-driver-pairing.test.ts` for the numeric-pairing regression
coverage.

Wall Connector additionally validates its DIN's continued presence, not just
its site's: `WallConnecter`'s `live_status` handler counts consecutive
events where its bound DIN is absent from the site's `wall_connectors` list.
`DIN_MISS_GRACE_EVENTS` skips the first couple of events after a bind (an
initial/cached snapshot may not yet include every connector), and
`DIN_MISS_THRESHOLD` then requires several further consecutive misses before
`markUnavailable("connector", ...)` fires - a distinct `AvailabilityReason`
from `"binding"` (the site itself missing), since a resolvable site with a
vanished DIN is a different cause. Recovery is symmetric: the next
`live_status` event carrying that DIN clears the `"connector"` reason and
resets the miss streak. See `test/wall-connector-availability.test.ts`.

Every device's `onUninit()` must be safe to call after any of these early
returns - a missing-product `onInit()` never assigns the product/cleanup
fields a normal bind would, so dereferencing them unconditionally in
`onUninit()` throws a secondary error that masks the original binding
failure. `VehicleDevice`/`WallConnecter` guard this with `this.vehicle?.sse`
and a `pollingCleanup` field initialized to `[]` at declaration plus
optional chaining at every use site (matching Solar/Gateway/Powerwall's
existing convention) - not one or the other alone, since a test double or
any other path that skips the constructor still needs the optional chaining
to be safe.

### Present-But-Ineligible Products (bind-time eligibility revalidation)

A product can stay listed in `Products` after losing access/subscription/
telemetry eligibility - the metadata entry isn't removed, only its
eligibility fields change. `checkVehicleEligibility()` /
`isVehicleEligible()` / `isEnergySiteEligible()` (`lib/TeslemetryDriver.ts`)
are the single source of truth for "is this product pairable/bindable right
now", shared by pairing (`drivers/vehicle/driver.ts`,
`listEnergySiteCandidates()`) and every driver's `resolveAndBindVehicle()`/
`resolveAndBindSite()` so the two can't drift apart. The vehicle predicate
mirrors pairing exactly (`access && fleet_telemetry && !polling`); the
energy predicate is `access` only - energy metadata exposes no telemetry/
polling equivalent, so don't invent a more specific reason than the record
proves.

A product that resolves but fails this predicate is treated like the
missing-product case above, not like a normal bind: nothing is assigned,
zero listeners are registered, and the device is marked unavailable with the
new `"eligibility"` `AvailabilityReason` and a message naming the specific
failed condition (`error.vehicle_access_required` /
`error.vehicle_telemetry_unavailable` / `error.vehicle_polling_mode` /
`error.energy_site_access_required`). Recovery is symmetric with binding: the
next bind/rebind that finds the product eligible again clears
`"eligibility"` the same way it clears `"binding"`. This does not detect an
eligibility change during an uninterrupted, indefinitely cached `Products`
generation - only revalidates at bind/rebind - see
`test/device-oninit-ineligible-product.test.ts` for the coverage (all three
false vehicle predicate cases, access-false energy cases, zero listener
registration, and rebind recovery).

### Firing Flow Trigger Cards

Homey does not reliably auto-fire trigger cards for this app's capabilities,
so every trigger card is fired explicitly from device code - always guarded
by comparing the old value to the new one, never firing when no prior value
exists (no baseline to compare against) or on a repeated identical value.

- **Simple 1:1 capability-changed cards** (`<capability>_changed`, one card
  per capability, token name matches the capability): add the capability to
  `TeslemetryDevice.CHANGE_TRIGGER_CAPABILITIES`. `update()` then fires it
  automatically whenever `setCapabilityValue` actually changes the value from
  a known prior value - it compares against the *persisted* capability value
  (`getCapabilityValue()`, which Homey retains across an app restart) and
  requires that prior value to be present, so a fresh device's first reading
  only sets the baseline and never fires. After an app restart, the persisted
  value remains the baseline, so only a genuine change fires the trigger.
  Numeric-token cards must also be listed in
  `NUMERIC_CHANGE_TRIGGER_CAPABILITIES`; `update()` still writes the capability
  value but suppresses the Flow trigger unless the new token is a finite
  number. See `test/capability-change-triggers.test.ts` for the test shape.
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
- **Boolean system capabilities with their own `$flow` definition** (any
  `alarm_*`, not just `alarm_generic.<sub>`) are the one exception to the
  "not reliably auto-fired" rule above: Homey's platform auto-fires the
  `<cap>_true`/`<cap>_false` triggers and auto-implements the plain `<cap>`
  is/isn't condition whenever `update()` changes the value - no
  `registerRunListener` or explicit `.trigger()` call needed. A
  subcapability (`alarm_generic.off_grid`/`.island`/`.rear_defrost`/`.fault`
  on Wall Connector) still needs its own manual card definitions (see
  "Subcapability Flow Cards" above); a plain system capability used as-is
  (`alarm_motion`, `alarm_presence` on Vehicle) needs none - just add it to
  the driver's `capabilities` array and call `update()`. If a trigger also
  needs a custom token (e.g. a fault code) or a distinct name (e.g.
  "arrived home" instead of the generic "presence alarm turned on"), don't
  try to attach it to this auto-fired card - define a separate,
  explicitly-fired trigger instead (see `wall_connector_fault_code`,
  `vehicle_arrived_home`/`vehicle_left_home`), since firing the same card
  manually on top of Homey's automatic firing would double-run any flow
  built on it.

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

### At-Home/At-Work Presence (`alarm_presence`, `alarm_generic.at_work`)

Presence is sourced from the vehicle's own native `LocatedAtHome`/
`LocatedAtWork` signals - Tesla-computed booleans ("is the vehicle at the
active driver profile's saved home/work location") that
`@teslemetry/api`'s type comments and the Teslemetry Home Assistant
integration's `binary_sensor.py` both confirm are genuine Fleet Telemetry
fields (Requires 2024.44.32), not something this app derives from raw
coordinates. This is deliberately not a Homey-side geofence and requires no
location math, geolocation permission, or device setting.
`VehicleDevice.handleLocatedAtHome`/
`handleLocatedAtWork` (registered via `onSignal("LocatedAtHome"/"LocatedAtWork",
...)`) just pass the boolean straight through to `alarm_presence`/
`alarm_generic.at_work`. `alarm_presence` is a plain system capability (free
`alarm_presence_true`/`_false`/condition cards - see the "Boolean system
capabilities" bullet above - plus the explicitly-fired, distinctly-named
`vehicle_arrived_home`/`vehicle_left_home` triggers since the generic
wording isn't clear enough on its own); `alarm_generic.at_work` is a
subcapability with its own manually-defined `_true`/`_false`/condition
cards (worded directly as "arrived at work"/"left work", so no supplementary
trigger is needed the way home's is).

If the account hasn't granted the `vehicle_location` scope, neither signal
ever arrives (cached or live), so the handlers never run and both
capabilities just stay at their unset/`null` value - an honest "unknown"
rather than a thrown error or a device marked unavailable. No separate
scope-detection call was added for this. `handleLocatedAtHome` tracks the
previous value in `previousLocatedAtHome` rather than reading it back via
`getCapabilityValue()`, since `update()` writes it asynchronously - a second
signal arriving before the first write settles would otherwise see the same
stale value and could double- or mis-fire `vehicle_arrived_home`/
`vehicle_left_home`. See `test/vehicle-presence.test.ts`.

### Connection Lifecycle: Single-Flight Init, Startup Retry, Freshness Watchdog (`app.ts`)

`app.ts` owns one shared, generation-safe pipeline for building/rebuilding
`teslemetry`/`products`, replacing an earlier ad hoc `initializeTeslemetry()`/
`reinitialize()` pair that could split an SDK instance from the `Products` it
published under concurrent calls. The pieces:

- **`initializeTeslemetry(forceRebuild?)`** is single-flight: every caller
  (boot `onInit()`, `getTeslemetry()`/`getProducts()`, the startup retry
  timer, a token-refresh rebuild) chains onto one `initChain` promise, so
  builds never run concurrently and no caller can observe a half-built
  generation. `forceRebuild` (used by the `oauth2:token_saved` listener - see
  the dead-listener caveat below) always builds a fresh generation even if
  the current one is `ready`; a plain call is a no-op once already ready.
- **`doInitialize()`** builds into local `const sdk`/`const products`,
  attaches that generation's stream handlers to the *local* `sdk`, and only
  publishes to `this.teslemetry`/`this.products` after `createProducts()`
  fully succeeds - a failed build never leaves those fields half-updated.
  The previous generation's stream is closed only *after* the new stream has
  been started, so a token-refresh rebuild has no gap with zero active stream.
  This does not imply that the optimistic `connect()` call has delivered data.
  `this.generation` is bumped when a completed build is published and inside
  `cleanup()`; every stream handler captures its own generation and no-ops
  once superseded, so a straggler event from an old/closed SDK (`close()`
  doesn't abort its in-flight request - a known `@teslemetry/api` gap, not
  fixed here) can't mutate current state.
- **`scheduleStartupRetry()`** covers a transient `createProducts()` failure
  at boot: bounded exponential backoff (`STARTUP_RETRY_BASE_MS` doubling up
  to `STARTUP_RETRY_MAX_MS`) via `this.homey.setTimeout`, cleared as soon as
  any build succeeds. Doesn't schedule without a valid token - that's an auth
  problem for the OAuth pairing/repair flow, not a timer. `isReady()`
  reflects whether a generation has ever been fully published; devices that
  fail to bind while not yet ready use the `"startup"` availability reason
  (see below) instead of a misleading "product not found" message.
- **The stream freshness watchdog** tracks per-product last-genuine-event
  time. The SDK emits `disconnect` before every reconnect attempt regardless
  of cause (network/server/parse/auth), so `handleStreamDisconnect()` starts
  a `STREAM_STALE_GRACE_MS` timer on the first one; if it fires with no
  genuine data in between, every currently-bound device is marked
  unavailable with reason `"stream"`. Each device recovers independently the
  moment its *own* product's next genuine (non-`isCache`) `state`/`data`/
  `connectivity`/`live_status` event arrives - never on a blanket reconnect,
  and never on the SDK's `connect` event, which fires optimistically before
  the underlying HTTP request even completes.
- **`rebindAllDeviceProducts()`** (unchanged from earlier versions) walks
  every driver's `getDevices()` and calls `TeslemetryDevice.rebindProduct()`
  (default no-op; overridden by every product-holding device) after each
  successful build - without it, an already-paired device would keep
  listening on the old, now-dead per-product stream forever. Runs
  unconditionally on every successful build, including the very first one at
  boot (a harmless no-op there, since no devices are paired yet).

Separately, and **not fixed by this work**: `TeslemetryOAuth2Client.saveToken()`
emits `oauth2:token_saved` on `this.app.homey` (the SDK's `Homey` instance),
but `app.ts`'s own `onInit()` listens via `this.on(...)` on the `App`
instance itself - a different `EventEmitter` with no bridging for custom
events (SDK's `_initApp` only forwards `__log`/`__error`/`__debug`). That
listener - and therefore `initializeTeslemetry(true)`'s force-rebuild path -
is dead code today; a normal token refresh never reaches it in production.
Flagged for a future pass.

### Credential Teardown & Availability Reasons (`app.ts`, `lib/TeslemetryDevice.ts`)

Every device's unavailability is tracked as one typed `AvailabilityReason`
(`"startup" | "binding" | "stream" | "auth" | "connector"`,
`lib/TeslemetryDevice.ts`) via
`markUnavailable(reason, message)` / `clearAvailabilityReason(reason)` -
never a raw `setUnavailable()`/`setAvailable()` call from app.ts or a data
handler. `clearAvailabilityReason()` is a no-op unless the device's *current*
reason matches, so one recovery signal (a stream reconnect, a genuine data
event) can never paper over an unrelated cause (a missing product binding, a
revoked subscription) - see `TeslemetryDevice.getProductKey()` and
`app.ts`'s `getDevicesForProductKey()`, used by both the freshness watchdog
above and the auth recovery below to target exactly the right device(s).

`teardownCredentials(message)` is the single path for every credential-removal
event: the SSE `auth_failure` terminal event (`stopSseAndSurfaceReauth()`)
and the manual Disconnect action (`api.ts`'s `deleteOAuthToken` calls the
public `app.disconnectAccount()`). Both close the stream, clear the token,
and mark every device unavailable with reason `"auth"` - no later unrelated
event can globally re-declare them healthy; only that specific device's own
genuine post-reauth data event clears it (`handleGenuineStreamEvent()`,
shared with the freshness watchdog, also tries `clearAvailabilityReason("auth")`
per matched device - a live event on the current stream generation is by
itself proof the account reauthenticated, so no separate "reauth in
progress" flag is needed).

`TeslemetryDevice.handleApiError()` marks the same `"auth"` reason on
`invalid_token`/`subscription_required` from an individual command response,
so a device-level auth failure and an app-level stream auth failure recover
through the identical per-device evidence path. See
`test/app-connection-lifecycle.test.ts` for the regression coverage of all
of the above (single-flight/generation-safety, startup retry, the freshness
watchdog, manual disconnect, and reason-scoped auth recovery).

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

### Dependency Vulnerabilities (`npm audit`)

`@teslemetry/api` and `source-map-support` (the runtime dependencies) pull in
no transitive dependencies of their own - every `npm audit` finding traces
back to the `homey` devDependency (the CLI/release toolchain), so treat audit
findings as toolchain hygiene, not runtime exposure. `homey` itself is pinned
to `^4.4.1`, the latest release on npm as of this writing - staying current
there is fine (it's dev-only and this repo tracks it deliberately), but it
alone does not clear the remaining findings below, since `homey`'s own
`package.json` declares narrow semver ranges for its transitive deps that
predate their advisories' fixed versions. `package.json`'s `overrides` block
pins several of those transitive deps (`uuid`, `tmp`, `minimatch`,
`update-notifier`, `sharp`) past their advisory-fixed versions - each was
verified individually (`npm run build && npm test && npm run lint && npm run
app:validate` after each override) since forcing a transitive major can break
the CLI in ways this app's own test suite can't catch on its own. The
remaining findings (`socket.io-client`/`engine.io-client`/`parseuri`, pinned
by `homey-api`, itself already the latest release `homey`'s range allows) are
left alone: `homey-api`'s client talks live protocol to a paired Homey box
during `homey app run`/`select`, a path this repo has no way to exercise in
CI, and `npm audit fix --force`'s only route is downgrading `homey` itself to
a much older release - a regression, not a fix. This is an upstream (Athom)
gap, not something fixable from this repo; re-run `npm audit` after any
`homey`/`homey-api` release to see whether it's been closed before adding
another override.

### Release Workflow (`homey-app-release.yml`)

Cutting a release is one manual `workflow_dispatch` on `homey-app-release.yml`
(version bump type + changelog) with three chained jobs: `version` (runs
Athom's `github-action-homey-app-version`, commits, tags, creates the GitHub
Release), `validate` (calls `homey-app-validate.yml` as a reusable workflow
via `workflow_call`, checked out at the exact commit `version` produced -
not whatever `main` has moved to since), then `publish` (Athom's
`github-action-homey-app-publish`). Only `publish` runs under the `production`
GitHub Environment, whose required reviewer is the run's single approval
gate - by the time someone approves, the candidate is already versioned and
validated. The old standalone `homey-app-version.yml`/`homey-app-publish.yml`
manual-dispatch workflows are gone; this is now the only way to cut a
release. Athom's publish still lands the build as a draft in Athom's
dashboard - promoting it there remains a separate, manual step.

The `version` job's commit/tag/release step is written idempotently (checks
before creating the tag and before creating the GitHub Release) and the job
skips re-running Athom's bump action on a same-run retry (detected via
`GITHUB_RUN_ATTEMPT` plus the prior commit message) - re-running a failed
`version` job resumes rather than double-bumping the version or failing on
an already-pushed tag/release.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
