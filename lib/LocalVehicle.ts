import { generateKeyPairSync } from "node:crypto";
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

  const vehicle = new TeslaBluetooth({ privateKey: Buffer.from(options.keyHex, "hex") }).vehicles.createBluetooth(
    options.vin,
    // Keepalive reads would keep the car awake.
    { transport: new HomeyBleTransport(options.ble), keepalive_interval_ms: null },
  );
  // A timeout once the car is waiting for the key card is the tap timing out.
  let waitingForTap = false;
  try {
    const device = await vehicle.find_vehicle();
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
