import { EnergyDetails } from "@teslemetry/api";
import TeslemetryDevice from "../../lib/TeslemetryDevice.js";

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
      return;
    }

    const onLiveStatus = (
      liveStatus: NonNullable<typeof this.site.api.cache.liveStatus>,
    ) => {
      const data = liveStatus?.response;
      if (!data) return;

      this.update("measure_battery", data.percentage_charged);
      this.update(
        "measure_power",
        data.battery_power !== undefined ? data.battery_power * -1 : undefined,
      );
      this.update("alarm_generic.storm", data.storm_mode_active);
    };

    const onSiteInfo = async (
      siteInfo: NonNullable<typeof this.site.api.cache.siteInfo>,
    ) => {
      const data = siteInfo?.response;
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
        data.components.customer_preferred_export_rule ??
          (data.components.non_export_configured ? "never" : "battery_ok"),
      );
      this.update(
        "onoff.charge_grid",
        // When this is missing, its allowed
        !data.components.disallow_charge_from_grid_with_solar_installed,
      );
      this.update("onoff.storm", data.user_settings.storm_mode_enabled);
    };

    const onEnergyHistory = async (
      energyHistory: NonNullable<typeof this.site.api.cache.energyHistory>,
    ) => {
      if (!energyHistory.response?.time_series?.length) return;

      const dateKey =
        energyHistory.response.time_series[0].timestamp.slice(0, 10);

      let charged = 0;
      let discharged = 0;
      let hasCharged = false;
      let hasDischarged = false;

      for (const event of energyHistory.response.time_series) {
        if (
          event.total_battery_charge !== undefined &&
          event.total_battery_charge !== null
        ) {
          charged += event.total_battery_charge;
          hasCharged = true;
        }
        if (
          event.total_battery_discharge !== undefined &&
          event.total_battery_discharge !== null
        ) {
          discharged += event.total_battery_discharge;
          hasDischarged = true;
        }
      }

      if (hasCharged) {
        await this.updateCumulativeMeter(
          "meter_power.charged",
          charged / 1000,
          dateKey,
        );
      }
      if (hasDischarged) {
        await this.updateCumulativeMeter(
          "meter_power.discharged",
          discharged / 1000,
          dateKey,
        );
      }
    };

    this.site.api.on("liveStatus", onLiveStatus);
    this.site.api.on("siteInfo", onSiteInfo);
    this.site.api.on("energyHistory", onEnergyHistory);

    this.pollingCleanup = [
      this.site.api.requestPolling("siteInfo"),
      this.site.api.requestPolling("liveStatus"),
      this.site.api.requestPolling("energyHistory"),
      () => this.site.api.off("liveStatus", onLiveStatus),
      () => this.site.api.off("siteInfo", onSiteInfo),
      () => this.site.api.off("energyHistory", onEnergyHistory),
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
