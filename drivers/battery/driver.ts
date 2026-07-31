import Homey from "homey";
import TeslemetryDriver from "../../lib/TeslemetryDriver.js";
import PowerwallDevice from "./device.js";

export default class PowerwallDriver extends TeslemetryDriver {
  async onRepair(session: any, device: Homey.Device) {
    await super.onRepair(session, device);

    this.wireIdentityRepair(session, device, {
      isTarget: (candidate): candidate is PowerwallDevice =>
        candidate instanceof PowerwallDevice,
      isBound: (target) =>
        !!this.homey.app.products?.energySites?.[target.getSiteId()],
      findCandidate: (target) => this.findRepairCandidate(target),
      repair: (target, siteId) => target.repairSite(siteId),
      statusEvent: "get_repair_site_status",
      confirmEvent: "confirm_repair_site",
      wrongDeviceMessage: "Not a Powerwall device",
    });
  }

  /**
   * The single battery-capable energy site not already bound to another live
   * Powerwall device, if exactly one such site exists. Returns null on zero
   * or multiple matches - the repair view only ever offers a relink when the
   * target is unambiguous, never guessing among several sites.
   */
  private async findRepairCandidate(
    excludeDevice: PowerwallDevice,
  ): Promise<{ id: string; name: string } | null> {
    const siblings = (this.getDevices() as Homey.Device[]).filter(
      (candidate): candidate is PowerwallDevice =>
        candidate instanceof PowerwallDevice,
    );
    return this.findUnboundSiteCandidate(
      siblings,
      excludeDevice,
      (target) => target.getSiteId(),
      async (site) => {
        const siteInfo = await site.api.getSiteInfo().catch(() => null);
        return !!siteInfo?.response.components?.battery;
      },
    );
  }

  async onPairListDevices() {
    const products = await this.homey.app.getProducts();
    if (!products) {
      throw new Error(
        "Failed to load products. Please restart the pairing process",
      );
    }

    return this.listEnergySiteCandidates(
      Object.values(products.energySites),
      async (site) => {
        const siteInfo = await site.api.getSiteInfo();
        if (!siteInfo?.response.components?.battery) return [];

        return [
          {
            name: `${site.name} Powerwall`,
            data: {
              id: String(site.id),
            },
            class: "battery",
          },
        ];
      },
    );
  }
}
