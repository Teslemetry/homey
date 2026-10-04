---
name: homey-energy-today-gauge
description: Use when adding or changing an energy-site cumulative meter_power capability or a *_today Insights gauge fed by the energy_totals SSE event - field choice, day key, local-midnight reset timer.
---

# Add a cumulative meter or `*_today` gauge from `energy_totals`

The `energy_totals` SSE event carries per-type totals from local midnight to
now, already summed server-side. The api republishes it about every 5 minutes,
and publishes the closed prior day's final just after local midnight.

Reference implementation: `drivers/solar/device.ts`
(`handleEnergyTotals`, `scheduleMidnightReset`, `applySiteInfo`).

## 1. Pick the field

- Use a field from `@teslemetry/api`'s `ENERGY_HISTORY_TOTAL_FIELDS`, and only
  one that HA enables by default. Per-source breakdowns
  (`battery_energy_imported_from_solar`, generator fields) stay unsurfaced.
- Names are not uniform. Existing mapping:

| Capability | Device | `energy_totals` field |
| --- | --- | --- |
| `solar_generation_today` | Solar | `total_solar_generation` |
| `grid_imported_today` | Gateway | `grid_energy_imported` (no `total_` prefix) |
| `grid_exported_today` | Gateway | `total_grid_energy_exported` |
| `home_usage_today` | Gateway | `total_home_usage` |
| `battery_charged_today` | Powerwall | `total_battery_charge` |
| `battery_discharged_today` | Powerwall | `total_battery_discharge` |

- Values arrive in Wh. Divide by 1000 for kWh.

## 2. Declare the capabilities

- `*_today`: a base capability in `.homeycompose/capabilities/<name>.json`,
  `type: number`, `units: kWh`, `insights: true`, **not** `cumulative`. Copy
  `solar_generation_today.json`.
- Cumulative meter: `meter_power` or `meter_power.<sub>` in
  `drivers/<type>/driver.compose.json`, with the `energy` block that names it
  (see `drivers/gateway/driver.compose.json`).
- Add both to the driver's `capabilities` list. `ensureCapabilities()` adds
  them to already-paired devices.

## 3. Handle the event

```ts
const { date, current } = this.energyTotalsDay(event);
if (current) await this.update("<name>_today", total / 1000);
await this.updateCumulativeMeter("<meter_power cap>", total / 1000, date);
```

- Return early when the field is `null` or `undefined`.
- Write the `*_today` gauge **only** when `current` is true. Otherwise it
  shows yesterday's final after the midnight reset.
- Every `*_today` handler also updates its cumulative meter. The meter takes
  every event and orders days itself.
- Key the meter on `date` from `energyTotalsDay()` (installation-local,
  zero-padded `YYYY-MM-DD`), never `createdAt` (UTC bucket end, double-counts
  days outside UTC).
- Wrap the async handler: `(event) => handleEnergyTotals(event).catch(this.error)`.
  EventEmitter does not await listeners.

## 4. Reset at local midnight

The new day's first event arrives up to 5 minutes late, so each owning device
runs its own reset timer. Duplicate it per device; there is no shared helper.

- Timezone: the site's `installation_time_zone` from
  `this.site.sse.siteInfoDocument`, read in a `site_info` listener. Never
  `this.homey.clock.getTimezone()`.
- Delay: `msUntilNextLocalMidnight(this.now(), timeZone)` from
  `lib/localMidnight.ts`.
- Timer body, all inside `try`/`catch` (an unguarded throw crashes the app):
  1. `this.closeEnergyTotalsDay()`
  2. `await this.update("<name>_today", 0)` for each gauge the device owns
  3. Reschedule only if this timer is still the current one and `this.isLive()`.
- Clear the timer in `pollingCleanup`.
- If the device already has a timer, add the new gauge to its reset body. Do
  not add a second timer.

## 5. Order in `onInit`

Register `energy_totals` (and `live_status`) **before** the `site_info`
listener. `site_info` replays a cached value synchronously, and
`Intl.DateTimeFormat` throws on a malformed timezone. Guard the `site_info`
callback with `try`/`catch` so it cannot undo the essential listeners.

## 6. Test

Pattern tests to copy:

- `test/cumulative-meter.test.ts`: monotonic meter contract.
- `test/local-midnight.test.ts`: `msUntilNextLocalMidnight` and DST.
- `test/solar-generation-today.test.ts`, `test/gateway-live-status.test.ts`,
  `test/battery-site-info.test.ts`: gauge reset, prior-day final, timezone.

Run `npm run build`, `npm test`, `npm run lint`, `npm run app:validate`.
