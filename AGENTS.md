## Project Overview

Homey app for Teslemetry: Tesla vehicles and energy products (Powerwall, Solar,
Wall Connector, Gateway) over Server-Sent Events. No polling.

## Commands

```bash
npm run build                 # Compile TypeScript to .homeybuild/
npm test                      # Build, then run test/*.test.ts with Node's test runner
npm run lint                  # oxlint (no ESLint in this repo)
npm run dev                   # Run app on local Homey
npm run app:validate          # homey app validate --level verified
npm run smoke:packaged-build  # Verify every driver loads from a real .homeybuild bundle
```

Always run `npm run app:validate` before committing.

### Testing

- `npm test` runs against the **compiled output** in `.homeybuild/`, not the TS
  sources. Tests import `../.homeybuild/...`.
- `test/support/loader.mjs` redirects `homey` and `@teslemetry/api` to stubs in
  `test/support/`. Drive the SDK via `configureTeslemetryStub(factory)`.
- `npm test` resolves from the repo root `node_modules`, so it cannot catch a
  dependency missing from the packaged bundle. `smoke:packaged-build` does.
- `app.json` is generated but committed. Rebuild it on every compose change;
  `npm test` does not regenerate it.

## Homey Compose

- Edit `.homeycompose/app.json`, never the root `app.json`.
- `.homeycompose/capabilities/` holds base capabilities only. Never create a
  file such as `alarm_generic.off_grid.json`: `.` in a capability name is
  reserved and fails validation.
- Consult the vendored Homey SDK reference in `docs/` before inventing a
  capability shape.

### Flow cards

- Homey does **not** generate flow cards for subcapabilities
  (`alarm_generic.off_grid`, `onoff.charge_grid`). Define them in
  `drivers/<type>/driver.flow.compose.json`.
- Card ids: `<capability>.<sub>_<state>`. Boolean triggers use `_true`/`_false`;
  on/off actions use `_on`/`_off`/`_toggle`. For other boolean capabilities,
  `<action>` must be one of the base capability's own `$flow.actions` ids -
  check `node_modules/homey-lib/assets/capability/capabilities/<cap>.json`.
- A capability ID is not unique across drivers (`measure_power` is on three).
  App-level cards (`.homeycompose/flow/`) are only for IDs unique to one
  driver, and **must** declare a `device` arg with a `filter`.
- Driver-scoped cards get an auto-injected `device` arg: do **not** declare
  one, use `"$filter": "capabilities=<cap>"` instead, and do **not** reference
  `[[device]]` in `titleFormatted` (validation rejects it).
- The verified level requires `titleFormatted` on any card with args beyond
  `device`.
- Capability-gated cards use `drivers/vehicle/capabilityGating.ts`, the same
  predicate as the device capabilities.

## Rules

### HA parity

Capability choice, units and semantics mirror the Teslemetry Home Assistant
integration, not the raw `@teslemetry/api` shape. Grep
`~/firstmate/projects/hass-teslemetry/homeassistant/components/teslemetry/`
before designing a capability. A field with no HA entity goes in the skip
list; do not invent a Homey-only shape.

### Commands

- **Never await a raw SDK command** in a capability listener or Flow action.
  Return `this.vehicleAction(...)` (vehicle) or `this.action(...)` (energy
  site). Exception: `wakeUp()` uses `this.action(...)`.
- Register capability listeners with `registerCommandListener`, not
  `registerCapabilityListener`.
- **Do not raise `ACTION_TIMEOUT`** (9s). It is deliberately just under
  Homey's ~10s flow-card cap. Never remove or downgrade the `this.error(...)`
  log of a late rejection: for a Flow card it is the only trace of a failure.
- Never hand-roll `.then(this.handleApiResponse)`.

### Capability updates and triggers

- `update()` and `updateWithThresholdTriggers()` **must never reject**: SSE
  handlers discard their Promise. Keep the single top-level `try`/`catch`.
- Fire every trigger card explicitly, and only on a real change from a known
  prior value. Never fire without a baseline or on a repeated value.
- Simple `<capability>_changed` cards: add the capability to
  `CHANGE_TRIGGER_CAPABILITIES` (and `NUMERIC_CHANGE_TRIGGER_CAPABILITIES` for
  numeric tokens). Threshold cards: use `updateWithThresholdTriggers()` and
  `registerThresholdCards()` in `app.ts`.
- **Exception:** Homey auto-fires `alarm_*` system capabilities. Firing one
  manually double-runs every flow. Subcapabilities still need manual cards.
- Check `isLive()` immediately before every `.trigger(this, ...)`. `destroyed`
  alone is not enough: the SDK drops a deleted device before `onUninit()`.
- When a trigger depends on the previous value, track it in a private field.
  Do not read it back with `getCapabilityValue()`: `update()` writes async.

### Energy meters

- `cumulative: true` `meter_power.*` values **must increase monotonically**.
  Use `updateCumulativeMeter()`. Key it on the event's installation-local
  `date` (`energyTotalsDay()`), never `createdAt` (UTC bucket end).
- `*_today` gauges reset at local midnight using the site's
  `installation_time_zone`, **not** `this.homey.clock.getTimezone()`.
- Every recurring `homey.setTimeout` reschedule body must wrap its callback in
  `try`/`catch`. An unguarded throw crashes the whole app process.

### Device lifecycle

- Device streams replay the cached payload **synchronously** on registration.
  In `onInit`, register essential listeners (state, connectivity, live SSE,
  all command listeners) **before** anything that replays a less-trusted cached
  value, and guard that replay. Otherwise one throw leaves the device paired
  but dead.
- If a product id no longer resolves or is ineligible, `onInit` returns early
  with zero listeners and `markUnavailable(...)` with an accurate message.
  `onUninit()` must be safe after that early return (optional chaining,
  `pollingCleanup = []`).
- Eligibility lives only in `checkVehicleEligibility()` /
  `isEnergySiteEligible()` in `lib/TeslemetryDriver.ts`, shared by pairing and
  rebind.
- If every vehicle on the account is ineligible, pairing throws the specific
  reason. An eligible-in-Teslemetry vehicle without Fleet Telemetry must never
  look like "no vehicles found".
- **No product-binding repair flow**: the device stays
  unavailable and the user re-pairs. Do not add binding overrides,
  identity-repair views or repair-candidate matching.
- Get product ids via `getSiteId()` / `getVin()` / `getDin()`, never
  `getData()`. Do not change pairing `data.id` from a number: Homey dedups on
  `data` verbatim, so paired devices would look unpaired.
- Set unavailability only via `markUnavailable(reason, message)` /
  `clearAvailabilityReason(reason)`, never raw `setUnavailable()` /
  `setAvailable()`.
- Credential removal goes only through `teardownCredentials(message)`.

### Connection and auth

- Only a token save with `reason: "grant"` rebuilds the connection. A
  `"refresh"` must **not**: it tears down a working SSE stream.
- `App` and `Homey` are separate EventEmitters. A custom event on
  `this.app.homey` never reaches the app; use a direct callback.
- A device recovers from `"stream"`/`"auth"` unavailability only on its own
  product's next genuine (non-`isCache`) event, never on a reconnect or the
  SDK's `connect` event.
- `SSE_TOPICS` in `app.ts` is an exact allowlist. A wire event from a new
  topic needs an entry.
- `site_id` arrives on the wire as a JSON number but sites are keyed by string.
  `String()` it wherever app code reads it from a raw payload.
- Stream reconnect backoff belongs to `@teslemetry/api`; the app has no hook
  to bound it. Fix it upstream.

### Flow card arguments

- A saved Flow argument can outlive its device. Every Flow run listener in
  `app.ts` must treat `args.device` as possibly `undefined`: actions call
  `requireFlowDevice()`; conditions and trigger predicates return `false`.
- `TeslemetryDriver.getDeviceById` overrides a private SDK method. Re-verify it
  after any Apps SDK bump.

### Vehicle location, presence and seats

- Honest-unknown: if a signal never arrives, leave the capability unset. Never
  substitute a default, throw, or mark the device unavailable.
- Never write `{ latitude: 0, longitude: 0 }` to `measure_latitude` /
  `measure_longitude`. `measure_distance.home` writes `null`, never `0`, when
  either position is unknown, and its condition fails closed on `null`.
- `DriverSeatBelt` `true` means **unbuckled**, not fastened. `null` is unknown.
- Do not surface `TpmsLastSeenPressureTime*`: it reports Pacific Time
  regardless of the vehicle's timezone.

## Tooling

- `tsconfig.json` lists `compilerOptions.types` explicitly (TypeScript 7 no
  longer auto-includes `@types/*`). Add any package used ambiently.
- `npm audit` findings all come from the `homey` devDependency. Leave the
  `socket.io-client`/`engine.io-client`/`parseuri` findings alone (upstream
  Athom gap; `npm audit fix --force` downgrades `homey`). Verify any new
  `overrides` pin with build, test, lint and `app:validate`.
- Releases run only via `workflow_dispatch` on
  `.github/workflows/homey-app-release.yml`. Athom's publish lands a draft;
  promoting it in Athom's dashboard is a separate manual step.

## Maintaining this file

Keep only what an agent cannot learn by reading the code or config: commands,
non-obvious rules, safety boundaries and captain decisions. Target under 200
lines. Put deep task-specific knowledge in a repo skill.
