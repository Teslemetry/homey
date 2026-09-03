import Homey from "homey";
import type { EnergyDetails, VehicleDetails } from "@teslemetry/api";
import type TeslemetryApp from "../app.js";
import TeslemetryDevice from "./TeslemetryDevice.js";

/**
 * The single vehicle eligibility predicate, shared by pairing
 * (drivers/vehicle/driver.ts) and existing-device bind
 * (drivers/vehicle/device.ts) so the two can't drift apart. A record failing
 * more than one condition reports only the first, in this priority order.
 */
export type VehicleEligibility =
  | { eligible: true }
  | { eligible: false; reason: "access" | "telemetry" | "polling" };

export function checkVehicleEligibility(
  metadata: VehicleDetails["metadata"],
): VehicleEligibility {
  if (!metadata.access) return { eligible: false, reason: "access" };
  if (!metadata.fleet_telemetry) return { eligible: false, reason: "telemetry" };
  if (metadata.polling) return { eligible: false, reason: "polling" };
  return { eligible: true };
}

/**
 * Locale key for each way checkVehicleEligibility() can report a vehicle
 * ineligible. Shared by pairing (drivers/vehicle/driver.ts) and bind-time
 * unavailability messaging (drivers/vehicle/device.ts) so the two can't
 * report different wording for the same reason.
 */
export const VEHICLE_INELIGIBILITY_MESSAGE_KEY = {
  access: "error.vehicle_access_required",
  telemetry: "error.vehicle_telemetry_unavailable",
  polling: "error.vehicle_polling_mode",
} as const;

/**
 * The single energy-site eligibility predicate, shared by pairing
 * (listEnergySiteCandidates below) and existing-device bind (every
 * <driver>/device.ts resolveAndBindSite()). Energy metadata only exposes
 * `access` - no telemetry/polling equivalent - so this can't distinguish
 * further reasons the way the vehicle predicate can.
 */
export function isEnergySiteEligible(metadata: EnergyDetails["metadata"]): boolean {
  return !!metadata.access;
}

export default class TeslemetryDriver extends Homey.Driver {
  declare homey: Homey.Device["homey"] & {
    app: TeslemetryApp;
  };

  private missingDeviceLogAt = new Map<string, number>();
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
    const accessible = sites.filter((site) => isEnergySiteEligible(site.metadata));
    this.log(
      `pairing[stage=filtering]: ${accessible.length}/${sites.length} energy site(s) accessible`,
    );

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
        `pairing[stage=products_fetch]: skipped ${failures.length}/${accessible.length} energy site(s) that failed: ${failures.join(", ")}`,
      );
    }

    return candidates;
  }

  /**
   * Structured stage logging so a red pairing-error support report can be
   * mapped to the exact stage that failed - session start, credential/token
   * acquisition, products/candidate fetch, filtering (see
   * listEnergySiteCandidates), or render handoff back to the pairing UI. An
   * unclassified list-devices failure also gets a list_devices catch-all tag.
   */
  private async runPairListDevices() {
    this.log(`pairing[stage=products_fetch]: list_devices requested`);
    try {
      const devices = await (this as any).onPairListDevices();
      this.log(
        `pairing[stage=render_handoff]: returning ${devices.length} candidate(s)`,
      );
      return devices;
    } catch (err) {
      this.error(`pairing[stage=list_devices]: onPairListDevices failed: ${err}`);
      throw err;
    }
  }

  async onPair(session: any) {
    this.log(`pairing[stage=session_start]: pairing session opened`);

    session.setHandler("showView", async (viewId: string) => {
      if (viewId === "login_oauth2") {
        // Check if we already have a valid OAuth token
        if (this.homey.app.oauth.hasValidToken()) {
          this.log(
            "pairing[stage=credential_acquisition]: valid OAuth token already exists, skipping OAuth flow",
          );
          session.emit("authorized");
          return;
        }
        await this.handleOAuth2Login(session);
      }
    });

    session.setHandler("list_devices", async () => {
      return this.runPairListDevices();
    });
  }

  async onRepair(session: any, device: Homey.Device) {
    this.log(`pairing[stage=session_start]: repair session opened`);

    if (device instanceof TeslemetryDevice) {
      this.log(`Repair: Syncing capabilities for device ${device.getName()}`);
      await device.ensureCapabilities();
    }

    session.setHandler("showView", async (viewId: string) => {
      if (viewId === "login_oauth2") {
        if (this.homey.app.oauth.hasValidToken()) {
          this.log(
            "pairing[stage=credential_acquisition]: valid OAuth token already exists, skipping OAuth flow",
          );
          session.emit("authorized");
          return;
        }

        await this.handleOAuth2Login(session);
      }
    });

    session.setHandler("list_devices", async () => {
      return this.runPairListDevices();
    });
  }

  private async handleOAuth2Login(session: any, onSuccess?: () => void) {
    this.log(
      "pairing[stage=credential_acquisition]: starting OAuth2 login flow",
    );
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
          this.error(
            `pairing[stage=credential_acquisition]: OAuth2 callback failed: ${code.message}`,
          );
          session.emit("error", code.message || "Unknown error");
          return;
        }

        try {
          await this.homey.app.oauth.exchangeCodeForToken(code, codeVerifier);
          this.log(
            "pairing[stage=credential_acquisition]: token exchange succeeded",
          );
          session.emit("authorized");
          if (onSuccess) onSuccess();
        } catch (err: any) {
          this.error(
            `pairing[stage=credential_acquisition]: token exchange failed: ${err}`,
          );
          session.emit("error", err.message || err.toString());
        }
      });
  }
}
