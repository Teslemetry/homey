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
      emit: () => {},
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

function stubFetch(responseBody: unknown) {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    ({
      ok: true,
      json: async () => responseBody,
    }) as unknown as Response) as typeof fetch;
  return () => {
    global.fetch = originalFetch;
  };
}

test("refreshToken() rotates the stored refresh token when the server returns a new one", async () => {
  const { app, settingsStore } = createApp({
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_in: 3600,
    token_type: "Bearer",
  });
  const restoreFetch = stubFetch({
    access_token: "new-access",
    refresh_token: "new-refresh",
    expires_in: 3600,
    token_type: "Bearer",
  });

  try {
    const client = new TeslemetryOAuth2Client(app as any);
    const token = await client.refreshToken();

    assert.equal(token.refresh_token, "new-refresh");
    assert.equal(
      (settingsStore.teslemetry_oauth2_token as any).refresh_token,
      "new-refresh",
    );
  } finally {
    restoreFetch();
  }
});

test("refreshToken() preserves the existing refresh token when the response omits it", async () => {
  const { app, settingsStore } = createApp({
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_in: 3600,
    token_type: "Bearer",
  });
  const restoreFetch = stubFetch({
    access_token: "new-access",
    expires_in: 3600,
    token_type: "Bearer",
  });

  try {
    const client = new TeslemetryOAuth2Client(app as any);
    const token = await client.refreshToken();

    assert.equal(token.access_token, "new-access");
    assert.equal(token.refresh_token, "old-refresh");
    assert.equal(
      (settingsStore.teslemetry_oauth2_token as any).refresh_token,
      "old-refresh",
    );
  } finally {
    restoreFetch();
  }
});

test("exchangeCodeForToken() rejects a response with no refresh token", async () => {
  const { app } = createApp(null);
  const restoreFetch = stubFetch({
    access_token: "first-access",
    expires_in: 3600,
    token_type: "Bearer",
  });

  try {
    const client = new TeslemetryOAuth2Client(app as any);
    await assert.rejects(
      () => client.exchangeCodeForToken("code", "verifier"),
      /refresh token/i,
    );
    assert.equal(client.hasValidToken(), false);
  } finally {
    restoreFetch();
  }
});

test("concurrent refresh and code exchange do not share token requests", async () => {
  const { app } = createApp({
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_in: 3600,
    token_type: "Bearer",
  });
  const originalFetch = global.fetch;
  const grantTypes: string[] = [];
  global.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    grantTypes.push(body.grant_type);
    return {
      ok: true,
      json: async () => ({
        access_token: `${body.grant_type}-access`,
        expires_in: 3600,
        token_type: "Bearer",
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const client = new TeslemetryOAuth2Client(app as any);
    const refresh = client.refreshToken();
    const exchange = client.exchangeCodeForToken("code", "verifier");

    assert.equal((await refresh).refresh_token, "old-refresh");
    await assert.rejects(exchange, /refresh token/i);
    assert.deepEqual(grantTypes, ["refresh_token", "authorization_code"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("slow access-only refresh preserves a concurrently rotated token", async () => {
  const { app, settingsStore } = createApp({
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_in: 3600,
    token_type: "Bearer",
  });
  const originalFetch = global.fetch;
  let releaseRefresh!: () => void;
  const refreshResponseReady = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  global.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return {
      ok: true,
      json: async () => {
        if (body.grant_type === "refresh_token") {
          await refreshResponseReady;
          return {
            access_token: "refreshed-access",
            expires_in: 3600,
            token_type: "Bearer",
          };
        }
        return {
          access_token: "exchanged-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        };
      },
    } as Response;
  }) as typeof fetch;

  try {
    const client = new TeslemetryOAuth2Client(app as any);
    const refresh = client.refreshToken();

    await client.exchangeCodeForToken("code", "verifier");
    releaseRefresh();
    const refreshedToken = await refresh;

    assert.equal(refreshedToken.refresh_token, "rotated-refresh");
    assert.equal(
      (settingsStore.teslemetry_oauth2_token as any).refresh_token,
      "rotated-refresh",
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("refreshToken() normalizes expires_at when the response omits expires_in", async () => {
  const { app } = createApp({
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_in: 3600,
    token_type: "Bearer",
  });
  const restoreFetch = stubFetch({
    access_token: "new-access",
    refresh_token: "new-refresh",
    token_type: "Bearer",
  });

  try {
    const client = new TeslemetryOAuth2Client(app as any);
    const before = Date.now();
    const token = await client.refreshToken();

    assert.equal(token.expires_in, 3600);
    assert.ok(typeof token.expires_at === "number" && !Number.isNaN(token.expires_at));
    assert.ok(token.expires_at! >= before + 3600 * 1000);
  } finally {
    restoreFetch();
  }
});

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
