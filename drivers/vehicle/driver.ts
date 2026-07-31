import Homey from "homey";
import TeslemetryDriver from "../../lib/TeslemetryDriver.js";
import VehicleDevice from "./device.js";
import { filterVehicleCapabilities } from "./capabilityGating.js";

const icon: Record<string, { icon: string }> = {
  S: { icon: "modelS.svg" },
  3: { icon: "model3.svg" },
  X: { icon: "modelX.svg" },
  Y: { icon: "modelY.svg" },
  C: { icon: "cybertruck.svg" },
};

export default class VehicleDriver extends TeslemetryDriver {
  async onRepair(session: any, device: Homey.Device) {
    await super.onRepair(session, device);

    this.wireIdentityRepair(session, device, {
      isTarget: (candidate): candidate is VehicleDevice =>
        candidate instanceof VehicleDevice,
      isBound: (target) => !!this.homey.app.products?.vehicles?.[target.getVin()],
      findCandidate: (target) => this.findRepairCandidate(target),
      repair: (target, vin) => target.repairVehicle(vin),
      statusEvent: "get_repair_vehicle_status",
      confirmEvent: "confirm_repair_vehicle",
      wrongDeviceMessage: "Not a Vehicle device",
    });
  }

  /**
   * The single pairing-eligible vehicle (same access/fleet_telemetry/polling
   * filter as onPairListDevices()) not already bound to another live
   * Vehicle device, if exactly one such vehicle exists. Returns null on
   * zero or multiple matches - the repair view only ever offers a relink
   * when the target is unambiguous, never guessing among several vehicles.
   */
  private async findRepairCandidate(
    excludeDevice: VehicleDevice,
  ): Promise<{ id: string; name: string } | null> {
    const { products } = this.homey.app;
    if (!products?.vehicles) return null;

    const boundVins = new Set(
      (this.getDevices() as Homey.Device[])
        .filter(
          (candidate): candidate is VehicleDevice =>
            candidate instanceof VehicleDevice && candidate !== excludeDevice,
        )
        .map((candidate) => candidate.getVin()),
    );

    const candidates = Object.values(products.vehicles)
      .filter(
        ({ vin, metadata }) =>
          !boundVins.has(vin) &&
          metadata.access &&
          !!metadata.fleet_telemetry &&
          !metadata.polling,
      )
      .map((vehicle) => ({ id: vehicle.vin, name: vehicle.name }));

    return candidates.length === 1 ? candidates[0] : null;
  }

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
