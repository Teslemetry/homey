import Homey from "homey";
import TeslemetryDriver from "../../lib/TeslemetryDriver.js";
import SolarDevice from "./device.js";

export default class SolarDriver extends TeslemetryDriver {
  async onRepair(session: any, device: Homey.Device) {
    await super.onRepair(session, device);

    this.wireIdentityRepair(session, device, {
      isTarget: (candidate): candidate is SolarDevice =>
        candidate instanceof SolarDevice,
      isBound: (target) =>
        !!this.homey.app.products?.energySites?.[target.getSiteId()],
      findCandidate: (target) => this.findRepairCandidate(target),
      repair: (target, siteId) => target.repairSite(siteId),
      statusEvent: "get_repair_site_status",
      confirmEvent: "confirm_repair_site",
      wrongDeviceMessage: "Not a Solar device",
    });
  }

  /**
   * The single solar-capable energy site not already bound to another live
   * Solar device, if exactly one such site exists. Returns null on zero or
   * multiple matches - the repair view only ever offers a relink when the
   * target is unambiguous, never guessing among several sites.
   */
  private async findRepairCandidate(
    excludeDevice: SolarDevice,
  ): Promise<{ id: string; name: string } | null> {
    const siblings = (this.getDevices() as Homey.Device[]).filter(
      (candidate): candidate is SolarDevice => candidate instanceof SolarDevice,
    );
    return this.findUnboundSiteCandidate(
      siblings,
      excludeDevice,
      (target) => target.getSiteId(),
      async (site) => {
        const siteInfo = await site.api.getSiteInfo().catch(() => null);
        return !!siteInfo?.response.components?.solar;
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
        if (!siteInfo?.response.components?.solar) return [];

        return [
          {
            name: `${site.name} Solar`,
            data: {
              id: String(site.id),
            },
            class: "solarpanel",
          },
        ];
      },
    );
  }
}
