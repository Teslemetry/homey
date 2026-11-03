// Test-only ESM redirect target for "tesla-fleet-api/bluetooth" (see
// loader.mjs). TeslaBluetooth hands out the vehicle a test puts in
// fakeBluetooth, so nothing reaches a radio.
export const fakeBluetooth = {
  /** The vehicle the next `vehicles.createBluetooth()` returns. */
  vehicle: null,
  /** Each `createBluetooth()` call: { vin, options, privateKey }. */
  created: [],
};

export class TeslaBluetooth {
  constructor({ privateKey }) {
    this.vehicles = {
      createBluetooth: (vin, options) => {
        fakeBluetooth.created.push({ vin, options, privateKey });
        return fakeBluetooth.vehicle;
      },
    };
  }
}
