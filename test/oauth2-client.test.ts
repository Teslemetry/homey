import test from "node:test";
import assert from "node:assert/strict";
import TeslemetryOAuth2Client from "../lib/TeslemetryOAuth2Client.ts";

function createApp(initialToken: unknown) {
  const settingsStore: Record<string, unknown> = {
    teslemetry_oauth2_token: initialToken,
  };
  const handledErrors: unknown[] = [];
  const loggedErrors: unknown[] = [];
  const app = {
    homey: {
      settings: {
        get: (key: string) => settingsStore[key],
        set: (key: string, value: unknown) => {
          settingsStore[key] = value;
        },
        unset: (key: string) => {
          delete settingsStore[key];
        },
      },
    },
    handleApiError: (apiError: unknown) => {
      handledErrors.push(apiError);
      throw new Error("handled");
    },
    error: (...args: unknown[]) => {
      loggedErrors.push(args);
    },
  };
  return { app, settingsStore, handledErrors, loggedErrors };
}

test("refreshToken() clears the stored token on the server's lowercase invalid_refresh_token error", async () => {
  const { app, settingsStore } = createApp({
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_in: 3600,
    token_type: "Bearer",
  });

  const originalFetch = global.fetch;
  global.fetch = (async () =>
    ({
      ok: false,
      json: async () => ({
        error: "invalid_refresh_token",
        error_description: "Invalid refresh token",
      }),
    }) as unknown as Response) as typeof fetch;

  try {
    const client = new TeslemetryOAuth2Client(app as any);
    assert.equal(client.hasValidToken(), true);

    await assert.rejects(() => client.refreshToken());

    // Guards that a lowercase invalid_refresh_token from the server clears
    // the token and its backing settings entry; a case mismatch here would
    // silently leave the dead token in place.
    assert.equal(client.hasValidToken(), false);
    assert.equal(settingsStore.teslemetry_oauth2_token, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test("saveToken() invokes onTokenSaved with the persisted token instead of emitting a custom event", async () => {
  const { app } = createApp({
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_in: 3600,
    token_type: "Bearer",
  });

  const originalFetch = global.fetch;
  global.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    }) as unknown as Response) as typeof fetch;

  try {
    const client = new TeslemetryOAuth2Client(app as any);
    const saved: unknown[] = [];
    client.onTokenSaved = (token) => saved.push(token);

    await client.refreshToken();

    // app.ts's onInit() relies on this callback firing synchronously off
    // saveToken() to force a Products rebuild - app.homey has no `emit`
    // method here on purpose, so a regression back to
    // `this.app.homey.emit(...)` would throw instead of silently no-oping.
    assert.equal(saved.length, 1);
    assert.equal((saved[0] as { access_token: string }).access_token, "new-access");
  } finally {
    global.fetch = originalFetch;
  }
});
