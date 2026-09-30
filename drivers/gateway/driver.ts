import TeslemetryDriver from "../../lib/TeslemetryDriver.js";

export default class GatewayDriver extends TeslemetryDriver {
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
        // A Wall-Connector-only site has no battery or solar, so no site-level
        // grid/home power ever arrives for a Gateway to show (HA skips it too).
        if (!components?.battery && !components?.solar) return [];

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
