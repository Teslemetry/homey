import sourceMapSupport from 'source-map-support';

import Homey from 'homey';
import { Products, Teslemetry } from '@teslemetry/api';
import type { TeslemetryStreamErrorEvent } from '@teslemetry/api';
import TeslemetryOAuth2Client from './lib/TeslemetryOAuth2Client.js';
import TeslemetryDevice from './lib/TeslemetryDevice.js';
import type { TeslemetryApiError } from './@types/error.d.ts';
import type VehicleDevice from './drivers/vehicle/device.js';
import type PowerwallDevice from './drivers/battery/device.js';
import type SolarDevice from './drivers/solar/device.js';
import type GatewayDevice from './drivers/gateway/device.js';

sourceMapSupport.install();

// Signal-carrying SSE events that only fire once the stream is genuinely
// connected and receiving data (unlike the SDK's "connect" event, which
// fires optimistically before the underlying HTTP request even completes).
// Includes one energy-site topic (live_status) so this also fires for
// accounts with energy sites but no vehicles.
const SSE_DATA_EVENTS = ['state', 'data', 'connectivity', 'live_status'] as const;

// Exact wire topics this app consumes, passed explicitly to the stream so
// the server only forwards what's actually used - see drivers/vehicle/device.ts
// for the vehicle signals and drivers/battery|solar|gateway|wall-connector/device.ts
// for the energy events.
const SSE_TOPICS = [
  'state',
  'data',
  'connectivity',
  'live_status',
  'site_info',
  'tariff_content_v2',
  'energy_totals',
] as const;

/**
 * The subset of fields this app reads off a genuine (live, non-cache)
 * SSE_DATA_EVENTS payload to identify which product it belongs to. Matches
 * TeslemetryDevice.getProductKey()'s `vehicle:<vin>` / `site:<id>` shape.
 */
interface ProductEventPayload {
  vin?: string;
  site_id?: string;
  isCache?: boolean;
}

export default class TeslemetryApp extends Homey.App {
  public oauth!: TeslemetryOAuth2Client;
  public teslemetry?: Teslemetry;
  public products?: Products;

  // Every attempt to build/rebuild teslemetry/products is chained onto this
  // promise, so overlapping callers (concurrent getProducts()/getTeslemetry()
  // calls, a token refresh landing mid-build) can never observe or publish a
  // half-built generation - see initializeTeslemetry().
  private initChain: Promise<void> = Promise.resolve();

  // Bumped when a completed build is published and on every teardown. Captured by
  // each generation's own stream event handlers so a straggler event from an
  // already-superseded/closed SDK instance can't mutate current state. SDK
  // 0.11.x's close() is itself async and aborts the active fetch/reconnect
  // loop, so this check is defense-in-depth rather than a workaround for an
  // unabortable request.
  private generation = 0;

  // True once a Products generation has been fully built and published.
  private ready = false;

  private startupRetryTimer?: NodeJS.Timeout;
  private startupRetryAttempt = 0;
  private static readonly STARTUP_RETRY_BASE_MS = 5_000;
  private static readonly STARTUP_RETRY_MAX_MS = 300_000;

  // Per-product ("vehicle:<vin>" / "site:<id>") timestamp of the last
  // genuine (non-cache) data event, for the stream freshness watchdog.
  private lastProductEventAt = new Map<string, number>();
  private productStaleTimers = new Map<string, NodeJS.Timeout>();
  private static readonly STREAM_STALE_GRACE_MS = 90_000;

  private logger = {
    info: (...args: unknown[]) => this.log(...args),
    error: (...args: unknown[]) => this.error(...args),
    warn: (...args: unknown[]) => this.log(...args),
    debug: (...args: unknown[]) => this.log(...args),
  };

  /**
   * onInit is called when the app is initialized
   */
  async onInit() {
    this.log('Teslemetry App initializing...');

    this.oauth = new TeslemetryOAuth2Client(this);

    // A saved token can be refreshed/replaced at any time; force a fresh
    // Products generation rather than trusting the current one still
    // matches the new token.
    this.oauth.onTokenSaved = () => {
      this.log('Token saved, re-initializing Teslemetry...');
      this.initializeTeslemetry(true).catch((error) => {
        this.error('Failed to reinitialize after token save:', error);
      });
    };

    // Register Flow card handlers
    this.registerFlowCards();

    // A transient failure here (network blip, momentary metadata error)
    // must not strand every device for the lifetime of the process - retry
    // with bounded backoff instead of letting this catch be the end of it.
    await this.initializeTeslemetry().catch((error) => {
      this.log(error.message);
      this.scheduleStartupRetry();
    });
  }

  async onUninit(): Promise<void> {
    this.oauth.onTokenSaved = undefined;
    if (this.startupRetryTimer !== undefined) {
      this.homey.clearTimeout(this.startupRetryTimer);
      this.startupRetryTimer = undefined;
    }
    this.cleanup();
  }

  /**
   * A saved Flow argument can outlive its device (removed and re-paired
   * elsewhere); TeslemetryDriver.getDeviceById then resolves it to undefined
   * instead of crashing the app. Actions must fail loudly and clearly;
   * conditions/trigger predicates must fail closed instead of silently
   * no-opping or matching by accident.
   */
  private requireFlowDevice<T>(device: T | undefined | null): T {
    if (!device) {
      throw new Error(this.homey.__('error.device_removed'));
    }
    return device;
  }

  /**
   * Register Flow card action handlers
   */
  private registerFlowCards(): void {
    // Vehicle action cards
    this.homey.flow
      .getActionCard('flash_lights')
      .registerRunListener(async (args: { device?: VehicleDevice }) => {
        await this.requireFlowDevice(args.device).flowFlashLights();
      });

    this.homey.flow
      .getActionCard('honk_horn')
      .registerRunListener(async (args: { device?: VehicleDevice }) => {
        await this.requireFlowDevice(args.device).flowHonkHorn();
      });

    this.homey.flow
      .getActionCard('keyless_driving')
      .registerRunListener(async (args: { device?: VehicleDevice }) => {
        await this.requireFlowDevice(args.device).flowStartKeylessDriving();
      });

    this.homey.flow
      .getActionCard('homelink')
      .registerRunListener(async (args: { device?: VehicleDevice }) => {
        await this.requireFlowDevice(args.device).flowTriggerHomelink();
      });

    this.homey.flow
      .getActionCard('wake_up')
      .registerRunListener(async (args: { device?: VehicleDevice }) => {
        await this.requireFlowDevice(args.device).flowWakeUp();
      });

    this.homey.flow
      .getActionCard('set_steering_wheel_heater')
      .registerRunListener(
        async (args: { device?: VehicleDevice; level: string }) => {
          await this.requireFlowDevice(args.device).flowSetSteeringWheelHeater(
            args.level,
          );
        },
      );

    this.homey.flow
      .getActionCard('start_charging')
      .registerRunListener(async (args: { device?: VehicleDevice }) => {
        await this.requireFlowDevice(args.device).flowStartCharging();
      });

    this.homey.flow
      .getActionCard('stop_charging')
      .registerRunListener(async (args: { device?: VehicleDevice }) => {
        await this.requireFlowDevice(args.device).flowStopCharging();
      });

    this.homey.flow
      .getActionCard('set_charge_limit')
      .registerRunListener(
        async (args: { device?: VehicleDevice; percentage: number }) => {
          await this.requireFlowDevice(args.device).flowSetChargeLimit(
            args.percentage,
          );
        },
      );

    this.homey.flow
      .getActionCard('set_charging_amps')
      .registerRunListener(
        async (args: { device?: VehicleDevice; amps: number }) => {
          await this.requireFlowDevice(args.device).flowSetChargingAmps(
            args.amps,
          );
        },
      );

    this.homey.flow
      .getActionCard('navigate_to_address')
      .registerRunListener(
        async (args: { device?: VehicleDevice; address: string }) => {
          await this.requireFlowDevice(args.device).flowNavigateToAddress(
            args.address,
          );
        },
      );

    this.homey.flow
      .getActionCard('set_cabin_temperature')
      .registerRunListener(
        async (args: { device?: VehicleDevice; temperature: number }) => {
          await this.requireFlowDevice(args.device).flowSetCabinTemperature(
            args.temperature,
          );
        },
      );

    this.homey.flow
      .getActionCard('set_climate_mode')
      .registerRunListener(
        async (args: { device?: VehicleDevice; mode: string }) => {
          await this.requireFlowDevice(args.device).flowSetClimateMode(
            args.mode,
          );
        },
      );

    this.homey.flow
      .getActionCard('set_cop_mode')
      .registerRunListener(
        async (args: { device?: VehicleDevice; mode: string }) => {
          await this.requireFlowDevice(args.device).flowSetCopMode(
            args.mode,
          );
        },
      );

    this.homey.flow
      .getActionCard('set_cop_temperature_limit')
      .registerRunListener(
        async (args: { device?: VehicleDevice; limit: string }) => {
          await this.requireFlowDevice(args.device).flowSetCopTemperatureLimit(
            args.limit,
          );
        },
      );

    this.homey.flow
      .getActionCard('set_bioweapon_defense_mode')
      .registerRunListener(
        async (args: { device?: VehicleDevice; state: string }) => {
          await this.requireFlowDevice(
            args.device,
          ).flowSetBioweaponDefenseMode(args.state);
        },
      );

    this.homey.flow
      .getActionCard('install_software_update')
      .registerRunListener(async (args: { device?: VehicleDevice }) => {
        await this.requireFlowDevice(args.device).flowInstallSoftwareUpdate();
      });

    this.homey.flow
      .getActionCard('cancel_software_update')
      .registerRunListener(async (args: { device?: VehicleDevice }) => {
        await this.requireFlowDevice(args.device).flowCancelSoftwareUpdate();
      });

    this.homey.flow
      .getActionCard('enable_scheduled_charging')
      .registerRunListener(
        async (args: { device?: VehicleDevice; time: string }) => {
          await this.requireFlowDevice(args.device).flowEnableScheduledCharging(
            args.time,
          );
        },
      );

    this.homey.flow
      .getActionCard('disable_scheduled_charging')
      .registerRunListener(async (args: { device?: VehicleDevice }) => {
        await this.requireFlowDevice(args.device).flowDisableScheduledCharging();
      });

    this.homey.flow
      .getActionCard('enable_scheduled_departure')
      .registerRunListener(
        async (args: {
          device?: VehicleDevice;
          departure_time: string;
          preconditioning_enabled: boolean;
          preconditioning_weekdays_only: boolean;
          off_peak_charging_enabled: boolean;
          off_peak_charging_weekdays_only: boolean;
          end_off_peak_time: string;
        }) => {
          await this.requireFlowDevice(args.device).flowEnableScheduledDeparture({
            departureTime: args.departure_time,
            preconditioningEnabled: args.preconditioning_enabled,
            preconditioningWeekdaysOnly: args.preconditioning_weekdays_only,
            offPeakChargingEnabled: args.off_peak_charging_enabled,
            offPeakChargingWeekdaysOnly: args.off_peak_charging_weekdays_only,
            endOffPeakTime: args.end_off_peak_time,
          });
        },
      );

    this.homey.flow
      .getActionCard('disable_scheduled_departure')
      .registerRunListener(async (args: { device?: VehicleDevice }) => {
        await this.requireFlowDevice(args.device).flowDisableScheduledDeparture();
      });

    this.homey.flow
      .getActionCard('add_charge_schedule')
      .registerRunListener(
        async (args: {
          device?: VehicleDevice; name: string; days_of_week: string;
          enabled: boolean; start_enabled: boolean; start_time: string;
          end_enabled: boolean; end_time: string; lat: number; lon: number;
          one_time: boolean;
        }) => {
          await this.requireFlowDevice(args.device).flowAddChargeSchedule({
            name: args.name, daysOfWeek: args.days_of_week, enabled: args.enabled,
            startEnabled: args.start_enabled, startTime: args.start_time,
            endEnabled: args.end_enabled, endTime: args.end_time,
            lat: args.lat, lon: args.lon, oneTime: args.one_time,
          });
        },
      );

    this.homey.flow
      .getActionCard('remove_charge_schedule')
      .registerRunListener(async (args: { device?: VehicleDevice; id: number }) => {
        await this.requireFlowDevice(args.device).flowRemoveChargeSchedule(args.id);
      });

    this.homey.flow
      .getActionCard('add_precondition_schedule')
      .registerRunListener(
        async (args: {
          device?: VehicleDevice; name: string; days_of_week: string;
          enabled: boolean; precondition_time: string; lat: number; lon: number;
          one_time: boolean;
        }) => {
          await this.requireFlowDevice(args.device).flowAddPreconditionSchedule({
            name: args.name, daysOfWeek: args.days_of_week, enabled: args.enabled,
            preconditionTime: args.precondition_time, lat: args.lat, lon: args.lon,
            oneTime: args.one_time,
          });
        },
      );

    this.homey.flow
      .getActionCard('remove_precondition_schedule')
      .registerRunListener(async (args: { device?: VehicleDevice; id: number }) => {
        await this.requireFlowDevice(args.device).flowRemovePreconditionSchedule(args.id);
      });

    // Valet mode / speed limit: args.pin is passed straight to the device
    // method and must never be logged - see VehicleDevice's flow* methods.
    this.homey.flow
      .getActionCard('enable_valet_mode')
      .registerRunListener(
        async (args: { device?: VehicleDevice; pin: string }) => {
          await this.requireFlowDevice(args.device).flowEnableValetMode(
            args.pin,
          );
        },
      );

    this.homey.flow
      .getActionCard('disable_valet_mode')
      .registerRunListener(
        async (args: { device?: VehicleDevice; pin: string }) => {
          await this.requireFlowDevice(args.device).flowDisableValetMode(
            args.pin,
          );
        },
      );

    this.homey.flow
      .getActionCard('activate_speed_limit')
      .registerRunListener(
        async (args: { device?: VehicleDevice; pin: string }) => {
          await this.requireFlowDevice(args.device).flowActivateSpeedLimit(
            args.pin,
          );
        },
      );

    this.homey.flow
      .getActionCard('deactivate_speed_limit')
      .registerRunListener(
        async (args: { device?: VehicleDevice; pin: string }) => {
          await this.requireFlowDevice(args.device).flowDeactivateSpeedLimit(
            args.pin,
          );
        },
      );

    // Vehicle seat climate action cards (subcapabilities get no auto-generated
    // Flow cards; the device capability filter Homey applies to driver-scoped
    // cards already hides these for seats a device wasn't paired with).
    const seatHeaterPositions = [
      'front_left',
      'front_right',
      'rear_left',
      'rear_right',
      'rear_center',
    ] as const;
    for (const position of seatHeaterPositions) {
      this.homey.flow
        .getActionCard(`seat_heater.${position}_set`)
        .registerRunListener(
          async (args: { device?: VehicleDevice; level: string }) => {
            await this.requireFlowDevice(args.device).flowSetSeatHeater(
              position,
              args.level,
            );
          },
        );
    }

    const seatCoolerPositions = ['front_left', 'front_right'] as const;
    for (const position of seatCoolerPositions) {
      this.homey.flow
        .getActionCard(`seat_cooler.${position}_set`)
        .registerRunListener(
          async (args: { device?: VehicleDevice; level: string }) => {
            await this.requireFlowDevice(args.device).flowSetSeatCooler(
              position,
              args.level,
            );
          },
        );
    }

    // Battery/Powerwall action cards
    this.homey.flow
      .getActionCard('set_backup_reserve')
      .registerRunListener(
        async (args: { device?: PowerwallDevice; percentage: number }) => {
          await this.requireFlowDevice(args.device).flowSetBackupReserve(
            args.percentage,
          );
        },
      );

    this.homey.flow
      .getActionCard('set_off_grid_vehicle_charging_reserve')
      .registerRunListener(
        async (args: { device?: PowerwallDevice; percentage: number }) => {
          await this.requireFlowDevice(
            args.device,
          ).flowSetOffGridVehicleChargingReserve(args.percentage);
        },
      );

    this.homey.flow
      .getActionCard('set_allow_export')
      .registerRunListener(
        async (args: {
          device?: PowerwallDevice;
          mode: 'battery_ok' | 'pv_only' | 'never';
        }) => {
          await this.requireFlowDevice(args.device).flowSetAllowExport(
            args.mode,
          );
        },
      );

    this.homey.flow
      .getActionCard('set_operation_mode')
      .registerRunListener(
        async (args: {
          device?: PowerwallDevice;
          mode: 'self_consumption' | 'backup' | 'autonomous';
        }) => {
          await this.requireFlowDevice(args.device).flowSetOperationMode(
            args.mode,
          );
        },
      );

    // Condition cards
    this.homey.flow
      .getConditionCard('operation_mode_is')
      .registerRunListener(
        async (args: { device?: PowerwallDevice; mode: string }) => {
          if (!args.device) return false;
          return args.device.getCapabilityValue('operation_mode') === args.mode;
        },
      );

    this.homey.flow
      .getConditionCard('battery_level')
      .registerRunListener(
        async (args: { device?: PowerwallDevice; percentage: number }) => {
          if (!args.device) return false;
          return (
            args.device.getCapabilityValue('measure_battery') >= args.percentage
          );
        },
      );

    this.homey.flow
      .getConditionCard('is_charging')
      .registerRunListener(async (args: { device?: VehicleDevice }) => {
        if (!args.device) return false;
        return !!args.device.getCapabilityValue('evcharger_charging');
      });

    this.homey.flow
      .getConditionCard('is_plugged_in')
      .registerRunListener(async (args: { device?: VehicleDevice }) => {
        if (!args.device) return false;
        return args.device.isPluggedIn();
      });

    this.homey.flow
      .getConditionCard('tpms_warning_is')
      .registerRunListener(
        async (args: { device?: VehicleDevice; level: string }) => {
          if (!args.device) return false;
          return args.device.getCapabilityValue('tpms_warning') === args.level;
        },
      );

    this.homey.flow
      .getConditionCard('cop_mode_is')
      .registerRunListener(
        async (args: { device?: VehicleDevice; mode: string }) => {
          if (!args.device) return false;
          return args.device.getCapabilityValue('cop_mode') === args.mode;
        },
      );

    this.homey.flow
      .getConditionCard('powershare_status_is')
      .registerRunListener(
        async (args: { device?: VehicleDevice; status: string }) => {
          if (!args.device) return false;
          return (
            args.device.getCapabilityValue('powershare_status') ===
            args.status
          );
        },
      );

    this.homey.flow
      .getConditionCard('cop_temperature_limit_is')
      .registerRunListener(
        async (args: { device?: VehicleDevice; limit: string }) => {
          if (!args.device) return false;
          return (
            args.device.getCapabilityValue('cop_temperature_limit') ===
            args.limit
          );
        },
      );

    this.homey.flow
      .getConditionCard('software_update_status_is')
      .registerRunListener(
        async (args: { device?: VehicleDevice; status: string }) => {
          if (!args.device) return false;
          return (
            args.device.getCapabilityValue('software_update_status') ===
            args.status
          );
        },
      );

    this.homey.flow
      .getConditionCard('island_status')
      .registerRunListener(
        async (args: { device?: GatewayDevice; status: string }) => {
          if (!args.device) return false;
          return args.device.getCapabilityValue('island_status') === args.status;
        },
      );

    // Vehicle trigger cards with per-card arguments need a run listener to
    // decide whether *this* card's threshold was actually crossed; cards
    // without args default to firing whenever .trigger() is called.
    this.homey.flow
      .getDeviceTriggerCard('battery_below')
      .registerRunListener(
        async (
          args: { device?: VehicleDevice; percentage: number },
          state: { previous: number; current: number },
        ) => {
          if (!args.device) return false;
          return state.previous >= args.percentage && state.current < args.percentage;
        },
      );

    // Power/tariff threshold trigger and condition cards: same
    // above/below-crossing pattern as battery_below, registered once per
    // capability across the three energy drivers that carry power/rate
    // values (Solar, Gateway, Powerwall).
    this.registerThresholdCards('solar_power', 'measure_power', 'watts');
    this.registerThresholdCards('grid_power', 'measure_power', 'watts');
    this.registerThresholdCards('load_power', 'measure_power.load', 'watts');
    this.registerThresholdCards(
      'generator_power',
      'measure_power.generator',
      'watts',
    );
    this.registerThresholdCards('battery_power', 'measure_power', 'watts');
    this.registerThresholdCards('grid_buy_rate', 'grid_buy_rate', 'rate');
    this.registerThresholdCards('grid_sell_rate', 'grid_sell_rate', 'rate');

    // Route/ETA threshold cards: same pattern, Vehicle-only.
    this.registerThresholdCards(
      'minutes_to_arrival',
      'minutes_to_arrival',
      'minutes',
    );
    this.registerThresholdCards(
      'route_traffic_delay',
      'route_traffic_delay',
      'minutes',
    );
    this.registerThresholdCards(
      'energy_at_arrival',
      'measure_battery.arrival',
      'percentage',
    );

    this.log('Flow card handlers registered');
  }

  /**
   * Registers the <prefix>_above/<prefix>_below trigger cards and the
   * <prefix> condition card for a numeric capability, using the same
   * crossing-check pattern as battery_below: the device fires the trigger
   * on every real value change with {previous,current} state, and this
   * listener decides whether *that* flow's own threshold argument was
   * actually crossed.
   */
  private registerThresholdCards(
    cardPrefix: string,
    capability: string,
    argName: string,
  ): void {
    type ThresholdArgs = {
      device?: SolarDevice | GatewayDevice | PowerwallDevice | VehicleDevice;
      [key: string]: unknown;
    };

    this.homey.flow
      .getDeviceTriggerCard(`${cardPrefix}_above`)
      .registerRunListener(
        async (
          args: ThresholdArgs,
          state: { previous: number; current: number },
        ) => {
          if (!args.device) return false;
          const threshold = args[argName] as number;
          return state.previous <= threshold && state.current > threshold;
        },
      );

    this.homey.flow
      .getDeviceTriggerCard(`${cardPrefix}_below`)
      .registerRunListener(
        async (
          args: ThresholdArgs,
          state: { previous: number; current: number },
        ) => {
          if (!args.device) return false;
          const threshold = args[argName] as number;
          return state.previous >= threshold && state.current < threshold;
        },
      );

    this.homey.flow
      .getConditionCard(cardPrefix)
      .registerRunListener(async (args: ThresholdArgs) => {
        if (!args.device) return false;
        return (
          (args.device.getCapabilityValue(capability) as number) >=
          (args[argName] as number)
        );
      });
  }

  /**
   * Ensures teslemetry/products reflect a fully-built Products generation.
   * Single-flight and generation-safe: every call - concurrent or
   * sequential, from onInit, a token refresh, driver pairing, or the
   * startup retry timer - chains onto the same promise, so two builds can
   * never run at once and no caller can ever observe a half-built or
   * already-superseded generation. `forceRebuild` (a saved-token change)
   * always builds a fresh generation even if the current one is `ready`;
   * otherwise an already-ready generation is left alone.
   * @throws Error if this attempt's build fails (no token, or the build
   * itself failed) - callers decide whether that's fatal or retryable.
   */
  private initializeTeslemetry(forceRebuild = false): Promise<void> {
    const run = async () => {
      if (!forceRebuild && this.ready) return;
      await this.doInitialize();
    };
    this.initChain = this.initChain.then(run, run);
    return this.initChain;
  }

  /**
   * Builds one Products generation into local variables, attaches its
   * stream handlers to that local instance, and only touches
   * `this.teslemetry`/`this.products` after the build fully succeeds - so a
   * failed build never leaves those fields half-updated, and no code path
   * can observe an SDK instance whose Products came from a different
   * instance. The previous generation's stream (if any) is closed only
   * after the new one is live, so there's no gap with no active stream at
   * all during a token-refresh rebuild.
   */
  private async doInitialize(): Promise<void> {
    if (!this.oauth.hasValidToken()) {
      throw new Error('No OAuth2 token available. User needs to authenticate.');
    }

    const baseGeneration = this.generation;
    this.log('Initializing Teslemetry...');

    const sdk = new Teslemetry(this.oauth.getAccessToken, {
      logger: this.logger,
      stream: {
        cache: true,
        topics: SSE_TOPICS,
      },
    });

    let products: Products;
    try {
      // No .catch(this.handleApiError) here: a real API error surfaces via
      // TeslemetryOAuth2Client's own handleApiError call during token
      // fetching, which already logs and translates it before rethrowing.
      products = await sdk.createProducts();
    } catch (error) {
      sdk.sse.close();
      throw error;
    }

    if (this.generation !== baseGeneration || !this.oauth.hasValidToken()) {
      sdk.sse.close();
      return;
    }

    const generation = baseGeneration + 1;
    this.attachStreamHandlers(sdk, generation);

    const oldSdk = this.teslemetry;
    this.generation = generation;
    this.cancelAllProductStaleChecks();
    this.teslemetry = sdk;
    this.products = products;
    this.ready = true;
    this.startupRetryAttempt = 0;
    if (this.startupRetryTimer !== undefined) {
      this.homey.clearTimeout(this.startupRetryTimer);
      this.startupRetryTimer = undefined;
    }

    sdk.sse.connect();
    if (oldSdk && oldSdk !== sdk) {
      oldSdk.sse.close();
    }

    const vehicleCount = Object.keys(products.vehicles).length;
    const energyCount = Object.keys(products.energySites).length;
    this.log(
      `Teslemetry initialized successfully! Found ${vehicleCount} vehicles and ${energyCount} energy sites. (generation ${generation})`,
    );

    // A no-op on first boot (no devices are paired yet at this point in
    // startup); load-bearing whenever this is a rebuild of an already
    // running app (token refresh, or a lazy re-init after teardown) or the
    // startup retry recovering from a transient failure - see
    // rebindAllDeviceProducts().
    this.rebindAllDeviceProducts();
  }

  /**
   * Attaches this generation's stream event handlers to its own local `sdk`
   * instance. Every handler checks `generation !== this.generation` first so
   * a straggler event from an already-superseded/closed generation can't
   * mutate current freshness/availability state.
   */
  private attachStreamHandlers(sdk: Teslemetry, generation: number): void {
    for (const event of SSE_DATA_EVENTS) {
      sdk.sse.on(event, (payload: ProductEventPayload) =>
        this.handleGenuineStreamEvent(generation, payload),
      );
    }
    sdk.sse.on('disconnect', () => this.handleStreamDisconnect(generation));
    sdk.sse.on('stream_error', (event) =>
      this.handleStreamError(generation, event).catch(this.error),
    );
    sdk.sse.on('auth_failure', () => {
      if (generation !== this.generation) return;
      this.stopSseAndSurfaceReauth();
    });
  }

  /**
   * A transient startup/rebuild failure must not strand every device for
   * the lifetime of the process. Retries with bounded exponential backoff;
   * a successful doInitialize() cancels this on its own. Does not schedule
   * without a valid token - that's an auth problem the OAuth pairing/repair
   * flow must resolve, not a timer.
   */
  private scheduleStartupRetry(): void {
    if (this.startupRetryTimer !== undefined) return;
    if (!this.oauth.hasValidToken()) return;

    const delay = Math.min(
      TeslemetryApp.STARTUP_RETRY_BASE_MS * 2 ** this.startupRetryAttempt,
      TeslemetryApp.STARTUP_RETRY_MAX_MS,
    );
    this.startupRetryAttempt++;
    this.log(
      `Retrying Teslemetry startup in ${Math.round(delay / 1000)}s (attempt ${this.startupRetryAttempt})`,
    );
    this.startupRetryTimer = this.homey.setTimeout(() => {
      this.startupRetryTimer = undefined;
      this.initializeTeslemetry().catch((error) => {
        this.log(error.message);
        this.scheduleStartupRetry();
      });
    }, delay);
  }

  /**
   * Rebinds every already-paired device across every driver to the
   * `products` object that was just (re)built. Every device captures its
   * own site/vehicle reference and registers SSE listeners on it during its
   * own onInit(); recreating `this.products` here without this would leave
   * those devices listening on the old, now-dead per-product streams
   * forever - staying "available" while silently never receiving another
   * update again. See TeslemetryDevice.rebindProduct().
   */
  private rebindAllDeviceProducts(): void {
    this.forEachTeslemetryDevice((device) => device.rebindProduct());
  }

  private forEachTeslemetryDevice(callback: (device: TeslemetryDevice) => void): void {
    const drivers = Object.values(this.homey.drivers.getDrivers());
    for (const driver of drivers) {
      for (const device of driver.getDevices()) {
        if (device instanceof TeslemetryDevice) callback(device);
      }
    }
  }

  private getDevicesForProductKey(key: string): TeslemetryDevice[] {
    const matches: TeslemetryDevice[] = [];
    this.forEachTeslemetryDevice((device) => {
      if (device.getProductKey() === key) matches.push(device);
    });
    return matches;
  }

  /**
   * Clean up Teslemetry connection and resources. Bumps `generation`
   * unconditionally (even with no active teslemetry) so any already
   * in-flight/queued stream event from a just-closed SDK is recognized as
   * stale by attachStreamHandlers' generation check.
   */
  cleanup(): void {
    this.generation++;
    this.cancelAllProductStaleChecks();
    this.lastProductEventAt.clear();
    this.ready = false;
    if (this.teslemetry) {
      this.teslemetry.sse.close();
      this.teslemetry = undefined;
      this.products = undefined;
      this.log('Teslemetry connection cleaned up');
    }
  }

  /**
   * Get the current Teslemetry instance, initializing if needed. Errors
   * propagate to the caller (driver pairing flows already handle an
   * undefined/thrown result with their own user-facing message).
   */
  async getTeslemetry(): Promise<Teslemetry | undefined> {
    await this.initializeTeslemetry();
    return this.teslemetry;
  }

  /**
   * Get the current Products instance, initializing if needed.
   */
  async getProducts(): Promise<Products | undefined> {
    await this.initializeTeslemetry();
    return this.products;
  }

  /** Whether the current Products generation has been fully built and published. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Check if the app is properly configured with OAuth2
   */
  isConfigured(): boolean {
    return this.oauth.hasValidToken() && this.ready;
  }

  public handleApiError = (apiError: TeslemetryApiError | Error): never => {
    // A plain Error means a lower layer already logged and translated it;
    // JSON.stringify(Error) is "{}" (message/stack aren't enumerable), so
    // rethrow it as-is instead of re-wrapping it into a blank-message Error.
    if (apiError instanceof Error) {
      this.error(`API Error: ${apiError.name}: ${apiError.message}`, apiError.stack);
      throw apiError;
    }
    const { error, error_description } = apiError;
    this.error('API Error:', JSON.stringify(apiError));
    const key = `error.${error?.toLowerCase()}`;
    const translation = this.homey.__(key);
    if (translation && translation !== key) {
      this.error(translation);
      throw new Error(translation);
    }
    this.error(error_description);
    throw new Error(error_description);
  };

  /**
   * The product key ("vehicle:<vin>" / "site:<id>") a genuine SSE_DATA_EVENTS
   * payload belongs to, matching TeslemetryDevice.getProductKey()'s shape.
   */
  private productKeyForEvent(payload: ProductEventPayload): string | undefined {
    if (payload.vin) return `vehicle:${payload.vin}`;
    if (payload.site_id) return `site:${payload.site_id}`;
    return undefined;
  }

  /**
   * Fires on every state/data/connectivity/live_status event from the
   * current generation's stream. A cached replay (`isCache`) is not
   * evidence of a live connection, only a genuine event is: it proves the
   * stream authenticated and is actively delivering data for that specific
   * product. This both cancels a pending stream-stale escalation and clears
   * that one device's own "stream"/"auth" unavailability reason. It never
   * touches devices for other products, and never blindly calls
   * setAvailable() - clearAvailabilityReason() is a no-op unless the
   * device's current reason matches.
   */
  private handleGenuineStreamEvent(
    generation: number,
    payload: ProductEventPayload,
  ): void {
    if (generation !== this.generation) return;
    if (payload.isCache) return;

    const key = this.productKeyForEvent(payload);
    if (!key) return;

    this.lastProductEventAt.set(key, Date.now());
    this.cancelProductStaleCheck(key);
    for (const device of this.getDevicesForProductKey(key)) {
      device.clearAvailabilityReason('stream');
      device.clearAvailabilityReason('auth');
    }
  }

  /**
   * Fires on every failed/dropped connection attempt (the SDK emits this
   * before every reconnect retry, auth or not). Starts the stale-check grace
   * period if one isn't already running; a genuine event or a full teardown
   * cancels it. Doesn't itself mark anything unavailable - see
   * markStreamStale().
   */
  private handleStreamDisconnect(generation: number): void {
    if (generation !== this.generation) return;
    this.forEachTeslemetryDevice((device) => {
      const key = device.getProductKey();
      if (key !== undefined) this.scheduleProductStaleCheck(generation, key);
    });
  }

  private scheduleProductStaleCheck(generation: number, key: string): void {
    if (this.productStaleTimers.has(key)) return;
    const timer = this.homey.setTimeout(() => {
      this.productStaleTimers.delete(key);
      this.markProductStale(generation, key);
    }, TeslemetryApp.STREAM_STALE_GRACE_MS);
    this.productStaleTimers.set(key, timer);
  }

  private cancelProductStaleCheck(key: string): void {
    const timer = this.productStaleTimers.get(key);
    if (timer === undefined) return;
    this.homey.clearTimeout(timer);
    this.productStaleTimers.delete(key);
  }

  private cancelAllProductStaleChecks(): void {
    for (const timer of this.productStaleTimers.values()) {
      this.homey.clearTimeout(timer);
    }
    this.productStaleTimers.clear();
  }

  private markProductStale(generation: number, key: string): void {
    if (generation !== this.generation) return;
    const lastEventAt = this.lastProductEventAt.get(key);
    const lastEventAge = lastEventAt === undefined ? 'never' : `${Date.now() - lastEventAt}ms`;
    this.log(
      `Stream freshness watchdog: ${key} has no genuine data after ${TeslemetryApp.STREAM_STALE_GRACE_MS}ms grace period; last event age ${lastEventAge} (generation ${generation})`,
    );
    const message = this.homey.__('error.stream_disconnected');
    for (const device of this.getDevicesForProductKey(key)) {
      device.markUnavailable('stream', message);
    }
  }

  /**
   * Called on every SSE reconnect failure. The stream itself now owns
   * backoff, auth-failure classification, and the stop-loss policy (see
   * `auth_failure` in attachStreamHandlers); the only actionable thing left
   * for the app is to give the stream's single same-attempt retry a token
   * that's actually fresh, covering a token that was revoked early enough
   * that our proactive expiry-based refresh wouldn't have caught it.
   */
  private async handleStreamError(
    generation: number,
    event: TeslemetryStreamErrorEvent,
  ): Promise<void> {
    if (generation !== this.generation) return;
    this.log(
      `SSE stream error (generation ${generation}, retry ${event.retries}, status ${event.status ?? 'n/a'}): ${event.error instanceof Error ? event.error.message : String(event.error)}`,
    );
    if (event.status !== 401 && event.status !== 403) return;

    this.log('SSE auth failure; forcing a token refresh before the SDK retries');
    await this.oauth.refreshToken().catch((refreshError) => {
      this.error('Token refresh after SSE auth failure failed:', refreshError);
    });
    if (generation !== this.generation) return; // superseded while refreshing
    if (!this.oauth.hasValidToken()) {
      // refreshToken() already determined the refresh token itself is
      // dead and cleared it - no need to wait for the SDK's own second
      // consecutive auth failure to surface reauth.
      this.stopSseAndSurfaceReauth();
    }
  }

  private stopSseAndSurfaceReauth(): void {
    this.teardownCredentials(this.homey.__('error.invalid_refresh_token'));
  }

  /**
   * The single teardown path for every credential-removal event: the
   * terminal SSE auth_failure above, and the manual Disconnect action
   * (api.ts, via disconnectAccount()). Closes the stream, clears the token,
   * and marks every device unavailable with the "auth" reason - no later
   * unrelated event (a stray reconnect, a different device's data) can
   * declare them healthy again; only that specific device's own genuine
   * post-reauth data event can (handleGenuineStreamEvent).
   */
  private teardownCredentials(message: string): void {
    this.cleanup();
    this.oauth.clearToken();
    if (this.startupRetryTimer !== undefined) {
      this.homey.clearTimeout(this.startupRetryTimer);
      this.startupRetryTimer = undefined;
    }
    this.startupRetryAttempt = 0;
    this.forEachTeslemetryDevice((device) => device.markUnavailable('auth', message));
  }

  /** Called by api.ts's manual Disconnect action. */
  public disconnectAccount(): void {
    this.teardownCredentials(this.homey.__('error.account_disconnected'));
  }
}
