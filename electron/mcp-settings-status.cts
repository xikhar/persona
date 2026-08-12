import { readPackageMetadata } from './package-metadata.cjs';
import type { SettingsSnapshotLike } from './types.cjs';
import type { PersonaMcpStatus } from '../shared/persona-api.js';

const { version } = readPackageMetadata();

export const MCP_TOOL_NAMES = Object.freeze([
  "play_animation",
  "list_animations",
  "control_window",
  "get_status",
]);
export const MCP_TRANSPORT = 'Streamable HTTP';

export type McpHealth = 'starting' | 'online' | 'unavailable';

export interface McpSettingsStatusOptions {
  error?: string | null;
  health: McpHealth;
  port: number;
  settingsSnapshot?: SettingsSnapshotLike | null;
}

export function createMcpSettingsStatus({
  error = null,
  health,
  port,
  settingsSnapshot,
}: McpSettingsStatusOptions): PersonaMcpStatus {
  if (!["starting", "online", "unavailable"].includes(health)) {
    throw new Error("MCP health state is invalid.");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("MCP server port is invalid.");
  }

  const serverUrl = `http://127.0.0.1:${port}/mcp`;
  const playableActions = (settingsSnapshot?.animations ?? [])
    .filter(
      (animation) =>
        Array.isArray(animation.asset_urls) && animation.asset_urls.length > 0,
    )
    .map((animation) => animation.animation_name);

  return {
    checked_at: new Date().toISOString(),
    error: typeof error === "string" && error.length > 0 ? error : null,
    health,
    health_url: `http://127.0.0.1:${port}/health`,
    local_only: true,
    playable_actions: playableActions,
    server_url: serverUrl,
    setup_command: `codex mcp add persona --url ${serverUrl}`,
    tools: [...MCP_TOOL_NAMES],
    transport: MCP_TRANSPORT,
    version,
  };
}
