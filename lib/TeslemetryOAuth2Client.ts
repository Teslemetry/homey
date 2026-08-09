import crypto from "crypto";
import type TeslemetryApp from "../app.js";

export interface OAuth2Token {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  expires_at?: number; // Calculated timestamp
}

export default class TeslemetryOAuth2Client {
  static TOKEN_URL = "https://api.teslemetry.com/oauth/token";
  static AUTHORIZATION_URL = "https://teslemetry.com/connect";
  static REDIRECT_URL = "https://callback.athom.com/oauth2/callback";
  static CLIENT_ID = "homey";
  static SETTINGS_KEY = "teslemetry_oauth2_token";

  private app: TeslemetryApp;
  private token: OAuth2Token | null = null;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(app: TeslemetryApp) {
    this.app = app;
    this.loadToken();
  }

  private loadToken() {
    const data = this.app.homey.settings.get(
      TeslemetryOAuth2Client.SETTINGS_KEY,
    );
    if (data) {
      this.token = data;
    }
  }

  private saveToken(token: OAuth2Token) {
    // Calculate expires_at if not present
    if (!token.expires_at) {
      token.expires_at = Date.now() + token.expires_in * 1000;
    }
    this.token = token;
    this.app.homey.settings.set(TeslemetryOAuth2Client.SETTINGS_KEY, token);
    this.app.homey.emit("oauth2:token_saved", token);
  }

  /**
   * Generates PKCE code verifier and challenge
   */
  generatePKCE() {
    const codeVerifier = this.base64URLEncode(crypto.randomBytes(32));
    const codeChallenge = this.base64URLEncode(
      crypto.createHash("sha256").update(codeVerifier).digest(),
    );
    return { codeVerifier, codeChallenge };
  }

  private base64URLEncode(buffer: Buffer) {
    return buffer
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  }

  getAuthorizationUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: TeslemetryOAuth2Client.CLIENT_ID,
      redirect_uri: TeslemetryOAuth2Client.REDIRECT_URL,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    return `${TeslemetryOAuth2Client.AUTHORIZATION_URL}?${params.toString()}`;
  }

  async exchangeCodeForToken(
    code: string,
    codeVerifier: string,
  ): Promise<OAuth2Token> {
    const body = {
      grant_type: "authorization_code",
      client_id: TeslemetryOAuth2Client.CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: TeslemetryOAuth2Client.REDIRECT_URL,
    };

    // The initial grant has no prior refresh token to fall back on, so a
    // missing one here is a genuine server-side error, not an omission.
    return this.requestToken(body, { requireRefreshToken: true });
  }

  /**
   * Refresh the token using the refresh token
   */
  async refreshToken(): Promise<OAuth2Token> {
    return this.requestToken(() => {
      if (!this.token?.refresh_token) {
        throw new Error("No refresh token available");
      }
      return {
        grant_type: "refresh_token",
        client_id: TeslemetryOAuth2Client.CLIENT_ID,
        refresh_token: this.token.refresh_token,
      };
    });
  }

  private async requestToken(
    body: any | (() => any),
    opts: { requireRefreshToken?: boolean } = {},
  ): Promise<OAuth2Token> {
    const requestPromise = this.requestQueue.then(() =>
      this._requestToken(typeof body === "function" ? body() : body, opts),
    );
    this.requestQueue = requestPromise.then(
      () => undefined,
      () => undefined,
    );
    return requestPromise;
  }

  private async _requestToken(
    body: any,
    opts: { requireRefreshToken?: boolean },
  ): Promise<OAuth2Token> {
    const response = await fetch(TeslemetryOAuth2Client.TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const data: any = await response.json();

    if (!response.ok) {
      const errorCode =
        typeof data.error === "string" ? data.error.toLowerCase() : data.error;
      if (errorCode === "invalid_refresh_token") {
        this.clearToken();
      }
      if (errorCode === "invalid_token") {
        this.refreshToken().catch((refreshError) => {
          this.app.error("Failed to refresh token after invalid_token error:", refreshError);
        });
      }
      this.app.handleApiError(data);
    }

    if (!data.access_token) {
      throw new Error("Invalid token response from server");
    }

    // An omitted refresh_token means "unchanged", not "revoked" - only the
    // initial grant has no prior token to fall back on, so that case fails loud.
    const refreshToken =
      data.refresh_token ??
      (opts.requireRefreshToken ? undefined : this.token?.refresh_token);
    if (opts.requireRefreshToken && !refreshToken) {
      throw new Error("No refresh token returned from server");
    }

    const expiresIn = data.expires_in || 3600;
    const token: OAuth2Token = {
      access_token: data.access_token,
      refresh_token: refreshToken,
      expires_in: expiresIn,
      token_type: data.token_type || "Bearer",
      expires_at: Date.now() + expiresIn * 1000,
    };

    this.saveToken(token);
    return token;
  }

  /**
   * Get a valid access token, refreshing if necessary.
   * Bound to instance for passing as callback.
   */
  getAccessToken = async (): Promise<string> => {
    if (!this.token) {
      throw new Error("No OAuth2 token available");
    }

    // Refresh if expiring in less than a minute
    if (this.token.expires_at && Date.now() + 60_000 > this.token.expires_at) {
      await this.refreshToken();
    }

    return this.token.access_token;
  };

  hasValidToken(): boolean {
    return !!this.token;
  }

  clearToken() {
    this.app.error("OAuth credentials are being removed");
    this.token = null;
    this.app.homey.settings.unset(TeslemetryOAuth2Client.SETTINGS_KEY);
  }
}
