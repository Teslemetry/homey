import { EnergyDetails } from "@teslemetry/api";
import TeslemetryDevice from "../../lib/TeslemetryDevice.js";

export default class WallConnecter extends TeslemetryDevice {
  site!: EnergyDetails;
  din!: string;
  pollingCleanup!: Array<() => void>;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    await super.onInit();

    try {
      const site = this.homey.app.products?.energySites?.[this.getData().site];
      if (!site) throw new Error("No site found");
      this.site = site;
    } catch (e) {
      this.log("Failed to initialize Wall Connector device");
      this.error(e);
      return;
    }
    this.din = this.getData().din;

    const onLiveStatus = ({
      response,
    }: NonNullable<typeof this.site.api.cache.liveStatus>) => {
      // Get specific Wall Connector
      const data = response?.wall_connectors?.find(
        ({ din }) => this.din === din,
      );

      if (!data) return;

      // Power
      this.update("measure_power", data.wall_connector_power);

      // State
      this.update(
        "evcharger_charging_state",
        this.mapWallConnectorState(data.wall_connector_state),
      );

      // Connected Vehicle
      this.update("connected_vehicle", this.findVin(data.vin));
    };

    const onChargeHistory = async (
      chargeHistory: NonNullable<typeof this.site.api.cache.chargeHistory>,
    ) => {
      if (!chargeHistory.response?.charge_history?.length) return;

      let charged = 0;
      let hasCharged = false;

      for (const event of chargeHistory.response.charge_history) {
        if (event.din !== this.din || event.energy_added_wh === undefined) {
          continue;
        }
        charged += event.energy_added_wh;
        hasCharged = true;
      }

      if (hasCharged) {
        const now = new Date();
        const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        await this.updateCumulativeMeter("meter_power", charged / 1000, dateKey);
      }
    };

    this.site.api.on("liveStatus", onLiveStatus);
    this.site.api.on("chargeHistory", onChargeHistory);

    this.pollingCleanup = [
      this.site.api.requestPolling("liveStatus"),
      this.site.api.requestPolling("chargeHistory"),
      () => this.site.api.off("liveStatus", onLiveStatus),
      () => this.site.api.off("chargeHistory", onChargeHistory),
    ];
  }

  /**
   * Map Tesla Wall Connector state (numerical) to Homey evcharger_charging_state (enum)
   * @param state - Numerical state from wall_connector_state
   * @returns The corresponding evcharger_charging_state enum value
   */
  private mapWallConnectorState(state: number): string | undefined {
    switch (state) {
      case 1:
        return "plugged_in_charging";
      case 2:
        return "plugged_out";
      case 3:
        return "plugged_in";
      case 4:
        return "plugged_in_paused";
      default:
        this.log(`Unknown wall_connector_state: ${state}`);
        return undefined;
    }
  }

  private findVin(vin: string | undefined): string {
    if (!vin) return "disconnected";
    const vehicle = this.homey.app.products?.vehicles[vin];
    return vehicle ? vehicle.name : vin;
  }

  async onUninit(): Promise<void> {
    await super.onUninit();
    this.pollingCleanup.forEach((stop) => stop());
  }
}
