import sourceMapSupport from 'source-map-support';

import Homey from 'homey';
import { Products, Teslemetry } from '@teslemetry/api';
import type { TeslemetryStreamErrorEvent } from '@teslemetry/api';
import TeslemetryOAuth2Client from './lib/TeslemetryOAuth2Client.js';
import type { TeslemetryApiError } from './@types/error.d.ts';
import type VehicleDevice from './drivers/vehicle/device.js';
import type PowerwallDevice from './drivers/battery/device.js';

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

export default class TeslemetryApp extends Homey.App {
  public oauth!: TeslemetryOAuth2Client;
  public teslemetry?: Teslemetry;
  public products?: Products;
  private initializationPromise?: Promise<void>;

  // Set once a persistent auth failure has surfaced reauth to the user, so
  // recovery can restore device availability once the stream reconnects.
  private reauthSurfaced = false;

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

    // Register Flow card handlers
    this.registerFlowCards();

    // Listen for token updates
    this.on('oauth2:token_saved', () => {
      this.log('Token saved, re-initializing Teslemetry...');
      this.reinitialize();
    });

    // Initialize the Teslemetry SDK connection using OAuth2 token
    await this.initializeTeslemetry().catch((error) => {
      this.log(error.message);
    });
  }

  /**
   * Register Flow card action handlers
   */
  private registerFlowCards(): void {
    // Vehicle action cards
    this.homey.flow
      .getActionCard('flash_lights')
      .registerRunListener(async (args: { device: VehicleDevice }) => {
        await args.device.flowFlashLights();
      });

    this.homey.flow
      .getActionCard('honk_horn')
      .registerRunListener(async (args: { device: VehicleDevice }) => {
        await args.device.flowHonkHorn();
      });

    this.homey.flow
      .getActionCard('keyless_driving')
      .registerRunListener(async (args: { device: VehicleDevice }) => {
        await args.device.flowStartKeylessDriving();
      });

    this.homey.flow
      .getActionCard('homelink')
      .registerRunListener(async (args: { device: VehicleDevice }) => {
        await args.device.flowTriggerHomelink();
      });

    this.homey.flow
      .getActionCard('wake_up')
      .registerRunListener(async (args: { device: VehicleDevice }) => {
        await args.device.flowWakeUp();
      });

    this.homey.flow
      .getActionCard('set_steering_wheel_heater')
      .registerRunListener(
        async (args: { device: VehicleDevice; level: string }) => {
          await args.device.flowSetSteeringWheelHeater(args.level);
        },
      );

    this.homey.flow
      .getActionCard('start_charging')
      .registerRunListener(async (args: { device: VehicleDevice }) => {
        await args.device.flowStartCharging();
      });

    this.homey.flow
      .getActionCard('stop_charging')
      .registerRunListener(async (args: { device: VehicleDevice }) => {
        await args.device.flowStopCharging();
      });

    this.homey.flow
      .getActionCard('set_charge_limit')
      .registerRunListener(
        async (args: { device: VehicleDevice; percentage: number }) => {
          await args.device.flowSetChargeLimit(args.percentage);
        },
      );

    this.homey.flow
      .getActionCard('set_charging_amps')
      .registerRunListener(
        async (args: { device: VehicleDevice; amps: number }) => {
          await args.device.flowSetChargingAmps(args.amps);
        },
      );

    this.homey.flow
      .getActionCard('navigate_to_address')
      .registerRunListener(
        async (args: { device: VehicleDevice; address: string }) => {
          await args.device.flowNavigateToAddress(args.address);
        },
      );

    this.homey.flow
      .getActionCard('set_cabin_temperature')
      .registerRunListener(
        async (args: { device: VehicleDevice; temperature: number }) => {
          await args.device.flowSetCabinTemperature(args.temperature);
        },
      );

    this.homey.flow
      .getActionCard('set_climate_mode')
      .registerRunListener(
        async (args: { device: VehicleDevice; mode: string }) => {
          await args.device.flowSetClimateMode(args.mode);
        },
      );

    // Battery/Powerwall action cards
    this.homey.flow
      .getActionCard('set_backup_reserve')
      .registerRunListener(
        async (args: { device: PowerwallDevice; percentage: number }) => {
          await args.device.flowSetBackupReserve(args.percentage);
        },
      );

    this.homey.flow
      .getActionCard('set_allow_export')
      .registerRunListener(
        async (args: {
          device: PowerwallDevice;
          mode: 'battery_ok' | 'pv_only' | 'never';
        }) => {
          await args.device.flowSetAllowExport(args.mode);
        },
      );

    this.homey.flow
      .getActionCard('set_operation_mode')
      .registerRunListener(
        async (args: {
          device: PowerwallDevice;
          mode: 'self_consumption' | 'backup' | 'autonomous';
        }) => {
          await args.device.flowSetOperationMode(args.mode);
        },
      );

    // Condition cards
    this.homey.flow
      .getConditionCard('operation_mode_is')
      .registerRunListener(
        async (args: { device: PowerwallDevice; mode: string }) => {
          return args.device.getCapabilityValue('operation_mode') === args.mode;
        },
      );

    this.homey.flow
      .getConditionCard('battery_level')
      .registerRunListener(
        async (args: { device: PowerwallDevice; percentage: number }) => {
          return (
            args.device.getCapabilityValue('measure_battery') >= args.percentage
          );
        },
      );

    this.homey.flow
      .getConditionCard('is_charging')
      .registerRunListener(async (args: { device: VehicleDevice }) => {
        return !!args.device.getCapabilityValue('evcharger_charging');
      });

    this.homey.flow
      .getConditionCard('is_plugged_in')
      .registerRunListener(async (args: { device: VehicleDevice }) => {
        return args.device.isPluggedIn();
      });

    // Vehicle trigger cards with per-card arguments need a run listener to
    // decide whether *this* card's threshold was actually crossed; cards
    // without args default to firing whenever .trigger() is called.
    this.homey.flow
      .getDeviceTriggerCard('battery_below')
      .registerRunListener(
        async (
          args: { device: VehicleDevice; percentage: number },
          state: { previous: number; current: number },
        ) => {
          return state.previous >= args.percentage && state.current < args.percentage;
        },
      );

    this.log('Flow card handlers registered');
  }

  /**
   * Initialize Teslemetry connection with OAuth2 token
   * @throws Error if initialization fails
   */
  private async initializeTeslemetry(): Promise<void> {
    if (!this.oauth.hasValidToken()) {
      throw new Error('No OAuth2 token available. User needs to authenticate.');
    }

    if (this.teslemetry && this.products) {
      // Is there a condition here where testing is invalid?
      return;
    }

    this.log('Initializing Teslemetry with OAuth2 token...');
    this.teslemetry = new Teslemetry(this.oauth.getAccessToken, {
      logger: this.logger,
      stream: {
        cache: true,
        topics: SSE_TOPICS,
      },
    });
    // No .catch(this.handleApiError) here: a real API error surfaces via
    // TeslemetryOAuth2Client's own handleApiError call during token
    // fetching, which already logs and translates it before rethrowing.
    this.products = await this.teslemetry.createProducts();

    for (const event of SSE_DATA_EVENTS) {
      this.teslemetry.sse.on(event, () => this.handleSseConnected());
    }
    this.teslemetry.sse.on('stream_error', (event) =>
      this.handleStreamError(event).catch(this.error),
    );
    this.teslemetry.sse.on('auth_failure', () =>
      this.stopSseAndSurfaceReauth(),
    );
    this.teslemetry.sse.connect();

    const vehicleCount = Object.keys(this.products.vehicles).length;
    const energyCount = Object.keys(this.products.energySites).length;

    this.log(
      `Teslemetry initialized successfully! Found ${vehicleCount} vehicles and ${energyCount} energy sites.`,
    );
  }

  /**
   * Clean up Teslemetry connection and resources
   */
  cleanup(): void {
    if (this.teslemetry) {
      this.teslemetry.sse.close();
      this.teslemetry = undefined;
      this.products = undefined;
      this.log('Teslemetry connection cleaned up');
    }
  }

  /**
   * Reinitialize the app when OAuth2 session changes
   */
  private async reinitialize(): Promise<void> {
    // Prevent multiple simultaneous initializations
    if (this.initializationPromise) {
      await this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      try {
        // Clean up existing connection
        this.cleanup();

        // Initialize with new OAuth2 session
        await this.initializeTeslemetry();
      } catch (error) {
        this.error('Failed to reinitialize:', error);
      } finally {
        this.initializationPromise = undefined;
      }
    })();

    return this.initializationPromise;
  }

  /**
   * Get the current Teslemetry instance, initializing if needed
   */
  async getTeslemetry(): Promise<Teslemetry | undefined> {
    if (!this.teslemetry) {
      await this.initializeTeslemetry();
    }
    return this.teslemetry;
  }

  /**
   * Get the current Products instance, initializing if needed
   */
  async getProducts(): Promise<Products | undefined> {
    if (!this.products) {
      await this.initializeTeslemetry();
    }
    return this.products;
  }

  /**
   * Check if the app is properly configured with OAuth2
   */
  isConfigured(): boolean {
    return this.oauth.hasValidToken() && !!this.teslemetry && !!this.products;
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
   * Called on every SSE reconnect failure. The stream itself now owns
   * backoff, auth-failure classification, and the stop-loss policy (see
   * `auth_failure` below); the only actionable thing left for the app is to
   * give the stream's single same-attempt retry a token that's actually
   * fresh, covering a token that was revoked early enough that our
   * proactive expiry-based refresh wouldn't have caught it.
   */
  private async handleStreamError(
    event: TeslemetryStreamErrorEvent,
  ): Promise<void> {
    if (event.status !== 401 && event.status !== 403) return;

    this.log('SSE auth failure; forcing a token refresh before the SDK retries');
    await this.oauth.refreshToken().catch((refreshError) => {
      this.error('Token refresh after SSE auth failure failed:', refreshError);
    });
    if (!this.oauth.hasValidToken()) {
      // refreshToken() already determined the refresh token itself is
      // dead and cleared it - no need to wait for the SDK's own second
      // consecutive auth failure to surface reauth.
      this.stopSseAndSurfaceReauth();
    }
  }

  /** Restore device availability once the stream proves it's genuinely reconnected. */
  private handleSseConnected(): void {
    if (this.reauthSurfaced) {
      this.reauthSurfaced = false;
      this.setAllDevicesAvailability(true);
    }
  }

  private stopSseAndSurfaceReauth(): void {
    this.cleanup();
    this.oauth.clearToken();
    this.reauthSurfaced = true;
    this.setAllDevicesAvailability(
      false,
      this.homey.__('error.invalid_refresh_token'),
    );
  }

  /**
   * Marks every device across every driver (un)available, mirroring the
   * per-device auth-failure pattern in TeslemetryDevice.handleApiError so
   * the reauth need surfaces through Homey's normal repair flow.
   */
  private setAllDevicesAvailability(available: boolean, message?: string): void {
    const drivers = Object.values(this.homey.drivers.getDrivers());
    for (const driver of drivers) {
      for (const device of driver.getDevices()) {
        if (available) {
          device.setAvailable().catch(this.error);
        } else {
          device.setUnavailable(message).catch(this.error);
        }
      }
    }
  }
}
