import { EnergyDetails, SseLiveStatus } from "@teslemetry/api";
import TeslemetryDevice from "../../lib/TeslemetryDevice.js";

/** The fields this device reads off the opaque `live_status` SSE payload. */
interface LiveStatusResponse {
  wall_connectors?: Array<{
    din: string;
    vin?: string;
    wall_connector_state: number;
    wall_connector_fault_state?: number;
    wall_connector_power: number;
  }>;
}

interface ConnectorBinding {
  siteId: string;
  din: string;
}

export default class WallConnecter extends TeslemetryDevice {
  site!: EnergyDetails;
  din!: string;
  pollingCleanup: Array<() => void> = [];
  private previousFaultCode?: number;

  /**
   * Number of live_status events seen since the current bind, and the
   * current run of consecutive events where this device's DIN was absent
   * from the site's wall_connectors list. DIN_MISS_GRACE_EVENTS skips the
   * first few events after a (re)bind - a cached/initial snapshot may not
   * yet include every connector - and DIN_MISS_THRESHOLD then requires
   * several consecutive misses past that grace before treating the DIN as
   * genuinely gone, so one transient/incomplete event can't flag it.
   */
  private liveStatusEventCount = 0;
  private dinMissStreak = 0;
  private static readonly DIN_MISS_GRACE_EVENTS = 2;
  private static readonly DIN_MISS_THRESHOLD = 3;

  /**
   * onInit is called when the device is initialized.
   */
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
        `Failed to initialize Wall Connector device: energy site not found for id ${siteId}`,
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
   * immutable pairing id (`getData().site`), but a repair rebind overrides
   * it via a store value instead, since Homey device data can't be changed
   * post-pairing.
   */
  public getSiteId(): string {
    const binding = this.getStoreValue(
      "wallConnectorBinding",
    ) as ConnectorBinding | null;
    return (
      binding?.siteId ??
      (this.getStoreValue("energySiteId") as string | null) ??
      this.getData().site
    );
  }

  /**
   * The wall connector DIN this device resolves against. Defaults to the
   * immutable pairing id (`getData().din`), but a repair rebind overrides
   * it via a store value instead, since Homey device data can't be changed
   * post-pairing.
   */
  public getDin(): string {
    const binding = this.getStoreValue(
      "wallConnectorBinding",
    ) as ConnectorBinding | null;
    return (
      binding?.din ??
      (this.getStoreValue("wallConnectorDin") as string | null) ??
      this.getData().din
    );
  }

  /**
   * Explicit, identity-preserving repair action: rebinds this same device to
   * a different site/DIN pair (via store values, not the immutable pairing
   * data) and (re-)registers its live listeners. Called from the driver's
   * repair view once the user confirms a specific connector. Validates the
   * target DIN is actually present at the target site before committing -
   * otherwise this would just reproduce the same "connector" unavailable
   * state under the new binding.
   */
  public async repairConnector(siteId: string, din: string): Promise<void> {
    const site = this.homey.app.products?.energySites?.[siteId];
    if (!site) {
      throw new Error(this.homey.__("error.energy_site_not_found"));
    }
    const siteInfo = await site.api.getSiteInfo().catch(() => null);
    const hasDin = siteInfo?.response?.components?.wall_connectors?.some(
      (connector) => connector.din === din,
    );
    if (!hasDin) {
      throw new Error(this.homey.__("error.wall_connector_not_found"));
    }
    this.pollingCleanup?.forEach((stop) => stop());
    await this.setStoreValue("wallConnectorBinding", { siteId, din });
    // bindSite() itself restores availability via clearAvailabilityReason
    // ("binding"/"connector" are the only reasons a device can have reached
    // this repair flow with) - no separate setAvailable() call needed here.
    this.bindSite(site);
  }

  private bindSite(site: EnergyDetails): void {
    this.site = site;
    this.din = this.getDin();
    this.liveStatusEventCount = 0;
    this.dinMissStreak = 0;
    this.clearAvailabilityReason("startup");
    this.clearAvailabilityReason("binding");

    const onLiveStatus = (event: SseLiveStatus) => {
      const response = event.live_status as LiveStatusResponse;
      // Get specific Wall Connector
      const data = response?.wall_connectors?.find(
        ({ din }) => this.din === din,
      );

      this.liveStatusEventCount++;
      if (!data) {
        if (this.liveStatusEventCount > WallConnecter.DIN_MISS_GRACE_EVENTS) {
          this.dinMissStreak++;
          if (this.dinMissStreak >= WallConnecter.DIN_MISS_THRESHOLD) {
            this.markUnavailable(
              "connector",
              this.homey.__("error.wall_connector_not_found"),
            );
          }
        }
        return;
      }

      this.dinMissStreak = 0;
      this.clearAvailabilityReason("connector");

      // Power
      this.update("measure_power", data.wall_connector_power);

      // State
      this.update(
        "evcharger_charging_state",
        this.mapWallConnectorState(data.wall_connector_state),
      );

      // Connected Vehicle
      this.update("connected_vehicle", this.findVin(data.vin));

      // Fault
      this.handleFaultState(data.wall_connector_fault_state);
    };

    const onChargeHistory = async (
      chargeHistory: NonNullable<typeof this.site.api.cache.chargeHistory>,
    ) => {
      if (!chargeHistory.response?.charge_history?.length) return;

      let charged = 0;
      let hasCharged = false;

      for (const event of chargeHistory.response.charge_history) {
        if (event.din !== this.din || event.energy_added_wh === undefined) {
          continue;
        }
        charged += event.energy_added_wh;
        hasCharged = true;
      }

      if (hasCharged) {
        const now = new Date();
        const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        await this.updateCumulativeMeter("meter_power", charged / 1000, dateKey);
      }
    };

    this.site.sse.on("live_status", onLiveStatus);
    this.site.api.on("chargeHistory", onChargeHistory);

    this.pollingCleanup = [
      this.site.api.requestPolling("chargeHistory"),
      () => this.site.sse.off("live_status", onLiveStatus),
      () => this.site.api.off("chargeHistory", onChargeHistory),
    ];
  }

  /**
   * Map Tesla Wall Connector state (numerical) to Homey evcharger_charging_state (enum)
   * @param state - Numerical state from wall_connector_state
   * @returns The corresponding evcharger_charging_state enum value
   */
  private mapWallConnectorState(state: number): string | undefined {
    switch (state) {
      case 1:
        return "plugged_in_charging";
      case 2:
        return "plugged_out";
      case 3:
        return "plugged_in";
      case 4:
        return "plugged_in_paused";
      default:
        this.log(`Unknown wall_connector_state: ${state}`);
        return undefined;
    }
  }

  /**
   * Maps the raw wall_connector_fault_state code (0 = clear, nonzero = fault)
   * to the alarm_generic.fault capability, firing a tokenized trigger with
   * the raw code on each new fault - there is no documented code table, so
   * every nonzero value is logged as unknown.
   */
  private handleFaultState(code: number | undefined): void {
    if (code === undefined || code === this.previousFaultCode) return;
    this.previousFaultCode = code;

    this.update("alarm_generic.fault", code !== 0);

    if (code !== 0) {
      this.log(`Unknown wall_connector_fault_state code: ${code}`);
      if (this.isLive()) {
        this.homey.flow
          .getDeviceTriggerCard("wall_connector_fault_code")
          .trigger(this, { code })
          .catch(this.error);
      }
    }
  }

  private findVin(vin: string | undefined): string {
    if (!vin) return "disconnected";
    const vehicle = this.homey.app.products?.vehicles[vin];
    return vehicle ? vehicle.name : vin;
  }

  async onUninit(): Promise<void> {
    await super.onUninit();
    this.pollingCleanup?.forEach((stop) => stop());
  }
}
