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
      return;
    }

    this.pollingCleanup = [
      this.site.api.requestPolling("liveStatus"),
      this.site.api.requestPolling("energyHistory"),
    ];

    this.site.api.on("liveStatus", (liveStatus) => {
      const data = liveStatus?.response;
      if (!data) return;

      this.update("measure_power.grid", data.grid_power);
      this.update("measure_power.load", data.load_power);
      this.update(
        "alarm_generic.off_grid",
        gridStatusMap.get(data.grid_status),
      );
      this.update(
        "alarm_generic.island",
        islandStatusMap.get(data.island_status),
      );
    });

    this.site.api.on("energyHistory", async (energyHistory) => {
      if (!energyHistory.response?.time_series?.length) return;

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

      if (hasImported) this.update("meter_power.imported", imported / 1000);
      if (hasExported) this.update("meter_power.exported", exported / 1000);
    });
  }

  async onUninit(): Promise<void> {
    this.pollingCleanup?.forEach((stop) => stop());
  }
}
