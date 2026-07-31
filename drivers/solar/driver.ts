import TeslemetryDriver from "../../lib/TeslemetryDriver.js";

export default class SolarDriver extends TeslemetryDriver {
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
              id: site.id,
            },
            class: "solarpanel",
          },
        ];
      },
    );
  }
}
