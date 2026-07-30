import { EnergyDetails, SseEnergyTotals, SseLiveStatus } from "@teslemetry/api";
import { getTariffPeriods } from "tesla-fleet-api";
import type { TariffContentV2 } from "tesla-fleet-api/dist/types/site_info.js";
import TeslemetryDevice from "../../lib/TeslemetryDevice.js";

/** The fields this device reads off the merged site_info/tariff_content_v2
 *  document (`TeslemetryEnergySiteStream.siteInfoDocument`), which is
 *  otherwise an untyped `Record<string, unknown>`. */
interface SiteInfoDocument {
  backup_reserve_percent?: number;
  default_real_mode?: string;
  components?: {
    customer_preferred_export_rule?: string;
    non_export_configured?: boolean;
    disallow_charge_from_grid_with_solar_installed?: boolean;
  };
  user_settings?: { storm_mode_enabled?: boolean | null };
  installation_time_zone?: string;
  tariff_content_v2?: Record<string, unknown> | null;
}

/** The fields this device reads off the opaque `live_status` SSE payload. */
interface LiveStatusResponse {
  percentage_charged?: number;
  battery_power?: number;
  storm_mode_active?: boolean;
}

export default class PowerwallDevice extends TeslemetryDevice {
  site!: EnergyDetails;
  pollingCleanup!: Array<() => void>;

  async onInit() {
    await super.onInit();

    try {
      const site = this.homey.app.products?.energySites?.[this.getData().id];
      if (!site) throw new Error("No site found");
      this.site = site;
    } catch (e) {
      this.log("Failed to initialize Powerwall device");
      this.error(e);
      this.setUnavailable(this.homey.__("error.invalid_refresh_token")).catch(
        this.error,
      );
      return;
    }

    const onLiveStatus = (event: SseLiveStatus) => {
      const data = event.live_status as LiveStatusResponse;

      this.update("measure_battery", data.percentage_charged);
      this.updateWithThresholdTriggers(
        "measure_power",
        data.battery_power !== undefined ? data.battery_power * -1 : undefined,
        "battery_power_above",
        "battery_power_below",
        "power",
      );
      this.update("alarm_generic.storm", data.storm_mode_active);
    };

    const applySiteInfo = () => {
      const data = this.site.sse.siteInfoDocument as
        | SiteInfoDocument
        | undefined;
      if (!data) return;

      this.update(
        "backup_reserve",
        data.backup_reserve_percent !== undefined
          ? data.backup_reserve_percent / 100
          : undefined,
      );
      this.update("operation_mode", data.default_real_mode);
      this.update(
        "allow_export",
        data.components?.customer_preferred_export_rule ??
          (data.components?.non_export_configured ? "never" : "battery_ok"),
      );
      this.update(
        "onoff.charge_grid",
        // When this is missing, its allowed
        !data.components?.disallow_charge_from_grid_with_solar_installed,
      );
      this.update("onoff.storm", data.user_settings?.storm_mode_enabled);
      this.updateTariffRates(
        data.tariff_content_v2 ?? undefined,
        data.installation_time_zone,
      );
    };

    const onEnergyTotals = async (event: SseEnergyTotals) => {
      const dateKey = event.createdAt.slice(0, 10);
      const { total_battery_charge, total_battery_discharge } = event.totals;

      if (total_battery_charge !== null && total_battery_charge !== undefined) {
        await this.updateCumulativeMeter(
          "meter_power.charged",
          total_battery_charge / 1000,
          dateKey,
        );
      }
      if (
        total_battery_discharge !== null &&
        total_battery_discharge !== undefined
      ) {
        await this.updateCumulativeMeter(
          "meter_power.discharged",
          total_battery_discharge / 1000,
          dateKey,
        );
      }
    };

    this.site.sse.on("live_status", onLiveStatus);
    this.site.sse.on("site_info", applySiteInfo);
    this.site.sse.on("tariff_content_v2", applySiteInfo);
    this.site.sse.on("energy_totals", onEnergyTotals);

    this.pollingCleanup = [
      () => this.site.sse.off("live_status", onLiveStatus),
      () => this.site.sse.off("site_info", applySiteInfo),
      () => this.site.sse.off("tariff_content_v2", applySiteInfo),
      () => this.site.sse.off("energy_totals", onEnergyTotals),
    ];

    // Register capability listeners
    this.registerCapabilityListener("backup_reserve", async (value) => {
      this.log(
        `Setting backup reserve to ${Math.round(value * 100)} (from ${value})`,
      );
      return this.action(
        this.site.api.setBackupReserve(Math.round(value * 100)),
      );
    });

    this.registerCapabilityListener("allow_export", async (value) => {
      this.log(`Setting allow export to ${value}`);
      return this.action(
        this.site.api.gridImportExport(
          value,
          !this.getCapabilityValue("onoff.charge_grid"), // Not Allow
        ),
      );
    });

    this.registerCapabilityListener("operation_mode", async (value) => {
      this.log(`Setting operation mode to ${value}`);
      return this.action(this.site.api.setOperationMode(value));
    });

    this.registerCapabilityListener("onoff.charge_grid", async (value) => {
      // When this is missing, its allowed
      this.log(`Setting charge from grid to ${!value}`);
      return this.action(
        this.site.api.gridImportExport(
          this.getCapabilityValue("allow_export"),
          !value, // Not Allow
        ),
      );
    });

    this.registerCapabilityListener("onoff.storm", async (value) => {
      return this.action(this.site.api.setStormMode(value));
    });
  }

  async onUninit(): Promise<void> {
    await super.onUninit();
    this.pollingCleanup?.forEach((stop) => stop());
  }

  private updateTariffRates(
    tariff: { [key: string]: unknown } | undefined,
    timeZone: string | undefined,
  ): void {
    if (!tariff || !timeZone) return;

    const resolution = getTariffPeriods(tariff as unknown as TariffContentV2, new Date(), {
      timeZone,
    });
    if (!resolution) return;

    this.updateWithThresholdTriggers(
      "grid_buy_rate",
      resolution.buy.price ?? undefined,
      "grid_buy_rate_above",
      "grid_buy_rate_below",
      "grid_buy_rate",
    );
    this.updateWithThresholdTriggers(
      "grid_sell_rate",
      resolution.sell.price ?? undefined,
      "grid_sell_rate_above",
      "grid_sell_rate_below",
      "grid_sell_rate",
    );

    if (resolution.currency) {
      this.setCapabilityOptions("grid_buy_rate", {
        ...this.driver.manifest.capabilitiesOptions["grid_buy_rate"],
        units: resolution.currency,
      }).catch(this.error);
      this.setCapabilityOptions("grid_sell_rate", {
        ...this.driver.manifest.capabilitiesOptions["grid_sell_rate"],
        units: resolution.currency,
      }).catch(this.error);
    }
  }

  // Public action methods for Flow cards
  public async flowSetBackupReserve(percentage: number): Promise<void> {
    this.log(`Setting backup reserve to ${percentage}%`);
    await this.action(this.site.api.setBackupReserve(percentage));
  }

  public async flowSetAllowExport(
    mode: "battery_ok" | "pv_only" | "never",
  ): Promise<void> {
    this.log(`Setting allow export to ${mode}`);
    await this.action(
      this.site.api.gridImportExport(
        mode,
        !this.getCapabilityValue("onoff.charge_grid"),
      ),
    );
  }

  public async flowSetOperationMode(
    mode: "self_consumption" | "backup" | "autonomous",
  ): Promise<void> {
    this.log(`Setting operation mode to ${mode}`);
    await this.action(this.site.api.setOperationMode(mode));
  }
}
