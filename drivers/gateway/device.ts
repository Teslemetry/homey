import { EnergyDetails } from "@teslemetry/api";
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

    const onLiveStatus = (
      liveStatus: NonNullable<typeof this.site.api.cache.liveStatus>,
    ) => {
      const data = liveStatus?.response;
      if (!data) return;

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

    const onEnergyHistory = async (
      energyHistory: NonNullable<typeof this.site.api.cache.energyHistory>,
    ) => {
      if (!energyHistory.response?.time_series?.length) return;

      const dateKey =
        energyHistory.response.time_series[0].timestamp.slice(0, 10);

      let imported = 0;
      let exported = 0;
      let hasImported = false;
      let hasExported = false;

      for (const event of energyHistory.response.time_series) {
        if (
          event.grid_energy_imported !== undefined &&
          event.grid_energy_imported !== null
        ) {
          imported += event.grid_energy_imported;
          hasImported = true;
        }
        if (
          event.total_grid_energy_exported !== undefined &&
          event.total_grid_energy_exported !== null
        ) {
          exported += event.total_grid_energy_exported;
          hasExported = true;
        }
      }

      if (hasImported) {
        await this.updateCumulativeMeter(
          "meter_power.imported",
          imported / 1000,
          dateKey,
        );
      }
      if (hasExported) {
        await this.updateCumulativeMeter(
          "meter_power.exported",
          exported / 1000,
          dateKey,
        );
      }
    };

    this.site.api.on("liveStatus", onLiveStatus);
    this.site.api.on("energyHistory", onEnergyHistory);

    this.pollingCleanup = [
      this.site.api.requestPolling("liveStatus"),
      this.site.api.requestPolling("energyHistory"),
      () => this.site.api.off("liveStatus", onLiveStatus),
      () => this.site.api.off("energyHistory", onEnergyHistory),
    ];
  }

  async onUninit(): Promise<void> {
    await super.onUninit();
    this.pollingCleanup?.forEach((stop) => stop());
  }
}
