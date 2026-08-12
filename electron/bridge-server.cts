import http, {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { ANIMATION_NAME_PATTERN } from './library-catalog.cjs';
import type { AudioLevelEvent, VoiceState, VoiceStateEvent } from './types.cjs';
import { isRecord } from './types.cjs';

export const DEFAULT_PORT = 47831;
const MAX_BODY_BYTES = 64 * 1024;
const TRUSTED_ORIGIN =
  /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?|codex-app:\/\/[A-Za-z0-9._~-]*)$/i;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const OAUTH_CALLBACK_PATH = '/vroid-oauth-callback';

export interface AnimationCommandEvent {
  type: 'animation-command';
  animationName: string;
}

export type IntegrationEvent =
  | AnimationCommandEvent
  | AudioLevelEvent
  | VoiceStateEvent;

export interface OauthCallbackParameters {
  code: string | null;
  error: string | null;
  state: string | null;
}

export type McpHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  parsedBody: unknown,
) => Promise<void> | void;

export interface BridgeServerOptions {
  host?: string;
  port?: number;
  onEvent: (event: IntegrationEvent) => boolean | void;
  mcpHandler?: McpHttpHandler | null;
  onOauthCallback?:
    | ((parameters: OauthCallbackParameters) => Promise<void> | void)
    | null;
}

export interface BridgeServer {
  getLastStateEvent(): VoiceStateEvent | null;
  listen(): Promise<AddressInfo | string | null>;
  close(): Promise<void>;
}

class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly code: 'BODY_TOO_LARGE' | 'INVALID_JSON',
  ) {
    super(message);
  }
}

function oauthCallbackPage(success: boolean): string {
  const title = success ? 'Persona is connected' : 'Sign-in failed';
  const message = success
    ? 'You can close this tab and return to Persona.'
    : "Something went wrong connecting your VRoid Hub account. Close this tab and try again from Persona's Settings.";
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${title}</title></head>` +
    '<body style="font-family: sans-serif; text-align: center; padding: 4rem 1rem;">' +
    `<h1>${title}</h1><p>${message}</p></body></html>`
  );
}

export function isVoiceState(value: unknown): value is VoiceState {
  const validNullableString = (field: unknown): boolean =>
    field === undefined || field === null || typeof field === 'string';
  const validLocator =
    value != null &&
    isRecord(value) &&
    (value.locator === undefined ||
      value.locator === null ||
      (isRecord(value.locator) &&
        validNullableString(value.locator.conversationId) &&
        validNullableString(value.locator.hostId)));
  return (
    isRecord(value) &&
    typeof value.phase === 'string' &&
    ['inactive', 'starting', 'active', 'stopping'].includes(value.phase) &&
    typeof value.activity === 'string' &&
    ['idle', 'listening', 'speaking'].includes(value.activity) &&
    typeof value.microphoneMuted === 'boolean' &&
    typeof value.outputMuted === 'boolean' &&
    validLocator &&
    validNullableString(value.preferredPresentationSurface) &&
    validNullableString(value.sessionId)
  );
}

export function normalizeEvent(value: unknown): IntegrationEvent | null {
  if (!isRecord(value)) return null;
  if (value.type === 'state' && isVoiceState(value.state)) {
    return { type: 'state', state: value.state };
  }
  if (value.type === 'audio-level' && Number.isFinite(value.level)) {
    const level = Math.max(0, Math.min(1, Number(value.level)));
    const bands = isRecord(value.bands) ? value.bands : undefined;
    return { type: 'audio-level', level, ...(bands ? { bands } : {}) };
  }
  if (
    value.type === 'animation' &&
    typeof value.animation_name === 'string' &&
    ANIMATION_NAME_PATTERN.test(value.animation_name)
  ) {
    return {
      type: 'animation-command',
      animationName: value.animation_name,
    };
  }
  return null;
}

export function originAllowed(origin: string | undefined): boolean {
  return origin == null || TRUSTED_ORIGIN.test(origin);
}

export function hostAllowed(hostHeader: string | undefined): boolean {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false;
  try {
    const url = new URL(`http://${hostHeader}`);
    return (
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function jsonRpcError(
  response: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    }),
  );
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new RequestBodyError('Request body is too large', 'BODY_TOO_LARGE'));
        request.resume();
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => {
      if (bytes > MAX_BODY_BYTES) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new RequestBodyError('Request body is not valid JSON', 'INVALID_JSON'));
      }
    });
    request.on('error', reject);
  });
}

export function createBridgeServer({
  host = '127.0.0.1',
  port = DEFAULT_PORT,
  onEvent,
  mcpHandler = null,
  onOauthCallback = null,
}: BridgeServerOptions): BridgeServer {
  let lastStateEvent: VoiceStateEvent | null = null;
  const server = http.createServer((request, response) => {
    const origin = request.headers.origin;
    const requestUrl = request.url ?? '/';
    if (!hostAllowed(request.headers.host)) {
      response.writeHead(403);
      response.end();
      return;
    }

    if (request.method === 'GET' && requestUrl === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ ok: true, lastState: lastStateEvent?.state ?? null }),
      );
      return;
    }

    if (
      request.method === 'GET' &&
      new URL(requestUrl, 'http://localhost').pathname === OAUTH_CALLBACK_PATH
    ) {
      if (onOauthCallback == null) {
        response.writeHead(404);
        response.end();
        return;
      }
      const params = new URL(requestUrl, 'http://localhost').searchParams;
      void Promise.resolve(
        onOauthCallback({
          code: params.get('code'),
          state: params.get('state'),
          error: params.get('error'),
        }),
      )
        .then(() => {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(oauthCallbackPage(true));
        })
        .catch(() => {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(oauthCallbackPage(false));
        });
      return;
    }

    if (requestUrl === '/mcp') {
      if (!originAllowed(origin)) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (!request.method || !['POST', 'GET', 'DELETE'].includes(request.method)) {
        response.writeHead(405, { allow: 'POST, GET, DELETE' });
        response.end();
        return;
      }
      if (mcpHandler == null) {
        response.writeHead(404);
        response.end();
        return;
      }
      const body =
        request.method === 'POST'
          ? readJsonBody(request)
          : Promise.resolve<undefined>(undefined);
      void body
        .then((parsedBody) => mcpHandler(request, response, parsedBody))
        .catch((error: unknown) => {
          if (response.headersSent) return;
          if (error instanceof RequestBodyError && error.code === 'BODY_TOO_LARGE') {
            jsonRpcError(response, 413, -32000, 'Request body is too large');
          } else if (
            error instanceof RequestBodyError &&
            error.code === 'INVALID_JSON'
          ) {
            jsonRpcError(response, 400, -32700, 'Parse error');
          } else {
            jsonRpcError(response, 500, -32603, 'Internal server error');
          }
        });
      return;
    }

    if (
      request.method === 'OPTIONS' &&
      requestUrl === '/events' &&
      originAllowed(origin)
    ) {
      response.writeHead(204, {
        ...(origin ? { 'access-control-allow-origin': origin } : {}),
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        vary: 'Origin',
      });
      response.end();
      return;
    }

    if (
      request.method !== 'POST' ||
      requestUrl !== '/events' ||
      !originAllowed(origin)
    ) {
      response.writeHead(404);
      response.end();
      return;
    }

    void readJsonBody(request)
      .then((body) => {
        const event = normalizeEvent(body);
        if (event == null) {
          response.writeHead(422);
          response.end();
          return;
        }
        if (event.type === 'state') lastStateEvent = event;
        const accepted = onEvent(event);
        if (accepted === false) {
          response.writeHead(422);
          response.end();
          return;
        }
        response.writeHead(202, {
          ...(origin
            ? { 'access-control-allow-origin': origin, vary: 'Origin' }
            : {}),
          'content-type': 'application/json',
        });
        response.end('{"accepted":true}');
      })
      .catch((error: unknown) => {
        if (response.headersSent) return;
        response.writeHead(
          error instanceof RequestBodyError && error.code === 'BODY_TOO_LARGE'
            ? 413
            : 400,
        );
        response.end();
      });
  });

  return {
    getLastStateEvent: () => lastStateEvent,
    listen: () =>
      new Promise<AddressInfo | string | null>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
