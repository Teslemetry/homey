import TeslemetryDriver from "../../lib/TeslemetryDriver.js";

export default class MediaDriver extends TeslemetryDriver {
  async onPairListDevices() {
    const products = await this.homey.app.getProducts();
    if (!products) {
      throw new Error(
        "Failed to load products. Please restart the pairing process",
      );
    }

    try {
      // Only includes vehicles with a subscription, that support fleet telemetry, and are configured correctly
      return Object.values(products.vehicles)
        .filter(
          ({ metadata }) =>
            metadata.access && !!metadata.fleet_telemetry && !metadata.polling,
        )
        .map((data) => ({
          name: `${data.name} Media`,
          data: {
            vin: data.vin,
          },
        }));
    } catch (error) {
      this.homey.error("Failed to list vehicles:", error);
      throw new Error(
        "Failed to load vehicles from Teslemetry. Please check your connection and try again.",
      );
    }
  }
}
