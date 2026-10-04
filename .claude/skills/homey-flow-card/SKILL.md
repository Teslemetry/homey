---
name: homey-flow-card
description: Use when adding or changing a Homey Flow card (trigger, condition or action) for a capability or subcapability in this app - card id naming, app-level vs driver-scoped placement, device filters, titleFormatted, and how each trigger gets fired.
---

# Add a Flow card for a capability

Reference: `docs/flow-cards.md` (vendored Homey SDK). Rebuild and commit
`app.json` after any compose change; `npm test` does not regenerate it.

## 1. Pick the scope

A capability id is not unique across drivers (`measure_power` is on Solar,
Gateway and Powerwall), and an app-level device `filter` matches on the
capability id alone.

- **App-level** - `.homeycompose/flow/{triggers,conditions,actions}/<id>.json`.
  Only for a capability id unique to one driver (`grid_buy_rate`,
  `backup_reserve`). The card **must** declare its own `device` arg with a
  filter, or energy-only users see vehicle cards and the reverse:
  ```json
  { "name": "device", "type": "device", "filter": "capabilities=backup_reserve" }
  ```
  `titleFormatted` may use `[[device]]` here.
- **Driver-scoped** - `drivers/<type>/driver.flow.compose.json`. For any card
  pinned to one driver, and for every subcapability card. Homey Compose
  injects a `driver_id`-filtered `device` arg, so:
  - Do **not** declare a `device` arg.
  - Add `"$filter": "capabilities=<cap>"` on the card when only devices with
    that capability may see it.
  - Do **not** put `[[device]]` in `titleFormatted`: the injected arg has no
    title and `homey app validate` rejects it. Word it around the other args,
    for example `"Rises above [[watts]] W"`.

At both scopes, the verified level requires `titleFormatted` on any card with
args beyond `device`.

## 2. Name the card

- Subcapabilities (Homey generates no cards for them): `<capability>.<sub>_<state>`.
  - Boolean triggers: `_true` / `_false` (`alarm_generic.off_grid_true`).
  - Condition: the bare subcapability id (`windowcoverings_closed.tonneau`).
  - On/off actions: `_on` / `_off` / `_toggle` (`onoff.charge_grid_on`).
  - Other boolean capabilities: the action suffix must be one of the base
    capability's own `$flow.actions` ids. Check
    `node_modules/homey-lib/assets/capability/capabilities/<cap>.json`
    (`windowcoverings_closed` gives `close`/`open`/`toggle`, so
    `windowcoverings_closed.tonneau_close`).
  - Homey wires these cards itself when the id follows this pattern. Do not
    add a `.trigger()` call or a run listener for them.
- Never create `.homeycompose/capabilities/<cap>.<sub>.json`: `.` is reserved
  in a capability name and fails validation.
- Simple change trigger: `<capability>_changed`, token name equal to the
  capability.
- Threshold triggers: `<prefix>_above` / `<prefix>_below`, plus a `<prefix>`
  condition.

## 3. Fire the trigger

Fire only on a real change from a known prior value, and check `isLive()`
immediately before each `.trigger(this, ...)`.

| Card kind | What to do |
| --- | --- |
| `<capability>_changed` | Add the capability to `CHANGE_TRIGGER_CAPABILITIES` in `lib/TeslemetryDevice.ts`. If the token is numeric, also add it to `NUMERIC_CHANGE_TRIGGER_CAPABILITIES`. `update()` then fires the card. |
| Numeric threshold | Write the value with `updateWithThresholdTriggers(cap, value, "<prefix>_above", "<prefix>_below", tokenName)` and add `this.registerThresholdCards("<prefix>", cap, argName)` in `app.ts`. |
| One signal to several named cards | Track the previous raw value in a private field (not `getCapabilityValue()`), then `this.homey.flow.getDeviceTriggerCard(id).trigger(this, tokens).catch(this.error)`. Examples: `VehicleDevice.handleDetailedChargeState`, `GatewayDevice.triggerFlow`. |
| Base `alarm_*` capability | Nothing. Homey fires `<cap>_true`/`_false` itself; a manual fire double-runs every flow. For a custom token or clearer name, add a separate explicitly fired card. |
| Subcapability | Nothing beyond the card definition (see step 2). |

## 4. Wire condition and action listeners in `app.ts`

- App-level actions: a `registerRunListener` that calls
  `this.requireFlowDevice(args.device).flow<Name>(...)`. That device method
  wraps the SDK call in `this.vehicleAction(...)` / `this.action(...)` (see
  `PowerwallDevice.flowSetBackupReserve`). Never await a raw SDK command.
- Conditions and trigger predicates: return `false` when `args.device` is
  missing, and fail closed on a `null` or non-finite value.

## 5. Capability-gated cards

If the capability is gated per vehicle (`drivers/vehicle/capabilityGating.ts`),
filter the card with `"$filter": "capabilities=<cap>"`. The card then shows
only on devices that got the capability from the same predicate.

## 6. Test and validate

- Card visibility per device: `test/vehicle-gated-flow-cards.test.ts`,
  `test/energy-capability-gates.test.ts` (both read the committed `app.json`).
- Firing rules: `test/capability-change-triggers.test.ts`,
  `test/power-threshold-triggers.test.ts`, `test/device-liveness.test.ts`.
- Stale device args: `test/flow-listener-stale-device.test.ts`.
- Run `npm run build`, `npm test`, `npm run lint`, `npm run app:validate`.
