import { describeMcpTool, MCP_TOOL_NAMES } from '../../mcp-tool-catalog';

interface McpSectionProps {
  copyText: (value: string, label: string) => Promise<void>;
  mcpHealth: PersonaMcpStatus['health'];
  mcpLoading: boolean;
  mcpServerUrl: string;
  mcpSetupCommand: string;
  mcpStatus: PersonaMcpStatus | null;
  refreshMcpStatus: () => Promise<void>;
}

export function McpSection({
  copyText,
  mcpHealth,
  mcpLoading,
  mcpServerUrl,
  mcpSetupCommand,
  mcpStatus,
  refreshMcpStatus,
}: McpSectionProps) {
  return (
    <>
      <section className="settings-panel mcp-overview-panel">
        <div className="panel-heading">
          <div>
            <h2>Local MCP server</h2>
            <p>
              Connect compatible agents to Persona&apos;s character
              controls and configured animation actions.
            </p>
          </div>
          <span className={`mcp-health-badge ${mcpHealth}`}>
            <i aria-hidden="true" />
            {mcpHealth === 'online'
              ? 'Online'
              : mcpHealth === 'starting'
                ? 'Starting'
                : 'Unavailable'}
          </span>
        </div>

        <div className="mcp-status-grid">
          <article>
            <span>Health</span>
            <strong>
              {mcpHealth === 'online'
                ? 'Ready'
                : mcpHealth === 'starting'
                  ? 'Starting'
                  : 'Not running'}
            </strong>
            <small>
              {mcpStatus?.checked_at
                ? `Checked ${new Date(
                    mcpStatus.checked_at,
                  ).toLocaleTimeString()}`
                : 'Waiting for the desktop bridge'}
            </small>
          </article>
          <article>
            <span>Transport</span>
            <strong>{mcpStatus?.transport ?? 'Streamable HTTP'}</strong>
            <small>Model Context Protocol</small>
          </article>
          <article>
            <span>Access</span>
            <strong>
              {mcpStatus?.local_only === false
                ? 'Network'
                : 'Local only'}
            </strong>
            <small>Bound to 127.0.0.1</small>
          </article>
          <article>
            <span>Persona</span>
            <strong>v{mcpStatus?.version ?? '—'}</strong>
            <small>Server version</small>
          </article>
        </div>

        {mcpStatus?.error && (
          <p className="mcp-error-message" role="alert">
            {mcpStatus.error}
          </p>
        )}
      </section>

      <section className="settings-panel mcp-endpoint-panel">
        <div className="panel-heading">
          <div>
            <h2>Server endpoint</h2>
            <p>
              Persona serves this endpoint while the desktop app is
              open.
            </p>
          </div>
          <button
            className="secondary-button"
            disabled={mcpLoading}
            onClick={() => void refreshMcpStatus()}
            type="button"
          >
            {mcpLoading ? 'Checking…' : 'Check health'}
          </button>
        </div>

        <div className="mcp-copy-field">
          <div>
            <span>Server URL</span>
            <code>{mcpServerUrl}</code>
          </div>
          <button
            className="secondary-button"
            onClick={() => void copyText(mcpServerUrl, 'Server URL')}
            type="button"
          >
            Copy
          </button>
        </div>

        <div className="mcp-copy-field">
          <div>
            <span>Codex setup command</span>
            <code>{mcpSetupCommand}</code>
          </div>
          <button
            className="secondary-button"
            onClick={() =>
              void copyText(mcpSetupCommand, 'Setup command')
            }
            type="button"
          >
            Copy
          </button>
        </div>

        <p className="desktop-note">
          To use a different port, set{' '}
          <code>PERSONA_BRIDGE_PORT</code> before launching Persona and
          register the displayed URL.
        </p>
      </section>

      <section className="settings-panel">
        <div className="panel-heading">
          <div>
            <h2>Available tools</h2>
            <p>
              Tools are exposed without filesystem, transcript, or raw
              audio access.
            </p>
          </div>
          <span className="file-pill">
            {mcpStatus?.tools.length ?? 4} tools
          </span>
        </div>
        <div className="mcp-tool-list">
          {(mcpStatus?.tools ?? MCP_TOOL_NAMES).map((tool) => (
            <article key={tool}>
              <code>{tool}</code>
              <p>{describeMcpTool(tool)}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="settings-panel">
        <div className="panel-heading">
          <div>
            <h2>Playable actions</h2>
            <p>
              Actions appear in the MCP animation tool after they have
              at least one VRMA clip.
            </p>
          </div>
          <span className="file-pill">
            {mcpStatus?.playable_actions.length ?? 0} active
          </span>
        </div>
        {mcpStatus && mcpStatus.playable_actions.length > 0 ? (
          <div className="mcp-action-list">
            {mcpStatus.playable_actions.map((action) => (
              <code key={action}>{action}</code>
            ))}
          </div>
        ) : (
          <div className="empty-library">
            <strong>No playable actions detected</strong>
            <p>
              Add a VRMA clip to an action, then check the server again.
            </p>
          </div>
        )}
        <p className="mcp-session-note">
          Start a new Codex session after registering Persona. Changes
          to installed actions are published to connected sessions
          automatically.
        </p>
      </section>
    </>
  );
}
