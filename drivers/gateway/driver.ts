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
