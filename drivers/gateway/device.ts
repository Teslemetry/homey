import { EnergyDetails, SseEnergyTotals, SseLiveStatus } from "@teslemetry/api";
import TeslemetryDevice from "../../lib/TeslemetryDevice.js";

const gridStatusMap = new Map<any, boolean>([
  ["Active", false],
  ["Inactive", true],
]);

const islandStatusMap = new Map<any, boolean>([
  ["off_grid_intentional", true],
  ["off_grid_unintentional", true],
  ["on_grid", false],
]);

/** The fields this device reads off the opaque `live_status` SSE payload. */
interface LiveStatusResponse {
  grid_power?: number;
  load_power?: number;
  grid_status?: string;
  island_status?: string;
}

export default class GatewayDevice extends TeslemetryDevice {
  site!: EnergyDetails;
  pollingCleanup!: Array<() => void>;

  async onInit() {
    await super.onInit();

    try {
      const site = this.homey.app.products?.energySites?.[this.getData().id];
      if (!site) throw new Error("No site found");
      this.site = site;
    } catch (e) {
      this.log("Failed to initialize Gateway device");
      this.error(e);
      this.setUnavailable(this.homey.__("error.invalid_refresh_token")).catch(
        this.error,
      );
      return;
    }

    const onLiveStatus = (event: SseLiveStatus) => {
      const data = event.live_status as LiveStatusResponse;

      this.update("measure_power", data.grid_power);
      this.update("measure_power.load", data.load_power);
      this.update(
        "alarm_generic.off_grid",
        gridStatusMap.get(data.grid_status),
      );
      this.update(
        "alarm_generic.island",
        islandStatusMap.get(data.island_status),
      );
    };

    const onEnergyTotals = async (event: SseEnergyTotals) => {
      const dateKey = event.createdAt.slice(0, 10);
      const { grid_energy_imported, total_grid_energy_exported } =
        event.totals;

      if (grid_energy_imported !== null && grid_energy_imported !== undefined) {
        await this.updateCumulativeMeter(
          "meter_power.imported",
          grid_energy_imported / 1000,
          dateKey,
        );
      }
      if (
        total_grid_energy_exported !== null &&
        total_grid_energy_exported !== undefined
      ) {
        await this.updateCumulativeMeter(
          "meter_power.exported",
          total_grid_energy_exported / 1000,
          dateKey,
        );
      }
    };

    this.site.sse.on("live_status", onLiveStatus);
    this.site.sse.on("energy_totals", onEnergyTotals);

    this.pollingCleanup = [
      () => this.site.sse.off("live_status", onLiveStatus),
      () => this.site.sse.off("energy_totals", onEnergyTotals),
    ];
  }

  async onUninit(): Promise<void> {
    await super.onUninit();
    this.pollingCleanup?.forEach((stop) => stop());
  }
}
