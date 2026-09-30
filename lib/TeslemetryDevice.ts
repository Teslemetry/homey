import { AsyncLocalStorage } from "node:async_hooks";
import Homey from "homey";
import type { SseEnergyTotals } from "@teslemetry/api";
import type TeslemetryApp from "../app.js";
import type TeslemetryDriver from "./TeslemetryDriver.js";
import toError from "./toError.js";

/**
 * Every reason a device can be unavailable, each with its own recovery
 * predicate (see markUnavailable/clearAvailabilityReason below):
 * - "startup": the app hasn't finished building its first Products
 *   generation yet (and has a token and no lapsed subscription - see
 *   TeslemetryApp.notReadyAvailability()); clears once this device
 *   successfully binds.
 * - "binding": this device's specific product/site/vehicle isn't present in
 *   a ready Products generation; clears once this device successfully binds.
 * - "eligibility": the product is present in a ready Products generation but
 *   its own metadata reports it ineligible (vehicle access/telemetry/polling,
 *   energy site access) - revalidated by the same predicate pairing uses, so
 *   the two can't drift; clears once a later bind finds the same product
 *   eligible again.
 * - "stream": the shared SSE connection has been disconnected/erroring past
 *   the freshness grace period; clears only when this device's own product
 *   receives a genuine (non-cache) data event.
 * - "auth": credentials are revoked/disconnected or the subscription has
 *   lapsed; clears only when this device's own product receives a genuine
 *   data event after reauth/renewal.
 * - "connector": Wall Connector only - the site itself resolves, but its
 *   saved DIN hasn't appeared in that site's live_status past the miss
 *   grace period; clears once a live_status event reports that DIN again.
 */
export type AvailabilityReason =
  | "startup"
  | "binding"
  | "eligibility"
  | "stream"
  | "auth"
  | "connector";

/**
 * One atomically-persisted snapshot of a cumulative meter's derived state.
 * `v` guards against trusting a differently-shaped or pre-migration value
 * found at the store key - an unrecognized shape is treated as absent
 * rather than partially applied. v1 keyed energy-site meters on
 * `createdAt`'s UTC date and v2 on the event's site-local `date`, so a v1
 * value is recalibrated rather than compared across two calendars.
 */
interface CumulativeMeterState {
  v: 2;
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
    state.v === 2 &&
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

  /**
   * Marks this device unavailable because no Products generation is ready
   * to bind against, naming the account-level cause when there is one.
   */
  protected markAppNotReady(): void {
    const { reason, message } = this.homey.app.notReadyAvailability();
    this.markUnavailable(reason, message);
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
    "powershare_status",
    "powershare_type",
    "powershare_stop_reason",
    "gear",
    "wifi_connected",
    "cellular_connected",
    "driver_seat_occupied",
    "connected_vehicle",
    "navigation_destination",
    "charging_amps",
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
    "charging_amps",
  ]);

  /**
   * Change-trigger tokens that must not carry the raw capability value. The
   * reserve capabilities are stored as 0-1 fractions (Homey's slider shows
   * them as %), but their `*_changed` cards promise a percentage token.
   */
  private static readonly CHANGE_TRIGGER_TOKEN_SCALE = new Map([
    ["backup_reserve", 100],
    ["off_grid_vehicle_charging_reserve", 100],
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

  /** Capabilities already handed to registerCapabilityListener. */
  private registeredCommandCapabilities?: Set<string>;

  /**
   * The undo for the capability-listener call currently running, if any,
   * read by action() when its command fails after the timeout already
   * reported success. Async context rather than a field, because a listener
   * may await other work before it reaches action().
   */
  private static readonly lateFailureUndo = new AsyncLocalStorage<(() => void) | undefined>();

  /** The latest listener call per capability, so only it may undo. */
  private commandCalls?: Map<string, number>;

  /**
   * Registers a command capability listener exactly once per device
   * lifetime. Homey keeps one listener per capability and warns when a
   * second is registered, and a rebind has nothing to re-register anyway -
   * these listeners read `this.site`/`this.vehicle` at call time, so
   * rebinding already points them at the new product.
   *
   * Homey commits the requested value once the listener resolves, which
   * action() does at its timeout even while the command is still in
   * flight. If that command then fails, the capability is put back to its
   * pre-command value - a sleeping car sends no telemetry to correct it.
   */
  protected registerCommandListener(
    capability: string,
    listener: Parameters<Homey.Device["registerCapabilityListener"]>[1],
  ): void {
    const registered = (this.registeredCommandCapabilities ??= new Set());
    if (registered.has(capability)) return;
    registered.add(capability);
    this.registerCapabilityListener(capability, async (value, opts) => {
      const calls = (this.commandCalls ??= new Map());
      const call = (calls.get(capability) ?? 0) + 1;
      calls.set(capability, call);
      let undo: (() => void) | undefined;
      try {
        const previous = this.getCapabilityValue(capability);
        undo = () => this.undoLateFailure(capability, value, previous, call);
      } catch (error) {
        this.error(error);
      }
      return TeslemetryDevice.lateFailureUndo.run(undo, () =>
        listener(value, opts),
      );
    });
  }

  /**
   * Restores `previous` unless something already moved the capability off
   * the value this call requested (telemetry, or a newer command).
   */
  private undoLateFailure(
    capability: string,
    requested: unknown,
    previous: unknown,
    call: number,
  ): void {
    try {
      if (this.destroyed || this.commandCalls?.get(capability) !== call) return;
      if (capability === "button" || capability.startsWith("button.")) return;
      if (previous === requested) return;
      if (this.getCapabilityValue(capability) !== requested) return;
      this.setCapabilityValue(capability, previous).catch(this.error);
    } catch (error) {
      this.error(error);
    }
  }

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
  public async update(capability: string, value: any): Promise<boolean> {
    // Every caller of update()/updateWithThresholdTriggers() fires it
    // without awaiting/catching from SSE signal handlers, so this boundary
    // must never reject - an uncaught rejection here becomes a process-level
    // unhandledRejection, not just a failed update for this one device.
    try {
      // Skip if the device has been removed
      if (this.destroyed) return false;
      // Check if capability is supported
      if (!this.getCapabilities().includes(capability)) {
        this.log(`Capability ${capability} is not supported`);
        return false;
      }
      // Evaluate value if required
      if (typeof value === "function") value = value();
      // Check if value is undefined
      if (value === undefined) {
        return false;
      }
      const hasChangeTrigger =
        TeslemetryDevice.CHANGE_TRIGGER_CAPABILITIES.has(capability);
      // getCapabilityValue reads Homey's own persisted value, which survives
      // an app restart - a null/undefined previousValue means no genuine prior
      // value exists yet (for example, on a fresh device), so that first write
      // must only set a baseline, never fire the change trigger.
      const previousValue = hasChangeTrigger
        ? this.getCapabilityValue(capability)
        : undefined;
      // Set the capability value
      await this.setCapabilityValue(capability, value);
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
        const scale =
          TeslemetryDevice.CHANGE_TRIGGER_TOKEN_SCALE.get(capability);
        // Reserve percentages are whole numbers; round away the float noise
        // of 0.35 * 100.
        const token = scale === undefined ? value : Math.round(value * scale);
        this.homey.flow
          .getDeviceTriggerCard(`${capability}_changed`)
          .trigger(this, { [capability]: token })
          .catch(this.error);
      }
      return true;
    } catch (error) {
      this.error(error);
      return false;
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
    // Same non-rejecting boundary contract as update() above - callers
    // discard this Promise from SSE signal handlers too.
    try {
      if (value === undefined) return;
      // null is an explicit clear (e.g. navigation ended): write it so the
      // threshold conditions fail closed, but never fire a trigger on it.
      if (value === null) {
        await this.update(capability, null);
        return;
      }
      const previous = this.getCapabilityValue(capability) as number | null;
      const updated = await this.update(capability, value);
      if (!updated) return;
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
    } catch (error) {
      this.error(error);
    }
  }

  /**
   * Reasons Tesla returns with `result: false` when the vehicle is already in
   * the requested state (or has accepted the request), which HA's
   * `handle_vehicle_command` also treats as success.
   */
  private static readonly BENIGN_COMMAND_REASONS = new Set([
    "already_set",
    "not_charging",
    "requested",
  ]);

  protected handleApiResponse = ({ response }: { response: any }): void => {
    if (response.result !== false) return;
    if (TeslemetryDevice.BENIGN_COMMAND_REASONS.has(response.reason)) return;
    const error = new Error(
      response.reason || this.homey.__("error.command_no_result"),
    ) as Error & {
      response: null;
      code: string;
    };
    error.response = null;
    error.code = "command_failed";
    throw error;
  };

  protected handleApiError = (apiError: unknown): never => {
    // JSON.stringify(Error) is "{}" (message/stack aren't enumerable), so a
    // plain Error - which a lower layer already logged and translated - is
    // logged by name and message and rethrown as-is by toError(), unless its
    // message is blank.
    if (apiError instanceof Error) {
      this.error(`API Error: ${apiError.name}: ${apiError.message}`, apiError.stack);
    } else {
      this.error("API Error:", JSON.stringify(apiError));
    }
    const error = toError(apiError, (key) => this.homey.__(key));
    if (apiError instanceof Error) throw error;
    this.error(error.message);
    if (error.code === "invalid_token" || error.code === "subscription_required") {
      this.markUnavailable("auth", error.message);
    }
    throw error;
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

  /** Newest site-local day seen on this device's `energy_totals`. */
  private latestEnergyTotalsDate?: string;
  /** Newest day already ended by this device's local-midnight reset. */
  private closedEnergyTotalsDate?: string;

  /**
   * The installation-local day an `energy_totals` event covers (its `date`,
   * or `createdAt`'s UTC date only when `date` is absent), and whether it is
   * the site's current day: the newest seen, and not one a local-midnight
   * reset has since closed. The api publishes the prior day's final just
   * after local midnight, so a `*_today` gauge must only take a `current`
   * event or it flashes yesterday's total after its reset; the cumulative
   * meters take every event and order days themselves.
   */
  protected energyTotalsDay(event: SseEnergyTotals): {
    date: string;
    current: boolean;
  } {
    const date = event.date ?? event.createdAt.slice(0, 10);
    const latest = this.latestEnergyTotalsDate;
    const closed = this.closedEnergyTotalsDate;
    const current =
      (latest === undefined || date >= latest) &&
      (closed === undefined || date > closed);
    if (current) this.latestEnergyTotalsDate = date;
    return { date, current };
  }

  /** Called by a device's local-midnight reset: every day seen so far is over. */
  protected closeEnergyTotalsDay(): void {
    this.closedEnergyTotalsDate = this.latestEnergyTotalsDate;
  }

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

    const newState: CumulativeMeterState = { v: 2, date: dateKey, lastTotal, offset };
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
    const undoLateFailure = TeslemetryDevice.lateFailureUndo.getStore();
    // If the timeout already won the race (flow card reported success), a
    // later rejection would otherwise vanish silently. Log it prominently
    // instead of discarding it - for a Flow card it's the only trace of the
    // failure - and undo the value Homey committed if a capability listener
    // sent it.
    handled.catch((error) => {
      if (timedOut) {
        this.error(
          `Action on ${this.getName()} failed after the ${TeslemetryDevice.ACTION_TIMEOUT}ms action timeout had already reported success to the flow:`,
          error,
        );
        undoLateFailure?.();
      }
    });
    // Clear the timer the moment the command settles first, so a fast
    // command doesn't leave its 9s timer (and this closure) referenced.
    handled.finally(() => clearTimeout(timer)).catch(() => {});
    return Promise.race([handled, timeout]);
  }
}
