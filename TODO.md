# Homey Teslemetry - Outstanding Issues

Issues identified from beta tester feedback (David - Powerwall 2 / Gateway 2 user, no vehicle).

## ~~1. Energy flow visualization incorrect~~ DONE

The Homey energy tab shows energy flowing from the grid into the house even when no grid energy is being consumed. Solar and battery flows display correctly.

**Technical context:**
- Gateway driver (`drivers/gateway/device.ts`) provides `measure_power` (grid) and `measure_power.load` (house load)
- Gateway energy config uses `cumulative: true` with `meter_power.imported` / `meter_power.exported`
- Battery driver uses `homeBattery: true` with `meter_power.charged` / `meter_power.discharged`
- The house icon in Homey's energy tab may derive its flow from cumulative meter data rather than real-time `measure_power` values
- Need to investigate how Homey calculates the house flow arrows and whether the gateway's energy configuration is correctly representing grid import/export

## ~~2. Duplicate flow trigger cards~~ DONE

**Gateway:** Duplicate "generic alarm turned on for" entries in 'when' cards.
**Powerwall:** Duplicate "turned on for" and "turned off for" entries in 'when' cards.

**Resolution:** Added `driver.flow.compose.json` files with descriptive flow cards for all boolean subcapabilities on gateway, battery, and vehicle drivers. Homey uses these instead of auto-generating generic duplicates.

## ~~3. No condition ('and') flow cards~~ DONE

**Resolution:** Added 6 condition cards:
- Gateway subcapability conditions in `drivers/gateway/driver.flow.compose.json`: Grid offline/online (`alarm_generic.off_grid`), Island mode active/inactive (`alarm_generic.island`)
- Battery subcapability conditions in `drivers/battery/driver.flow.compose.json`: Charge from grid enabled/disabled (`onoff.charge_grid`), Storm watch alert active/inactive (`alarm_generic.storm`)
- App-level conditions in `.homeycompose/flow/conditions/`: Operation mode is X (`operation_mode_is`), Battery level above X% (`battery_level`)
- Run listeners registered in `app.ts` for `operation_mode_is` and `battery_level`

## ~~4. Missing action ('then') flow cards for energy products~~ DONE

Current energy action cards: `set_allow_export`, `set_backup_reserve`, `set_operation_mode`.

**Resolution:** Added action flow cards for `onoff.charge_grid` (on/off/toggle) and `onoff.storm` (on/off/toggle) in `drivers/battery/driver.flow.compose.json`.

## 5. Vehicle flow cards visible to energy-only users

David (no Tesla vehicle) sees vehicle-related items in the 'when' trigger card list. The `steering_wheel_heater_changed` trigger card does not have a device capability filter to hide it from users without vehicles.

**Technical context:**
- Action cards like `flash_lights` use `"filter": "capabilities=button.flash"` which correctly hides them
- Trigger card `steering_wheel_heater_changed` in `.homeycompose/flow/triggers/steering_wheel_heater_changed.json` needs a similar filter added
- Other trigger cards (`allow_export_changed`, `backup_reserve_changed`, `operation_mode_changed`) are energy-specific and fine

## 6. Grid status / power outage detection in flows

David requested a way to detect power outages in flows. The gateway capabilities exist (`alarm_generic.off_grid`, `alarm_generic.island`) and Homey auto-generates basic trigger cards for alarms, but:
- No condition card to check grid status (covered by issue #3)
- ~~Auto-generated trigger card labels are generic ("Generic alarm turned on") rather than descriptive ("Grid power lost")~~ DONE - descriptive trigger cards added in `drivers/gateway/driver.flow.compose.json`
