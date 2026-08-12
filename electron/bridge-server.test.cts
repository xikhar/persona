import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import {
  createBridgeServer,
  hostAllowed,
  normalizeEvent,
  originAllowed,
} from './bridge-server.cjs';
import type {
  IntegrationEvent,
  OauthCallbackParameters,
} from './bridge-server.cjs';

interface TestResponse {
  body: string;
  headers: IncomingHttpHeaders;
  status: number | undefined;
}

interface TestRequestOptions {
  body?: string;
  headers?: OutgoingHttpHeaders;
  method?: string;
  path: string;
}

function requestServer(
  address: AddressInfo | string | null,
  { path, method = "GET", headers = {}, body = "" }: TestRequestOptions,
): Promise<TestResponse> {
  if (!address || typeof address === 'string') {
    return Promise.reject(new Error('Bridge did not return a TCP address.'));
  }
  return new Promise<TestResponse>((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path,
        method,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("normalizes voice events and configured animation commands", () => {
  const state = {
    activity: "speaking",
    microphoneMuted: false,
    outputMuted: false,
    phase: "active",
  };
  assert.deepEqual(normalizeEvent({ type: "state", state }), { type: "state", state });
  assert.deepEqual(normalizeEvent({ type: "audio-level", level: 4 }), {
    type: "audio-level",
    level: 1,
  });
  assert.deepEqual(
    normalizeEvent({ type: "animation", animation_name: "wave-hello" }),
    {
      type: "animation-command",
      animationName: "wave-hello",
    },
  );
  assert.equal(
    normalizeEvent({ type: "animation", animation_name: "Wave Hello" }),
    null,
  );
  assert.equal(
    normalizeEvent({ type: "animation", animation_name: "unknown/name" }),
    null,
  );
  assert.equal(
    normalizeEvent({ type: "animation", animation: "LEGACY_VALUE" }),
    null,
  );
  assert.equal(normalizeEvent({ type: "state", state: { phase: "wat" } }), null);
  assert.equal(
    normalizeEvent({
      type: 'state',
      state: { ...state, locator: { conversationId: 42 } },
    }),
    null,
  );
  assert.equal(
    normalizeEvent({ type: 'state', state: { ...state, sessionId: false } }),
    null,
  );
});

test("only accepts supported app and local webview origins", () => {
  assert.equal(originAllowed("http://127.0.0.1:5175"), true);
  assert.equal(originAllowed("http://localhost:5175"), true);
  assert.equal(originAllowed("codex-app://codex"), true);
  assert.equal(originAllowed("null"), false);
  assert.equal(originAllowed("https://example.com"), false);
  assert.equal(originAllowed("codex://settings"), false);
  assert.equal(originAllowed(undefined), true);
});

test("only accepts loopback Host headers", () => {
  assert.equal(hostAllowed("127.0.0.1:47831"), true);
  assert.equal(hostAllowed("localhost:47831"), true);
  assert.equal(hostAllowed("[::1]:47831"), true);
  assert.equal(hostAllowed("persona.example"), false);
  assert.equal(hostAllowed("127.0.0.1.example"), false);
  assert.equal(hostAllowed(undefined), false);
});

test("bridge rejects a non-loopback Host header", async (context) => {
  const bridge = createBridgeServer({ port: 0, onEvent: () => {} });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const response = await requestServer(address, {
    path: "/health",
    headers: { host: "persona.example" },
  });

  assert.equal(response.status, 403);
});

test("vroid-oauth-callback is 404 with no handler configured", async (context) => {
  const bridge = createBridgeServer({ port: 0, onEvent: () => {} });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const response = await requestServer(address, {
    path: "/vroid-oauth-callback?code=abc&state=xyz",
  });

  assert.equal(response.status, 404);
});

test("vroid-oauth-callback forwards the parsed query params and shows a success page", async (context) => {
  const received: OauthCallbackParameters[] = [];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    onOauthCallback: async (params) => {
      received.push(params);
    },
  });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const response = await requestServer(address, {
    path: "/vroid-oauth-callback?code=abc123&state=xyz789",
  });

  assert.equal(response.status, 200);
  const contentType = response.headers["content-type"];
  assert.ok(contentType);
  assert.match(contentType, /text\/html/);
  assert.match(response.body, /connected/i);
  assert.deepEqual(received, [{ code: "abc123", state: "xyz789", error: null }]);
});

test("vroid-oauth-callback shows a failure page when the handler rejects", async (context) => {
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    onOauthCallback: async () => {
      throw new Error("state mismatch");
    },
  });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const response = await requestServer(address, {
    path: "/vroid-oauth-callback?error=access_denied",
  });

  assert.equal(response.status, 200);
  assert.match(response.body, /failed/i);
});

test("bridge accepts a valid native adapter state event", async (context) => {
  const events: IntegrationEvent[] = [];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: (event) => {
      events.push(event);
    },
  });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const body = JSON.stringify({
    type: "state",
    state: {
      activity: "listening",
      microphoneMuted: false,
      outputMuted: false,
      phase: "active",
    },
  });
  const response = await requestServer(address, {
    path: "/events",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
    body,
  });
  const originlessPreflight = await requestServer(address, {
    path: '/events',
    method: 'OPTIONS',
  });

  assert.equal(response.status, 202);
  assert.equal(originlessPreflight.status, 204);
  assert.equal(originlessPreflight.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(events, [{
    type: 'state',
    state: {
      activity: 'listening',
      microphoneMuted: false,
      outputMuted: false,
      phase: 'active',
    },
  }]);
});

test("bridge delegates configured animation names to the active library", async (context) => {
  const events: IntegrationEvent[] = [];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: (event) => {
      events.push(event);
      return (
        event.type === 'animation-command' &&
        event.animationName === "installed-motion"
      );
    },
  });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const acceptedBody = JSON.stringify({
    type: "animation",
    animation_name: "installed-motion",
  });
  const rejectedBody = JSON.stringify({
    type: "animation",
    animation_name: "uninstalled-motion",
  });
  const accepted = await requestServer(address, {
    path: "/events",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: acceptedBody,
  });
  const rejected = await requestServer(address, {
    path: "/events",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rejectedBody,
  });

  assert.equal(accepted.status, 202);
  assert.equal(rejected.status, 422);
  assert.deepEqual(events, [
    { type: "animation-command", animationName: "installed-motion" },
    { type: "animation-command", animationName: "uninstalled-motion" },
  ]);
});

test("bridge routes only valid local JSON requests to MCP", async (context) => {
  const bodies: { body: unknown; method: string | undefined }[] = [];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: (request, response, body) => {
      bodies.push({ body, method: request.method });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    },
  });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const accepted = await requestServer(address, {
    path: "/mcp",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"jsonrpc":"2.0"}',
  });
  const acceptedGet = await requestServer(address, {
    path: "/mcp",
  });
  const acceptedDelete = await requestServer(address, {
    path: "/mcp",
    method: "DELETE",
  });
  const blockedOrigin = await requestServer(address, {
    path: "/mcp",
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://example.com",
    },
    body: "{}",
  });
  const unsupportedMethod = await requestServer(address, {
    path: "/mcp",
    method: "PUT",
  });
  const invalidJson = await requestServer(address, {
    path: "/mcp",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  const oversized = await requestServer(address, {
    path: "/mcp",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(64 * 1024) }),
  });

  assert.equal(accepted.status, 200);
  assert.equal(acceptedGet.status, 200);
  assert.equal(acceptedDelete.status, 200);
  assert.equal(blockedOrigin.status, 403);
  assert.equal(unsupportedMethod.status, 405);
  assert.equal(unsupportedMethod.headers.allow, "POST, GET, DELETE");
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(JSON.parse(invalidJson.body), {
    jsonrpc: '2.0',
    error: { code: -32700, message: 'Parse error' },
    id: null,
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(bodies, [
    { body: { jsonrpc: "2.0" }, method: "POST" },
    { body: undefined, method: "GET" },
    { body: undefined, method: "DELETE" },
  ]);
});
