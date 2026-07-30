import Homey from "homey";
import type TeslemetryApp from "../app.js";
import TeslemetryDevice from "./TeslemetryDevice.js";

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
