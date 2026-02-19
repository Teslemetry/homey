import sourceMapSupport from 'source-map-support';

import Homey from 'homey';
import { Products, Teslemetry } from '@teslemetry/api';
import TeslemetryOAuth2Client from './lib/TeslemetryOAuth2Client.js';
import type { TeslemetryApiError } from './@types/error.d.ts';
import type VehicleDevice from './drivers/vehicle/device.js';
import type PowerwallDevice from './drivers/battery/device.js';

sourceMapSupport.install();

export default class TeslemetryApp extends Homey.App {
  public oauth!: TeslemetryOAuth2Client;
  public teslemetry?: Teslemetry;
  public products?: Products;
  private initializationPromise?: Promise<void>;
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
      },
    });
    this.products = await this.teslemetry
      .createProducts()
      .catch(this.handleApiError);

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

  public handleApiError = (apiError: TeslemetryApiError): never => {
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
}
