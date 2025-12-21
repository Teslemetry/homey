import { EnergyDetails } from "@teslemetry/api";
import TeslemetryDevice from "../../lib/TeslemetryDevice.js";
import { getCapabilities } from "./capabilities.js";

export default class PowerwallDevice extends TeslemetryDevice {
  site!: EnergyDetails;
  pollingCleanup!: Array<() => void>;

  async onInit() {
    try {
      const site = this.homey.app.products?.energySites?.[this.getData().id];
      if (!site) throw new Error("No site found");
      this.site = site;
    } catch (e) {
      this.log("Failed to initialize Powerwall device");
      this.error(e);
      return;
    }

    this.pollingCleanup = [
      this.site.api.requestPolling("siteInfo"),
      this.site.api.requestPolling("liveStatus"),
    ];

    this.site.api.on("liveStatus", ({ response: data }) => {
      if (!data) return;

      this.addCapability;

      // Map Live Status fields
      this.setCapabilityValue("measure_battery", data.percentage_charged).catch(
        this.error,
      );
      this.setCapabilityValue("measure_energy_left", data.energy_left).catch(
        this.error,
      );
      this.setCapabilityValue("measure_power", data.battery_power).catch(
        this.error,
      );
      this.setCapabilityValue("measure_power.solar", data.solar_power).catch(
        this.error,
      );
      this.setCapabilityValue("measure_load_power", data.load_power).catch(
        this.error,
      );
      this.setCapabilityValue("measure_home_usage", data.load_power).catch(
        this.error,
      );
      this.setCapabilityValue("measure_power.grid", data.grid_power).catch(
        this.error,
      );
      this.setCapabilityValue(
        "measure_generator_exported",
        data.generator_power,
      ).catch(this.error);
      this.setCapabilityValue(
        "measure_island_status",
        String(data.island_status),
      ).catch(this.error);
      this.setCapabilityValue(
        "storm_watch_active",
        data.storm_mode_active,
      ).catch(this.error);

      // Grid Status: "Active" -> true, otherwise false? Or just check field presence/value
      this.setCapabilityValue(
        "grid_status",
        data.grid_status === "Active",
      ).catch(this.error);

      // Calculated values
      if (typeof data.grid_power === "number") {
        const exported = data.grid_power < 0 ? Math.abs(data.grid_power) : 0;
        this.setCapabilityValue("measure_grid_exported", exported).catch(
          this.error,
        );
      }
    });

    this.site.api.on("siteInfo", ({ response: data }) => {
      if (!data) return;

      // Ensure class and capabilities are correct
      const { capabilities } = getCapabilities(data);
      const currentCapabilities = this.getCapabilities();

      // Add new capabilities
      for (const capability of capabilities) {
        if (!currentCapabilities.includes(capability)) {
          this.addCapability(capability);
        }
      }

      // Remove old capabilities
      for (const capability of currentCapabilities) {
        if (!capabilities.includes(capability)) {
          this.removeCapability(capability);
        }
      }

      // Update capabilities

      this.update("backup_reserve", data.backup_reserve_percent);

      this.update("operation_mode", data.default_real_mode);

      this.update(
        "allow_export",
        (data.components.customer_preferred_export_rule ??
          data.components.non_export_configured)
          ? "never"
          : "battery_ok",
      );

      this.update(
        "charge_from_grid",
        !data.components.disallow_charge_from_grid_with_solar_installed,
      );

      this.update("storm_watch", data.user_settings.storm_mode_enabled);

      this.update(
        "off_grid_reserve",
        data.off_grid_vehicle_charging_reserve_percent,
      );

      this.update(
        "grid_services_enabled",
        data.components.grid_services_enabled,
      );
      this.update(
        "measure_vpp_backup_reserve",
        data.vpp_backup_reserve_percent,
      );
    });

    // Register capability listeners
    this.registerCapabilityListener("backup_reserve", async (value) => {
      await this.site.api.setBackupReserve(value);
    });

    this.registerCapabilityListener("off_grid_reserve", async (value) => {
      await this.site.api.setOffGridVehicleChargingReserve(value);
    });

    this.registerCapabilityListener(
      "allow_charging_from_grid",
      async (value) => {
        const exportRule = this.getCapabilityValue("allow_export");
        await this.site.api.gridImportExport(exportRule, !value);
      },
    );

    this.registerCapabilityListener("operation_mode", async (value) => {
      await this.site.api.setOperationMode(value);
    });

    this.registerCapabilityListener("storm_watch", async (value) => {
      await this.site.api.setStormMode(value);
    });
  }

  async onUninit(): Promise<void> {
    this.pollingCleanup.forEach((stop) => stop());
  }
}
