import Homey from "homey";
import type { EnergyDetails } from "@teslemetry/api";
import type TeslemetryApp from "../app.js";
import TeslemetryDevice from "./TeslemetryDevice.js";

export default class TeslemetryDriver extends Homey.Driver {
  declare homey: Homey.Device["homey"] & {
    app: TeslemetryApp;
  };

  private missingDeviceLogAt = new Map<string, number>();
  private identityRepairChain: Promise<void> = Promise.resolve();
  private static readonly MISSING_DEVICE_LOG_INTERVAL_MS = 60_000;

  /**
   * Apps SDK 1.7.0 workaround for a Homey SDK defect: see AGENTS.md for the
   * rationale. `getDeviceById` is undeclared/private, so the stock
   * implementation throws synchronously when a saved Flow reference outlives
   * its device (e.g. removed and re-paired), crashing the app before any
   * listener runs. Resolving by scanning live runtime instances and
   * returning undefined instead lets the SDK's own request/reply chain turn
   * that into an ordinary rejected/false Flow result. Remove once a fixed
   * SDK ships.
   */
  getDeviceById(runtimeId: string): Homey.Device | undefined {
    const devices = this.getDevices() as Array<
      Homey.Device & { getId(): string }
    >;
    const found = devices.find((device) => device.getId() === runtimeId);
    if (found) return found;

    const now = Date.now();
    const lastLoggedAt = this.missingDeviceLogAt.get(runtimeId);
    if (
      lastLoggedAt === undefined ||
      now - lastLoggedAt >= TeslemetryDriver.MISSING_DEVICE_LOG_INTERVAL_MS
    ) {
      this.missingDeviceLogAt.set(runtimeId, now);
      this.error(
        `getDeviceById: no live device for runtime id ${runtimeId} on driver ${this.id}`,
      );
    }
    return undefined;
  }

  /**
   * Wires the identity-preserving repair session handlers shared by every
   * driver whose devices bind to a mutable store-backed id (energy site,
   * vehicle VIN, wall connector DIN): a status handler reporting whether the
   * device's current binding still resolves and, if not, the sole
   * unambiguous repair candidate; and a confirm handler that hands the
   * user-picked id to the device's own repair method. Every driver's
   * onRepair calls this instead of forking its own copy of the same
   * status/confirm contract - see PowerwallDriver.onRepair for the reference
   * usage this generalizes from.
   */
  protected wireIdentityRepair<TDevice extends Homey.Device>(
    session: any,
    device: Homey.Device,
    config: {
      isTarget: (device: Homey.Device) => device is TDevice;
      isBound: (device: TDevice) => boolean | Promise<boolean>;
      findCandidate: (
        device: TDevice,
      ) => Promise<{ id: string; name: string } | null>;
      repair: (device: TDevice, id: string) => Promise<void>;
      statusEvent: string;
      confirmEvent: string;
      wrongDeviceMessage: string;
    },
  ): void {
    session.setHandler(config.statusEvent, async () => {
      if (!config.isTarget(device)) return { needsRepair: false };
      if (await config.isBound(device)) return { needsRepair: false };

      const candidate = await config.findCandidate(device);
      return {
        needsRepair: true,
        candidateId: candidate?.id ?? null,
        candidateName: candidate?.name ?? null,
      };
    });

    session.setHandler(config.confirmEvent, async (id: string) => {
      if (!config.isTarget(device)) {
        throw new Error(config.wrongDeviceMessage);
      }

      const repair = this.identityRepairChain.then(async () => {
        if (await config.isBound(device)) {
          throw new Error("Device binding no longer needs repair");
        }
        const candidate = await config.findCandidate(device);
        if (candidate?.id !== id) {
          throw new Error("Repair candidate is no longer available");
        }
        await config.repair(device, id);
      });
      this.identityRepairChain = repair.catch(() => {});
      await repair;
    });
  }

  /**
   * The energy site not already bound to another live device of this
   * driver, matching an additional per-driver eligibility check (e.g. a
   * required component), if exactly one such site exists. Shared by every
   * energy-site driver's (Powerwall/Solar/Gateway) findRepairCandidate so
   * zero or multiple matches consistently block a guessed repair.
   */
  protected async findUnboundSiteCandidate<TDevice>(
    siblingDevices: TDevice[],
    excludeDevice: TDevice,
    getSiteId: (device: TDevice) => string,
    isEligible: (site: EnergyDetails) => Promise<boolean>,
  ): Promise<{ id: string; name: string } | null> {
    const { products } = this.homey.app;
    if (!products?.energySites) return null;

    const boundSiteIds = new Set(
      siblingDevices
        .filter((candidate) => candidate !== excludeDevice)
        .map((candidate) => getSiteId(candidate)),
    );

    const candidates: Array<{ id: string; name: string }> = [];
    for (const site of Object.values(products.energySites)) {
      const siteId = String(site.id);
      if (boundSiteIds.has(siteId)) continue;
      if (!(await isEligible(site))) continue;
      candidates.push({ id: siteId, name: site.name });
    }

    return candidates.length === 1 ? candidates[0] : null;
  }

  /**
   * Maps every accessible energy site (metadata.access) to zero or more pair
   * candidates independently via Promise.allSettled, so one site's rejected
   * getSiteInfo() can't blank the whole pairing list. Failures are logged
   * with the failing site id/reason and otherwise skipped - callers get back
   * only the healthy candidates.
   */
  protected async listEnergySiteCandidates<T>(
    sites: EnergyDetails[],
    mapSite: (site: EnergyDetails) => Promise<T[]>,
  ): Promise<T[]> {
    const accessible = sites.filter((site) => site.metadata.access);
    const results = await Promise.allSettled(accessible.map(mapSite));

    const candidates: T[] = [];
    const failures: string[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        candidates.push(...result.value);
      } else {
        failures.push(`${accessible[index].id} (${result.reason})`);
      }
    });

    if (failures.length > 0) {
      this.error(
        `onPairListDevices: skipped ${failures.length}/${accessible.length} energy site(s) that failed: ${failures.join(", ")}`,
      );
    }

    return candidates;
  }

  async onPair(session: any) {
    session.setHandler("showView", async (viewId: string) => {
      if (viewId === "login_oauth2") {
        // Check if we already have a valid OAuth token
        if (this.homey.app.oauth.hasValidToken()) {
          this.log("Valid OAuth token already exists, skipping OAuth flow");
          session.emit("authorized");
          return;
        }
        await this.handleOAuth2Login(session);
      }
    });

    session.setHandler("list_devices", async () => {
      return this.onPairListDevices();
    });
  }

  async onRepair(session: any, device: Homey.Device) {
    if (device instanceof TeslemetryDevice) {
      this.log(`Repair: Syncing capabilities for device ${device.getName()}`);
      await device.ensureCapabilities();
    }

    session.setHandler("showView", async (viewId: string) => {
      if (viewId === "login_oauth2") {
        if (this.homey.app.oauth.hasValidToken()) {
          this.log("Valid OAuth token already exists, skipping OAuth flow");
          session.emit("authorized");
          return;
        }

        await this.handleOAuth2Login(session);
      }
    });

    session.setHandler("list_devices", async () => {
      return (this as any).onPairListDevices();
    });
  }

  private async handleOAuth2Login(session: any, onSuccess?: () => void) {
    const pkce = this.homey.app.oauth.generatePKCE();
    const { codeVerifier } = pkce;
    const state = Math.random().toString(36).substring(7);
    const url = this.homey.app.oauth.getAuthorizationUrl(
      state,
      pkce.codeChallenge,
    );

    const callback = await this.homey.cloud.createOAuth2Callback(url);

    callback
      .on("url", (url: string) => {
        session.emit("url", url);
      })
      .on("code", async (code: string | Error) => {
        if (code instanceof Error) {
          session.emit("error", code.message || "Unknown error");
          return;
        }

        try {
          await this.homey.app.oauth.exchangeCodeForToken(code, codeVerifier);
          session.emit("authorized");
          if (onSuccess) onSuccess();
        } catch (err: any) {
          this.error(err);
          session.emit("error", err.message || err.toString());
        }
      });
  }
}
