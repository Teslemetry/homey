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

## 2. Duplicate flow trigger cards

**Gateway:** Duplicate "generic alarm turned on for" entries in 'when' cards.
**Powerwall:** Duplicate "turned on for" and "turned off for" entries in 'when' cards.

**Technical context:**
- Gateway has `alarm_generic.off_grid` and `alarm_generic.island` - Homey auto-generates trigger cards for each `alarm_generic` subcapability
- Battery has `alarm_generic.storm` - may also generate duplicate triggers
- May need custom trigger flow cards with clear labels instead of relying on Homey's auto-generated ones, or use `preventTag: true` / capability options to suppress auto-generation

## 3. No condition ('and') flow cards

Teslemetry does not appear as an option when adding an 'and' card in flows. There are zero condition cards defined in `.homeycompose/flow/conditions/`.

**Useful conditions to add:**
- Grid status (online/offline) - uses `alarm_generic.off_grid` on gateway
- Island mode active - uses `alarm_generic.island` on gateway
- Operation mode is X - uses `operation_mode` on battery
- Battery level above/below X% - uses `measure_battery` on battery
- Charge from grid enabled - uses `onoff.charge_grid` on battery
- Storm watch active - uses `alarm_generic.storm` on battery

## 4. Missing action ('then') flow cards for energy products

Current energy action cards: `set_allow_export`, `set_backup_reserve`, `set_operation_mode`.

**Missing actions:**
- Set charge from grid on/off - capability `onoff.charge_grid` exists on battery but has no flow card
- Set storm watch on/off - capability `onoff.storm` exists on battery but has no flow card

**Technical context:**
- `onoff.charge_grid` listener calls `site.api.gridImportExport()` with the inverted value
- `onoff.storm` listener calls `site.api.stormMode(value)`
- Flow card definitions go in `.homeycompose/flow/actions/`

## 5. Vehicle flow cards visible to energy-only users

David (no Tesla vehicle) sees vehicle-related items in the 'when' trigger card list. The `steering_wheel_heater_changed` trigger card does not have a device capability filter to hide it from users without vehicles.

**Technical context:**
- Action cards like `flash_lights` use `"filter": "capabilities=button.flash"` which correctly hides them
- Trigger card `steering_wheel_heater_changed` in `.homeycompose/flow/triggers/steering_wheel_heater_changed.json` needs a similar filter added
- Other trigger cards (`allow_export_changed`, `backup_reserve_changed`, `operation_mode_changed`) are energy-specific and fine

## 6. Grid status / power outage detection in flows

David requested a way to detect power outages in flows. The gateway capabilities exist (`alarm_generic.off_grid`, `alarm_generic.island`) and Homey auto-generates basic trigger cards for alarms, but:
- No condition card to check grid status (covered by issue #3)
- Auto-generated trigger card labels are generic ("Generic alarm turned on") rather than descriptive ("Grid power lost")
- May want dedicated trigger cards with clear naming: "Power outage detected", "Grid restored", "Island mode activated"
