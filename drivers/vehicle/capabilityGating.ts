import type { VehicleDetails } from "@teslemetry/api";
import isCybertruck, { isModelSorX } from "./model.js";

type VehicleConfig = VehicleDetails["metadata"]["config"];

/** Capabilities only Cybertruck exposes; excluded from every other model. */
const CYBERTRUCK_ONLY_CAPABILITIES = new Set([
  "windowcoverings_closed.tonneau",
  "windowcoverings_set.tonneau",
  "powershare_status",
  "powershare_type",
  "powershare_stop_reason",
  "powershare_hours_left",
  "measure_power.powershare",
]);

/** Capabilities only Model S/X expose; excluded from every other model. */
const MODEL_S_X_ONLY_CAPABILITIES = new Set(["button.bioweapon"]);

/**
 * Capabilities gated on vehicle config metadata (seat cooling / rear seat
 * heater layout / sunroof / COP limit) rather than VIN, keyed to the config
 * field each one reads. Metadata can be temporarily unresolved (products not
 * loaded yet), and `/api/metadata` returns every config field as `null` when
 * the server can't read the vehicle's config - unlike VIN, which is always
 * known from pairing data/store.
 */
const METADATA_GATED_CAPABILITIES = new Map<string, keyof VehicleConfig>([
  ["seat_cooler.front_left", "has_seat_cooling"],
  ["seat_cooler.front_right", "has_seat_cooling"],
  ["seat_heater.rear_left", "rear_seat_heaters"],
  ["seat_heater.rear_right", "rear_seat_heaters"],
  ["seat_heater.rear_center", "rear_seat_heaters"],
  ["windowcoverings_closed.sunroof", "sun_roof_installed"],
  ["cop_temperature_limit", "cop_user_set_temp_supported"],
]);

/**
 * The single feature-gating predicate shared by pairing
 * (VehicleDriver.onPairListDevices) and runtime capability sync
 * (VehicleDevice.getExpectedCapabilities), so the two never disagree about
 * which seat/tonneau capabilities a given vehicle supports.
 */
export function isCapabilitySupported(
  capability: string,
  vin: string | undefined,
  config: VehicleConfig | undefined,
): boolean {
  if (
    capability === "seat_cooler.front_left" ||
    capability === "seat_cooler.front_right"
  ) {
    return !!config?.has_seat_cooling;
  }
  // `rear_seat_heaters` is a rear-bench layout code, not a heater count: any
  // non-zero value has left/right heaters, and only 1 and 3 add a centre one
  // (mirrors HA teslemetry select.py).
  if (
    capability === "seat_heater.rear_left" ||
    capability === "seat_heater.rear_right"
  ) {
    return !!config?.rear_seat_heaters;
  }
  if (capability === "seat_heater.rear_center") {
    return [1, 3].includes(config?.rear_seat_heaters ?? 0);
  }
  if (capability === "windowcoverings_closed.sunroof") {
    return !!config?.sun_roof_installed;
  }
  if (capability === "cop_temperature_limit") {
    return !!config?.cop_user_set_temp_supported;
  }
  if (CYBERTRUCK_ONLY_CAPABILITIES.has(capability)) {
    return isCybertruck(vin);
  }
  if (MODEL_S_X_ONLY_CAPABILITIES.has(capability)) {
    return isModelSorX(vin);
  }
  return true;
}

export function filterVehicleCapabilities(
  capabilities: string[],
  vin: string | undefined,
  config: VehicleConfig | undefined,
): string[] {
  return capabilities.filter((cap) => isCapabilitySupported(cap, vin, config));
}

/**
 * Whether `capability`'s support depends on vehicle config metadata (as
 * opposed to VIN alone) that `config` doesn't know - absent, or `null`.
 * Callers keep such a capability as the device already has it rather than
 * reading "unknown" as "hardware absent".
 */
export function isCapabilitySupportUnknown(
  capability: string,
  config: VehicleConfig | undefined,
): boolean {
  const key = METADATA_GATED_CAPABILITIES.get(capability);
  return key !== undefined && config?.[key] == null;
}
