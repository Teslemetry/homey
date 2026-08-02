import { EnergyDetails, SseEnergyTotals, SseLiveStatus } from "@teslemetry/api";
import TeslemetryDevice from "../../lib/TeslemetryDevice.js";
import { isEnergySiteEligible } from "../../lib/TeslemetryDriver.js";
import msUntilNextLocalMidnight from "../../lib/localMidnight.js";

const gridStatusMap = new Map<any, boolean>([
  ["Active", false],
  ["Inactive", true],
]);

const islandStatusMap = new Map<any, boolean>([
  ["off_grid_intentional", true],
  ["off_grid_unintentional", true],
  ["on_grid", false],
]);

/**
 * The raw `island_status` strings the `island_status` capability accepts -
 * mirrors the Teslemetry Home Assistant integration's `sensor.island_status`
 * enum exactly (`off_grid`, HA's fifth option, is a polling-only synonym
 * this streaming-only app never receives). An unrecognized future value is
 * left untouched rather than passed straight through to setCapabilityValue,
 * which would reject a value outside the capability's declared enum.
 */
const KNOWN_ISLAND_STATUSES = new Set([
  "on_grid",
  "off_grid_intentional",
  "off_grid_unintentional",
  "island_status_unknown",
]);

/** The fields this device reads off the opaque `live_status` SSE payload. */
interface LiveStatusResponse {
  grid_power?: number;
  load_power?: number;
  generator_power?: number;
  grid_status?: string;
  island_status?: string;
}

/** The fields this device reads off the merged site_info/tariff_content_v2
 *  document (`TeslemetryEnergySiteStream.siteInfoDocument`). */
interface SiteInfoDocument {
  installation_time_zone?: string;
  components?: {
    generator?: boolean;
  };
}

const TODAY_TOTAL_CAPABILITIES = [
  "grid_imported_today",
  "grid_exported_today",
  "home_usage_today",
] as const;

export default class GatewayDevice extends TeslemetryDevice {
  site!: EnergyDetails;
  pollingCleanup!: Array<() => void>;
  private timeZone: string | undefined;
  private midnightTimer: NodeJS.Timeout | undefined;
  private previousIslandStatus: string | undefined;
  private hasGenerator: boolean | undefined;
  private latestGeneratorPower: number | undefined;

  /** Overridden by tests to control the clock without waiting real time. */
  protected now(): Date {
    return new Date();
  }

  /**
   * `energy_totals` only pushes on a change, so a "today" total goes silent
   * once its underlying activity stops for a stretch and keeps showing a
   * stale value until the next sample arrives. This timer forces the reset
   * at the actual local midnight boundary instead, using the site's own
   * installation timezone - see SolarDevice.scheduleMidnightReset, the same
   * fix applied there for solar_generation_today.
   */
  private scheduleMidnightReset(timeZone: string): void {
    if (this.midnightTimer !== undefined) {
      this.homey.clearTimeout(this.midnightTimer);
    }
    const delay = msUntilNextLocalMidnight(this.now(), timeZone);
    const midnightTimer = this.homey.setTimeout(async () => {
      try {
        for (const capability of TODAY_TOTAL_CAPABILITIES) {
          await this.update(capability, 0);
        }
        if (this.midnightTimer === midnightTimer && this.isLive()) {
          this.scheduleMidnightReset(timeZone);
        }
      } catch (e) {
        this.error("Failed to reset Gateway midnight totals", e);
      }
    }, delay);
    this.midnightTimer = midnightTimer;
  }

  async onInit() {
    await super.onInit();
    this.resolveAndBindSite();
  }

  /**
   * Re-resolves the site and rebinds, torn down and re-registered exactly
   * like onInit(). See TeslemetryDevice.rebindProduct().
   */
  public rebindProduct(): void {
    this.pollingCleanup?.forEach((stop) => stop());
    // pollingCleanup just cleared the midnight timer; reset so the cached
    // site_info replay below doesn't treat an unchanged timezone as
    // "already scheduled" and skip rescheduling it.
    this.timeZone = undefined;
    this.hasGenerator = undefined;
    this.latestGeneratorPower = undefined;
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
        `Failed to initialize Gateway device: energy site not found for id ${siteId}`,
      );
      this.markUnavailable("binding", this.homey.__("error.energy_site_not_found"));
      return;
    }
    // Present but ineligible (access revoked): revalidated with the exact
    // predicate pairing uses, so an already-paired site that loses access
    // doesn't stay bound with a frozen last-known state.
    if (!isEnergySiteEligible(site.metadata)) {
      this.site = undefined!;
      this.error(
        `Failed to initialize Gateway device: energy site ${siteId} is not eligible (access revoked)`,
      );
      this.markUnavailable(
        "eligibility",
        this.homey.__("error.energy_site_access_required"),
      );
      return;
    }
    this.bindSite(site);
  }

  public getProductKey(): string | undefined {
    return this.site ? `site:${String(this.site.id)}` : undefined;
  }

  public getSiteId(): string {
    return String(this.getData().id);
  }

  private bindSite(site: EnergyDetails): void {
    this.site = site;
    this.clearAvailabilityReason("startup");
    this.clearAvailabilityReason("binding");
    this.clearAvailabilityReason("eligibility");

    const onLiveStatus = (event: SseLiveStatus) => {
      const data = event.live_status as LiveStatusResponse;
      if (data.generator_power !== undefined) {
        this.latestGeneratorPower = data.generator_power;
      }

      this.updateWithThresholdTriggers(
        "measure_power",
        data.grid_power,
        "grid_power_above",
        "grid_power_below",
        "power",
      );
      this.updateWithThresholdTriggers(
        "measure_power.load",
        data.load_power,
        "load_power_above",
        "load_power_below",
        "power",
      );
      this.updateWithThresholdTriggers(
        "measure_power.generator",
        this.hasGenerator ? this.latestGeneratorPower : undefined,
        "generator_power_above",
        "generator_power_below",
        "power",
      );
      this.update(
        "alarm_generic.off_grid",
        gridStatusMap.get(data.grid_status),
      );
      this.update(
        "alarm_generic.island",
        islandStatusMap.get(data.island_status),
      );
      this.handleIslandStatus(data.island_status);
    };

    const handleEnergyTotals = async (event: SseEnergyTotals) => {
      const dateKey = event.createdAt.slice(0, 10);
      const {
        grid_energy_imported,
        total_grid_energy_exported,
        total_home_usage,
      } = event.totals;

      if (grid_energy_imported !== null && grid_energy_imported !== undefined) {
        await this.update("grid_imported_today", grid_energy_imported / 1000);
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
        await this.update(
          "grid_exported_today",
          total_grid_energy_exported / 1000,
        );
        await this.updateCumulativeMeter(
          "meter_power.exported",
          total_grid_energy_exported / 1000,
          dateKey,
        );
      }
      if (total_home_usage !== null && total_home_usage !== undefined) {
        await this.update("home_usage_today", total_home_usage / 1000);
      }
    };
    // EventEmitter doesn't await listeners, so an unhandled rejection here
    // would otherwise crash the app instead of just failing this update.
    const onEnergyTotals = (event: SseEnergyTotals) => {
      return handleEnergyTotals(event).catch(this.error);
    };

    // Essential behavior: live data and the today/cumulative totals.
    // Registered before the optional site-info timezone lookup below so a
    // malformed cached timezone can never leave this device without them.
    this.site.sse.on("live_status", onLiveStatus);
    this.site.sse.on("energy_totals", onEnergyTotals);

    this.pollingCleanup = [
      () => this.site.sse.off("live_status", onLiveStatus),
      () => this.site.sse.off("energy_totals", onEnergyTotals),
      () => {
        if (this.midnightTimer !== undefined) {
          this.homey.clearTimeout(this.midnightTimer);
          this.midnightTimer = undefined;
        }
      },
    ];

    // Optional enrichment: site_info replays a cached value synchronously
    // from `site.sse.on`; Intl.DateTimeFormat throws on a malformed
    // timezone string, so this is guarded and can't undo the essential
    // registration above.
    const applySiteInfo = () => {
      try {
        const data = this.site.sse.siteInfoDocument as
          | SiteInfoDocument
          | undefined;

        const hasGenerator = data?.components?.generator === true;
        if (this.hasGenerator === true && !hasGenerator) {
          this.update("measure_power.generator", null);
        }
        if (this.hasGenerator !== true && hasGenerator) {
          this.updateWithThresholdTriggers(
            "measure_power.generator",
            this.latestGeneratorPower,
            "generator_power_above",
            "generator_power_below",
            "power",
          );
        }
        this.hasGenerator = hasGenerator;

        const timeZone = data?.installation_time_zone;
        if (!timeZone || timeZone === this.timeZone) return;
        this.timeZone = timeZone;
        this.scheduleMidnightReset(timeZone);
      } catch (e) {
        this.error("Failed to schedule gateway midnight reset", e);
      }
    };
    this.site.sse.on("site_info", applySiteInfo);
    this.pollingCleanup.push(() =>
      this.site.sse.off("site_info", applySiteInfo),
    );
  }

  /**
   * Updates island_status and fires the distinct outage/test lifecycle
   * triggers a plain changed card can't express - a real grid outage
   * (off_grid_unintentional) and a user-initiated Go Off-Grid test
   * (off_grid_intentional) need separate automations, mirroring
   * VehicleDevice.handleDetailedChargeState's value-specific branching.
   */
  private handleIslandStatus(value: string | undefined): void {
    if (value === undefined || !KNOWN_ISLAND_STATUSES.has(value)) return;
    const previous = this.previousIslandStatus;
    this.previousIslandStatus = value;
    this.update("island_status", value);

    if (previous === undefined || previous === value) return;

    if (previous === "off_grid_unintentional") {
      this.triggerFlow("grid_outage_ended");
    }
    if (previous === "off_grid_intentional") {
      this.triggerFlow("island_test_ended");
    }
    if (value === "off_grid_unintentional") {
      this.triggerFlow("grid_outage_started");
    }
    if (value === "off_grid_intentional") {
      this.triggerFlow("island_test_started");
    }
  }

  private triggerFlow(cardId: string): void {
    if (!this.isLive()) return;
    this.homey.flow.getDeviceTriggerCard(cardId).trigger(this).catch(this.error);
  }

  async onUninit(): Promise<void> {
    await super.onUninit();
    this.pollingCleanup?.forEach((stop) => stop());
  }
}
