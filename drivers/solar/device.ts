import { EnergyDetails, SseEnergyTotals, SseLiveStatus } from "@teslemetry/api";
import TeslemetryDevice from "../../lib/TeslemetryDevice.js";
import msUntilNextLocalMidnight from "../../lib/localMidnight.js";

/** The fields this device reads off the opaque `live_status` SSE payload. */
interface LiveStatusResponse {
  solar_power?: number;
}

/** The fields this device reads off the merged site_info/tariff_content_v2
 *  document (`TeslemetryEnergySiteStream.siteInfoDocument`). */
interface SiteInfoDocument {
  installation_time_zone?: string;
}

export default class SolarDevice extends TeslemetryDevice {
  site!: EnergyDetails;
  pollingCleanup!: Array<() => void>;
  private timeZone: string | undefined;
  private midnightTimer: NodeJS.Timeout | undefined;

  /** Overridden by tests to control the clock without waiting real time. */
  protected now(): Date {
    return new Date();
  }

  /**
   * `energy_totals` only pushes on a change, so the "today" total goes
   * silent overnight and keeps showing yesterday's value until the day's
   * first sample arrives. This timer forces the reset at the actual local
   * midnight boundary instead, using the site's own installation timezone -
   * the same source the Powerwall tariff resolver trusts - since Tesla's
   * daily totals roll over on that boundary, not the Homey box's timezone.
   */
  private scheduleMidnightReset(timeZone: string): void {
    if (this.midnightTimer !== undefined) {
      this.homey.clearTimeout(this.midnightTimer);
    }
    const delay = msUntilNextLocalMidnight(this.now(), timeZone);
    this.midnightTimer = this.homey.setTimeout(() => {
      this.update("solar_generation_today", 0);
      this.scheduleMidnightReset(timeZone);
    }, delay);
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
    this.resolveAndBindSite();
  }

  private resolveAndBindSite(): void {
    let site: EnergyDetails | undefined;
    try {
      site = this.homey.app.products?.energySites?.[this.getData().id];
      if (!site) throw new Error("No site found");
    } catch (e) {
      if (!(this.homey.app.isReady?.() ?? true)) {
        this.markUnavailable(
          "startup",
          this.homey.__("error.teslemetry_connecting"),
        );
        return;
      }
      this.log("Failed to initialize Solar device");
      this.error(e);
      this.markUnavailable("binding", this.homey.__("error.invalid_refresh_token"));
      return;
    }
    this.bindSite(site);
  }

  public getProductKey(): string | undefined {
    return this.site ? `site:${String(this.site.id)}` : undefined;
  }

  private bindSite(site: EnergyDetails): void {
    this.site = site;
    this.clearAvailabilityReason("startup");
    this.clearAvailabilityReason("binding");

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

    const handleEnergyTotals = async (event: SseEnergyTotals) => {
      const { total_solar_generation } = event.totals;
      if (total_solar_generation === null || total_solar_generation === undefined) {
        return;
      }
      const dateKey = event.createdAt.slice(0, 10);
      await this.update("solar_generation_today", total_solar_generation / 1000);
      await this.updateCumulativeMeter(
        "meter_power",
        total_solar_generation / 1000,
        dateKey,
      );
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
        const timeZone = data?.installation_time_zone;
        if (!timeZone || timeZone === this.timeZone) return;
        this.timeZone = timeZone;
        this.scheduleMidnightReset(timeZone);
      } catch (e) {
        this.error("Failed to schedule solar midnight reset", e);
      }
    };
    this.site.sse.on("site_info", applySiteInfo);
    this.pollingCleanup.push(() =>
      this.site.sse.off("site_info", applySiteInfo),
    );
  }

  async onUninit() {
    await super.onUninit();
    this.pollingCleanup?.forEach((stop) => stop());
  }
}
