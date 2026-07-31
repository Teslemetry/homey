import type { VehicleDetails } from "@teslemetry/api";
import isCybertruck from "./model.js";

type VehicleConfig = VehicleDetails["metadata"]["config"];

/** Capabilities only Cybertruck exposes; excluded from every other model. */
const CYBERTRUCK_ONLY_CAPABILITIES = new Set([
  "windowcoverings_closed.tonneau",
  "windowcoverings_set.tonneau",
]);

/**
 * Capabilities gated on vehicle config metadata (seat cooling / rear seat
 * heater count) rather than VIN. Metadata can be temporarily unresolved
 * (e.g. products not loaded yet), unlike VIN which is always known from
 * pairing data/store.
 */
const METADATA_GATED_CAPABILITIES = new Set([
  "seat_cooler.front_left",
  "seat_cooler.front_right",
  "seat_heater.rear_left",
  "seat_heater.rear_right",
  "seat_heater.rear_center",
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
  if (
    capability === "seat_heater.rear_left" ||
    capability === "seat_heater.rear_right"
  ) {
    return (config?.rear_seat_heaters ?? 0) >= 2;
  }
  if (capability === "seat_heater.rear_center") {
    return (config?.rear_seat_heaters ?? 0) >= 3;
  }
  if (CYBERTRUCK_ONLY_CAPABILITIES.has(capability)) {
    return isCybertruck(vin);
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

/** Whether `capability`'s support depends on vehicle config metadata (as opposed to VIN alone). */
export function isMetadataGatedCapability(capability: string): boolean {
  return METADATA_GATED_CAPABILITIES.has(capability);
}
