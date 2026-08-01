import Homey from "homey";
import type TeslemetryApp from "../app.js";
import type TeslemetryDriver from "./TeslemetryDriver.js";
import { TeslemetryApiError } from "../@types/error.js";

/**
 * Every reason a device can be unavailable, each with its own recovery
 * predicate (see markUnavailable/clearAvailabilityReason below):
 * - "startup": the app hasn't finished building its first Products
 *   generation yet; clears once this device successfully binds.
 * - "binding": this device's specific product/site/vehicle isn't present in
 *   a ready Products generation; clears once this device successfully binds.
 * - "stream": the shared SSE connection has been disconnected/erroring past
 *   the freshness grace period; clears only when this device's own product
 *   receives a genuine (non-cache) data event.
 * - "auth": credentials are revoked/disconnected; clears only when this
 *   device's own product receives a genuine data event after reauth.
 * - "connector": Wall Connector only - the site itself resolves, but its
 *   saved DIN hasn't appeared in that site's live_status past the miss
 *   grace period; clears once a live_status event reports that DIN again.
 */
export type AvailabilityReason =
  | "startup"
  | "binding"
  | "stream"
  | "auth"
  | "connector";

/**
 * One atomically-persisted snapshot of a cumulative meter's derived state.
 * `v` guards against trusting a differently-shaped or pre-migration value
 * found at the store key - an unrecognized shape is treated as absent
 * rather than partially applied.
 */
interface CumulativeMeterState {
  v: 1;
  date: string;
  lastTotal: number;
  offset: number;
}

function isCumulativeMeterState(
  value: unknown,
): value is CumulativeMeterState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    state.v === 1 &&
    typeof state.date === "string" &&
    typeof state.lastTotal === "number" &&
    typeof state.offset === "number"
  );
}

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
   * The reason this device is currently unavailable, or undefined when
   * available. Set only through markUnavailable/clearAvailabilityReason so
   * recovery from one cause (e.g. a stream reconnect) can never clear an
   * unrelated cause (e.g. a missing product binding).
   */
  private availabilityReason?: AvailabilityReason;

  /**
   * Marks the device unavailable for a specific, tracked reason. Overwrites
   * any previously tracked reason - the newest cause of unavailability wins.
   */
  public markUnavailable(reason: AvailabilityReason, message: string): void {
    this.availabilityReason = reason;
    this.setUnavailable(message).catch(this.error);
  }

  /**
   * Restores availability, but only if the device is currently unavailable
   * for exactly this reason. A no-op otherwise, so e.g. a stream reconnect
   * can never paper over a device that's unavailable because its product
   * binding is missing.
   */
  public clearAvailabilityReason(reason: AvailabilityReason): void {
    if (this.availabilityReason !== reason) return;
    this.availabilityReason = undefined;
    this.setAvailable().catch(this.error);
  }

  protected getAvailabilityReason(): AvailabilityReason | undefined {
    return this.availabilityReason;
  }

  /**
   * The app-level product key (`vehicle:<vin>` / `site:<id>`) this device is
   * currently bound to, or undefined when unbound. Used by TeslemetryApp's
   * per-product stream freshness watchdog to find which devices a genuine
   * data event or a stale-stream escalation applies to. Subclasses that hold
   * a product reference override this once bound.
   */
  public getProductKey(): string | undefined {
    return undefined;
  }

  /**
   * Capabilities with a declared `*_changed` flow trigger card. The card ID
   * and token name both match the capability name for each of these.
   */
  private static readonly CHANGE_TRIGGER_CAPABILITIES = new Set([
    "allow_export",
    "backup_reserve",
    "off_grid_vehicle_charging_reserve",
    "operation_mode",
    "steering_wheel_heater",
    "grid_buy_rate",
    "grid_sell_rate",
    "tpms_warning",
    "cop_mode",
    "cop_temperature_limit",
    "software_update_status",
    "scheduled_charging_mode",
    "scheduled_charging_pending",
  ]);

  /**
   * The subset of CHANGE_TRIGGER_CAPABILITIES whose `*_changed` Flow card
   * carries a numeric token (Apps SDK rejects null/undefined/non-finite for
   * a numeric token - see NUMERIC_CHANGE_TRIGGER_CAPABILITIES usage in
   * update()).
   */
  private static readonly NUMERIC_CHANGE_TRIGGER_CAPABILITIES = new Set([
    "backup_reserve",
    "off_grid_vehicle_charging_reserve",
    "grid_buy_rate",
    "grid_sell_rate",
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
   * built up exactly as they are in `onInit()`. Whenever
   * `TeslemetryApp.initializeTeslemetry()` publishes a new `Products`/SSE
   * connection, an already-paired device would otherwise keep its listeners
   * on the old, now-dead per-product stream forever - it stays "available" but
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
    // getCapabilityValue reads Homey's own persisted value, which survives
    // an app restart - a null/undefined previousValue means no genuine prior
    // value exists yet (for example, on a fresh device), so that first write
    // must only set a baseline, never fire the change trigger.
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
    const isInvalidNumericToken =
      TeslemetryDevice.NUMERIC_CHANGE_TRIGGER_CAPABILITIES.has(capability) &&
      (typeof value !== "number" || !Number.isFinite(value));
    if (
      hasChangeTrigger &&
      previousValue !== null &&
      previousValue !== undefined &&
      previousValue !== value &&
      !isInvalidNumericToken &&
      this.isLive()
    ) {
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
        this.markUnavailable("auth", translation);
      }
      throw new Error(translation);
    }
    this.error(error_description);
    if (error === "invalid_token" || error === "subscription_required") {
      this.markUnavailable("auth", error_description);
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

  /**
   * Per-capability update queues so two close SSE events for the same
   * cumulative meter can never interleave its read-modify-write cycle.
   * Lazily initialized rather than a field initializer, since some tests
   * construct devices via `Object.create(Driver.prototype)` without running
   * the constructor.
   */
  private cumulativeMeterQueues?: Map<string, Promise<void>>;

  /**
   * Converts a source system's daily running total into a monotonically
   * increasing `meter_*` capability value. See AGENTS.md's "Cumulative
   * Energy Meters" section for why this exists.
   *
   * `dateKey` must be a zero-padded ISO `YYYY-MM-DD` string - every caller
   * derives it that way - so plain string comparison orders it correctly,
   * with no timezone-parsing ambiguity from constructing a `Date`.
   */
  protected updateCumulativeMeter(
    capability: string,
    todayTotal: number,
    dateKey: string,
  ): Promise<void> {
    const queues = (this.cumulativeMeterQueues ??= new Map());
    const previous = queues.get(capability) ?? Promise.resolve();
    // Swallow a prior failure here (not at the caller) so one bad event
    // can't wedge every later update for this capability behind it.
    const next = previous
      .catch(() => {})
      .then(() =>
        this.runCumulativeMeterUpdate(capability, todayTotal, dateKey),
      );
    queues.set(capability, next);
    return next;
  }

  private async runCumulativeMeterUpdate(
    capability: string,
    todayTotal: number,
    dateKey: string,
  ): Promise<void> {
    if (this.destroyed) return;

    const storeKey = `meter_${capability}_state`;
    const stored = this.getStoreValue(storeKey) as unknown;
    const state = isCumulativeMeterState(stored) ? stored : null;

    let offset: number;
    let lastTotal: number;

    if (state === null) {
      // First run, or a store value from before this format existed / an
      // unrecognized shape: recalibrate from whatever the capability
      // already shows so this can't make the meter jump or go backwards.
      const current = this.getCapabilityValue(capability) as number | null;
      offset = (current || 0) - todayTotal;
      lastTotal = todayTotal;
    } else if (dateKey < state.date) {
      // Older than the last-applied event - applying it would either write
      // a decrease or fold its day into the offset a second time.
      return;
    } else if (dateKey === state.date) {
      if (todayTotal < state.lastTotal) {
        // Same-day source regression - clamp instead of decreasing.
        return;
      }
      offset = state.offset;
      lastTotal = todayTotal;
    } else {
      // Forward day rollover: fold the prior day's final total into the
      // offset exactly once, then start tracking the new day.
      offset = state.offset + state.lastTotal;
      lastTotal = todayTotal;
    }

    const newState: CumulativeMeterState = { v: 1, date: dateKey, lastTotal, offset };
    if (!(await this.setStore(storeKey, newState))) return;

    await this.update(capability, offset + lastTotal);
  }

  private static readonly ACTION_TIMEOUT = 9000;

  /**
   * Wraps an API action with a 9-second timeout using Promise.race.
   * If the action completes within the timeout, its result or error is returned.
   * If the timeout wins, the promise resolves and the action continues in the background.
   */
  protected action(promise: Promise<unknown>): Promise<void> {
    let timedOut = false;
    let timer: NodeJS.Timeout;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, TeslemetryDevice.ACTION_TIMEOUT);
    });
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
    // Clear the timer the moment the command settles first, so a fast
    // command doesn't leave its 9s timer (and this closure) referenced.
    handled.finally(() => clearTimeout(timer)).catch(() => {});
    return Promise.race([handled, timeout]);
  }
}
