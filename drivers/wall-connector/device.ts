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

export default class WallConnecter extends TeslemetryDevice {
  site!: EnergyDetails;
  din!: string;
  pollingCleanup!: Array<() => void>;
  private previousFaultCode?: number;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    await super.onInit();
    this.din = this.getData().din;
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
    let site: EnergyDetails | undefined;
    try {
      site = this.homey.app.products?.energySites?.[this.getData().site];
      if (!site) throw new Error("No site found");
    } catch (e) {
      this.log("Failed to initialize Wall Connector device");
      this.error(e);
      return;
    }
    this.bindSite(site);
  }

  public getProductKey(): string | undefined {
    return this.site ? `site:${String(this.site.id)}` : undefined;
  }

  private bindSite(site: EnergyDetails): void {
    this.site = site;

    const onLiveStatus = (event: SseLiveStatus) => {
      const response = event.live_status as LiveStatusResponse;
      // Get specific Wall Connector
      const data = response?.wall_connectors?.find(
        ({ din }) => this.din === din,
      );

      if (!data) return;

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
    this.pollingCleanup.forEach((stop) => stop());
  }
}
