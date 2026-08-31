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
import type {
  CustomAnimationMetadata,
  PersonaAnimationGenerationJob,
  PersonaAnimationGenerationRequest,
  PersonaAnimationLibraryClip,
  PersonaAnimationSettings,
} from '../shared/persona-api.js';

const { version } = readPackageMetadata();

export const MCP_PATH = '/mcp';
export const WINDOW_ACTIONS = ['show', 'hide', 'toggle'] as const;
export type WindowAction = (typeof WINDOW_ACTIONS)[number];
export const SERVER_INSTRUCTIONS =
  'Persona controls the installed local desktop character. Use play_animation when the user asks for a visual reaction or it clearly supports their request. Call list_animations for actions and list_animation_clips for reusable clips. If the user explicitly asks to create a new motion, generate_animation can start an asynchronous job when enabled in Settings; poll get_animation_generation until the reusable clip is ready, then use create_animation_action or attach_animation_clip only when the user also asked to configure it. Use control_window to show, hide, or toggle Persona. Persona never speaks or plays audio. get_status, list_animations, list_animation_clips, and get_animation_generation are read-only.';

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
  getAnimationClips?: () => readonly PersonaAnimationLibraryClip[];
  onCreateAnimationAction?: (
    metadata: CustomAnimationMetadata,
    clipIds: readonly string[],
  ) => PersonaAnimationSettings | Promise<PersonaAnimationSettings>;
  onAttachAnimationClip?: (
    actionName: string,
    clipId: string,
  ) => PersonaAnimationSettings | Promise<PersonaAnimationSettings>;
  onGenerateAnimation?: (
    request: PersonaAnimationGenerationRequest,
  ) => PersonaAnimationGenerationJob | Promise<PersonaAnimationGenerationJob>;
  getAnimationGeneration?: (
    jobId: string,
  ) => PersonaAnimationGenerationJob | null | Promise<PersonaAnimationGenerationJob | null>;
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
  lastActiveAt: number;
  server: PersonaMcpServer;
  transport: StreamableHTTPServerTransport;
}

// A session is only released when its client sends DELETE or drops its stream.
// A client that crashes, is killed, or simply reconnects without closing leaves
// one behind, and the endpoint is reachable by anything on this machine, so the
// map needs its own ceiling rather than trusting clients to tidy up.
export const MAX_MCP_SESSIONS = 8;
export const MCP_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;

export interface PersonaMcpHandlerOptions {
  maxSessions?: number;
  now?: () => number;
  sessionIdleTimeoutMs?: number;
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

// The catalog belongs to the tool description and only there; repeating it here
// shipped the same paragraph to the model twice. The name stays deliberately
// unconstrained -- docs/INTEGRATIONS.md covers why the live check is the gate.
const ANIMATION_INPUT_SCHEMA = z
  .string()
  .regex(
    ANIMATION_NAME_PATTERN,
    'Animation names use lowercase letters, numbers, and single hyphens.',
  )
  .describe('The installed character action to play.');

export function createPersonaMcpServer({
  onAnimation,
  onWindowAction,
  getStatus,
  getAnimations = () => [],
  getAnimationClips = () => [],
  onCreateAnimationAction,
  onAttachAnimationClip,
  onGenerateAnimation,
  getAnimationGeneration,
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
        animation: ANIMATION_INPUT_SCHEMA,
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
    'list_animation_clips',
    {
      title: 'List Persona animation clips',
      description: 'Read reusable VRMA clips, their source prompts, and the actions currently linked to them.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => textResult(JSON.stringify(getAnimationClips())),
  );

  server.registerTool(
    'create_animation_action',
    {
      title: 'Create Persona animation action',
      description: 'Create one action with trigger and expression metadata, atomically linked to one or more reusable clip IDs. Use only when the user asks to add or configure an action.',
      inputSchema: {
        animation_name: z.string().regex(ANIMATION_NAME_PATTERN).max(48).describe('Unique lowercase action name.'),
        animation_description: z.string().min(1).max(240).describe('What the action looks like.'),
        animation_trigger_scenario: z.string().min(1).max(240).describe('When an agent should play the action.'),
        expression_name: z.string().min(1).max(120).nullable().optional().describe('Optional VRM expression applied with the clips.'),
        expression_weight: z.number().min(0).max(1).optional().describe('Expression strength from 0 to 1.'),
        clip_ids: z.array(z.string().uuid()).min(1).max(20).describe('Reusable clip IDs returned by list_animation_clips or a ready generation job.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ clip_ids, ...metadata }) => {
      if (!onCreateAnimationAction) {
        return { ...textResult('Animation action creation is not available in this Persona process.'), isError: true };
      }
      try {
        const action = await onCreateAnimationAction({
          ...metadata,
          expression_name: metadata.expression_name ?? null,
          expression_weight: metadata.expression_weight ?? 1,
        }, clip_ids);
        return textResult(JSON.stringify(action));
      } catch (error) {
        return { ...textResult(error instanceof Error ? error.message : String(error)), isError: true };
      }
    },
  );

  server.registerTool(
    'attach_animation_clip',
    {
      title: 'Attach Persona animation clip',
      description: 'Link one reusable clip to an existing action without copying or deleting the clip file.',
      inputSchema: {
        animation: ANIMATION_INPUT_SCHEMA,
        clip_id: z.string().uuid().describe('Reusable clip ID returned by list_animation_clips or a ready generation job.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ animation, clip_id }) => {
      if (!onAttachAnimationClip) {
        return { ...textResult('Animation clip linking is not available in this Persona process.'), isError: true };
      }
      try {
        return textResult(JSON.stringify(await onAttachAnimationClip(animation, clip_id)));
      } catch (error) {
        return { ...textResult(error instanceof Error ? error.message : String(error)), isError: true };
      }
    },
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

  server.registerTool(
    'generate_animation',
    {
      title: 'Generate Persona animation',
      description:
        'Start one asynchronous local Kimodo motion-generation job and save the result as a reusable Persona clip. This is only available after the user enables Kimodo and agent generation in Settings. Use get_animation_generation to follow progress.',
      inputSchema: {
        prompt: z.string().min(1).max(4096).describe('A concrete description of the body motion to generate.'),
        clip_name: z.string().regex(ANIMATION_NAME_PATTERN).max(64).optional().describe('Optional lowercase clip title. Persona derives one from the prompt if omitted.'),
        frames: z.number().int().min(60).max(150).optional().describe('Motion length at 30 FPS. Defaults to 150 frames.'),
        steps: z.number().int().min(1).max(1000).optional().describe('Diffusion steps. Persona defaults to a resource-conscious 50.'),
        seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Optional deterministic Kimodo seed.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (request) => {
      if (!onGenerateAnimation) {
        return { ...textResult('Animation generation is not available in this Persona process.'), isError: true };
      }
      try {
        const job = await onGenerateAnimation({
          prompt: request.prompt,
          ...(request.clip_name === undefined ? {} : { clip_name: request.clip_name }),
          ...(request.frames === undefined ? {} : { frames: request.frames }),
          ...(request.steps === undefined ? {} : { steps: request.steps }),
          ...(request.seed === undefined ? {} : { seed: request.seed }),
        });
        return textResult(JSON.stringify(job));
      } catch (error) {
        return {
          ...textResult(error instanceof Error ? error.message : String(error)),
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'get_animation_generation',
    {
      title: 'Get animation generation',
      description:
        'Read the current phase of a Persona animation-generation job. A ready job includes clip_id for the reusable VRMA clip installed in Persona.',
      inputSchema: {
        job_id: z.string().uuid().describe('The Persona generation job id returned by generate_animation.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id }) => {
      const job = await getAnimationGeneration?.(job_id);
      if (!job) {
        return { ...textResult('Animation generation job was not found.'), isError: true };
      }
      return textResult(JSON.stringify(job));
    },
  );

  const refreshAnimationCatalog = (): void => {
    animationTool.update({
      description: animationToolDescription(getAnimations()),
    });
  };

  return Object.assign(server, { refreshAnimationCatalog });
}

export function createPersonaMcpHandler(
  controller: PersonaMcpController,
  {
    maxSessions = MAX_MCP_SESSIONS,
    now = Date.now,
    sessionIdleTimeoutMs = MCP_SESSION_IDLE_TIMEOUT_MS,
  }: PersonaMcpHandlerOptions = {},
): PersonaMcpHandler {
  const sessions = new Map<string, McpSession>();

  function evictSession(evictedSessionId: string): void {
    const evicted = sessions.get(evictedSessionId);
    if (!evicted) return;
    sessions.delete(evictedSessionId);
    // The transport's onclose also deletes by id, which is a no-op by now.
    void evicted.server.close().catch(() => {
      // An already-broken session has nothing left to fail at.
    });
  }

  /**
   * Makes room for one more session: first anything idle past the timeout,
   * then the least recently used until the map is back under its ceiling.
   *
   * Evicting the oldest rather than refusing the newest is deliberate. Both
   * lose a session when the endpoint is busy, but the realistic cause is a
   * client that keeps reconnecting without closing, and this keeps the live
   * client working while the abandoned sessions are the ones reaped.
   */
  function reapSessions(): void {
    const idleCutoff = now() - sessionIdleTimeoutMs;
    for (const [candidateId, candidate] of sessions) {
      if (candidate.lastActiveAt <= idleCutoff) evictSession(candidateId);
    }
    while (sessions.size >= maxSessions) {
      let oldestId: string | null = null;
      let oldestActiveAt = Infinity;
      for (const [candidateId, candidate] of sessions) {
        if (candidate.lastActiveAt < oldestActiveAt) {
          oldestActiveAt = candidate.lastActiveAt;
          oldestId = candidateId;
        }
      }
      if (oldestId == null) break;
      evictSession(oldestId);
    }
  }

  const handler = async (
    request: IncomingMessage,
    response: ServerResponse,
    parsedBody: unknown,
  ): Promise<void> => {
    const header = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (session) session.lastActiveAt = now();
    try {
      if (
        !session &&
        !sessionId &&
        request.method === 'POST' &&
        isInitializeRequest(parsedBody)
      ) {
        reapSessions();
        const server = createPersonaMcpServer(controller);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (initializedSessionId: string) => {
            sessions.set(initializedSessionId, {
              lastActiveAt: now(),
              server,
              transport,
            });
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
