import Homey from "homey";
import TeslemetryDriver from "../../lib/TeslemetryDriver.js";
import PowerwallDevice from "./device.js";

export default class PowerwallDriver extends TeslemetryDriver {
  async onRepair(session: any, device: Homey.Device) {
    await super.onRepair(session, device);

    session.setHandler("get_repair_site_status", async () => {
      if (!(device instanceof PowerwallDevice)) return { needsRepair: false };

      if (this.homey.app.products?.energySites?.[device.getSiteId()]) {
        return { needsRepair: false };
      }

      const candidate = await this.findRepairCandidate(device);
      return {
        needsRepair: true,
        candidateId: candidate?.id ?? null,
        candidateName: candidate?.name ?? null,
      };
    });

    session.setHandler("confirm_repair_site", async (siteId: string) => {
      if (!(device instanceof PowerwallDevice)) {
        throw new Error("Not a Powerwall device");
      }
      await device.repairSite(siteId);
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
    const { products } = this.homey.app;
    if (!products?.energySites) return null;

    const boundSiteIds = new Set(
      (this.getDevices() as Homey.Device[])
        .filter(
          (candidate): candidate is PowerwallDevice =>
            candidate instanceof PowerwallDevice && candidate !== excludeDevice,
        )
        .map((candidate) => candidate.getSiteId()),
    );

    const candidates: Array<{ id: string; name: string }> = [];
    for (const site of Object.values(products.energySites)) {
      const siteId = String(site.id);
      if (boundSiteIds.has(siteId)) continue;
      const siteInfo = await site.api.getSiteInfo().catch(() => null);
      if (siteInfo?.response.components?.battery) {
        candidates.push({ id: siteId, name: site.name });
      }
    }

    return candidates.length === 1 ? candidates[0] : null;
  }

  async onPairListDevices() {
    const products = await this.homey.app.getProducts();
    if (!products) {
      throw new Error(
        "Failed to load products. Please restart the pairing process",
      );
    }

    return (
      await Promise.all(
        Object.values(products.energySites).map(async (site) => {
          const siteInfo = await site.api.getSiteInfo();
          if (!siteInfo?.response.components?.battery) return null;

          return {
            name: `${site.name} Powerwall`,
            data: {
              id: site.id,
            },
            class: "battery",
          };
        }),
      )
    ).filter((device): device is NonNullable<typeof device> => device !== null);
  }
}
