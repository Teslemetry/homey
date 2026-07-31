import Homey from "homey";
import TeslemetryDriver from "../../lib/TeslemetryDriver.js";
import WallConnecter from "./device.js";

export default class WallConnectorDriver extends TeslemetryDriver {
  async onRepair(session: any, device: Homey.Device) {
    await super.onRepair(session, device);

    this.wireIdentityRepair(session, device, {
      isTarget: (candidate): candidate is WallConnecter =>
        candidate instanceof WallConnecter,
      isBound: (target) => this.isConnectorBound(target),
      findCandidate: (target) => this.findRepairCandidate(target),
      repair: (target, candidateId) => {
        const [siteId, din] = candidateId.split("::");
        return target.repairConnector(siteId, din);
      },
      statusEvent: "get_repair_connector_status",
      confirmEvent: "confirm_repair_connector",
      wrongDeviceMessage: "Not a Wall Connector device",
    });
  }

  /**
   * Whether this device's current site+DIN pair still resolves to a real
   * connector - covers both a missing site (finding 4) and a site that
   * resolves but no longer lists this DIN (finding 5) with one check.
   */
  private async isConnectorBound(target: WallConnecter): Promise<boolean> {
    const site = this.homey.app.products?.energySites?.[target.getSiteId()];
    if (!site) return false;
    const siteInfo = await site.api.getSiteInfo().catch(() => null);
    const wallConnectors = siteInfo?.response?.components?.wall_connectors ?? [];
    return wallConnectors.some((connector) => connector.din === target.getDin());
  }

  /**
   * The single accessible site+DIN pair not already bound to another live
   * Wall Connector device, if exactly one such pair exists across every
   * accessible energy site. Returns null on zero or multiple matches - the
   * repair view only ever offers a relink when the target is unambiguous,
   * never guessing among several connectors.
   */
  private async findRepairCandidate(
    excludeDevice: WallConnecter,
  ): Promise<{ id: string; name: string } | null> {
    const { products } = this.homey.app;
    if (!products?.energySites) return null;

    const boundKeys = new Set(
      (this.getDevices() as Homey.Device[])
        .filter(
          (candidate): candidate is WallConnecter =>
            candidate instanceof WallConnecter && candidate !== excludeDevice,
        )
        .map((candidate) => `${candidate.getSiteId()}::${candidate.getDin()}`),
    );

    const candidates: Array<{ id: string; name: string }> = [];
    for (const site of Object.values(products.energySites)) {
      if (!site.metadata.access) continue;
      const siteInfo = await site.api.getSiteInfo().catch(() => null);
      const wallConnectors = siteInfo?.response?.components?.wall_connectors ?? [];
      for (const connector of wallConnectors) {
        const key = `${String(site.id)}::${connector.din}`;
        if (boundKeys.has(key)) continue;
        candidates.push({ id: key, name: `${site.name} ${connector.part_name}` });
      }
    }

    return candidates.length === 1 ? candidates[0] : null;
  }

  async onPairListDevices() {
    const products = await this.homey.app.getProducts();
    if (!products) {
      throw new Error(
        "Failed to load wall connectors from Teslemetry. Please check your connection and try again.",
      );
    }

    const sitesResults = await Promise.all(
      Object.values(products.energySites)
        .filter(({ metadata }) => metadata.access)
        .map(async (site) => {
          const siteInfo = await site.api.getSiteInfo();
          const wallConnectors =
            siteInfo.response?.components?.wall_connectors ?? [];

          return wallConnectors.map((connector) => ({
            name: `${site.name} ${connector.part_name}`,
            data: {
              site: site.id,
              din: connector.din,
            },
          }));
        }),
    );
    return sitesResults.flat();
  }
}
