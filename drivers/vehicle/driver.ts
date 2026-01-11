import type TeslemetryApp from "../../app.js";
import TeslemetryDriver from "../../lib/TeslemetryDriver.js";

const icon: Record<string, { icon: string }> = {
  "3": { icon: "model3.svg" },
  Y: { icon: "modelY.svg" },
  S: { icon: "modelS.svg" },
  X: { icon: "modelX.svg" },
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
          const hasSeatCooling = !!data.metadata.config?.has_seat_cooling;
          const rearSeatHeaters = data.metadata.config?.rear_seat_heaters ?? 0;

          // Build capabilities list, excluding unsupported features
          const capabilities = (
            this.manifest.capabilities as string[]
          ).filter((cap) => {
            if (
              cap === "seat_cooler.front_left" ||
              cap === "seat_cooler.front_right"
            ) {
              return hasSeatCooling;
            }
            if (cap === "seat_heater.rear_left" || cap === "seat_heater.rear_right") {
              return rearSeatHeaters >= 2;
            }
            if (cap === "seat_heater.rear_center") {
              return rearSeatHeaters >= 3;
            }
            return true;
          });

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
