import TeslemetryDriver, {
  checkVehicleEligibility,
  VEHICLE_INELIGIBILITY_MESSAGE_KEY,
} from "../../lib/TeslemetryDriver.js";
import { filterVehicleCapabilities } from "./capabilityGating.js";

const icon: Record<string, { icon: string }> = {
  S: { icon: "modelS.svg" },
  3: { icon: "model3.svg" },
  X: { icon: "modelX.svg" },
  Y: { icon: "modelY.svg" },
  C: { icon: "cybertruck.svg" },
};

export default class VehicleDriver extends TeslemetryDriver {
  async onPairListDevices() {
    const products = await this.homey.app.getProducts();
    if (!products) {
      throw new Error(
        "Failed to load products. Please restart the pairing process",
      );
    }

    // Only includes vehicles with a subscription, that support fleet telemetry, and are configured correctly.
    const allVehicles = Object.values(products.vehicles);
    const ineligible: { vin: string; reason: "access" | "telemetry" | "polling" }[] = [];
    const eligibleVehicles = allVehicles.filter((data) => {
      const result = checkVehicleEligibility(data.metadata);
      if (!result.eligible) {
        ineligible.push({ vin: data.vin, reason: result.reason });
        return false;
      }
      return true;
    });

    this.log(
      `pairing[stage=filtering]: ${eligibleVehicles.length}/${allVehicles.length} vehicle(s) eligible`,
    );

    // Every vehicle on the account is present but ineligible: an empty list
    // with no explanation reads to the user as "vehicle not found", even
    // though it's online in Teslemetry. Surface the specific reason instead
    // of silently handing pairing zero candidates.
    if (eligibleVehicles.length === 0 && ineligible.length > 0) {
      this.error(
        `pairing[stage=filtering]: no eligible vehicles - ${ineligible
          .map(({ vin, reason }) => `${vin} (${reason})`)
          .join(", ")}`,
      );
      throw new Error(
        this.homey.__(VEHICLE_INELIGIBILITY_MESSAGE_KEY[ineligible[0].reason]),
      );
    }

    try {
      return eligibleVehicles.map((data) => {
        // Build capabilities list, excluding unsupported features
        const capabilities = filterVehicleCapabilities(
          this.manifest.capabilities as string[],
          data.vin,
          data.metadata.config,
        );

        return {
          name: data.name,
          data: {
            vin: data.vin,
          },
          capabilities,
          capabilitiesOptions: {
            "onoff.frunk": {
              ...this.manifest.capabilitiesOptions["onoff.frunk"],
              setable: data.metadata.config?.can_actuate_trunks,
            },
            "onoff.trunk": {
              ...this.manifest.capabilitiesOptions["onoff.trunk"],
              setable: data.metadata.config?.can_actuate_trunks,
            },
          },
          ...icon?.[data.vin[3]],
        };
      });
    } catch (error) {
      this.homey.error("Failed to list vehicles:", error);
      throw new Error(
        "Failed to load vehicles from Teslemetry. Please check your connection and try again.",
      );
    }
  }
}
