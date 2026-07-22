import { EnergyDetails } from "@teslemetry/api";
import TeslemetryDevice from "../../lib/TeslemetryDevice.js";

export default class SolarDevice extends TeslemetryDevice {
  site!: EnergyDetails;
  pollingCleanup!: Array<() => void>;

  async onInit() {
    await super.onInit();

    try {
      const site = this.homey.app.products?.energySites?.[this.getData().id];
      if (!site) throw new Error("No site found");
      this.site = site;
    } catch (e) {
      this.log("Failed to initialize Solar device");
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
      this.update("measure_power", data.solar_power);
    };

    const onEnergyHistory = async (
      energyHistory: NonNullable<typeof this.site.api.cache.energyHistory>,
    ) => {
      if (!energyHistory.response?.time_series?.length) return;

      const dateKey =
        energyHistory.response.time_series[0].timestamp.slice(0, 10);

      let generated = 0;
      let hasGenerated = false;

      for (const event of energyHistory.response.time_series) {
        if (
          event.total_solar_generation !== undefined &&
          event.total_solar_generation !== null
        ) {
          generated += event.total_solar_generation;
          hasGenerated = true;
        }
      }

      if (hasGenerated) {
        await this.updateCumulativeMeter("meter_power", generated / 1000, dateKey);
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

  async onUninit() {
    await super.onUninit();
    this.pollingCleanup?.forEach((stop) => stop());
  }
}
