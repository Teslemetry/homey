// Test-only ESM redirect target for "tesla-fleet-api/powerwall" (see
// loader.mjs). The merge helpers and error classes are the real library;
// only the client that would open an HTTPS connection to a gateway is
// replaced, with each read answered by fakeGateway.
// oxlint-disable max-classes-per-file -- one fake per library class the app constructs
export {
  ENERGY_CONFIG_INTERVAL_MS,
  ENERGY_LIVE_INTERVAL_MS,
  LiveStatusMerge,
  PowerwallAuthenticationError,
  PowerwallCommandError,
  PowerwallConnectionError,
  PowerwallError,
  PowerwallKeyRejectedError,
  SiteInfoMerge,
} from "../../node_modules/tesla-fleet-api/dist/powerwall.mjs";

export const fakeGateway = {
  /** Answers PowerwallEnergySite.live_status() for every client. */
  liveStatus: async () => ({ response: {} }),
  /** Answers PowerwallEnergySite.local_config(). */
  localConfig: async () => ({}),
  /** Answers verify_local_gateway(client). */
  verify: async () => {},
  /** Answers each local command; every call is recorded in `commands`. */
  command: async () => {},
  commands: [],
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

  local_config() {
    return fakeGateway.localConfig(this.client);
  }

  backup(...args) {
    return this.#command("backup", args);
  }

  operation(...args) {
    return this.#command("operation", args);
  }

  grid_import_export(...args) {
    return this.#command("grid_import_export", args);
  }

  dispatch_battery_power(...args) {
    return this.#command("dispatch_battery_power", args);
  }

  resume_battery_operation(...args) {
    return this.#command("resume_battery_operation", args);
  }

  async #command(name, args) {
    fakeGateway.commands.push([name, ...args]);
    await fakeGateway.command(name, args);
    return { response: { code: 201, message: "", result: true } };
  }
}

export function verify_local_gateway(client) {
  return fakeGateway.verify(client);
}
