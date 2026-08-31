import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  LATEST_PROTOCOL_VERSION,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createBridgeServer } from './bridge-server.cjs';
import {
  SERVER_INSTRUCTIONS,
  WINDOW_ACTIONS,
  createPersonaMcpHandler,
  type PersonaMcpHandlerOptions,
  type WindowAction,
} from './mcp-server.cjs';
import { isRecord } from './types.cjs';
import { McpTransportAdapter } from './mcp-transport.cjs';

function bridgePort(address: AddressInfo | string | null): number {
  if (!address || typeof address === 'string') {
    throw new Error('Bridge did not return a TCP address.');
  }
  return address.port;
}

async function connectClient(
  client: Client,
  transport: StreamableHTTPClientTransport,
): Promise<McpTransportAdapter> {
  const adapter = new McpTransportAdapter(transport);
  await client.connect(adapter);
  return adapter;
}

function toolNamed(tools: readonly unknown[], name: string): Record<string, unknown> {
  const tool = tools.find((candidate) => isRecord(candidate) && candidate.name === name);
  if (!isRecord(tool)) throw new Error(`Missing MCP tool ${name}`);
  return tool;
}

function toolInputProperty(
  tool: Record<string, unknown>,
  property: string,
): Record<string, unknown> {
  const inputSchema = tool.inputSchema;
  if (!isRecord(inputSchema) || !isRecord(inputSchema.properties)) {
    throw new Error('MCP tool has no input properties.');
  }
  const value = inputSchema.properties[property];
  if (!isRecord(value)) throw new Error(`MCP tool has no ${property} input.`);
  return value;
}

function toolDescription(tool: Record<string, unknown>): string {
  if (typeof tool.description !== 'string') throw new Error('MCP tool has no description.');
  return tool.description;
}

function resultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error('MCP result has no content.');
  }
  const first: unknown = result.content[0];
  if (!isRecord(first) || typeof first.text !== 'string') {
    throw new Error('MCP result has no text content.');
  }
  return first.text;
}

test("Persona MCP exposes and executes the local character tools", async (context) => {
  const playedAnimations: string[] = [];
  const configuredAnimations = [
    {
      animation_name: "wave-hello",
      animation_description: "A friendly wave.",
      animation_trigger_scenario: "Use when greeting the user.",
    },
  ];
  const windowActions: WindowAction[] = [];
  let windowVisible = false;
  const voiceState = {
    activity: "listening",
    microphoneMuted: false,
    outputMuted: false,
    phase: "active",
  };
  const listener = {
    available: true,
    capturing: false,
    monitoring: true,
    source: null,
  };
  const mcpHandler = createPersonaMcpHandler({
    onAnimation: (animation) => {
      playedAnimations.push(animation);
      return true;
    },
    onWindowAction: (action) => {
      windowActions.push(action);
      if (action === "show") windowVisible = true;
      else if (action === "hide") windowVisible = false;
      else windowVisible = !windowVisible;
      return windowVisible;
    },
    getStatus: () => ({ windowVisible, voiceState, listener }),
    getAnimations: () => configuredAnimations,
  });
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler,
  });
  const address = await bridge.listen();
  const client = new Client({ name: "persona-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${bridgePort(address)}/mcp`),
  );
  context.after(async () => {
    await client.close();
    await bridge.close();
  });

  const adapter = await connectClient(client, transport);
  assert.equal(adapter.getSessionId(), transport.sessionId);
  assert.equal(typeof transport.protocolVersion, 'string');
  const tools = await client.listTools();

  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [
      "play_animation",
      "list_animations",
      "list_animation_clips",
      "create_animation_action",
      "attach_animation_clip",
      "control_window",
      "get_status",
      "generate_animation",
      "get_animation_generation",
    ],
  );
  assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
  const animationTool = toolNamed(tools.tools, 'play_animation');
  const animationInput = toolInputProperty(animationTool, 'animation');
  assert.equal(animationInput.type, "string");
  assert.equal(animationInput.enum, undefined);
  assert.equal(
    animationInput.description,
    'The installed character action to play.',
  );
  assert.match(toolDescription(animationTool), /A friendly wave/);
  const windowTool = toolNamed(tools.tools, 'control_window');
  assert.deepEqual(toolInputProperty(windowTool, 'action').enum, WINDOW_ACTIONS);

  const animationResult = await client.callTool({
    name: "play_animation",
    arguments: { animation: "wave-hello" },
  });
  const windowResult = await client.callTool({
    name: "control_window",
    arguments: { action: "show" },
  });
  const statusResult = await client.callTool({
    name: "get_status",
    arguments: {},
  });
  const animationsResult = await client.callTool({
    name: "list_animations",
    arguments: {},
  });

  assert.deepEqual(playedAnimations, ["wave-hello"]);
  assert.deepEqual(windowActions, ["show"]);
  assert.match(resultText(animationResult), /wave-hello action/);
  assert.match(resultText(animationsResult), /A friendly wave/);
  assert.match(resultText(windowResult), /now visible/);
  assert.deepEqual(JSON.parse(resultText(statusResult)), {
    windowVisible: true,
    voiceState,
    listener,
  });
});

test('Persona MCP starts and reads an opted-in asynchronous animation generation', async (context) => {
  const clipId = '123e4567-e89b-42d3-a456-426614174001';
  const job = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    action_id: null,
    action_name: null,
    clip_id: null,
    clip_name: 'friendly-wave',
    prompt: 'A friendly wave',
    phase: 'generating' as const,
    error: null,
    error_code: null,
    failure_phase: null,
    attempt: 1,
    provider_animation_id: 'remote-1',
    frames: 90,
    steps: 25,
    seed: 7,
    model: 'soma-rp-v1.1',
    model_license: 'NVIDIA Open Model License',
    source_sha256: null,
    vrma_sha256: null,
    converter_version: 'persona-soma30-v1',
    created_at: '2026-08-31T00:00:00.000Z',
    updated_at: '2026-08-31T00:00:01.000Z',
  };
  const requests: unknown[] = [];
  const actionRequests: unknown[] = [];
  const attachedRequests: unknown[] = [];
  const configuredAction = {
    id: '123e4567-e89b-42d3-a456-426614174002',
    animation_name: 'friendly-wave',
    animation_description: 'A friendly wave.',
    animation_trigger_scenario: 'Use when greeting the user.',
    expression_name: 'happy',
    expression_weight: 0.8,
    animation_type: null,
    origin: 'user' as const,
    system: false,
    editable: true,
    modified: false,
    removable: true,
    clips: [],
    asset_urls: [],
  };
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: createPersonaMcpHandler({
      onAnimation: () => true,
      onWindowAction: () => false,
      getStatus: () => ({}),
      getAnimationClips: () => [{
        id: clipId,
        clip_name: 'friendly-wave',
        source: 'kimodo',
        asset_url: `persona-asset://animation/${clipId}.vrma`,
        created_at: '2026-08-31T00:00:00.000Z',
        prompt: 'A friendly wave',
        generation_job_id: job.id,
        linked_action_ids: [],
      }],
      onCreateAnimationAction: (metadata, clipIds) => {
        actionRequests.push({ metadata, clipIds });
        return configuredAction;
      },
      onAttachAnimationClip: (actionName, requestedClipId) => {
        attachedRequests.push({ actionName, clipId: requestedClipId });
        return configuredAction;
      },
      onGenerateAnimation: (request) => {
        requests.push(request);
        return job;
      },
      getAnimationGeneration: (jobId) => jobId === job.id ? job : null,
    }),
  });
  const address = await bridge.listen();
  const client = new Client({ name: 'persona-generation-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${bridgePort(address)}/mcp`),
  );
  context.after(async () => {
    await client.close();
    await bridge.close();
  });
  await connectClient(client, transport);

  const started = await client.callTool({
    name: 'generate_animation',
    arguments: {
      prompt: 'A friendly wave',
      clip_name: 'friendly-wave',
      frames: 90,
      steps: 25,
      seed: 7,
    },
  });
  assert.equal(started.isError, undefined);
  assert.deepEqual(JSON.parse(resultText(started)), job);
  assert.deepEqual(requests, [{
    prompt: 'A friendly wave',
    clip_name: 'friendly-wave',
    frames: 90,
    steps: 25,
    seed: 7,
  }]);

  const progress = await client.callTool({
    name: 'get_animation_generation',
    arguments: { job_id: job.id },
  });
  assert.deepEqual(JSON.parse(resultText(progress)), job);

  const clips = await client.callTool({ name: 'list_animation_clips', arguments: {} });
  assert.equal(JSON.parse(resultText(clips))[0]?.id, clipId);
  const created = await client.callTool({
    name: 'create_animation_action',
    arguments: {
      animation_name: 'friendly-wave',
      animation_description: 'A friendly wave.',
      animation_trigger_scenario: 'Use when greeting the user.',
      expression_name: 'happy',
      expression_weight: 0.8,
      clip_ids: [clipId],
    },
  });
  assert.equal(JSON.parse(resultText(created)).animation_name, 'friendly-wave');
  assert.deepEqual(actionRequests, [{
    metadata: {
      animation_name: 'friendly-wave',
      animation_description: 'A friendly wave.',
      animation_trigger_scenario: 'Use when greeting the user.',
      expression_name: 'happy',
      expression_weight: 0.8,
    },
    clipIds: [clipId],
  }]);
  const attached = await client.callTool({
    name: 'attach_animation_clip',
    arguments: { animation: 'friendly-wave', clip_id: clipId },
  });
  assert.equal(JSON.parse(resultText(attached)).id, configuredAction.id);
  assert.deepEqual(attachedRequests, [{ actionName: 'friendly-wave', clipId }]);
});

test("Persona MCP exposes custom animation metadata in its tool contract", async (context) => {
  const animations = [
    {
      animation_name: "wave-hello",
      animation_description: "A small friendly wave.",
      animation_trigger_scenario: "Use when greeting the user.",
    },
  ];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: createPersonaMcpHandler({
      onAnimation: () => true,
      onWindowAction: () => false,
      getStatus: () => ({}),
      getAnimations: () => animations,
    }),
  });
  const address = await bridge.listen();
  const client = new Client({ name: "persona-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${bridgePort(address)}/mcp`),
  );
  context.after(async () => {
    await client.close();
    await bridge.close();
  });

  await connectClient(client, transport);
  const tool = toolNamed((await client.listTools()).tools, 'play_animation');

  assert.match(toolDescription(tool), /A small friendly wave/);
  assert.match(toolDescription(tool), /Use when greeting the user/);
  assert.equal(
    JSON.stringify(tool).split('Use when greeting the user').length - 1,
    1,
    'The action catalog belongs to one field of the tool definition.',
  );
});

test("Persona MCP refreshes animation actions inside an active client session", async (context) => {
  const playedAnimations: string[] = [];
  const configuredAnimations = [
    {
      animation_name: "wave-hello",
      animation_description: "A small friendly wave.",
      animation_trigger_scenario: "Use when greeting the user.",
    },
  ];
  const mcpHandler = createPersonaMcpHandler({
    onAnimation: (animation) => {
      playedAnimations.push(animation);
      return true;
    },
    onWindowAction: () => false,
    getStatus: () => ({}),
    getAnimations: () => configuredAnimations,
  });
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler,
  });
  const address = await bridge.listen();
  const client = new Client({ name: "persona-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${bridgePort(address)}/mcp`),
  );
  let resolveToolChange: (() => void) | null = null;
  const toolChanged = new Promise<void>((resolve) => {
    resolveToolChange = resolve;
  });
  client.setNotificationHandler(
    ToolListChangedNotificationSchema,
    () => resolveToolChange?.(),
  );
  context.after(async () => {
    await client.close();
    await mcpHandler.close();
    await bridge.close();
  });

  await connectClient(client, transport);
  await client.listTools();
  await new Promise((resolve) => setTimeout(resolve, 50));

  configuredAnimations.push({
    animation_name: "finger-gun",
    animation_description: "A playful finger-gun gesture.",
    animation_trigger_scenario: "Use after a clever success.",
  });
  const immediateResult = await client.callTool({
    name: "play_animation",
    arguments: { animation: "finger-gun" },
  });
  assert.equal(immediateResult.isError, undefined);
  assert.deepEqual(playedAnimations, ["finger-gun"]);

  mcpHandler.notifyToolsChanged();

  await Promise.race([
    toolChanged,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Tool list change was not delivered.")),
        1500,
      ),
    ),
  ]);

  const refreshedTool = toolNamed(
    (await client.listTools()).tools,
    'play_animation',
  );
  assert.match(toolDescription(refreshedTool), /finger-gun/);
  assert.equal(
    toolInputProperty(refreshedTool, 'animation').description,
    'The installed character action to play.',
  );
});

test("Persona MCP rejects unknown animation names before invoking the app", async (context) => {
  const animations: string[] = [];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: createPersonaMcpHandler({
      onAnimation: (animation) => {
        animations.push(animation);
        return true;
      },
      onWindowAction: () => false,
      getStatus: () => ({
        windowVisible: false,
        voiceState: null,
        listener: null,
      }),
    }),
  });
  const address = await bridge.listen();
  const client = new Client({ name: "persona-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${bridgePort(address)}/mcp`),
  );
  context.after(async () => {
    await client.close();
    await bridge.close();
  });

  await connectClient(client, transport);
  const result = await client.callTool({
    name: "play_animation",
    arguments: { animation: "download_from_the_internet" },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(animations, []);
});

test("Persona MCP reports an inactive animation command without a model", async (context) => {
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: createPersonaMcpHandler({
      onAnimation: () => false,
      onWindowAction: () => false,
      getStatus: () => ({}),
      getAnimations: () => [
        {
          animation_name: "user-motion",
          animation_description: "A user-installed motion.",
          animation_trigger_scenario: "Use only after a model is configured.",
        },
      ],
    }),
  });
  const address = await bridge.listen();
  const client = new Client({ name: "persona-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${bridgePort(address)}/mcp`),
  );
  context.after(async () => {
    await client.close();
    await bridge.close();
  });

  await connectClient(client, transport);
  const result = await client.callTool({
    name: "play_animation",
    arguments: { animation: "user-motion" },
  });

  assert.equal(result.isError, true);
  assert.match(resultText(result), /model and at least one clip/);
});

interface RawMcpResponse {
  body: string;
  sessionId: string | null;
  status: number;
}

async function postMcp(
  port: number,
  payload: unknown,
  sessionId: string | null = null,
): Promise<RawMcpResponse> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(payload),
  });
  return {
    body: await response.text(),
    sessionId: response.headers.get("mcp-session-id"),
    status: response.status,
  };
}

function initializeRequest(clientName: string): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    },
  };
}

function toolsListRequest(): unknown {
  return { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
}

function sessionBridge(
  context: TestContext,
  options: PersonaMcpHandlerOptions,
): Promise<number> {
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: createPersonaMcpHandler(
      {
        onAnimation: () => true,
        onWindowAction: () => true,
        getStatus: () => ({}),
        getAnimations: () => [],
      },
      options,
    ),
  });
  context.after(() => bridge.close());
  return bridge.listen().then(bridgePort);
}

async function openSession(port: number, name: string): Promise<string> {
  const opened = await postMcp(port, initializeRequest(name));
  assert.equal(opened.status, 200, opened.body);
  assert.ok(opened.sessionId, "initialize did not return a session id");
  return opened.sessionId;
}

test("Persona MCP evicts the least recently used session at its ceiling", async (context) => {
  // A client that crashes or reconnects without DELETE leaves its session
  // behind. The endpoint is unauthenticated loopback, so the ceiling is what
  // stops those accumulating for the lifetime of the app.
  const port = await sessionBridge(context, { maxSessions: 3 });

  const first = await openSession(port, "first");
  const second = await openSession(port, "second");
  const third = await openSession(port, "third");

  // Touching the first makes the second the least recently used.
  assert.equal((await postMcp(port, toolsListRequest(), first)).status, 200);

  const fourth = await openSession(port, "fourth");

  assert.equal((await postMcp(port, toolsListRequest(), second)).status, 404);
  for (const live of [first, third, fourth]) {
    assert.equal(
      (await postMcp(port, toolsListRequest(), live)).status,
      200,
      "a live session must survive the eviction",
    );
  }
});

test("Persona MCP reaps sessions left idle past the timeout", async (context) => {
  let clock = 1_000;
  const port = await sessionBridge(context, {
    maxSessions: 8,
    now: () => clock,
    sessionIdleTimeoutMs: 60_000,
  });

  const abandoned = await openSession(port, "abandoned");
  clock += 30_000;
  const recent = await openSession(port, "recent");

  // Far enough that the first session is idle but the second is not.
  clock += 45_000;
  const opener = await openSession(port, "opener");

  assert.equal((await postMcp(port, toolsListRequest(), abandoned)).status, 404);
  assert.equal((await postMcp(port, toolsListRequest(), recent)).status, 200);
  assert.equal((await postMcp(port, toolsListRequest(), opener)).status, 200);
});

test("Persona MCP keeps a session alive while its client keeps using it", async (context) => {
  let clock = 1_000;
  const port = await sessionBridge(context, {
    maxSessions: 8,
    now: () => clock,
    sessionIdleTimeoutMs: 60_000,
  });
  const session = await openSession(port, "busy");

  for (let tick = 0; tick < 5; tick += 1) {
    clock += 45_000;
    assert.equal((await postMcp(port, toolsListRequest(), session)).status, 200);
  }

  clock += 45_000;
  await openSession(port, "other");
  assert.equal((await postMcp(port, toolsListRequest(), session)).status, 200);
});
