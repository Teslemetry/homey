## Project Overview

Homey app for Teslemetry. Real-time control and monitoring of Tesla vehicles and
energy products (Powerwall, Solar, Wall Connector, Gateway) over Server-Sent
Events (no polling).

## Commands

```bash
npm run build           # Compile TypeScript to .homeybuild/
npm test                # Build, then run test/*.test.ts with Node's test runner
npm run lint            # oxlint (see .oxlintrc.json)
npm run dev             # Run app on local Homey
npm run app:validate    # homey app validate --level verified
npm run smoke:packaged-build  # Verify every driver loads out of a real .homeybuild bundle
```

Always run `npm run app:validate` before committing.

### Testing

`npm test` runs against the **compiled output** in `.homeybuild/`, not the TS
sources - Node's native TS support can't resolve TS-style `.js`-extension
imports or elide type-only named imports, so it can't load the source import
graph. `test/support/loader.mjs` redirects two imports so classes can be
exercised via their prototypes with no live Homey and no network:

- `homey` → `test/support/homey-stub.js` (stand-in `Device`/`Driver`/`App`).
- `@teslemetry/api` → `test/support/teslemetry-api-stub.js`. Call its
  `configureTeslemetryStub(factory)` before triggering a build to control
  `createProducts()` timing/outcome and drive the returned `sse` EventEmitter
  (see `test/app-connection-lifecycle.test.ts`). It re-exports the *real*
  `getTariffPeriods` by relative path so tariff tests use real window math.

`npm test` resolves modules from this repo's root `node_modules`, so it can
never catch a dependency missing from the *packaged* bundle Homey uploads.
`npm run smoke:packaged-build` closes that gap - see the header of
`scripts/smoke-test-packaged-build.mjs`.

## Architecture

### Core Files

- `app.ts` - Entry point. OAuth2 client + Teslemetry SDK connection, owns the
  `Products` instance and all app-level Flow card registration.
- `api.ts` - OAuth status and token revocation endpoints
- `lib/TeslemetryOAuth2Client.ts` - PKCE OAuth2 flow, token storage/refresh
- `lib/TeslemetryDriver.ts` - Base driver: OAuth2 pairing/repair, eligibility
- `lib/TeslemetryDevice.ts` - Base device: capability sync, availability
- `docs/` - Vendored Homey SDK reference (capabilities, flow cards, custom
  capabilities). Consult before inventing a capability shape.

### Driver Pattern

Each device type (vehicle, battery, solar, gateway, wall-connector):
- `drivers/<type>/driver.ts` - Extends `TeslemetryDriver`, implements `onPairListDevices()`
- `drivers/<type>/device.ts` - Extends `TeslemetryDevice`, registers signal handlers and capability listeners

### Data Flow

1. `TeslemetryApp` creates `Products` from `@teslemetry/api`
2. Devices get their product instance (e.g. `this.homey.app.products.vehicles[vin]`)
3. Incoming: `vehicle.sse.onSignal("SignalName", cb)` → `this.update(capability, value)`
4. Outgoing: `registerCapabilityListener` → `vehicle.api.methodName()`

### Homey Compose

`.homeycompose/` generates `app.json` at build time:
- `.homeycompose/app.json` - Base app manifest (edit this, never `app.json`)
- `.homeycompose/capabilities/` - Custom capability definitions (base capabilities only, NOT subcapabilities)
- `.homeycompose/flow/` - App-level flow cards
- `.homeycompose/drivers/` - Driver capability configurations
- `drivers/<type>/driver.flow.compose.json` - Driver-scoped flow cards

### Subcapability Flow Cards

Homey does **not** auto-generate flow cards for subcapabilities (e.g.
`alarm_generic.off_grid`, `onoff.charge_grid`); define them manually in
`drivers/<type>/driver.flow.compose.json`. Do **not** create files like
`.homeycompose/capabilities/alarm_generic.off_grid.json` - the `.` in a
capability name is reserved and fails validation.

Card ids follow `<capability>.<sub>_<state>`:
- **Boolean triggers** (`alarm_generic`, `onoff`): `_true` / `_false`
- **On/off actions**: `_on` / `_off` / `_toggle`
- **Other boolean capabilities**: Homey auto-wires a manually-defined
  subcapability action only when `<action>` is one of the *base* capability's
  own `$flow.actions` ids - not always `on`/`off`. Check
  `node_modules/homey-lib/assets/capability/capabilities/<cap>.json` before
  naming one. (`windowcoverings_closed` uses `close`/`open`/`toggle`, hence
  `windowcoverings_closed.tonneau_close`.)

### Flow Card Scoping (app-level vs driver-scoped)

A capability ID is not unique across drivers (`measure_power` exists on Solar,
Gateway and Powerwall), and an app-level device `filter` matches on capability
ID alone.

- **App-level** (`.homeycompose/flow/`): only for capability IDs unique to one
  driver (`grid_buy_rate`, `backup_reserve`). Every app-level card **must**
  declare a `device` arg with a `filter` - without it, energy-only users see
  vehicle cards and vice versa.
- **Driver-scoped** (`driver.flow.compose.json`): for any card that must be
  pinned to one driver/capability pair. Homey Compose auto-unshifts a
  `driver_id`-filtered `device` arg, so the source JSON **must not** declare
  its own `device` arg; add `"$filter": "capabilities=<cap>"` to the card
  instead when it also needs a capability filter. The auto-injected arg has no
  `title`, so a driver-scoped `titleFormatted` **must not** reference
  `[[device]]` (`homey app validate` rejects it) - word it around the other
  args, e.g. `"Rises above [[watts]] W"`.

`titleFormatted` is required by the verified level for any card with args
beyond `device`, at either scope. Capability-gated cards (e.g. seat
heater/cooler in `drivers/vehicle/driver.flow.compose.json`) use the same
`drivers/vehicle/capabilityGating.ts` predicate the device capabilities use, so
pairing and Flow-card visibility can't disagree.

## Key Patterns

### Checking HA Parity

Capability choice, units and semantics mirror the Teslemetry Home Assistant
integration rather than the raw `@teslemetry/api` field shape. A checkout of
`home-assistant/core` lives at `~/firstmate/projects/hass-teslemetry`; grep
`homeassistant/components/teslemetry/{sensor,binary_sensor,switch,number}.py`
and `strings.json` for the field before designing a new Homey capability. A
field with no HA entity there generally belongs in the skip list, not invented
as a Homey-only shape.

### Commands: `action()` / `vehicleAction()`

**Never await a raw SDK command** in a capability listener or Flow action - they
can take a minute. Always return `this.action(...)` / `this.vehicleAction(...)`,
which race the command against a fixed 9s `ACTION_TIMEOUT`:

```typescript
this.registerCapabilityListener("locked", async (value) =>
  this.vehicleAction(
    value ? this.vehicle.api.lockDoors() : this.vehicle.api.unlockDoors(),
  ),
);
```

- **Do not raise `ACTION_TIMEOUT`** - it is deliberately just under Homey's own
  ~10s flow-card cap. When the timeout wins, the card reports success while the
  command is still in flight; if that command later rejects, `action()` logs it
  via `this.error(...)`. That log is the only trace of a silent failure - never
  remove or downgrade it.
- Every vehicle SDK command resolves `{ response: { result, reason? } }` and
  Homey only sees resolve-vs-reject, so **every** vehicle command must route
  through `VehicleDevice.vehicleAction()`, which validates `response.result`
  via `handleApiResponse`. Never hand-roll `.then(this.handleApiResponse)`.
  `wakeUp()` is the sole exemption (its response is the vehicle state payload,
  and `vehicleAction()`'s generic constraint rejects it at compile time) - call
  `this.action(this.vehicle.api.wakeUp())` for that one.
- Energy-site commands (`this.site.api...`) have a different, less consistent
  response shape and call the base `action()` directly; `vehicleAction()` is
  vehicle-only.
- `handleApiResponse` / `handleApiError` (the latter marks the device
  `"auth"`-unavailable on `invalid_token`/`subscription_required`) are used
  internally by these wrappers; call them directly only for a command that
  bypasses both.

### Capability Updates

`update()` no-ops on unsupported capabilities: `this.update("measure_battery", v)`.

SSE signal handlers routinely discard the returned Promise, so `update()` and
`updateWithThresholdTriggers()` **must never reject** - each wraps its whole
body in one top-level `try`/`catch` logging via `this.error`. This is a single
containment boundary, not per-call-site `.catch()` scatter; a detached
`trigger()` inside either method still keeps its own `.catch(this.error)` since
that Promise is never returned. See `test/update-boundary-containment.test.ts`.

### Cumulative Energy Meters

Homey's energy tab uses `cumulative: true` `meter_power.*` capabilities, whose
values **must be monotonically increasing** - a decrease breaks energy tracking
and flow visualization.

The `energy_totals` SSE event carries per-type daily totals (midnight to now,
already summed server-side). `TeslemetryDevice.updateCumulativeMeter()`
converts those into monotonic values, tracking a persistent offset across day
boundaries via the device store (`meter_<capability>_state`), keyed on the date
derived from the event's `createdAt` (UTC - `energy_totals` carries no per-site
local timestamp). Callers must pass a zero-padded ISO `YYYY-MM-DD` date.
`test/cumulative-meter.test.ts` is the behavioral contract.

### Non-Cumulative "Today" Totals (Insight gauges)

Each `*_today` capability is a plain (non-`cumulative`) gauge with
`insights: true` that must read 0 from local midnight until the day's first
activity. `energy_totals` only pushes on change, so each owning device runs its
own timer - scheduled via `msUntilNextLocalMidnight()` (`lib/localMidnight.ts`)
off the site's `installation_time_zone` from `site_info`/`siteInfoDocument`,
**not** `this.homey.clock.getTimezone()` (the Homey box's own location) - that
force-resets the capability at the boundary and reschedules itself.
Per-device duplication is the convention here, not a shared base-class helper.

**Every recurring `homey.setTimeout` reschedule body must wrap its callback in
`try`/`catch`** (this timer and `PowerwallDevice`'s `tariffTimer`) - an
unguarded throw crashes the whole app process on its next fire.

| Capability | Device | `energy_totals` field |
| --- | --- | --- |
| `solar_generation_today` | Solar | `total_solar_generation` |
| `grid_imported_today` | Gateway | `grid_energy_imported` (no `total_` prefix) |
| `grid_exported_today` | Gateway | `total_grid_energy_exported` |
| `home_usage_today` | Gateway | `total_home_usage` |
| `battery_charged_today` | Powerwall | `total_battery_charge` |
| `battery_discharged_today` | Powerwall | `total_battery_discharge` |

Field names come from `@teslemetry/api`'s `ENERGY_HISTORY_TOTAL_FIELDS`, which
mirrors HA's default-enabled energy-history sensors. Per-source breakdown
fields (`battery_energy_imported_from_solar`, generator fields) are disabled by
default in HA too and deliberately not surfaced. These gauges are additive -
every `*_today` handler still updates the `meter_power*` cumulative meter too.

Boundary/repro patterns: `test/local-midnight.test.ts`,
`test/solar-generation-today.test.ts`, `test/gateway-live-status.test.ts`,
`test/battery-site-info.test.ts`.

### Grid Tariff Rate (`grid_buy_rate` / `grid_sell_rate`)

`PowerwallDevice.recomputeTariffRates` resolves the live buy/sell rate via
`getTariffPeriods` from `@teslemetry/api` (>= 0.11.0 vendors and re-exports it
from `tesla-fleet-api` - no separate dependency). The SSE protocol splits
`tariff_content_v2` out of a now-slim `site_info` (a `null` body means the
tariff was removed), so the device subscribes to **both** events and re-reads
`site.sse.siteInfoDocument` - the SDK's merged view - rather than reassembling
them. `siteInfoDocument` is typed opaque, so tariff data needs an
`as unknown as TariffContentV2` cast.

- A period boundary arrives with the clock, not an SSE event, so
  `recomputeTariffRates` retains the last-seen document/timezone and schedules
  a timeout at `getTariffPeriods`' own `resolution.nextChange`. Every call
  clears any pending timer first, so a fresh event always beats a stale
  boundary; the timer is cleaned up in `onUninit` via `pollingCleanup`.
- When the tariff is absent or unresolvable (no timezone, no matching season),
  `clearTariffRates` unsets both capabilities *and* their currency `units`
  rather than leaving a stale price in place.
- Both are plain (non-dotted) custom capabilities - a base capability name may
  not contain `.`, and Homey has no system pricing capability. Currency varies
  per site and is unknown at compose time, so `units` is set at runtime via
  `setCapabilityOptions`.

### Device `onInit` Ordering ("registered but dead")

Every device stream (`site.sse`/`vehicle.sse` `.on`/`onSignal`) replays the
last cached payload **synchronously** on registration. An uncaught throw while
processing that replay propagates out of the still-synchronous part of
`onInit`, so nothing registered after it ever runs - the device is paired but
permanently unresponsive.

Register essential listeners (state/connectivity/live SSE and all
`registerCapabilityListener` command listeners) **before** anything replaying a
less-trusted cached value, and guard the fallible replay. See
`PowerwallDevice.onInit` (guards `recomputeTariffRates`) and
`VehicleDevice.onInit` (`registerCommandCapabilityListeners()` first, fallible
`registerSignalListeners()` wrapped). `VehicleDevice`'s private `onSignal()`
wrapper further isolates each individual signal (see `signalHandlerFailures`).

This only protects against a *synchronous* throw. An `async` handler never
throws synchronously - the rejection surfaces later as an unhandled rejection
unless the async boundary contains it itself.

### Missing or Ineligible Products

A saved device's product id (site id, VIN, wall connector DIN) can stop
resolving in `products`, or resolve but no longer be eligible. In **either**
case every driver's `onInit` returns early: nothing assigned, zero SSE
listeners, zero command listeners, and the device marked unavailable via
`markUnavailable(reason, message)` with an accurate message (never the
misleading `error.invalid_refresh_token`). Recovery is symmetric - a later
successful bind clears it.

- Eligibility is revalidated at bind/rebind only (not during an uninterrupted
  cached `Products` generation). `checkVehicleEligibility()` /
  `isVehicleEligible()` / `isEnergySiteEligible()` in `lib/TeslemetryDriver.ts`
  are the single source of truth, shared by pairing and every
  `resolveAndBindVehicle()`/`resolveAndBindSite()` so the two can't drift.
  Vehicle: `access && fleet_telemetry && !polling`. Energy: `access` only
  (energy metadata exposes no telemetry/polling equivalent). Messages name the
  specific failed condition (`error.vehicle_access_required`,
  `error.vehicle_telemetry_unavailable`, `error.vehicle_polling_mode`,
  `error.energy_site_access_required`).
- There is **no product-binding repair/rebind flow**: the device stays honestly
  unavailable and the user deletes and re-pairs. Do not add store-backed
  binding overrides, identity-repair views, or repair-candidate matching -
  Homey's generic OAuth repair flow only restores account authorization.
- Product ids come from `getSiteId()` / `getVin()` / `getDin()`, resolved from
  the immutable pairing `data` - never `getData()` directly. `EnergyDetails.id`
  is a `number`, so pairing `data.id` (Wall Connector: `data.site`) keeps the
  raw numeric id; changing its type would make an already-paired device look
  unpaired (Homey's dedup compares `data` verbatim). `getSiteId()`
  canonicalizes with `String(...)` for string-keyed registry lookups.
- Wall Connector also validates its DIN's continued presence: its `live_status`
  handler counts consecutive events missing its DIN, skipping the first
  `DIN_MISS_GRACE_EVENTS` after a bind, then marks `"connector"` unavailable (a
  distinct reason from `"binding"`) after `DIN_MISS_THRESHOLD` more.
- **`onUninit()` must be safe after any of these early returns** - a missing
  product never assigns the fields a normal bind would. Guard with
  `this.vehicle?.sse`, a `pollingCleanup` initialized to `[]` at declaration,
  and optional chaining at every use site.

Tests: `test/energy-driver-pairing.test.ts`,
`test/device-oninit-ineligible-product.test.ts`,
`test/wall-connector-availability.test.ts`,
`test/partial-init-uninit-safety.test.ts`.

### Firing Flow Trigger Cards

Homey does not reliably auto-fire trigger cards for this app's capabilities, so
every trigger is fired explicitly from device code - **always** guarded by
comparing old value to new, never firing without a prior value (no baseline) or
on a repeated identical value.

- **Simple 1:1 capability-changed cards** (`<capability>_changed`, token name
  matches the capability): add the capability to
  `TeslemetryDevice.CHANGE_TRIGGER_CAPABILITIES`; `update()` fires it whenever
  `setCapabilityValue` changes the value from a known *persisted* prior value.
  Numeric-token cards must **also** be in `NUMERIC_CHANGE_TRIGGER_CAPABILITIES`
  - `update()` still writes the value but suppresses the trigger unless the new
  token is a finite number. See `test/capability-change-triggers.test.ts`.
- **Value-specific branching** (one raw signal fanning out to differently named
  cards, e.g. `charging_started` vs `charging_complete` vs `plugged_in` off
  `DetailedChargeState`): track the previous raw value in a private field and
  call `getDeviceTriggerCard(id).trigger(this, tokens).catch(this.error)`. See
  `VehicleDevice.handleDetailedChargeState`.
- **Threshold/argument-gated cards**: fire on every real change with a `state`
  object (`{ previous, current }`) as `.trigger()`'s third argument, and
  register a `registerRunListener` in `app.ts` comparing `args` against
  `state`. For a numeric *capability*, use
  `TeslemetryDevice.updateWithThresholdTriggers()` rather than hand-rolling -
  `app.ts`'s `registerThresholdCards()` wires the above/below/condition
  listeners for a `(cardPrefix, capability, argName)` triple.
- **Boolean system capabilities with their own `$flow`** (any `alarm_*`) are
  the exception: Homey auto-fires `<cap>_true`/`<cap>_false` and the plain
  `<cap>` condition on every `update()` change - no listener or `.trigger()`
  needed, and firing one manually would double-run every flow built on it. A
  *subcapability* still needs its own manual definitions. For a custom token or
  clearer name, define a separate explicitly-fired trigger instead (see
  `wall_connector_fault_code`, `vehicle_arrived_home`/`vehicle_left_home`).

### Vehicle Location, Presence and Seat Capabilities

All of these depend on signals that simply never arrive without the
`vehicle_location` scope or on older firmware. The contract is
**honest-unknown**: leave the capability unset/`null`; never substitute a
default, throw, or mark the device unavailable.

- **`alarm_presence` / `alarm_generic.at_work`** pass Tesla's own
  `LocatedAtHome`/`LocatedAtWork` booleans straight through - these are genuine
  Fleet Telemetry fields (2024.44.32+), not a Homey-side geofence, and need no
  location math or geolocation permission. `handleLocatedAtHome` tracks the
  previous value in `previousLocatedAtHome` rather than reading it back via
  `getCapabilityValue()` - `update()` writes asynchronously, so a second signal
  arriving first would see a stale value and mis-fire
  `vehicle_arrived_home`/`vehicle_left_home`.
- **`measure_latitude` / `measure_longitude`** expose raw coordinates from the
  same `Location` signal used internally for window control. **Never** fall
  back to `{ latitude: 0, longitude: 0 }` (the internal-only default for window
  math is a real, misleading coordinate) - only write on a genuine `Location`.
  Homey has no location primitive, so both are `"uiComponent": null` (readable
  via API/Insights/Flow, not shown on the tile).
- **`measure_distance.home`** (Distance From Home) is haversine (`lib/haversineDistance.ts`) between
  the last `Location` and `this.homey.geolocation` (requiring
  `homey:manager:geolocation`, this app's only declared permission).
  `updateDistanceFromHome()` writes `null` - never `0` or a stale figure -
  whenever either side is unknown, and the `distance_from_home` condition
  **fails closed** on `null`; a confidently wrong zero would fire a gate
  automation. It only recomputes on a live `Location` event, so it does not
  track a later change to the hub's own position. `alarm_presence` remains the
  authoritative "is it home".
- **`driver_seat_occupied` / `alarm_generic.driver_unbuckled`**:
  `DriverSeatBelt`'s raw value is *buckle status*
  (`BuckleStatusLatched`/`Unlatched`/`Unknown`/`Faulted`), **not** "belt
  fastened" - an unlatched belt in an empty seat is not an alarm.
  `VehicleDevice` tracks occupancy and latch state independently (ignoring
  `Unknown`/`Faulted`) and `updateDriverUnbuckledAlarm()` only sets the alarm
  once both are known, true only when occupied AND unlatched. No metadata flag
  exposes "has seat sensor", so both register unconditionally.

Tests: `test/vehicle-presence.test.ts`,
`test/vehicle-distance-from-home.test.ts`,
`test/vehicle-driver-seat-location.test.ts`.

### TPMS Warning Level (`tpms_warning`)

`TpmsSoftWarnings`/`TpmsHardWarnings` are per-tire boolean objects;
`VehicleDevice` aggregates both across all four tires into one custom enum
capability (`off`/`soft`/`hard`, hard beats soft beats off) rather than eight
per-wheel alarms. Three states, so it is a plain
`CHANGE_TRIGGER_CAPABILITIES` entry, not an `alarm_generic` subcapability.
`TpmsLastSeenPressureTime*` is not surfaced - it reports as though the reading
time were Pacific Time regardless of the vehicle's real timezone.

### Connection Lifecycle (`app.ts`)

`app.ts` owns one shared, generation-safe pipeline for building/rebuilding
`teslemetry`/`products`:

- **`initializeTeslemetry(forceRebuild?)`** is single-flight: every caller
  (boot, `getTeslemetry()`/`getProducts()`, the startup retry timer, a
  token-refresh rebuild) chains onto one `initChain`, so builds never run
  concurrently and no caller observes a half-built generation. `forceRebuild`
  always builds fresh; a plain call is a no-op once ready.
- **`doInitialize()`** publishes to `this.teslemetry`/`this.products` only
  after `createProducts()` fully succeeds, and closes the previous
  generation's stream only *after* the new one has started, so a rebuild never
  leaves a gap with no active stream. `this.generation` is bumped on every
  publish/cleanup and every stream handler captures its own generation and
  no-ops once superseded, so a straggler event from a dead SDK can't mutate
  current state.
- **`scheduleStartupRetry()`** covers a transient boot-time `createProducts()`
  failure with bounded exponential backoff (`STARTUP_RETRY_BASE_MS` →
  `STARTUP_RETRY_MAX_MS`), cleared on any successful build, never scheduled
  without a valid token. `isReady()` reflects whether a generation was ever
  fully published; devices failing to bind before then use the `"startup"`
  availability reason, not a misleading "product not found".
- **Stream freshness watchdog**: the SDK emits `disconnect` before every
  reconnect regardless of cause, so `handleStreamDisconnect()` starts a
  `STREAM_STALE_GRACE_MS` timer on the first one; if it fires with no genuine
  data in between, every bound device is marked unavailable with reason
  `"stream"`. Each device recovers independently on its **own** product's next
  genuine (non-`isCache`) event - never on a blanket reconnect or the SDK's
  optimistic `connect` event.
- **`rebindAllDeviceProducts()`** walks every driver's `getDevices()` and calls
  `rebindProduct()` after each successful build - without it, an already-paired
  device keeps listening on the old, dead per-product stream.
- **Token-save recovery**: `TeslemetryOAuth2Client.saveToken()` invokes a plain
  `onTokenSaved` callback, **not** a custom event on `this.app.homey` - `App`
  and `Homey` are distinct EventEmitters with no bridging for custom events, so
  that hop never fires. `app.ts` assigns `onTokenSaved` to force the same
  `initializeTeslemetry(true)` rebuild every other recovery path uses.

Tests: `test/app-connection-lifecycle.test.ts`, `test/oauth2-client.test.ts`,
`test/product-rebind-recovery.test.ts`.

### Availability Reasons and Credential Teardown

Unavailability is always one typed `AvailabilityReason` (`"startup" |
"binding" | "eligibility" | "stream" | "auth" | "connector"`, defined in
`lib/TeslemetryDevice.ts`) set via `markUnavailable(reason, message)` /
`clearAvailabilityReason(reason)` - **never** a raw
`setUnavailable()`/`setAvailable()`. `clearAvailabilityReason()` is a no-op
unless the device's *current* reason matches, so one recovery signal can never
paper over an unrelated cause.

`teardownCredentials(message)` is the single path for every credential-removal
event (the SSE `auth_failure` terminal event, and `api.ts`'s
`deleteOAuthToken` → `app.disconnectAccount()`): close the stream, clear the
token, mark every device `"auth"`-unavailable. Only that device's own genuine
post-reauth data event clears it (`handleGenuineStreamEvent()`, shared with the
freshness watchdog), so a device-level `handleApiError()` auth failure and an
app-level stream auth failure recover through the identical per-device path.

### SSE Topic Selection

`app.ts`'s `SSE_TOPICS` is an exact allowlist passed to `Teslemetry`'s
`stream.topics` option. Adding a signal from an already-selected topic needs no
change; consuming a wire event not in that list does.

### Stale Device References (Flow cards)

A saved Flow argument can outlive its device: re-pairing the same Tesla product
gives Homey a new runtime device ID while this app returns the same
`deviceData.id`. Deserializing that argument calls the SDK's private
`Driver.getDeviceById`, which throws **synchronously before any app code runs**
- uncaught, that crashes the whole `com.teslemetry` process.

Two coordinated guards close this:

- `TeslemetryDriver.getDeviceById` is overridden to scan `getDevices()`
  comparing runtime `getId()` (not `getDevice({id})`, which compares pairing
  `deviceData`) and return `undefined` on a miss, rate-limited per missing ID.
  This targets an undeclared/private SDK method - re-verify after any Apps SDK
  bump (see the comment on the override).
- Every app-owned Flow run listener in `app.ts` must treat `args.device` as
  possibly `undefined`: actions call `requireFlowDevice()` to reject with a
  user-actionable error; conditions and device-trigger predicates return
  `false`. Never let a stale device silently no-op an action or match by
  accident.

Separately, `TeslemetryDevice.isLive()` (`!destroyed` AND still in
`driver.getDevices()`) must be checked immediately before every
`.trigger(this, ...)` this app fires. `destroyed` alone is insufficient: the
SDK removes a deleted device from the driver's map *before* calling
`onUninit()`, so an in-flight capability write can resume in that gap. See
`test/device-liveness.test.ts` and `test/flow-listener-stale-device.test.ts`.

## Tooling

### Lint

`npm run lint` runs [oxlint](https://oxc.rs) (native Rust/TS parser). There is
no ESLint config in this repo. `.oxlintrc.json` mirrors what
`eslint-config-athom` enforced, minus two categories with no oxlint
equivalent: pure formatting rules (oxlint expects a formatter to own these;
none is installed) and a few unported rules (`no-restricted-syntax`,
`import/no-extraneous-dependencies`, `import/order`, most CJS-oriented
`eslint-plugin-node` rules - low impact in an ESM-only app).

### TypeScript

`tsconfig.json` sets `compilerOptions.types` explicitly to `["node", "homey"]`
because TypeScript 7 dropped automatic inclusion of everything under
`@types/*`. Add any package whose types are used *ambiently* (not via an
explicit `import`) to that list, or its globals stop resolving and the build
fails.

### Dependency Vulnerabilities (`npm audit`)

The runtime dependencies (`@teslemetry/api`, `source-map-support`) have no
transitive dependencies, so every audit finding traces to the `homey`
devDependency - toolchain hygiene, not runtime exposure. `package.json`'s
`overrides` pin several of `homey`'s transitive deps past their advisory-fixed
versions; verify any new override with `npm run build && npm test &&
npm run lint && npm run app:validate`, since forcing a transitive major can
break the CLI in ways this suite can't catch. The remaining
`socket.io-client`/`engine.io-client`/`parseuri` findings (pinned by
`homey-api`) are deliberately left alone: that client only talks to a paired
Homey box during `homey app run`, a path CI cannot exercise, and
`npm audit fix --force`'s only route is downgrading `homey` itself. This is an
upstream (Athom) gap; re-check after any `homey`/`homey-api` release.

### Release Workflow

Cutting a release is one `workflow_dispatch` on
`.github/workflows/homey-app-release.yml` (version bump type + changelog):
`version` → `validate` (reusable `homey-app-validate.yml`, checked out at the
exact commit `version` produced) → `publish`. Only `publish` runs under the
`production` GitHub Environment, whose required reviewer is the run's single
approval gate, so the candidate is already versioned and validated by the time
anyone approves. The `version` job is idempotent (checks before tagging and
before creating the Release, and skips re-running the bump action on a same-run
retry), so a failed job resumes rather than double-bumping. Athom's publish
lands the build as a draft in Athom's dashboard; promoting it there is a
separate manual step.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
