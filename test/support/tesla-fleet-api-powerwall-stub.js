// Test-only ESM redirect target for "tesla-fleet-api/powerwall" (see
// loader.mjs). The merge helpers and error classes are the real library;
// only the client that would open an HTTPS connection to a gateway is
// replaced, with each read answered by fakeGateway.
// oxlint-disable max-classes-per-file -- one fake per library class the app constructs
export {
  ENERGY_LIVE_INTERVAL_MS,
  LiveStatusMerge,
  PowerwallAuthenticationError,
  PowerwallConnectionError,
  PowerwallError,
  PowerwallKeyRejectedError,
} from "../../node_modules/tesla-fleet-api/dist/powerwall.mjs";

export const fakeGateway = {
  /** Answers PowerwallEnergySite.live_status() for every client. */
  liveStatus: async () => ({ response: {} }),
  /** Answers verify_local_gateway(client). */
  verify: async () => {},
  /** Every client constructed, newest last. */
  clients: [],
};

export class PowerwallClient {
  constructor(options) {
    this.options = options;
    this.closed = false;
    fakeGateway.clients.push(this);
  }

  get host() {
    return this.options.host;
  }

  close() {
    this.closed = true;
  }
}

export class PowerwallEnergySite {
  constructor(client) {
    this.client = client;
  }

  live_status() {
    return fakeGateway.liveStatus(this.client);
  }
}

export function verify_local_gateway(client) {
  return fakeGateway.verify(client);
}
