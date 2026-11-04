// Test-only ESM redirect target for "tesla-fleet-api/bluetooth/homey" (see
// loader.mjs): the transport only carries the Homey BLE manager it was given.
export { HOMEY_VEHICLE_OPTIONS } from "../../node_modules/tesla-fleet-api/dist/bluetooth/homey.mjs";

export class HomeyBleTransport {
  constructor(ble) {
    this.ble = ble;
  }
}
