import Homey from "homey";
import type TeslemetryApp from "../app.js";
import type TeslemetryDriver from "./TeslemetryDriver.js";
import { TeslemetryApiError } from "../@types/error.js";

export default class TeslemetryDevice extends Homey.Device {
  declare homey: Homey.Device["homey"] & {
    app: TeslemetryApp;
  };

  declare driver: TeslemetryDriver;

  /**
   * Set once the device has been uninitialised/deleted. Guards against
   * stale, in-flight API callbacks writing to a device Homey no longer
   * knows about (which throws "Not Found: Device with ID ...").
   */
  protected destroyed = false;

  /**
   * Capabilities with a declared `*_changed` flow trigger card. The card ID
   * and token name both match the capability name for each of these.
   */
  private static readonly CHANGE_TRIGGER_CAPABILITIES = new Set([
    "allow_export",
    "backup_reserve",
    "operation_mode",
    "steering_wheel_heater",
    "grid_buy_rate",
    "grid_sell_rate",
    "tpms_warning",
  ]);

  async onInit() {
    await this.ensureCapabilities();
  }

  async onUninit(): Promise<void> {
    this.destroyed = true;
  }

  /**
   * Re-resolves this device's product (energy site or vehicle) from
   * `homey.app.products` and re-registers its SSE listeners, torn down and
   * built up exactly as they are in `onInit()`. `TeslemetryApp.reinitialize()`
   * builds a brand new `Products`/SSE connection when the Teslemetry session
   * gets torn down and recreated (an auth failure recovering, a saved token
   * refresh); without this, an already-paired device keeps its listeners on
   * the old, now-dead per-product stream forever - it stays "available" but
   * silently stops receiving any live data. Subclasses that hold a
   * `site`/`vehicle` reference override this; the default no-op covers
   * subclasses with no such reference to go stale.
   */
  public rebindProduct(): void {}

  /**
   * Whether this device instance is still safe to fire a Flow trigger for.
   * `destroyed` alone isn't enough: the Apps SDK removes a deleted device
   * from the driver's runtime map before calling onUninit(), so a write
   * that was already in flight can resume in that gap with destroyed still
   * false. Checking current membership in driver.getDevices() closes it.
   * Call this after the last await and immediately before every
   * `.trigger(this, ...)`.
   */
  protected isLive(): boolean {
    return !this.destroyed && this.driver.getDevices().includes(this);
  }

  /**
   * The capabilities this device instance should have. Defaults to the
   * driver's full static manifest list; subclasses override to exclude
   * capabilities that don't apply to this specific device (e.g. a
   * model-gated feature), since the manifest itself has no per-instance
   * concept.
   */
  protected getExpectedCapabilities(): string[] {
    return this.driver.manifest.capabilities || [];
  }

  public async ensureCapabilities() {
    const driverCapabilities = this.getExpectedCapabilities();
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
    // Skip if the device has been removed
    if (this.destroyed) return;
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
    const hasChangeTrigger = TeslemetryDevice.CHANGE_TRIGGER_CAPABILITIES.has(
      capability,
    );
    const previousValue = hasChangeTrigger
      ? this.getCapabilityValue(capability)
      : undefined;
    // Set the capability value
    // this.log(`Setting capability ${capability} to ${value}`);
    try {
      await this.setCapabilityValue(capability, value);
    } catch (error) {
      this.error(error);
      return;
    }
    if (hasChangeTrigger && previousValue !== value && this.isLive()) {
      this.homey.flow
        .getDeviceTriggerCard(`${capability}_changed`)
        .trigger(this, { [capability]: value })
        .catch(this.error);
    }
  }

  /**
   * Updates a numeric capability and fires its paired <cap>_above/<cap>_below
   * threshold trigger cards with {previous,current} state, mirroring
   * battery_below's pattern: this only fires on a real value change, and
   * each flow's own numeric argument decides whether *that* card's
   * threshold was actually crossed (see the registerRunListener pair for
   * these card IDs in app.ts).
   */
  protected async updateWithThresholdTriggers(
    capability: string,
    value: number | undefined | null,
    aboveCardId: string,
    belowCardId: string,
    tokenName: string,
  ): Promise<void> {
    if (value === undefined || value === null) return;
    const previous = this.getCapabilityValue(capability) as number | null;
    await this.update(capability, value);
    if (previous === null || previous === undefined || previous === value) {
      return;
    }
    if (!this.isLive()) return;
    const tokens = { [tokenName]: value };
    const state = { previous, current: value };
    this.homey.flow
      .getDeviceTriggerCard(aboveCardId)
      .trigger(this, tokens, state)
      .catch(this.error);
    this.homey.flow
      .getDeviceTriggerCard(belowCardId)
      .trigger(this, tokens, state)
      .catch(this.error);
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

  protected handleApiError = (apiError: TeslemetryApiError | Error): never => {
    // A plain Error means a lower layer already logged and translated it;
    // JSON.stringify(Error) is "{}" (message/stack aren't enumerable), so
    // rethrow it as-is instead of re-wrapping it into a blank-message Error.
    if (apiError instanceof Error) {
      this.error(`API Error: ${apiError.name}: ${apiError.message}`, apiError.stack);
      throw apiError;
    }
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

  /**
   * Persists a store value, tolerating the device being removed mid-flight.
   * setStoreValue on a deleted device throws "Not Found: Device with ID ...",
   * which would otherwise surface as an unhandled rejection from async API
   * callbacks. Returns false if the write was skipped/failed because the
   * device is gone.
   */
  private async setStore(key: string, value: unknown): Promise<boolean> {
    if (this.destroyed) return false;
    try {
      await this.setStoreValue(key, value);
      return true;
    } catch (e) {
      if (this.destroyed) return false;
      this.error(e);
      return false;
    }
  }

  protected async updateCumulativeMeter(
    capability: string,
    todayTotal: number,
    dateKey: string,
  ): Promise<void> {
    if (this.destroyed) return;

    const storeKey = `meter_${capability}`;
    const lastDate = this.getStoreValue(`${storeKey}_date`) as string | null;
    const lastToday = this.getStoreValue(`${storeKey}_last`) as number | null;
    let offset = this.getStoreValue(`${storeKey}_offset`) as number | null;

    // First run: initialize offset from existing capability value
    if (offset === null) {
      const current = this.getCapabilityValue(capability) as number | null;
      offset = (current || 0) - todayTotal;
      if (!(await this.setStore(`${storeKey}_offset`, offset))) return;
    }

    // Day rollover: date changed since last poll
    if (lastDate !== null && dateKey !== lastDate && lastToday !== null) {
      offset += lastToday;
      if (!(await this.setStore(`${storeKey}_offset`, offset))) return;
    }

    if (!(await this.setStore(`${storeKey}_date`, dateKey))) return;
    if (!(await this.setStore(`${storeKey}_last`, todayTotal))) return;
    this.update(capability, offset + todayTotal);
  }

  private static readonly ACTION_TIMEOUT = 9000;

  /**
   * Wraps an API action with a 9-second timeout using Promise.race.
   * If the action completes within the timeout, its result or error is returned.
   * If the timeout wins, the promise resolves and the action continues in the background.
   */
  protected action(promise: Promise<unknown>): Promise<void> {
    let timedOut = false;
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, TeslemetryDevice.ACTION_TIMEOUT),
    );
    const handled = promise.then(() => {}, this.handleApiError);
    // If the timeout already won the race (flow card reported success), a
    // later rejection would otherwise vanish silently. Log it prominently
    // instead of discarding it, since it's the only trace of the failure.
    handled.catch((error) => {
      if (timedOut) {
        this.error(
          `Action on ${this.getName()} failed after the ${TeslemetryDevice.ACTION_TIMEOUT}ms action timeout had already reported success to the flow:`,
          error,
        );
      }
    });
    return Promise.race([handled, timeout]);
  }
}
