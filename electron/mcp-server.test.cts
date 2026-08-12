import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createBridgeServer } from './bridge-server.cjs';
import {
  SERVER_INSTRUCTIONS,
  WINDOW_ACTIONS,
  createPersonaMcpHandler,
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
      "control_window",
      "get_status",
    ],
  );
  assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
  const animationTool = toolNamed(tools.tools, 'play_animation');
  const animationInput = toolInputProperty(animationTool, 'animation');
  assert.equal(animationInput.type, "string");
  assert.equal(animationInput.enum, undefined);
  assert.equal(typeof animationInput.description, 'string');
  assert.match(String(animationInput.description), /wave-hello/);
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

  assert.equal(toolInputProperty(tool, 'animation').enum, undefined);
  assert.match(
    String(toolInputProperty(tool, 'animation').description),
    /wave-hello/,
  );
  assert.match(toolDescription(tool), /A small friendly wave/);
  assert.match(toolDescription(tool), /Use when greeting the user/);
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
  assert.match(
    String(toolInputProperty(refreshedTool, 'animation').description),
    /finger-gun/,
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
