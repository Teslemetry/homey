import { EnergyDetails, SseEnergyTotals, SseLiveStatus } from "@teslemetry/api";
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

/** The fields this device reads off the opaque `live_status` SSE payload. */
interface LiveStatusResponse {
  grid_power?: number;
  load_power?: number;
  grid_status?: string;
  island_status?: string;
}

export default class GatewayDevice extends TeslemetryDevice {
  site!: EnergyDetails;
  pollingCleanup!: Array<() => void>;

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
    return String(
      (this.getStoreValue("energySiteId") as string | null) ??
        this.getData().id,
    );
  }

  /**
   * Explicit, identity-preserving repair action: rebinds this same device to
   * a different energy site id (via a store value, not the immutable
   * pairing data) and (re-)registers its live listeners. Called from the
   * driver's repair view once the user confirms a specific site.
   */
  public async repairSite(siteId: string): Promise<void> {
    const site = this.homey.app.products?.energySites?.[siteId];
    if (!site) {
      throw new Error(this.homey.__("error.energy_site_not_found"));
    }
    this.pollingCleanup?.forEach((stop) => stop());
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
      this.update(
        "alarm_generic.off_grid",
        gridStatusMap.get(data.grid_status),
      );
      this.update(
        "alarm_generic.island",
        islandStatusMap.get(data.island_status),
      );
    };

    const handleEnergyTotals = async (event: SseEnergyTotals) => {
      const dateKey = event.createdAt.slice(0, 10);
      const { grid_energy_imported, total_grid_energy_exported } =
        event.totals;

      if (grid_energy_imported !== null && grid_energy_imported !== undefined) {
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
        await this.updateCumulativeMeter(
          "meter_power.exported",
          total_grid_energy_exported / 1000,
          dateKey,
        );
      }
    };
    // EventEmitter doesn't await listeners, so an unhandled rejection here
    // would otherwise crash the app instead of just failing this update.
    const onEnergyTotals = (event: SseEnergyTotals) => {
      return handleEnergyTotals(event).catch(this.error);
    };

    this.site.sse.on("live_status", onLiveStatus);
    this.site.sse.on("energy_totals", onEnergyTotals);

    this.pollingCleanup = [
      () => this.site.sse.off("live_status", onLiveStatus),
      () => this.site.sse.off("energy_totals", onEnergyTotals),
    ];
  }

  async onUninit(): Promise<void> {
    await super.onUninit();
    this.pollingCleanup?.forEach((stop) => stop());
  }
}
