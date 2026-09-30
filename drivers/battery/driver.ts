import TeslemetryDriver from "../../lib/TeslemetryDriver.js";

/** The site_info `components` fields the gates below read. */
interface SiteComponents {
  battery?: boolean | null;
  solar?: boolean | null;
  storm_mode_capable?: boolean | null;
  off_grid_vehicle_charging_reserve_supported?: boolean | null;
}

/**
 * Powerwall capabilities that only apply to some site hardware, mirroring
 * the Teslemetry HA integration's entity predicates (charge-from-grid switch
 * and export rule select: battery AND solar; storm mode switch:
 * storm_mode_capable; off-grid EV reserve number:
 * off_grid_vehicle_charging_reserve_supported).
 */
const COMPONENT_GATES: Record<string, (components: SiteComponents) => boolean> = {
  "onoff.charge_grid": (c) => !!c.battery && !!c.solar,
  allow_export: (c) => !!c.battery && !!c.solar,
  "onoff.storm": (c) => !!c.storm_mode_capable,
  off_grid_vehicle_charging_reserve: (c) =>
    !!c.off_grid_vehicle_charging_reserve_supported,
};

export function isPowerwallCapabilitySupported(
  capability: string,
  components: SiteComponents,
): boolean {
  return COMPONENT_GATES[capability]?.(components) ?? true;
}

/**
 * Whether `components` is a real read of the site's hardware: its required
 * `battery` and `solar` booleans are both present. Anything less (no
 * site_info yet, or a components block of nulls) is unknown, and must never
 * be read as "unsupported".
 */
export function hasKnownComponents(
  components: SiteComponents | undefined,
): components is SiteComponents {
  return (
    typeof components?.battery === "boolean" &&
    typeof components?.solar === "boolean"
  );
}

export function isComponentGatedCapability(capability: string): boolean {
  return capability in COMPONENT_GATES;
}

export default class PowerwallDriver extends TeslemetryDriver {
  async onPairListDevices() {
    const products = await this.homey.app.getProducts();
    if (!products) {
      this.error(
        "pairing[stage=products_fetch]: getProducts() returned no products",
      );
      throw new Error(
        "Failed to load products. Please restart the pairing process",
      );
    }

    return this.listEnergySiteCandidates(
      Object.values(products.energySites),
      async (site) => {
        const siteInfo = await site.api.getSiteInfo();
        const components = siteInfo?.response.components;
        if (!components?.battery) return [];

        return [
          {
            name: `${site.name} Powerwall`,
            data: {
              id: site.id,
            },
            class: "battery",
            capabilities: (this.manifest.capabilities as string[]).filter(
              (capability) =>
                isPowerwallCapabilitySupported(capability, components),
            ),
          },
        ];
      },
    );
  }
}
