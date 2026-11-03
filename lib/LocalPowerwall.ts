import { createPublicKey, generateKeyPair } from "node:crypto";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import type { EnergyDetails, SseLiveStatus, TeslemetryEnergySiteStream } from "@teslemetry/api";
import type { LiveStatusMerge, PowerwallClient, SiteInfoMerge } from "tesla-fleet-api/powerwall";
import type { LiveStatusResponse, SiteInfoResponse } from "tesla-fleet-api/types";
import type TeslemetryApp from "../app.js";

/** A verified gateway, as the Powerwall device stores it once enrolment succeeds. */
export interface LocalGateway {
  host: string;
  password: string;
}

/**
 * Backup reserve, operation mode and grid import/export, local first and on
 * the cloud when the gateway is unhealthy or unreachable. Every other command
 * has no local mapping and stays on the app's own cloud client.
 */
export interface LocalPowerwallCommands {
  backup(percent: number): Promise<unknown>;
  operation(mode: string): Promise<unknown>;
  grid_import_export(disallowChargeFromGrid: boolean | null, exportRule: string | null): Promise<unknown>;
}

/** What a Powerwall, Gateway or Solar device needs from its live_status source. */
export interface LiveStatusSource {
  on(event: "live_status", listener: (event: SseLiveStatus) => void): unknown;
  off(event: "live_status", listener: (event: SseLiveStatus) => void): unknown;
}

export function isLocalGateway(value: unknown): value is LocalGateway {
  const gateway = value as Partial<LocalGateway> | null;
  return typeof gateway?.host === "string" && typeof gateway.password === "string";
}

/** A device's refusal resolves as `{ response: { result: false } }` instead of throwing. */
function refused(result: unknown): boolean {
  return (result as { response?: { result?: unknown } } | null)?.response?.result === false;
}

/**
 * One enrolled site's local Powerwall link. It reads the gateway's
 * live_status every 5 s and overlays the keys the gateway owns on the latest
 * cloud live_status, so the site's Powerwall, Gateway and Solar devices get
 * one merged view. Every other key keeps its cloud value, and a failed read
 * falls back to the cloud values (LiveStatusMerge). Every 30 s it does the
 * same for the backup reserve and operation mode in site_info (SiteInfoMerge).
 *
 * `island_status` is never overlaid: the gateway only knows "off grid", and
 * the grid outage and island test Flow cards need the cloud's reason.
 */
export class LocalPowerwallSite extends EventEmitter implements LocalPowerwallCommands {
  private cloud?: TeslemetryEnergySiteStream;
  private cloudInfo?: Record<string, unknown>;
  private readonly configTimer: NodeJS.Timeout;
  private cloudEvent?: SseLiveStatus;
  private latest?: SseLiveStatus;
  private lastHealth: boolean | null = null;
  private stopped = false;
  private readonly timer: NodeJS.Timeout;

  /**
   * The site a device binds to while there is no Products generation: no
   * cloud events, and a Teslemetry API that refuses until the cloud is back.
   */
  readonly standIn: EnergyDetails;

  /** Loads `tesla-fleet-api` only now, so a site that never enrols costs nothing. */
  static async start(app: TeslemetryApp, siteId: string, gateway: LocalGateway, keyPem: string) {
    const {
      ENERGY_CONFIG_INTERVAL_MS,
      ENERGY_LIVE_INTERVAL_MS,
      LiveStatusMerge,
      PowerwallClient,
      PowerwallEnergySite,
      SiteInfoMerge,
    } = await import("tesla-fleet-api/powerwall");
    const { EnergySiteRouter, LOCAL_LIVE_STATUS_KEYS } = await import("tesla-fleet-api/router");
    const { Teslemetry } = await import("tesla-fleet-api");
    const client = new PowerwallClient({
      host: gateway.host,
      gatewayPassword: gateway.password,
      rsaPrivateKeyPem: keyPem,
    });
    const local = new PowerwallEnergySite(client);
    const merge = new LiveStatusMerge(local, {}, {
      owned_keys: LOCAL_LIVE_STATUS_KEYS.filter((key) => key !== "island_status"),
    });
    const cloud = new Teslemetry(app.oauth.getAccessToken).energySites!.create(Number(siteId));
    const commands = new EnergySiteRouter([local, cloud], {
      // A gateway that is not answering costs a command no wait at all.
      health: () => merge.healthy === true,
      logger: { debug: (message) => app.log(`Local Powerwall ${siteId}: ${message}`) },
    });
    const info = new SiteInfoMerge(local, {} as SiteInfoResponse);
    return new LocalPowerwallSite(app, siteId, client, merge, info, commands, {
      live: ENERGY_LIVE_INTERVAL_MS,
      config: ENERGY_CONFIG_INTERVAL_MS,
    });
  }

  private constructor(
    private readonly app: TeslemetryApp,
    readonly siteId: string,
    private readonly client: PowerwallClient,
    private readonly merge: LiveStatusMerge,
    private readonly info: SiteInfoMerge,
    private readonly router: LocalPowerwallCommands,
    intervalMs: { live: number; config: number },
  ) {
    super();
    const offline = () => Promise.reject(new Error(app.homey.__("error.teslemetry_connecting")));
    this.standIn = {
      id: Number(siteId),
      name: "",
      api: new Proxy({}, { get: (_api, method) => (method === "then" ? undefined : offline) }),
      sse: new EventEmitter(),
      metadata: { access: true },
    } as unknown as EnergyDetails;
    this.timer = app.homey.setInterval(() => {
      this.poll().catch((error) => this.app.error(`Local Powerwall ${siteId}: poll failed`, error));
    }, intervalMs.live);
    this.configTimer = app.homey.setInterval(() => {
      this.pollConfig().catch((error) => this.app.error(`Local Powerwall ${siteId}: config poll failed`, error));
    }, intervalMs.config);
  }

  async backup(percent: number): Promise<unknown> {
    const result = await this.router.backup(percent);
    if (!refused(result)) this.hold("backup_reserve_percent", percent);
    return result;
  }

  async operation(mode: string): Promise<unknown> {
    const result = await this.router.operation(mode);
    if (!refused(result)) this.hold("default_real_mode", mode);
    return result;
  }

  grid_import_export(disallowChargeFromGrid: boolean | null, exportRule: string | null): Promise<unknown> {
    return this.router.grid_import_export(disallowChargeFromGrid, exportRule);
  }

  /**
   * The cloud's site_info document with the gateway's backup reserve and
   * operation mode overlaid. Undefined until the cloud has sent one: the
   * gateway alone cannot fill the rest of it.
   */
  get siteInfoDocument(): Record<string, unknown> | undefined {
    if (!this.cloudInfo) return undefined;
    const { tariff_content_v2: _held, ...merged } = this.info.merged as Record<string, unknown>;
    return "tariff_content_v2" in this.cloudInfo
      ? { ...merged, tariff_content_v2: this.cloudInfo.tariff_content_v2 }
      : merged;
  }

  /**
   * The live_status source for a device bound to `cloud`, this site's
   * current stream. A rebuilt Products generation brings a new stream, so
   * the first device to bind to it moves the subscription over.
   */
  attach(cloud: TeslemetryEnergySiteStream): this {
    if (this.cloud === cloud) return this;
    this.detach();
    this.cloud = cloud;
    // Each replays the stream's cached payload synchronously.
    cloud.on("live_status", this.onCloud);
    cloud.on("site_info", this.onCloudSiteInfo);
    cloud.on("tariff_content_v2", this.onCloudTariff);
    return this;
  }

  /** Replays the latest merged view to a new listener, as the cloud stream does. */
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === "live_status" && this.latest) listener(this.latest);
    if (event === "site_info" && this.cloudInfo) listener();
    return this;
  }

  /** Whether the last gateway read succeeded. */
  get healthy(): boolean {
    return !this.stopped && this.merge.healthy === true;
  }

  stop(): void {
    this.stopped = true;
    this.app.homey.clearInterval(this.timer);
    this.app.homey.clearInterval(this.configTimer);
    this.detach();
    this.client.close();
    this.removeAllListeners();
  }

  private detach(): void {
    this.cloud?.off("live_status", this.onCloud);
    this.cloud?.off("site_info", this.onCloudSiteInfo);
    this.cloud?.off("tariff_content_v2", this.onCloudTariff);
    this.cloud = undefined;
  }

  /** A site_info report covers every held command value. */
  private onCloudSiteInfo = () => {
    const document = this.cloud?.siteInfoDocument;
    if (!document) return;
    this.cloudInfo = document;
    this.info.set_cloud(document as SiteInfoResponse);
    this.emit("site_info");
  };

  /** A tariff change says nothing of the reserve or mode, so held values stay. */
  private onCloudTariff = () => {
    const document = this.cloud?.siteInfoDocument;
    if (!document) return;
    this.cloudInfo = document;
    this.emit("site_info");
  };

  private async pollConfig(): Promise<void> {
    if ((await this.info.poll()) !== null && this.cloudInfo) this.emit("site_info");
  }

  /** Keeps a command's value through a config read that started before it. */
  private hold(key: string, value: unknown): void {
    this.info.hold_command_value(key, value);
    if (this.cloudInfo) this.emit("site_info");
  }

  private onCloud = (event: SseLiveStatus) => {
    this.cloudEvent = event;
    this.publish(this.merge.set_cloud((event.live_status ?? {}) as LiveStatusResponse));
  };

  private async poll(): Promise<void> {
    const merged = await this.merge.poll();
    if (merged === null) return;
    this.publish(merged);
    if (this.merge.healthy !== this.lastHealth) {
      this.lastHealth = this.merge.healthy;
      this.app.log(
        this.lastHealth
          ? `Local Powerwall ${this.siteId}: reading the gateway at ${this.client.host}`
          : `Local Powerwall ${this.siteId}: gateway read failed, using cloud values: ${this.merge.last_error?.message}`,
      );
      if (!this.lastHealth) this.app.handleLocalPowerwallLost(this.siteId);
    }
    if (this.lastHealth) this.app.handleLocalPowerwallRead(this.siteId);
  }

  private publish(liveStatus: unknown): void {
    this.latest = { ...this.cloudEvent, live_status: liveStatus } as SseLiveStatus;
    this.emit("live_status", this.latest);
  }
}

/** Why enrolment stopped short of a verified gateway, as a `local_powerwall.*` locale key. */
export type EnrolmentFailure =
  | "approve"
  | "host_not_found"
  | "wrong_password"
  | "gateway_unreachable"
  | "cloud_unreachable";

/** The RSA-4096 key a Powerwall v1r gateway pairs with, as a PKCS#1 PEM. */
export async function generateGatewayKey(): Promise<string> {
  const { privateKey } = await promisify(generateKeyPair)("rsa", {
    modulusLength: 4096,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return privateKey;
}

/**
 * Home Assistant's enrolment, in one pass: register this key through the
 * cloud if the gateway does not know it, stop until the owner approves it on
 * the Powerwall, then prove the password and key against the gateway itself.
 * Each run is one Settings save; a pending key asks the owner to save again.
 */
export async function enrolLocalGateway(options: {
  app: TeslemetryApp;
  siteId: string;
  host: string;
  password: string;
  keyPem: string;
}): Promise<{ host: string } | { failure: EnrolmentFailure }> {
  const { app, siteId, password, keyPem } = options;
  let { host } = options;
  const { Teslemetry, AuthorizedClientKeyType, AuthorizedClientState, AuthorizedClientType, EnergyGatewayUnreachable } =
    await import("tesla-fleet-api");
  const {
    PowerwallAuthenticationError,
    PowerwallClient,
    PowerwallError,
    PowerwallKeyRejectedError,
    verify_local_gateway,
  } = await import("tesla-fleet-api/powerwall");

  const cloud = new Teslemetry(app.oauth.getAccessToken).energySites!.create(Number(siteId));
  const publicKey = createPublicKey(keyPem).export({ type: "pkcs1", format: "der" });

  try {
    const { clients } = await cloud.find_authorized_clients();
    const state = clients.find((client) => client.public_key === publicKey.toString("base64"))?.state;
    if (state !== AuthorizedClientState.VERIFIED) {
      // Re-registering a pending key would restart its approval window.
      if (state !== AuthorizedClientState.PENDING_VERIFICATION) {
        app.log(`Local Powerwall ${siteId}: registering Homey's key with the gateway`);
        await cloud.add_authorized_client(
          publicKey,
          "Homey",
          AuthorizedClientKeyType.RSA,
          AuthorizedClientType.CUSTOMER_MOBILE_APP,
        );
      }
      return { failure: "approve" };
    }
    host ||= (await cloud.find_gateway_address()) ?? "";
  } catch (error) {
    if (error instanceof EnergyGatewayUnreachable) return { failure: "cloud_unreachable" };
    throw error;
  }
  if (!host) return { failure: "host_not_found" };

  const client = new PowerwallClient({ host, gatewayPassword: password, rsaPrivateKeyPem: keyPem });
  try {
    await verify_local_gateway(client);
  } catch (error) {
    if (!(error instanceof PowerwallError)) throw error;
    app.log(`Local Powerwall ${siteId}: verifying the gateway at ${host} failed: ${error.message}`);
    if (error instanceof PowerwallKeyRejectedError) return { failure: "approve" };
    if (error instanceof PowerwallAuthenticationError) return { failure: "wrong_password" };
    return { failure: "gateway_unreachable" };
  } finally {
    client.close();
  }
  return { host };
}
