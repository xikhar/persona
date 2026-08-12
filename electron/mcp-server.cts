import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import {
  ANIMATION_NAME_PATTERN,
  describeAnimations,
  type PackagedAnimation,
} from './library-catalog.cjs';
import { readPackageMetadata } from './package-metadata.cjs';
import { McpTransportAdapter } from './mcp-transport.cjs';

const { version } = readPackageMetadata();

export const MCP_PATH = '/mcp';
export const WINDOW_ACTIONS = ['show', 'hide', 'toggle'] as const;
export type WindowAction = (typeof WINDOW_ACTIONS)[number];
export const SERVER_INSTRUCTIONS =
  'Persona controls the installed local desktop character. Use play_animation when the user asks for a visual reaction or it clearly supports their request. Call list_animations when you need the current action catalog. Use control_window to show, hide, or toggle Persona. Persona never speaks or plays audio. get_status and list_animations are read-only.';

type PlayableAnimation = Pick<
  PackagedAnimation,
  | 'animation_name'
  | 'animation_description'
  | 'animation_trigger_scenario'
>;

export interface PersonaMcpController {
  onAnimation: (animationName: string) => boolean | Promise<boolean>;
  onWindowAction: (action: WindowAction) => boolean | Promise<boolean>;
  getStatus: () => unknown | Promise<unknown>;
  getAnimations?: () => readonly PlayableAnimation[];
}

export interface PersonaMcpServer extends McpServer {
  refreshAnimationCatalog(): void;
}

export interface PersonaMcpHandler {
  (
    request: IncomingMessage,
    response: ServerResponse,
    parsedBody: unknown,
  ): Promise<void>;
  notifyToolsChanged(): void;
  close(): Promise<void>;
}

interface McpSession {
  server: PersonaMcpServer;
  transport: StreamableHTTPServerTransport;
}

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

function animationToolDescription(
  animations: readonly PlayableAnimation[],
): string {
  return [
    'Play one randomly selected clip from an installed character action. This shows Persona and temporarily takes priority over voice-driven body motion.',
    'Playable actions:',
    describeAnimations(animations),
  ].join('\n');
}

function animationInputSchema(animations: readonly PlayableAnimation[]) {
  return z
    .string()
    .regex(
      ANIMATION_NAME_PATTERN,
      'Animation names use lowercase letters, numbers, and single hyphens.',
    )
    .describe(
      `The installed character action to play.\n${describeAnimations(animations)}`,
    );
}

export function createPersonaMcpServer({
  onAnimation,
  onWindowAction,
  getStatus,
  getAnimations = () => [],
}: PersonaMcpController): PersonaMcpServer {
  const animations = getAnimations();
  const server = new McpServer(
    {
      name: 'Persona',
      version,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  const animationTool = server.registerTool(
    'play_animation',
    {
      title: 'Play Persona animation',
      description: animationToolDescription(animations),
      inputSchema: {
        animation: animationInputSchema(animations),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ animation }) => {
      const installed = getAnimations().some(
        (candidate) => candidate.animation_name === animation,
      );
      if (!installed) {
        return {
          ...textResult(
            `The ${animation} action is not currently playable. Call list_animations for the latest action catalog.`,
          ),
          isError: true,
        };
      }
      const played = await onAnimation(animation);
      if (played === false) {
        return {
          ...textResult(
            'Persona cannot play that action until a model and at least one clip are configured.',
          ),
          isError: true,
        };
      }
      return textResult(`Persona is playing the ${animation} action.`);
    },
  );

  server.registerTool(
    'list_animations',
    {
      title: 'List Persona animations',
      description:
        'Read the current playable Persona action names, descriptions, and trigger scenarios. The result reflects Settings changes immediately.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => textResult(describeAnimations(getAnimations())),
  );

  server.registerTool(
    'control_window',
    {
      title: 'Control Persona window',
      description:
        'Show, hide, or toggle the local Persona window. Hiding the window does not quit Persona.',
      inputSchema: {
        action: z.enum(WINDOW_ACTIONS).describe('The window action to perform.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ action }) => {
      const visible = await onWindowAction(action);
      return textResult(
        `Persona's window is now ${visible ? 'visible' : 'hidden'}.`,
      );
    },
  );

  server.registerTool(
    'get_status',
    {
      title: 'Get Persona status',
      description:
        "Read Persona's window visibility, voice state, and local listener status.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => textResult(JSON.stringify(await getStatus())),
  );

  const refreshAnimationCatalog = (): void => {
    const currentAnimations = getAnimations();
    animationTool.update({
      description: animationToolDescription(currentAnimations),
      paramsSchema: {
        animation: animationInputSchema(currentAnimations),
      },
    });
  };

  return Object.assign(server, { refreshAnimationCatalog });
}

export function createPersonaMcpHandler(
  controller: PersonaMcpController,
): PersonaMcpHandler {
  const sessions = new Map<string, McpSession>();

  const handler = async (
    request: IncomingMessage,
    response: ServerResponse,
    parsedBody: unknown,
  ): Promise<void> => {
    const header = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    let session = sessionId ? sessions.get(sessionId) : undefined;
    try {
      if (
        !session &&
        !sessionId &&
        request.method === 'POST' &&
        isInitializeRequest(parsedBody)
      ) {
        const server = createPersonaMcpServer(controller);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (initializedSessionId: string) => {
            session = { server, transport };
            sessions.set(initializedSessionId, session);
          },
        });
        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId) sessions.delete(closedSessionId);
        };
        await server.connect(new McpTransportAdapter(transport));
        await transport.handleRequest(request, response, parsedBody);
        return;
      }

      if (!session) {
        response.writeHead(sessionId ? 404 : 400, {
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: sessionId
                ? 'MCP session not found'
                : 'MCP session ID is required',
            },
            id: null,
          }),
        );
        return;
      }

      await session.transport.handleRequest(request, response, parsedBody);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      }
      throw error;
    }
  };

  const notifyToolsChanged = (): void => {
    for (const { server } of sessions.values()) {
      server.refreshAnimationCatalog();
    }
  };

  const close = async (): Promise<void> => {
    const activeSessions = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(
      activeSessions.map(({ server }) => server.close()),
    );
  };

  return Object.assign(handler, { close, notifyToolsChanged });
}
