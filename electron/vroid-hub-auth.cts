import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isRecord } from './types.cjs';

export const AUTHORIZE_URL = 'https://hub.vroid.com/oauth/authorize';
export const TOKEN_URL = 'https://hub.vroid.com/oauth/token';
const API_VERSION = '11';
const PENDING_FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const DEFAULT_EXPIRES_IN_SECONDS = 60 * 60;
const TOKEN_REQUEST_TIMEOUT_MS = 15 * 1000;

interface PendingFlow {
  state: string;
  codeVerifier: string;
  expiresAt: number;
}

interface TokenRecord {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: number;
}

export interface VroidHubAccessToken {
  accessToken: string;
  tokenType: string;
}

export interface VroidHubAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  encrypt: (plaintext: Buffer) => Buffer;
  decrypt: (encrypted: Buffer) => Buffer;
  authFilePath: string;
}

export interface VroidHubAuth {
  buildAuthorizeUrl(): string;
  disconnect(): void;
  exchangeCode(code: unknown, state: unknown): Promise<void>;
  getValidAccessToken(options?: { forceRefresh?: boolean }): Promise<VroidHubAccessToken>;
  isConnected(): boolean;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function tokenRequestHeaders(): Record<string, string> {
  return {
    'content-type': 'application/x-www-form-urlencoded',
    'X-Api-Version': API_VERSION,
  };
}

async function oauthErrorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) && typeof body.error === 'string' && body.error !== ''
      ? body.error
      : null;
  } catch {
    return null;
  }
}

function isTokenRecord(value: unknown): value is TokenRecord {
  return (
    isRecord(value) &&
    typeof value.access_token === 'string' &&
    typeof value.refresh_token === 'string' &&
    typeof value.token_type === 'string' &&
    typeof value.expires_at === 'number'
  );
}

export function createVroidHubAuth({
  clientId,
  clientSecret,
  redirectUri,
  fetchImpl = fetch,
  encrypt,
  decrypt,
  authFilePath,
}: VroidHubAuthOptions): VroidHubAuth {
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'VRoid Hub auth requires clientId, clientSecret, and redirectUri.',
    );
  }
  if (typeof encrypt !== 'function' || typeof decrypt !== 'function') {
    throw new Error('VRoid Hub auth requires encrypt/decrypt callbacks.');
  }

  let pendingFlow: PendingFlow | null = null;
  let tokens = readTokens();
  let refreshInFlight: Promise<void> | null = null;

  function readTokens(): TokenRecord | null {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(authFilePath, 'utf8'));
      if (!isRecord(parsed) || typeof parsed.encrypted !== 'string') return null;
      const decrypted = decrypt(Buffer.from(parsed.encrypted, 'base64'));
      const record: unknown = JSON.parse(decrypted.toString('utf8'));
      return isTokenRecord(record) ? record : null;
    } catch {
      return null;
    }
  }

  function writeTokens(): void {
    if (tokens == null) {
      try {
        fs.unlinkSync(authFilePath);
      } catch {
        // Already absent.
      }
      return;
    }
    fs.mkdirSync(path.dirname(authFilePath), { recursive: true });
    const encrypted = encrypt(Buffer.from(JSON.stringify(tokens), 'utf8')).toString(
      'base64',
    );
    const temporaryPath = `${authFilePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ encrypted }), {
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, authFilePath);
  }

  function storeTokenResponse(payload: unknown): void {
    if (
      !isRecord(payload) ||
      typeof payload.access_token !== 'string' ||
      typeof payload.refresh_token !== 'string'
    ) {
      throw new Error('VRoid Hub returned an unexpected token response.');
    }
    const expiresInSeconds = Number(payload.expires_in);
    refreshInFlight = null;
    tokens = {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      token_type:
        typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
      expires_at:
        Date.now() +
        (Number.isFinite(expiresInSeconds)
          ? expiresInSeconds
          : DEFAULT_EXPIRES_IN_SECONDS) *
          1000,
    };
    writeTokens();
  }

  function buildAuthorizeUrl(): string {
    const codeVerifier = base64UrlEncode(nodeCrypto.randomBytes(32));
    const codeChallenge = base64UrlEncode(
      nodeCrypto.createHash('sha256').update(codeVerifier).digest(),
    );
    const state = base64UrlEncode(nodeCrypto.randomBytes(16));
    pendingFlow = {
      state,
      codeVerifier,
      expiresAt: Date.now() + PENDING_FLOW_TIMEOUT_MS,
    };

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'default heart');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  // The redirect URI is a plain loopback GET that anything on this machine can
  // reach, so a callback only consumes the pending flow once its state proves
  // it belongs to that flow. Clearing first would let any local page cancel a
  // sign-in in progress just by hitting the callback path.
  async function exchangeCode(code: unknown, state: unknown): Promise<void> {
    const flow = pendingFlow;
    if (!flow) {
      throw new Error('No pending VRoid Hub sign-in, or it expired. Start again.');
    }
    if (flow.expiresAt < Date.now()) {
      pendingFlow = null;
      throw new Error('No pending VRoid Hub sign-in, or it expired. Start again.');
    }
    if (typeof state !== 'string' || state !== flow.state) {
      throw new Error('VRoid Hub sign-in state did not match. Start again.');
    }
    // The state matched, so this callback is the answer to the flow and the
    // flow is spent either way: the code is single-use, and a retry has to
    // start a fresh authorization rather than replay this one.
    pendingFlow = null;
    if (typeof code !== 'string' || code === '') {
      throw new Error('VRoid Hub did not return an authorization code.');
    }

    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: tokenRequestHeaders(),
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: flow.codeVerifier,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`VRoid Hub sign-in failed (${response.status}).`);
    }
    storeTokenResponse(await response.json());
  }

  async function requestRefresh(refreshToken: string): Promise<void> {
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: tokenRequestHeaders(),
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    const stillCurrent = (): boolean => tokens?.refresh_token === refreshToken;

    if (!response.ok) {
      const code = await oauthErrorCode(response);
      if (code === 'invalid_grant') {
        if (stillCurrent()) {
          tokens = null;
          writeTokens();
        }
        throw new Error(
          `VRoid Hub rejected the saved session (${response.status}` +
            `${code ? `: ${code}` : ''}). Reconnect your account.`,
        );
      }
      if (code === 'invalid_client') {
        throw new Error(
          `VRoid Hub rejected Persona's app credentials (${response.status}: invalid_client). ` +
            'Update them in Settings; your saved account session was preserved.',
        );
      }
      throw new Error(
        `VRoid Hub could not refresh the session right now (${response.status}` +
          `${code ? `: ${code}` : ''}). Your account is still connected — try again in a moment.`,
      );
    }

    const payload: unknown = await response.json();
    if (!stillCurrent()) throw new Error('VRoid Hub is not connected.');
    storeTokenResponse(payload);
  }

  function refreshTokens(): Promise<void> {
    if (!tokens) return Promise.reject(new Error('VRoid Hub is not connected.'));
    if (refreshInFlight) return refreshInFlight;
    const inFlight = requestRefresh(tokens.refresh_token).finally(() => {
      if (refreshInFlight === inFlight) refreshInFlight = null;
    });
    refreshInFlight = inFlight;
    return inFlight;
  }

  async function getValidAccessToken({
    forceRefresh = false,
  }: { forceRefresh?: boolean } = {}): Promise<VroidHubAccessToken> {
    if (!tokens) throw new Error('VRoid Hub is not connected.');
    if (forceRefresh || tokens.expires_at - TOKEN_REFRESH_SKEW_MS <= Date.now()) {
      await refreshTokens();
      if (!tokens) throw new Error('VRoid Hub is not connected.');
    }
    return { accessToken: tokens.access_token, tokenType: tokens.token_type };
  }

  function isConnected(): boolean {
    return tokens != null;
  }

  function disconnect(): void {
    pendingFlow = null;
    refreshInFlight = null;
    tokens = null;
    writeTokens();
  }

  return {
    buildAuthorizeUrl,
    disconnect,
    exchangeCode,
    getValidAccessToken,
    isConnected,
  };
}
