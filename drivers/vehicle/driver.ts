import TeslemetryDriver from "../../lib/TeslemetryDriver.js";
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

    try {
      // Only includes vehicles with a subscription, that support fleet telemetry, and are configured correctly
      return Object.values(products.vehicles)
        .filter(
          ({ metadata }) =>
            metadata.access && !!metadata.fleet_telemetry && !metadata.polling,
        )
        .map((data) => {
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
