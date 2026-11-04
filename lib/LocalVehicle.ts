import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import type { VehicleDetails } from "@teslemetry/api";
import type { BleDeviceRef } from "tesla-fleet-api/bluetooth";
import type { HomeyBleManagerLike } from "tesla-fleet-api/bluetooth/homey";

/** Why pairing stopped short of a key on the car, as a `local_vehicle.*` locale key. */
export type PairingFailure = "not_found" | "tap_timeout" | "declined" | "failed";

/** A new P-256 key for the car's key list, as the hex of its 32-byte scalar. */
export function generateVehicleKey(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url").toString("hex");
}

/**
 * Adds Homey's key to the car over Bluetooth, as Home Assistant does: a key
 * the car already accepts needs nothing more, otherwise the car asks for a
 * key card tap on its center console and this waits for it. Loads
 * `tesla-fleet-api/bluetooth` only now, so a car that never pairs costs nothing.
 */
export async function pairVehicleKey(options: {
  ble: HomeyBleManagerLike;
  vin: string;
  keyHex: string;
  signal: AbortSignal;
  log: (message: string) => void;
}): Promise<{ device: BleDeviceRef } | { failure: PairingFailure }> {
  const { TeslaBluetooth } = await import("tesla-fleet-api/bluetooth");
  const { HomeyBleTransport } = await import("tesla-fleet-api/bluetooth/homey");
  const {
    BluetoothTimeout,
    BluetoothTransportError,
    NotOnWhitelistFault,
    TeslaFleetError,
    WhitelistOperationAttemptingToAddExistingKey,
    WhitelistOperationLocalEntityAuthFailedCancelled,
    WhitelistOperationLocalEntityAuthFailedTimedOutWaitingForTap,
    WhitelistOperationLocalEntityAuthFailedUIDenied,
  } = await import("tesla-fleet-api");

  // A pairing turned off already must not reach for the car; the caller ignores this result.
  if (options.signal.aborted) return { failure: "failed" };
  const vehicle = new TeslaBluetooth({ privateKey: Buffer.from(options.keyHex, "hex") }).vehicles.createBluetooth(
    options.vin,
    // Keepalive reads would keep the car awake.
    { transport: new HomeyBleTransport(options.ble), keepalive_interval_ms: null },
  );
  // A timeout once the car is waiting for the key card is the tap timing out.
  let waitingForTap = false;
  try {
    const device = await vehicle.find_vehicle();
    if (options.signal.aborted) return { failure: "failed" };
    await vehicle.connect();
    try {
      await vehicle.handshakeVehicleSecurity();
      options.log("Bluetooth: Homey's key is already on the car");
      return { device };
    } catch (error) {
      if (!(error instanceof NotOnWhitelistFault)) throw error;
    }
    options.log("Bluetooth: asking the car to add Homey's key");
    waitingForTap = true;
    try {
      await vehicle.pair({ signal: options.signal });
    } catch (error) {
      if (!(error instanceof WhitelistOperationAttemptingToAddExistingKey)) throw error;
    }
    return { device };
  } catch (error) {
    if (!(error instanceof TeslaFleetError)) throw error;
    options.log(`Bluetooth: pairing stopped: ${error.name}: ${error.message}`);
    if (
      error instanceof WhitelistOperationLocalEntityAuthFailedTimedOutWaitingForTap ||
      (waitingForTap && error instanceof BluetoothTimeout)
    ) {
      return { failure: "tap_timeout" };
    }
    if (error instanceof BluetoothTransportError || error instanceof BluetoothTimeout) {
      return { failure: "not_found" };
    }
    if (
      error instanceof WhitelistOperationLocalEntityAuthFailedUIDenied ||
      error instanceof WhitelistOperationLocalEntityAuthFailedCancelled
    ) {
      return { failure: "declined" };
    }
    return { failure: "failed" };
  } finally {
    await vehicle.disconnect().catch(() => {});
  }
}

/** The commands a paired car near Homey takes over Bluetooth first. */
export interface VehicleCommands {
  door_lock(): Promise<any>;
  door_unlock(): Promise<any>;
  charge_start(): Promise<any>;
  charge_stop(): Promise<any>;
  set_charge_limit(percent: number): Promise<any>;
  set_charging_amps(amps: number): Promise<any>;
  charge_port_door_open(): Promise<any>;
  charge_port_door_close(): Promise<any>;
  actuate_trunk(which: "front" | "rear"): Promise<any>;
  auto_conditioning_start(): Promise<any>;
  auto_conditioning_stop(): Promise<any>;
  flash_lights(): Promise<any>;
  honk_horn(): Promise<any>;
  wake_up(): Promise<any>;
}

export interface VehicleLink {
  commands: VehicleCommands;
  close(): Promise<unknown>;
  /**
   * The car a device binds to while there is no Products generation: no
   * cloud events, and a Teslemetry API that refuses until the cloud is back.
   */
  standIn: VehicleDetails;
}

/**
 * A paired car's commands, over Bluetooth while `inRange()` and on the cloud
 * otherwise or when the Bluetooth link fails before the car judged the
 * command (VehicleRouter). The cloud backend is `tesla-fleet-api`'s
 * TeslemetryVehicle. A connect is one attempt (HOMEY_VEHICLE_OPTIONS), and
 * `inRange()` skips Bluetooth altogether for a car away from Homey.
 */
export async function createVehicleLink(options: {
  ble: HomeyBleManagerLike;
  vin: string;
  keyHex: string;
  device: BleDeviceRef;
  accessToken: () => Promise<string>;
  inRange: () => boolean;
  /** What a command the stand-in sends to the cloud fails with. */
  offlineMessage: string;
  log: (message: string) => void;
}): Promise<VehicleLink> {
  const { TeslaBluetooth } = await import("tesla-fleet-api/bluetooth");
  const { HOMEY_VEHICLE_OPTIONS, HomeyBleTransport } = await import("tesla-fleet-api/bluetooth/homey");
  const { Teslemetry } = await import("tesla-fleet-api");
  const { VehicleRouter } = await import("tesla-fleet-api/router");

  const bluetooth = new TeslaBluetooth({ privateKey: Buffer.from(options.keyHex, "hex") }).vehicles.createBluetooth(
    options.vin,
    {
      transport: new HomeyBleTransport(options.ble),
      device: options.device,
      ...HOMEY_VEHICLE_OPTIONS,
      // As Home Assistant: let the car sleep, and settle a timed-out command by reading its state.
      keepalive_interval_ms: null,
      confirmation: "verify",
    },
  );
  const cloud = new Teslemetry(options.accessToken).vehicles.create(options.vin);
  const commands = new VehicleRouter([bluetooth, cloud], {
    health: options.inRange,
    logger: { debug: (message) => options.log(`Bluetooth: ${message}`) },
  });
  const offline = () => Promise.reject(new Error(options.offlineMessage));
  return {
    commands,
    close: () => bluetooth.disconnect(),
    standIn: {
      vin: options.vin,
      name: "",
      api: new Proxy({}, { get: (_api, method) => (method === "then" ? undefined : offline) }),
      sse: Object.assign(new EventEmitter(), { cache: {}, onSignal: () => () => {} }),
      metadata: {},
    } as unknown as VehicleDetails,
  };
}

/**
 * How long a car counts as near Homey after Homey last heard its Bluetooth
 * advertisement: Home Assistant's window for a connectable device.
 */
export const PRESENCE_WINDOW_MS = 195_000;

/** What presence needs of `this.homey.ble`. */
export interface HomeyPresenceBleLike {
  find(peripheralUuid: string): Promise<unknown>;
  subscribeToAdvertisements?(peripheralUuid: string, callback: () => void): Promise<unknown>;
  unsubscribeFromAdvertisements?(peripheralUuid: string): Promise<unknown>;
}

/**
 * Whether a paired car is near Homey, from its Bluetooth advertisements alone,
 * as Home Assistant decides: nothing connects to the car or wakes it.
 * `find()` answers from Homey's advertisement cache in milliseconds, and scans
 * for about 10 s once that cache is cold, which it is within 40 s unless an
 * advertisement subscription is open. That subscription never calls back for
 * a car, so it is held only to keep `find()` instant.
 */
export class VehiclePresence {
  private heardAt?: number;

  constructor(
    private readonly ble: HomeyPresenceBleLike,
    private readonly peripheralUuid: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether Homey heard the car within PRESENCE_WINDOW_MS. */
  get present(): boolean {
    return this.heardAt !== undefined && this.now() - this.heardAt <= PRESENCE_WINDOW_MS;
  }

  /** Asks Homey whether it hears the car, then answers `present`. */
  async check(): Promise<boolean> {
    try {
      await this.ble.find(this.peripheralUuid);
      this.heardAt = this.now();
    } catch {
      // Homey has not heard it: "Peripheral Not Found".
    }
    return this.present;
  }

  async keepCacheWarm(): Promise<void> {
    await this.ble.subscribeToAdvertisements?.(this.peripheralUuid, () => {});
  }

  async close(): Promise<void> {
    await this.ble.unsubscribeFromAdvertisements?.(this.peripheralUuid);
  }
}
