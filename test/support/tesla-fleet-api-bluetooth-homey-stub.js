// Test-only ESM redirect target for "tesla-fleet-api/bluetooth/homey" (see
// loader.mjs): the transport only carries the Homey BLE manager it was given.
// oxlint-disable-next-line import/prefer-default-export -- mirrors the library's named export.
export class HomeyBleTransport {
  constructor(ble) {
    this.ble = ble;
  }
}
