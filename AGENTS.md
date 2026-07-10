## Project Overview

Homey app for Teslemetry. Provides real-time control and monitoring of Tesla vehicles and energy products (Powerwall, Solar, Wall Connector, Gateway) using Server-Sent Events (no polling).

## Commands

```bash
npm run build          # Compile TypeScript to .homeybuild/
npm run lint           # oxlint check (see .oxlintrc.json)
npm run dev            # Run app on local Homey
npm run app:validate   # Validate app (required before commit)
```

Always run `npm run app:validate` before committing changes.

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

The Tesla `energyHistory` API returns daily totals (midnight to now, 5-minute intervals). Use `updateCumulativeMeter()` in `TeslemetryDevice` to convert daily totals into monotonically increasing values. It tracks a persistent offset across day boundaries using Homey's device store, detecting day rollover by comparing the date from `time_series[0].timestamp`.

### Capability Updates

Use the `update()` method which safely handles unsupported capabilities:

```typescript
this.update("measure_battery", value);  // No-op if capability not present
```

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

Device availability is restored on the SDK's `state`/`data`/`errors`/
`alerts`/`connectivity` events, **not** on `connect` — `TeslemetryStream`
still emits `connect` optimistically, before the underlying HTTP request
even completes (it fires right after constructing the SSE generator, not
after the first byte), so it fires on every reconnect attempt regardless
of whether that attempt goes on to fail.

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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
