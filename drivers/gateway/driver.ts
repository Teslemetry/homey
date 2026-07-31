import Homey from "homey";
import TeslemetryDriver from "../../lib/TeslemetryDriver.js";
import GatewayDevice from "./device.js";

export default class GatewayDriver extends TeslemetryDriver {
  async onRepair(session: any, device: Homey.Device) {
    await super.onRepair(session, device);

    this.wireIdentityRepair(session, device, {
      isTarget: (candidate): candidate is GatewayDevice =>
        candidate instanceof GatewayDevice,
      isBound: (target) =>
        !!this.homey.app.products?.energySites?.[target.getSiteId()],
      findCandidate: (target) => this.findRepairCandidate(target),
      repair: (target, siteId) => target.repairSite(siteId),
      statusEvent: "get_repair_site_status",
      confirmEvent: "confirm_repair_site",
      wrongDeviceMessage: "Not a Gateway device",
    });
  }

  /**
   * The single energy site not already bound to another live Gateway
   * device, if exactly one such site exists. Every accessible site is
   * eligible - onPairListDevices() doesn't filter by a gateway-specific
   * component either. Returns null on zero or multiple matches - the
   * repair view only ever offers a relink when the target is unambiguous.
   */
  private async findRepairCandidate(
    excludeDevice: GatewayDevice,
  ): Promise<{ id: string; name: string } | null> {
    const siblings = (this.getDevices() as Homey.Device[]).filter(
      (candidate): candidate is GatewayDevice =>
        candidate instanceof GatewayDevice,
    );
    return this.findUnboundSiteCandidate(
      siblings,
      excludeDevice,
      (target) => target.getSiteId(),
      async () => true,
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
        if (!siteInfo) return [];

        return [
          {
            name: `${site.name} Gateway`,
            data: {
              id: site.id,
            },
            class: "sensor",
          },
        ];
      },
    );
  }
}
