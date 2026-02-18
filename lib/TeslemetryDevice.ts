import Homey from "homey";
import type TeslemetryApp from "../app.js";
import type TeslemetryDriver from "./TeslemetryDriver.js";
import { TeslemetryApiError } from "../@types/error.js";

export default class TeslemetryDevice extends Homey.Device {
  declare homey: Homey.Device["homey"] & {
    app: TeslemetryApp;
  };

  declare driver: TeslemetryDriver;

  async onInit() {
    await this.ensureCapabilities();
  }

  public async ensureCapabilities() {
    const driverCapabilities = this.driver.manifest.capabilities || [];
    const deviceCapabilities = this.getCapabilities();

    // Remove extra capabilities
    for (const capability of deviceCapabilities) {
      if (!driverCapabilities.includes(capability)) {
        this.log(`Removing capability ${capability}`);
        await this.removeCapability(capability).catch((e) => {
          if (e.statusCode === 404) {
            this.log(
              `Could not remove capability ${capability} as it wasn't found`,
            );
          } else {
            this.error(e);
          }
        });
      }
    }

    // Add missing capabilities
    for (const capability of driverCapabilities) {
      if (!deviceCapabilities.includes(capability)) {
        this.log(`Adding capability ${capability}`);
        await this.addCapability(capability).catch((e) => {
          if (e.statusCode === 404) {
            this.log(
              `Could not add capability ${capability} as it wasn't found`,
            );
          } else {
            this.error(e);
          }
        });
      }
    }
  }

  /**
   * Safely updates a capability value if its supported.
   * @param capability The capability to update.
   * @param value The value from the API
   */
  public async update(capability: string, value: any): Promise<void> {
    // Check if capability is supported
    if (!this.getCapabilities().includes(capability)) {
      this.log(`Capability ${capability} is not supported`);
      return;
    }
    // Evaluate value if required
    if (typeof value === "function") value = value();
    // Check if value is undefined
    if (value === undefined) {
      return;
    }
    // Set the capability value
    // this.log(`Setting capability ${capability} to ${value}`);
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  protected handleApiResponse = ({ response }: { response: any }): void => {
    if (response.result === false) {
      const error = new Error(response.reason) as Error & {
        response: null;
        code: string;
      };
      error.response = null;
      error.code = "command_failed";
      throw error;
    }
  };

  protected handleApiError = (apiError: TeslemetryApiError): never => {
    const { error, error_description } = apiError;
    this.error("API Error:", JSON.stringify(apiError));
    const key = `error.${error}`;
    const translation = this.homey.__(key);
    if (translation && translation !== key) {
      this.error(translation);
      if (error === "invalid_token" || error === "subscription_required") {
        this.setUnavailable(translation).catch(this.error);
      }
      throw new Error(translation);
    }
    this.error(error_description);
    if (error === "invalid_token" || error === "subscription_required") {
      this.setUnavailable(error_description).catch(this.error);
    }
    throw new Error(error_description);
  };

  protected async updateCumulativeMeter(
    capability: string,
    todayTotal: number,
    dateKey: string,
  ): Promise<void> {
    const storeKey = `meter_${capability}`;
    const lastDate = this.getStoreValue(`${storeKey}_date`) as string | null;
    const lastToday = this.getStoreValue(`${storeKey}_last`) as number | null;
    let offset = this.getStoreValue(`${storeKey}_offset`) as number | null;

    // First run: initialize offset from existing capability value
    if (offset === null) {
      const current = this.getCapabilityValue(capability) as number | null;
      offset = (current || 0) - todayTotal;
      await this.setStoreValue(`${storeKey}_offset`, offset);
    }

    // Day rollover: date changed since last poll
    if (lastDate !== null && dateKey !== lastDate && lastToday !== null) {
      offset += lastToday;
      await this.setStoreValue(`${storeKey}_offset`, offset);
    }

    await this.setStoreValue(`${storeKey}_date`, dateKey);
    await this.setStoreValue(`${storeKey}_last`, todayTotal);
    this.update(capability, offset + todayTotal);
  }

  private static readonly ACTION_TIMEOUT = 9000;

  /**
   * Wraps an API action with a 9-second timeout using Promise.race.
   * If the action completes within the timeout, its result or error is returned.
   * If the timeout wins, the promise resolves and the action continues in the background.
   */
  protected action(promise: Promise<unknown>): Promise<void> {
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, TeslemetryDevice.ACTION_TIMEOUT),
    );
    const handled = promise.then(() => {}, this.handleApiError);
    // Prevent unhandled rejection if action fails after timeout
    handled.catch(() => {});
    return Promise.race([handled, timeout]);
  }
}
