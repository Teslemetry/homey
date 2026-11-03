import { createPublicKey, generateKeyPair } from "node:crypto";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import type { SseLiveStatus, TeslemetryEnergySiteStream } from "@teslemetry/api";
import type { LiveStatusMerge, PowerwallClient } from "tesla-fleet-api/powerwall";
import type { LiveStatusResponse } from "tesla-fleet-api/types";
import type TeslemetryApp from "../app.js";

/** A verified gateway, as the Powerwall device stores it once enrolment succeeds. */
export interface LocalGateway {
  host: string;
  password: string;
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

/**
 * One enrolled site's local Powerwall link. It reads the gateway's
 * live_status every 5 s and overlays the keys the gateway owns on the latest
 * cloud live_status, so the site's Powerwall, Gateway and Solar devices get
 * one merged view. Every other key keeps its cloud value, and a failed read
 * falls back to the cloud values (LiveStatusMerge).
 *
 * `island_status` is never overlaid: the gateway only knows "off grid", and
 * the grid outage and island test Flow cards need the cloud's reason.
 */
export class LocalPowerwallSite extends EventEmitter {
  private cloud?: TeslemetryEnergySiteStream;
  private cloudEvent?: SseLiveStatus;
  private latest?: SseLiveStatus;
  private lastHealth: boolean | null = null;
  private stopped = false;
  private readonly timer: NodeJS.Timeout;

  /** Loads `tesla-fleet-api/powerwall` only now, so a site that never enrols costs nothing. */
  static async start(app: TeslemetryApp, siteId: string, gateway: LocalGateway, keyPem: string) {
    const { LiveStatusMerge, PowerwallClient, PowerwallEnergySite, ENERGY_LIVE_INTERVAL_MS } =
      await import("tesla-fleet-api/powerwall");
    const { LOCAL_LIVE_STATUS_KEYS } = await import("tesla-fleet-api/router");
    const client = new PowerwallClient({
      host: gateway.host,
      gatewayPassword: gateway.password,
      rsaPrivateKeyPem: keyPem,
    });
    const merge = new LiveStatusMerge(new PowerwallEnergySite(client), {}, {
      owned_keys: LOCAL_LIVE_STATUS_KEYS.filter((key) => key !== "island_status"),
    });
    return new LocalPowerwallSite(app, siteId, client, merge, ENERGY_LIVE_INTERVAL_MS);
  }

  private constructor(
    private readonly app: TeslemetryApp,
    readonly siteId: string,
    private readonly client: PowerwallClient,
    private readonly merge: LiveStatusMerge,
    intervalMs: number,
  ) {
    super();
    this.timer = app.homey.setInterval(() => {
      this.poll().catch((error) => this.app.error(`Local Powerwall ${siteId}: poll failed`, error));
    }, intervalMs);
  }

  /**
   * The live_status source for a device bound to `cloud`, this site's
   * current stream. A rebuilt Products generation brings a new stream, so
   * the first device to bind to it moves the subscription over.
   */
  attach(cloud: TeslemetryEnergySiteStream): this {
    if (this.cloud === cloud) return this;
    this.cloud?.off("live_status", this.onCloud);
    this.cloud = cloud;
    // Replays the stream's cached live_status synchronously.
    cloud.on("live_status", this.onCloud);
    return this;
  }

  /** Replays the latest merged live_status to a new listener, as the cloud stream does. */
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === "live_status" && this.latest) listener(this.latest);
    return this;
  }

  /** Whether the last gateway read succeeded. */
  get healthy(): boolean {
    return !this.stopped && this.merge.healthy === true;
  }

  stop(): void {
    this.stopped = true;
    this.app.homey.clearInterval(this.timer);
    this.cloud?.off("live_status", this.onCloud);
    this.cloud = undefined;
    this.client.close();
    this.removeAllListeners();
  }

  private onCloud = (event: SseLiveStatus) => {
    this.cloudEvent = event;
    this.publish(this.merge.set_cloud((event.live_status ?? {}) as LiveStatusResponse));
  };

  private async poll(): Promise<void> {
    const merged = await this.merge.poll();
    if (merged === null) return;
    if (this.merge.healthy !== this.lastHealth) {
      this.lastHealth = this.merge.healthy;
      this.app.log(
        this.lastHealth
          ? `Local Powerwall ${this.siteId}: reading the gateway at ${this.client.host}`
          : `Local Powerwall ${this.siteId}: gateway read failed, using cloud values: ${this.merge.last_error?.message}`,
      );
    }
    this.publish(merged);
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
