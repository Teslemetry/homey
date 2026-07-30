import { EnergyDetails, SseEnergyTotals, SseLiveStatus } from "@teslemetry/api";
import TeslemetryDevice from "../../lib/TeslemetryDevice.js";

/** The fields this device reads off the opaque `live_status` SSE payload. */
interface LiveStatusResponse {
  solar_power?: number;
}

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

    const onLiveStatus = (event: SseLiveStatus) => {
      const data = event.live_status as LiveStatusResponse;
      this.updateWithThresholdTriggers(
        "measure_power",
        data.solar_power,
        "solar_power_above",
        "solar_power_below",
        "power",
      );
    };

    const onEnergyTotals = async (event: SseEnergyTotals) => {
      const { total_solar_generation } = event.totals;
      if (total_solar_generation === null || total_solar_generation === undefined) {
        return;
      }
      const dateKey = event.createdAt.slice(0, 10);
      this.update("solar_generation_today", total_solar_generation / 1000);
      await this.updateCumulativeMeter(
        "meter_power",
        total_solar_generation / 1000,
        dateKey,
      );
    };

    this.site.sse.on("live_status", onLiveStatus);
    this.site.sse.on("energy_totals", onEnergyTotals);

    this.pollingCleanup = [
      () => this.site.sse.off("live_status", onLiveStatus),
      () => this.site.sse.off("energy_totals", onEnergyTotals),
    ];
  }

  async onUninit() {
    await super.onUninit();
    this.pollingCleanup?.forEach((stop) => stop());
  }
}
