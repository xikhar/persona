import { describe, expect, it } from 'vitest';
import { describeMcpTool, MCP_TOOL_NAMES } from './mcp-tool-catalog';

describe('MCP tool catalog', () => {
  it('lists the tools the main process serves', () => {
    // Mirrors the tools registered in electron/mcp-server.cts. This list is
    // only shown before the live catalog arrives, so a drift here means the
    // section briefly advertises a tool Persona does not have.
    expect([...MCP_TOOL_NAMES].sort()).toEqual([
      'control_window',
      'get_status',
      'list_animations',
      'play_animation',
    ]);
  });

  it('describes every tool it lists', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(describeMcpTool(name)).not.toBe('Persona MCP tool');
    }
  });

  it('still lists a tool the running server added ahead of this table', () => {
    expect(describeMcpTool('some_future_tool')).toBe('Persona MCP tool');
  });
});
