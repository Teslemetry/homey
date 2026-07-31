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
  private tariff: Record<string, unknown> | undefined;
  private tariffTimeZone: string | undefined;
  private tariffTimer: NodeJS.Timeout | undefined;

  /** Overridden by tests to control the clock without waiting real time. */
  protected now(): Date {
    return new Date();
  }

  async onInit() {
    await super.onInit();
    this.resolveAndBindSite();
  }

  /**
   * Re-resolves the current site id and rebinds, torn down and re-registered
   * exactly like onInit(). See TeslemetryDevice.rebindProduct().
   */
  public rebindProduct(): void {
    this.pollingCleanup?.forEach((stop) => stop());
    // pollingCleanup just cleared the tariff timer; reset the retained
    // tariff/timezone so the new site's cached site_info replay is what
    // drives the next recompute, not this now-unbound site's data.
    this.tariff = undefined;
    this.tariffTimeZone = undefined;
    this.clearTariffRates();
    this.resolveAndBindSite();
  }

  private resolveAndBindSite(): void {
    const siteId = this.getSiteId();
    const site = this.homey.app.products?.energySites?.[siteId];
    if (!site) {
      if (!(this.homey.app.isReady?.() ?? true)) {
        this.markUnavailable(
          "startup",
          this.homey.__("error.teslemetry_connecting"),
        );
        return;
      }
      this.error(
        `Failed to initialize Powerwall device: energy site not found for id ${siteId}`,
      );
      this.markUnavailable("binding", this.homey.__("error.energy_site_not_found"));
      return;
    }
    this.bindSite(site);
  }

  public getProductKey(): string | undefined {
    return this.site ? `site:${String(this.site.id)}` : undefined;
  }

  /**
   * The energy site id this device resolves against. Defaults to the
   * immutable pairing id (`getData().id`), but a repair rebind overrides it
   * via a store value instead, since Homey device data can't be changed
   * post-pairing.
   */
  public getSiteId(): string {
    return (
      (this.getStoreValue("energySiteId") as string | null) ??
      this.getData().id
    );
  }

  /**
   * Explicit, identity-preserving repair action: rebinds this same device to
   * a different energy site id (via a store value, not the immutable
   * pairing data) and (re-)registers its live/command listeners. Called from
   * the driver's repair view once the user confirms a specific site.
   */
  public async repairSite(siteId: string): Promise<void> {
    const site = this.homey.app.products?.energySites?.[siteId];
    if (!site) {
      throw new Error(this.homey.__("error.energy_site_not_found"));
    }
    this.pollingCleanup?.forEach((stop) => stop());
    this.tariff = undefined;
    this.tariffTimeZone = undefined;
    this.clearTariffRates();
    await this.setStoreValue("energySiteId", siteId);
    // bindSite() itself restores availability via clearAvailabilityReason
    // ("binding" is the only reason a device can have reached this repair
    // flow with) - no separate setAvailable() call needed here.
    this.bindSite(site);
  }

  private bindSite(site: EnergyDetails): void {
    this.site = site;
    this.clearAvailabilityReason("startup");
    this.clearAvailabilityReason("binding");

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
      this.tariff = data.tariff_content_v2 ?? undefined;
      this.tariffTimeZone = data.installation_time_zone;
      try {
        this.recomputeTariffRates();
      } catch (e) {
        this.error("Failed to update Powerwall tariff rates", e);
      }
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

    // Essential behavior: live data and commands. Registered before the
    // optional site-info/tariff enrichment below so a malformed cached
    // tariff/timezone can never leave this device without them.
    this.site.sse.on("live_status", onLiveStatus);

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

    this.pollingCleanup = [
      () => this.site.sse.off("live_status", onLiveStatus),
      () => {
        if (this.tariffTimer !== undefined) {
          this.homey.clearTimeout(this.tariffTimer);
          this.tariffTimer = undefined;
        }
      },
    ];

    // Optional enrichment: site_info/tariff_content_v2 replay a cached value
    // synchronously from `site.sse.on`, and `applySiteInfo` itself never
    // throws (its only fallible step, tariff resolution, is caught above),
    // so this can't undo the essential registration above.
    this.site.sse.on("site_info", applySiteInfo);
    this.site.sse.on("tariff_content_v2", applySiteInfo);
    this.site.sse.on("energy_totals", onEnergyTotals);

    this.pollingCleanup.push(
      () => this.site.sse.off("site_info", applySiteInfo),
      () => this.site.sse.off("tariff_content_v2", applySiteInfo),
      () => this.site.sse.off("energy_totals", onEnergyTotals),
    );

    this.log("Powerwall device initialized: live and command listeners registered");
  }

  async onUninit(): Promise<void> {
    await super.onUninit();
    this.pollingCleanup?.forEach((stop) => stop());
  }

  /**
   * Resolves the buy/sell rate for the retained tariff/timezone at the
   * current moment, applies it, and schedules a Homey timeout at the
   * resolution's own next period boundary so a later call recomputes and
   * reschedules itself with no further site_info/tariff_content_v2 event
   * required. Clears the rates/currency (and any pending timer) when the
   * tariff or timezone is absent, or when the tariff can't be resolved at
   * all (e.g. no season covers the current date).
   */
  private recomputeTariffRates(): void {
    if (this.tariffTimer !== undefined) {
      this.homey.clearTimeout(this.tariffTimer);
      this.tariffTimer = undefined;
    }

    if (!this.tariff || !this.tariffTimeZone) {
      this.clearTariffRates();
      return;
    }

    const resolution = getTariffPeriods(
      this.tariff as unknown as TariffContentV2,
      this.now(),
      { timeZone: this.tariffTimeZone },
    );
    if (!resolution) {
      this.clearTariffRates();
      return;
    }

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

    const delay = Math.max(
      0,
      resolution.nextChange.getTime() - this.now().getTime(),
    );
    this.tariffTimer = this.homey.setTimeout(() => {
      try {
        this.recomputeTariffRates();
      } catch (e) {
        this.error("Failed to update Powerwall tariff rates", e);
      }
    }, delay);
  }

  private clearTariffRates(): void {
    this.update("grid_buy_rate", null);
    this.update("grid_sell_rate", null);
    this.setCapabilityOptions("grid_buy_rate", {
      ...this.driver.manifest.capabilitiesOptions["grid_buy_rate"],
    }).catch(this.error);
    this.setCapabilityOptions("grid_sell_rate", {
      ...this.driver.manifest.capabilitiesOptions["grid_sell_rate"],
    }).catch(this.error);
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
