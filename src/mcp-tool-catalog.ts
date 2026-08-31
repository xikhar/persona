/**
 * Plain-language summaries for the tools the MCP section lists. The main
 * process reports the live tool names; these describe what each one does for a
 * reader deciding whether to connect an agent at all.
 */
const MCP_TOOL_DESCRIPTIONS: Record<string, string> = {
  play_animation: 'Play any configured action with at least one animation clip.',
  list_animations: 'Read the latest playable actions and their usage details.',
  list_animation_clips: 'Read reusable clips, generation prompts, and current action links.',
  create_animation_action: 'Create an action with trigger and expression metadata linked to reusable clips.',
  attach_animation_clip: 'Link a reusable clip to an existing action without duplicating its file.',
  control_window: 'Show, hide, or toggle the Persona character window.',
  get_status: 'Read window, model, voice, and listener readiness.',
  generate_animation: 'Start an asynchronous local Kimodo motion-generation job when the user has enabled it.',
  get_animation_generation: 'Read generation progress and learn when the reusable VRMA clip is ready.',
};

/** What the section lists before the main process has reported a live catalog. */
export const MCP_TOOL_NAMES: readonly string[] = Object.keys(
  MCP_TOOL_DESCRIPTIONS,
);

/**
 * A tool Persona ships gets its written description; anything else is still
 * listed, because the catalog comes from the running server and a tool added
 * there should never go unmentioned just because this table is behind.
 */
export function describeMcpTool(name: string): string {
  return MCP_TOOL_DESCRIPTIONS[name] ?? 'Persona MCP tool';
}
