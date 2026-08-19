import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  createVroidHubAuth,
  type VroidHubAuthOptions,
} from './vroid-hub-auth.cjs';
import { isRecord } from './types.cjs';

function fixture(context: TestContext): { authFilePath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-vroid-auth-"));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return { authFilePath: path.join(root, "vroid-hub-auth.json") };
}

// Not real encryption, just proves the store actually transforms bytes and
// round-trips through the injected callbacks rather than assuming identity.
function hexCodec(): {
  decrypt: (buffer: Buffer) => Buffer;
  encrypt: (buffer: Buffer) => Buffer;
} {
  return {
    encrypt: (buffer: Buffer) => Buffer.from(buffer.toString("hex")),
    decrypt: (buffer: Buffer) => Buffer.from(buffer.toString(), "hex"),
  };
}

type FetchHandler = (
  params: URLSearchParams,
  url: string,
) => Promise<Response> | Response;

function fakeFetch(handler: FetchHandler): typeof fetch {
  return async (input, init) => {
    const params = new URLSearchParams(init?.body?.toString());
    const url = input instanceof Request ? input.url : input.toString();
    return handler(params, url);
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createAuth(
  context: TestContext,
  overrides: Partial<VroidHubAuthOptions> = {},
) {
  const { authFilePath } = fixture(context);
  const { encrypt, decrypt } = hexCodec();
  return createVroidHubAuth({
    clientId: "client-123",
    clientSecret: "secret-456",
    redirectUri: "http://127.0.0.1:47831/vroid-oauth-callback",
    authFilePath,
    encrypt,
    decrypt,
    ...overrides,
  });
}

test("builds an authorize URL with PKCE and state", (context) => {
  const auth = createAuth(context, { fetchImpl: async () => jsonResponse(200, {}) });
  const url = new URL(auth.buildAuthorizeUrl());

  assert.equal(url.origin + url.pathname, "https://hub.vroid.com/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "http://127.0.0.1:47831/vroid-oauth-callback",
  );
  assert.equal(url.searchParams.get("scope"), "default heart");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("state"));
  assert.ok(url.searchParams.get("code_challenge"));
  assert.equal(auth.isConnected(), false);
});

test("completes sign-in and persists encrypted tokens that survive a reload", async (context) => {
  const { authFilePath } = fixture(context);
  const { encrypt, decrypt } = hexCodec();
  const fetchImpl = fakeFetch((params) => {
    assert.equal(params.get("grant_type"), "authorization_code");
    assert.equal(params.get("client_secret"), "secret-456");
    assert.equal(params.get("code"), "auth-code");
    return jsonResponse(200, {
      access_token: "access-1",
      refresh_token: "refresh-1",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
  const auth = createVroidHubAuth({
    clientId: "client-123",
    clientSecret: "secret-456",
    redirectUri: "http://127.0.0.1:47831/vroid-oauth-callback",
    authFilePath,
    encrypt,
    decrypt,
    fetchImpl,
  });
  const url = new URL(auth.buildAuthorizeUrl());
  const state = url.searchParams.get("state");

  await auth.exchangeCode("auth-code", state);

  assert.equal(auth.isConnected(), true);
  const token = await auth.getValidAccessToken();
  assert.deepEqual(token, { accessToken: "access-1", tokenType: "Bearer" });

  const onDisk = fs.readFileSync(authFilePath, "utf8");
  assert.equal(onDisk.includes("access-1"), false, "token must not be stored in plaintext");

  const reloaded = createVroidHubAuth({
    clientId: "client-123",
    clientSecret: "secret-456",
    redirectUri: "http://127.0.0.1:47831/vroid-oauth-callback",
    authFilePath,
    encrypt,
    decrypt,
    fetchImpl: async () => jsonResponse(500, {}),
  });
  assert.equal(reloaded.isConnected(), true);
  assert.deepEqual(await reloaded.getValidAccessToken(), {
    accessToken: "access-1",
    tokenType: "Bearer",
  });
});

test("rejects exchanging a code with no pending flow or a mismatched state", async (context) => {
  const auth = createAuth(context, { fetchImpl: async () => jsonResponse(200, {}) });

  await assert.rejects(() => auth.exchangeCode("code", "some-state"), /no pending/i);

  const url = new URL(auth.buildAuthorizeUrl());
  const state = url.searchParams.get("state");
  await assert.rejects(() => auth.exchangeCode("code", `not-${state}`), /state/i);
  assert.equal(auth.isConnected(), false);
});

test("a callback with the wrong state leaves the real sign-in usable", async (context) => {
  // The redirect URI is a loopback GET, so anything local can call it. A
  // callback that cannot prove it belongs to the pending flow must not be able
  // to cancel that flow.
  const auth = createAuth(context, {
    fetchImpl: async () =>
      jsonResponse(200, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        token_type: "Bearer",
        expires_in: 3600,
      }),
  });
  const state = new URL(auth.buildAuthorizeUrl()).searchParams.get("state");

  await assert.rejects(() => auth.exchangeCode("forged", "wrong-state"), /state/i);
  await assert.rejects(() => auth.exchangeCode("forged", null), /state/i);
  await assert.rejects(() => auth.exchangeCode("forged", ""), /state/i);

  await auth.exchangeCode("auth-code", state);
  assert.equal(auth.isConnected(), true);
});

test("a matching callback consumes the pending flow exactly once", async (context) => {
  const auth = createAuth(context, {
    fetchImpl: async () =>
      jsonResponse(200, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        token_type: "Bearer",
        expires_in: 3600,
      }),
  });
  const state = new URL(auth.buildAuthorizeUrl()).searchParams.get("state");

  await auth.exchangeCode("auth-code", state);
  await assert.rejects(() => auth.exchangeCode("auth-code", state), /no pending/i);
});

test("a matching callback without a code still spends the flow", async (context) => {
  const auth = createAuth(context, { fetchImpl: async () => jsonResponse(200, {}) });
  const state = new URL(auth.buildAuthorizeUrl()).searchParams.get("state");

  await assert.rejects(() => auth.exchangeCode(null, state), /authorization code/i);
  await assert.rejects(() => auth.exchangeCode("auth-code", state), /no pending/i);
  assert.equal(auth.isConnected(), false);
});

test("surfaces a failed token exchange without persisting anything", async (context) => {
  const { authFilePath } = fixture(context);
  const auth = createAuth(context, {
    fetchImpl: async () => jsonResponse(400, { error: "invalid_grant" }),
  });
  const url = new URL(auth.buildAuthorizeUrl());
  const state = url.searchParams.get("state");

  await assert.rejects(() => auth.exchangeCode("bad-code", state), /sign-in failed/i);
  assert.equal(auth.isConnected(), false);
  assert.equal(fs.existsSync(authFilePath), false);
});

test("refreshes an access token automatically once it is close to expiring", async (context) => {
  let call = 0;
  const fetchImpl = fakeFetch((params) => {
    call += 1;
    if (call === 1) {
      assert.equal(params.get("grant_type"), "authorization_code");
      return jsonResponse(200, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        token_type: "Bearer",
        expires_in: 0,
      });
    }
    assert.equal(params.get("grant_type"), "refresh_token");
    assert.equal(params.get("refresh_token"), "refresh-1");
    return jsonResponse(200, {
      access_token: "access-2",
      refresh_token: "refresh-2",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
  const auth = createAuth(context, { fetchImpl });
  const url = new URL(auth.buildAuthorizeUrl());
  await auth.exchangeCode("auth-code", url.searchParams.get("state"));

  const token = await auth.getValidAccessToken();
  assert.equal(token.accessToken, "access-2");
  assert.equal(call, 2);
});

// As above but with an hour left on the access token, so nothing refreshes
// unless a caller forces it.
type RefreshHandler = (
  params: URLSearchParams,
  call: number,
) => Promise<Response> | Response;

function connectedWithFreshToken(
  context: TestContext,
  onRefresh: RefreshHandler,
) {
  return connectedWithExpiredToken(context, onRefresh, 3600);
}

// Signs in with an already-expired access token, so the next
// getValidAccessToken() must refresh and `onRefresh` decides what it gets back.
async function connectedWithExpiredToken(
  context: TestContext,
  onRefresh: RefreshHandler,
  expiresIn = 0,
) {
  const { authFilePath } = fixture(context);
  let call = 0;
  const fetchImpl = fakeFetch((params) => {
    call += 1;
    if (call === 1) {
      return jsonResponse(200, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        token_type: "Bearer",
        expires_in: expiresIn,
      });
    }
    return onRefresh(params, call);
  });
  const auth = createAuth(context, { authFilePath, fetchImpl });
  const url = new URL(auth.buildAuthorizeUrl());
  await auth.exchangeCode("auth-code", url.searchParams.get("state"));
  assert.equal(fs.existsSync(authFilePath), true);
  return { auth, authFilePath, fetchImpl };
}

// The refresh token lives in this one file, so deleting it over a rate limit
// or an outage costs a full re-authorization that nothing actually required.
for (const status of [429, 500, 502, 503, 504, 403]) {
  test(`keeps the session when a refresh hits a transient ${status}`, async (context) => {
    const { auth, authFilePath } = await connectedWithExpiredToken(context, () =>
      jsonResponse(status, {}),
    );

    await assert.rejects(
      () => auth.getValidAccessToken(),
      new RegExp(`could not refresh the session right now \\(${status}\\)`, "i"),
    );
    assert.equal(auth.isConnected(), true);
    assert.equal(fs.existsSync(authFilePath), true);
  });
}

test("recovers on the next attempt after a transient refresh failure", async (context) => {
  const { auth } = await connectedWithExpiredToken(context, (params, call) => {
    assert.equal(params.get("grant_type"), "refresh_token");
    assert.equal(params.get("refresh_token"), "refresh-1");
    if (call === 2) return jsonResponse(503, {});
    return jsonResponse(200, {
      access_token: "access-2",
      refresh_token: "refresh-2",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });

  await assert.rejects(() => auth.getValidAccessToken(), /try again in a moment/i);

  const token = await auth.getValidAccessToken();
  assert.equal(token.accessToken, "access-2");
});

test("clears the session when VRoid Hub rejects the refresh token", async (context) => {
  const { auth, authFilePath } = await connectedWithExpiredToken(context, () =>
    jsonResponse(400, { error: "invalid_grant" }),
  );

  await assert.rejects(
    () => auth.getValidAccessToken(),
    /rejected the saved session \(400: invalid_grant\)/i,
  );
  assert.equal(auth.isConnected(), false);
  assert.equal(fs.existsSync(authFilePath), false);
});

test("keeps the session on a 401 whose body is not JSON", async (context) => {
  const { auth, authFilePath } = await connectedWithExpiredToken(
    context,
    () => new Response('<html>', { status: 401 }),
  );

  await assert.rejects(
    () => auth.getValidAccessToken(),
    /could not refresh the session right now \(401\)/i,
  );
  assert.equal(auth.isConnected(), true);
  assert.equal(fs.existsSync(authFilePath), true);
});

test("keeps the session for an invalid refresh request", async (context) => {
  const { auth, authFilePath } = await connectedWithExpiredToken(context, () =>
    jsonResponse(400, { error: "invalid_request" }),
  );

  await assert.rejects(
    () => auth.getValidAccessToken(),
    /could not refresh the session right now \(400: invalid_request\)/i,
  );
  assert.equal(auth.isConnected(), true);
  assert.equal(fs.existsSync(authFilePath), true);
});

test("keeps the session when the app credentials are rejected", async (context) => {
  const { auth, authFilePath } = await connectedWithExpiredToken(context, () =>
    jsonResponse(401, { error: "invalid_client" }),
  );

  await assert.rejects(
    () => auth.getValidAccessToken(),
    /app credentials.*saved account session was preserved/i,
  );
  assert.equal(auth.isConnected(), true);
  assert.equal(fs.existsSync(authFilePath), true);
});

test("keeps the session when the refresh request never gets a response", async (context) => {
  const { auth, authFilePath } = await connectedWithExpiredToken(context, () => {
    throw new TypeError("fetch failed");
  });

  await assert.rejects(() => auth.getValidAccessToken(), /fetch failed/);
  assert.equal(auth.isConnected(), true);
  assert.equal(fs.existsSync(authFilePath), true);
});

// A second concurrent refresh would present the token the first just rotated
// away and come back invalid_grant, destroying a session that never expired.
test("shares one request between concurrent refreshes", async (context) => {
  let refreshCalls = 0;
  let release: () => void = () => {
    throw new Error('Refresh gate was not initialized.');
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { auth } = await connectedWithExpiredToken(context, async () => {
    refreshCalls += 1;
    await gate;
    return jsonResponse(200, {
      access_token: "access-2",
      refresh_token: "refresh-2",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });

  const both = Promise.all([
    auth.getValidAccessToken(),
    auth.getValidAccessToken(),
  ]);
  release();
  const [first, second] = await both;

  assert.equal(refreshCalls, 1);
  assert.equal(first.accessToken, "access-2");
  assert.equal(second.accessToken, "access-2");
});

test("a refresh that lands after disconnect does not restore the session", async (context) => {
  let release: () => void = () => {
    throw new Error('Refresh gate was not initialized.');
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { auth, authFilePath } = await connectedWithExpiredToken(
    context,
    async () => {
      await gate;
      return jsonResponse(200, {
        access_token: "access-2",
        refresh_token: "refresh-2",
        token_type: "Bearer",
        expires_in: 3600,
      });
    },
  );

  const pending = assert.rejects(
    () => auth.getValidAccessToken(),
    /not connected/i,
  );
  auth.disconnect();
  release();
  await pending;

  assert.equal(auth.isConnected(), false);
  assert.equal(fs.existsSync(authFilePath), false);
});

// Revoking the app on hub.vroid.com kills the access token immediately, so
// expires_at still reads as valid and no refresh is due. Without forceRefresh
// the API's 401 is a dead end: the session looks connected forever and the
// user is never told to reconnect.
test("forceRefresh refreshes a token the clock still considers valid", async (context) => {
  let refreshes = 0;
  const { auth } = await connectedWithFreshToken(context, () => {
    refreshes += 1;
    return jsonResponse(200, {
      access_token: "access-2",
      refresh_token: "refresh-2",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });

  assert.equal((await auth.getValidAccessToken()).accessToken, "access-1");
  assert.equal(refreshes, 0);

  const forced = await auth.getValidAccessToken({ forceRefresh: true });
  assert.equal(forced.accessToken, "access-2");
  assert.equal(refreshes, 1);
});

test("forceRefresh clears the session when the authorization was revoked", async (context) => {
  const { auth, authFilePath } = await connectedWithFreshToken(context, () =>
    jsonResponse(400, { error: "invalid_grant" }),
  );

  await assert.rejects(
    () => auth.getValidAccessToken({ forceRefresh: true }),
    /rejected the saved session \(400: invalid_grant\)\. Reconnect your account\./,
  );
  assert.equal(auth.isConnected(), false);
  assert.equal(fs.existsSync(authFilePath), false);
});

// A forced refresh must not be able to destroy a session over an outage — the
// 401 that prompted it could just as easily have been a blip.
test("forceRefresh keeps the session when the token endpoint is down", async (context) => {
  const { auth, authFilePath } = await connectedWithFreshToken(context, () =>
    jsonResponse(503, {}),
  );

  await assert.rejects(
    () => auth.getValidAccessToken({ forceRefresh: true }),
    /could not refresh the session right now \(503\)/,
  );
  assert.equal(auth.isConnected(), true);
  assert.equal(fs.existsSync(authFilePath), true);
});

// Reconnecting without disconnecting first replaces the session under an
// in-flight refresh. That request now answers for a token nobody holds, so
// leaving it in the shared slot would fail the next caller on the new session.
test("a reconnect frees the shared refresh slot", async (context) => {
  let release: () => void = () => {
    throw new Error('Refresh gate was not initialized.');
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signIns = 0;
  const { authFilePath } = fixture(context);
  const fetchImpl = fakeFetch(async (params) => {
    if (params.get("grant_type") === "authorization_code") {
      signIns += 1;
      // expires_in 0 so each new session still needs a refresh to be usable.
      return jsonResponse(200, {
        access_token: `access-${signIns}`,
        refresh_token: `refresh-${signIns}`,
        token_type: "Bearer",
        expires_in: 0,
      });
    }
    await gate;
    return jsonResponse(200, {
      access_token: `refreshed-from-${params.get("refresh_token")}`,
      refresh_token: "refresh-next",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
  const auth = createAuth(context, { authFilePath, fetchImpl });
  const firstUrl = new URL(auth.buildAuthorizeUrl());
  await auth.exchangeCode("auth-code", firstUrl.searchParams.get("state"));

  // Holds the shared slot for the rest of the test: it is never released
  // before the second session's caller arrives.
  const stale = auth.getValidAccessToken().catch((error: unknown) => error);
  const secondUrl = new URL(auth.buildAuthorizeUrl());
  await auth.exchangeCode("auth-code-2", secondUrl.searchParams.get("state"));

  const fresh = auth.getValidAccessToken();
  release();

  assert.equal((await fresh).accessToken, "refreshed-from-refresh-2");
  const staleError = await stale;
  assert.ok(isRecord(staleError) && typeof staleError.message === 'string');
  assert.match(staleError.message, /not connected/i);
  assert.equal(auth.isConnected(), true);
});

test("clears the persisted session on disconnect", async (context) => {
  const { authFilePath } = fixture(context);
  const { encrypt, decrypt } = hexCodec();
  const fetchImpl = async () =>
    jsonResponse(200, {
      access_token: "access-1",
      refresh_token: "refresh-1",
      token_type: "Bearer",
      expires_in: 3600,
    });
  const auth = createVroidHubAuth({
    clientId: "client-123",
    clientSecret: "secret-456",
    redirectUri: "http://127.0.0.1:47831/vroid-oauth-callback",
    authFilePath,
    encrypt,
    decrypt,
    fetchImpl,
  });
  const url = new URL(auth.buildAuthorizeUrl());
  await auth.exchangeCode("auth-code", url.searchParams.get("state"));
  assert.equal(auth.isConnected(), true);

  auth.disconnect();

  assert.equal(auth.isConnected(), false);
  assert.equal(fs.existsSync(authFilePath), false);
  await assert.rejects(() => auth.getValidAccessToken(), /not connected/i);

  const reloaded = createVroidHubAuth({
    clientId: "client-123",
    clientSecret: "secret-456",
    redirectUri: "http://127.0.0.1:47831/vroid-oauth-callback",
    authFilePath,
    encrypt,
    decrypt,
    fetchImpl,
  });
  assert.equal(reloaded.isConnected(), false);
});
