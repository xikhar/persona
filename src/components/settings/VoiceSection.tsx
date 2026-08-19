import {
  voicePatternRisk,
  voicePatternRiskMessage,
} from '../../voice-pattern-risk';

interface VoiceSectionProps {
  bridge: Window['personaSettings'];
  busy: boolean;
  chooseApplicationSource: (source: PersonaVoiceSource) => void;
  chooseVoiceMode: (mode: PersonaVoiceSourceSettings['mode']) => void;
  copyText: (value: string, label: string) => Promise<void>;
  listenerStatus: AudioListenerStatus | null | undefined;
  refreshVoiceSources: () => Promise<void>;
  saveCustomVoiceSource: () => void;
  selectedVoiceSourceAvailable: boolean;
  setVoiceMode: (mode: PersonaVoiceSourceSettings['mode']) => void;
  setVoicePattern: (pattern: string) => void;
  setVoiceSourceSearch: (search: string) => void;
  settings: PersonaSettingsSnapshot;
  visibleVoiceSources: readonly PersonaVoiceSource[];
  voiceCatalog: PersonaVoiceSourceCatalog | null;
  voiceHeading: string;
  voiceMode: PersonaVoiceSourceSettings['mode'];
  voicePattern: string;
  voiceSourceDirty: boolean;
  voiceSourceSearch: string;
  voiceSourcesLoading: boolean;
}

export function VoiceSection({
  bridge,
  busy,
  chooseApplicationSource,
  chooseVoiceMode,
  copyText,
  listenerStatus,
  refreshVoiceSources,
  saveCustomVoiceSource,
  selectedVoiceSourceAvailable,
  setVoiceMode,
  setVoicePattern,
  setVoiceSourceSearch,
  settings,
  visibleVoiceSources,
  voiceCatalog,
  voiceHeading,
  voiceMode,
  voicePattern,
  voiceSourceDirty,
  voiceSourceSearch,
  voiceSourcesLoading,
}: VoiceSectionProps) {
  const patternRisk = voicePatternRisk(voicePattern);
  const patternWarning = voicePatternRiskMessage(patternRisk);

  return (
    <>
      <section className="settings-panel voice-source-panel">
        <div className="panel-heading">
          <div>
            <h2>Choose a voice source</h2>
            <p>
              Persona observes output from one voice application and
              turns its volume into animation and lip sync.
            </p>
          </div>
        </div>

        <div
          aria-label="Voice source mode"
          className="voice-mode-grid"
          role="group"
        >
          <button
            aria-pressed={voiceMode === 'default'}
            data-testid="voice-mode-default"
            disabled={busy || !bridge}
            onClick={() => chooseVoiceMode('default')}
            type="button"
          >
            <span className="voice-mode-icon" aria-hidden="true">
              A
            </span>
            <strong>Automatic</strong>
            <small>Detect ChatGPT or Codex output.</small>
          </button>
          <button
            aria-pressed={voiceMode === 'application'}
            data-testid="voice-mode-application"
            disabled={busy || !bridge}
            onClick={() => setVoiceMode('application')}
            type="button"
          >
            <span className="voice-mode-icon" aria-hidden="true">
              ◎
            </span>
            <strong>Application</strong>
            <small>Pick a running app or playback stream.</small>
          </button>
          <button
            aria-pressed={voiceMode === 'custom'}
            data-testid="voice-mode-custom"
            disabled={busy || !bridge}
            onClick={() => setVoiceMode('custom')}
            type="button"
          >
            <span className="voice-mode-icon" aria-hidden="true">
              .*
            </span>
            <strong>Advanced</strong>
            <small>Match processes with a regular expression.</small>
          </button>
          <button
            aria-pressed={voiceMode === 'external'}
            data-testid="voice-mode-external"
            disabled={busy || !bridge}
            onClick={() => chooseVoiceMode('external')}
            type="button"
          >
            <span className="voice-mode-icon" aria-hidden="true">
              ↗
            </span>
            <strong>External</strong>
            <small>Receive levels directly from a pipeline.</small>
          </button>
        </div>
      </section>

      {voiceMode === 'application' && (
        <section className="settings-panel voice-application-panel">
          <div className="panel-heading">
            <div>
              <h2>Application output</h2>
              <p>
                {voiceCatalog?.platform === 'linux'
                  ? 'Play audio in the target app, then select its PipeWire playback stream.'
                  : 'Start the target voice app, then select its running process.'}
              </p>
            </div>
            <button
              className="secondary-button"
              disabled={voiceSourcesLoading || !bridge}
              onClick={() => void refreshVoiceSources()}
              type="button"
            >
              {voiceSourcesLoading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          <label className="voice-source-search">
            <span>Filter applications</span>
            <input
              onChange={(event) =>
                setVoiceSourceSearch(event.currentTarget.value)
              }
              placeholder="Search by application, executable, or stream"
              type="search"
              value={voiceSourceSearch}
            />
          </label>

          {!voiceSourcesLoading &&
            voiceCatalog &&
            settings.voice_source.mode === 'application' &&
            !selectedVoiceSourceAvailable && (
              <div className="voice-saved-source">
                <div>
                  <strong>
                    {settings.voice_source.source_name ??
                      'Saved application'}
                  </strong>
                  <small>Not currently running</small>
                </div>
                <span className="source-state unavailable">
                  Unavailable
                </span>
              </div>
            )}

          <div className="voice-source-list">
            {visibleVoiceSources.map((source) => {
              const selected =
                settings.voice_source.mode === 'application' &&
                settings.voice_source.source_id === source.id;
              return (
                <button
                  aria-pressed={selected}
                  disabled={busy || !bridge}
                  key={source.id}
                  onClick={() => chooseApplicationSource(source)}
                  type="button"
                >
                  <span className="source-app-mark" aria-hidden="true">
                    {source.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="source-copy">
                    <strong>{source.name}</strong>
                    <small>{source.detail}</small>
                  </span>
                  <span
                    className={`source-state ${
                      selected ? 'selected' : ''
                    }`}
                  >
                    {selected ? 'Selected' : 'Available'}
                  </span>
                </button>
              );
            })}
          </div>

          {voiceCatalog?.error && (
            <p className="mcp-error-message" role="alert">
              {voiceCatalog.error}
            </p>
          )}

          {!voiceSourcesLoading &&
            voiceCatalog &&
            !voiceCatalog?.error &&
            visibleVoiceSources.length === 0 && (
              <div className="empty-library">
                <strong>No matching voice sources</strong>
                <p>
                  {voiceCatalog?.platform === 'linux'
                    ? 'Start playback in the target application and refresh the list.'
                    : 'Start the target application and refresh the list.'}
                </p>
              </div>
            )}
        </section>
      )}

      {voiceMode === 'custom' && (
        <section className="settings-panel voice-pattern-panel">
          <div className="panel-heading">
            <div>
              <h2>Advanced process pattern</h2>
              <p>
                Match output applications that are unavailable or
                ambiguous in the application picker.
              </p>
            </div>
          </div>
          <label className="voice-pattern-field">
            <span>Process pattern</span>
            <input
              aria-label="Custom voice process pattern"
              data-testid="voice-process-pattern"
              disabled={busy || !bridge}
              onChange={(event) =>
                setVoicePattern(event.currentTarget.value)
              }
              placeholder="my-voice-app|local-tts"
              spellCheck={false}
              type="text"
              value={voicePattern}
            />
          </label>
          {patternWarning && (
            <p className="voice-pattern-warning" role="status">
              {patternWarning}
            </p>
          )}
          <p className="theme-note">
            The expression is case-insensitive and works across Linux,
            macOS, and Windows. Persona matches it on its main thread while
            it looks for the voice source, so keep it simple — a plain
            substring or alternation like <code>my-voice-app|my-tts</code>.{' '}
            <code>PERSONA_TARGET_PROCESS_PATTERN</code> overrides
            automatic and advanced matching when set.
          </p>
          <div className="panel-actions">
            <button
              className="primary-button"
              data-testid="voice-source-save"
              disabled={
                busy ||
                !bridge ||
                !voiceSourceDirty ||
                !voicePattern.trim() ||
                patternRisk === 'invalid'
              }
              onClick={saveCustomVoiceSource}
              type="button"
            >
              Save pattern
            </button>
          </div>
        </section>
      )}

      {voiceMode === 'external' && (
        <section className="settings-panel voice-external-panel">
          <div className="panel-heading">
            <div>
              <h2>External voice pipeline</h2>
              <p>
                Send normalized state and output levels directly from
                the component that plays generated speech.
              </p>
            </div>
          </div>
          <div className="mcp-copy-field">
            <div>
              <span>Events endpoint</span>
              <code>
                {voiceCatalog?.events_url ??
                  'http://127.0.0.1:47831/events'}
              </code>
            </div>
            <button
              className="secondary-button"
              onClick={() =>
                void copyText(
                  voiceCatalog?.events_url ??
                    'http://127.0.0.1:47831/events',
                  'Events endpoint',
                )
              }
              type="button"
            >
              Copy
            </button>
          </div>
          <p className="desktop-note">
            External mode disables automatic capture. Persona receives
            only speaking state and a normalized level; raw audio and
            transcripts remain in your pipeline.
          </p>
        </section>
      )}

      <section className="settings-panel voice-status-panel">
        <div className="panel-heading">
          <div>
            <h2>Listener status</h2>
            <p>Current state of the local voice integration.</p>
          </div>
          <button
            className="secondary-button"
            disabled={voiceSourcesLoading || !bridge}
            onClick={() => void refreshVoiceSources()}
            type="button"
          >
            Check status
          </button>
        </div>
        <div className="voice-status-grid">
          <article>
            <span>Mode</span>
            <strong>{voiceHeading}</strong>
            <small>
              {settings.voice_source.mode === 'custom'
                ? settings.voice_source.process_pattern
                : settings.voice_source.mode === 'external'
                  ? 'Loopback event API'
                  : settings.voice_source.source_name ??
                    'ChatGPT and Codex'}
            </small>
          </article>
          <article>
            <span>Status</span>
            <strong>
              {settings.voice_source.mode === 'external'
                ? 'Waiting for events'
                : listenerStatus?.capturing
                  ? 'Receiving audio'
                  : listenerStatus?.monitoring
                    ? 'Monitoring'
                    : 'Not active'}
            </strong>
            <small>
              {listenerStatus?.error ??
                listenerStatus?.source ??
                'No active output stream'}
            </small>
          </article>
          <article>
            <span>Available</span>
            <strong>{voiceCatalog?.sources.length ?? 0}</strong>
            <small>
              {voiceCatalog?.platform === 'linux'
                ? 'PipeWire playback streams'
                : 'Running applications'}
            </small>
          </article>
        </div>
      </section>
    </>
  );
}
