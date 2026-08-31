import { MillisecondRangeSlider } from './MillisecondRangeSlider';
import { singleRangeStyle } from '../../range-slider';

interface DeveloperSectionProps {
  bridge: Window['personaSettings'];
  busy: boolean;
  developerSettingsModified: boolean;
  previewBodyTransitionMs: (value: number) => void;
  previewIdleInterimMs: (value: number) => void;
  previewSpeakingDebounceMs: (value: number) => void;
  previewSpeakingTransition: (
    field: keyof PersonaSpeakingTransitionSettings,
    range: readonly [number, number],
  ) => void;
  previewVroidHubPlaintextStorageAllowed: (allowed: boolean) => void;
  requestDeveloperSettingsAccess: () => void;
  resetDeveloperSettings: () => void;
  saveBodyTransitionMs: (value: number) => Promise<void>;
  saveIdleInterimMs: (value: number) => Promise<void>;
  saveSpeakingDebounceMs: (value: number) => Promise<void>;
  saveSpeakingTransition: (
    field: keyof PersonaSpeakingTransitionSettings,
    range: readonly [number, number],
  ) => Promise<void>;
  saveVroidHubPlaintextStorageAllowed: (allowed: boolean) => Promise<void>;
  settings: PersonaSettingsSnapshot;
}

export function DeveloperSection({
  bridge,
  busy,
  developerSettingsModified,
  previewBodyTransitionMs,
  previewIdleInterimMs,
  previewSpeakingDebounceMs,
  previewSpeakingTransition,
  previewVroidHubPlaintextStorageAllowed,
  requestDeveloperSettingsAccess,
  resetDeveloperSettings,
  saveBodyTransitionMs,
  saveIdleInterimMs,
  saveSpeakingDebounceMs,
  saveSpeakingTransition,
  saveVroidHubPlaintextStorageAllowed,
  settings,
}: DeveloperSectionProps) {
  return (
    <>
      {!settings.developer_settings_enabled ? (
        <section className="settings-panel developer-lock-panel">
          <div className="developer-lock-icon" aria-hidden="true">
            !
          </div>
          <div>
            <span className="eyebrow">Advanced controls</span>
            <h2>Developer settings are locked</h2>
            <p>
              These values tune low-level animation behavior. Incorrect
              values can make movement look unstable or unnatural.
            </p>
            <button
              className="btn btn-primary"
              disabled={busy || !bridge}
              onClick={requestDeveloperSettingsAccess}
              type="button"
            >
              Enable developer settings
            </button>
          </div>
        </section>
      ) : (
        <>
          <section className="settings-panel developer-overview-panel">
            <div className="panel-heading">
              <div>
                <h2>Developer settings</h2>
                <p>
                  Experimental controls for tuning Persona's runtime
                  behavior.
                </p>
              </div>
              <button
                className="btn btn-secondary"
                disabled={
                  busy || !bridge || !developerSettingsModified
                }
                onClick={resetDeveloperSettings}
                type="button"
              >
                Reset developer settings
              </button>
            </div>
          </section>

          <section className="settings-panel lighting-panel">
            <div className="panel-heading">
              <div>
                <h2>Animation scheduler</h2>
                <p>
                  Tune speaking pause handling and the transition
                  profile used for speaking chunks and agent-triggered
                  animations.
                </p>
              </div>
            </div>

            <div className="lighting-toggle-row">
              <span>VRoid Hub Linux override</span>
              <button
                aria-checked={settings.vroid_hub_allow_plaintext_storage}
                className={`toggle-switch${settings.vroid_hub_allow_plaintext_storage ? ' active' : ''}`}
                disabled={busy || !bridge}
                onClick={() => {
                  const next =
                    !settings.vroid_hub_allow_plaintext_storage;
                  previewVroidHubPlaintextStorageAllowed(next);
                  void saveVroidHubPlaintextStorageAllowed(next);
                }}
                role="switch"
                type="button"
              />
            </div>
            <p className="theme-note">
              On Linux, this allows VRoid Hub authentication to keep
              working even when Electron falls back to plaintext
              credential storage. Leave it off to require a secure
              keyring backend.
            </p>

            {(
              [
                ['entry_ms', 'Chunk / action entry transition'],
                ['exit_ms', 'Chunk / action exit transition'],
              ] as const
            ).map(([field, label]) => (
              <div className="lighting-row" key={field}>
                <label>
                  <span>
                    {label}
                    <small className="transition-range-state">
                      {settings.speaking_transition[field][0] ===
                      settings.speaking_transition[field][1]
                        ? `${settings.speaking_transition[field][0]}ms fixed`
                        : `${settings.speaking_transition[field][0]}–${settings.speaking_transition[field][1]}ms random`}
                    </small>
                  </span>
                  <MillisecondRangeSlider
                    disabled={busy || !bridge}
                    label={label}
                    onCommit={(range) =>
                      void saveSpeakingTransition(field, range)
                    }
                    onPreview={(range) =>
                      previewSpeakingTransition(field, range)
                    }
                    value={settings.speaking_transition[field]}
                  />
                  <div className="slider-labels">
                    <span>45ms · Fast</span>
                    <span>1800ms</span>
                    <span>3600ms · Slow</span>
                  </div>
                </label>
              </div>
            ))}

            <div className="lighting-row">
              <label>
                <span>
                  Speaking debounce
                  <small className="transition-range-state">
                    {settings.speaking_debounce_ms}ms
                  </small>
                </span>
                <input
                  className="single-range-slider"
                  disabled={busy || !bridge}
                  max="3000"
                  min="0"
                  onChange={(event) =>
                    previewSpeakingDebounceMs(
                      Number(event.currentTarget.value),
                    )
                  }
                  onKeyUp={(event) => {
                    if (event.key.startsWith('Arrow')) {
                      void saveSpeakingDebounceMs(
                        Number(event.currentTarget.value),
                      );
                    }
                  }}
                  onPointerUp={(event) =>
                    void saveSpeakingDebounceMs(
                      Number(event.currentTarget.value),
                    )
                  }
                  step="50"
                  style={singleRangeStyle(
                    settings.speaking_debounce_ms,
                    0,
                    3000,
                  )}
                  type="range"
                  value={settings.speaking_debounce_ms}
                />
                <div className="slider-labels">
                  <span>0ms</span>
                  <span>350ms</span>
                  <span>3000ms</span>
                </div>
              </label>
            </div>

            <div className="lighting-row">
              <label>
                <span>
                  Idle interim
                  <small className="transition-range-state">
                    {settings.idle_interim_ms}ms
                  </small>
                </span>
                <input
                  className="single-range-slider"
                  disabled={busy || !bridge}
                  max="3000"
                  min="0"
                  onChange={(event) =>
                    previewIdleInterimMs(
                      Number(event.currentTarget.value),
                    )
                  }
                  onKeyUp={(event) => {
                    if (event.key.startsWith('Arrow')) {
                      void saveIdleInterimMs(
                        Number(event.currentTarget.value),
                      );
                    }
                  }}
                  onPointerUp={(event) =>
                    void saveIdleInterimMs(
                      Number(event.currentTarget.value),
                    )
                  }
                  step="50"
                  style={singleRangeStyle(
                    settings.idle_interim_ms,
                    0,
                    3000,
                  )}
                  type="range"
                  value={settings.idle_interim_ms}
                />
                <div className="slider-labels">
                  <span>0ms</span>
                  <span>350ms</span>
                  <span>3000ms</span>
                </div>
              </label>
            </div>

            <div className="lighting-row">
              <label>
                <span>
                  Body transition duration
                  <small className="transition-range-state">
                    {settings.body_transition_ms}ms
                  </small>
                </span>
                <input
                  className="single-range-slider"
                  disabled={busy || !bridge}
                  max="3000"
                  min="50"
                  onChange={(event) =>
                    previewBodyTransitionMs(
                      Number(event.currentTarget.value),
                    )
                  }
                  onKeyUp={(event) => {
                    if (event.key.startsWith('Arrow')) {
                      void saveBodyTransitionMs(
                        Number(event.currentTarget.value),
                      );
                    }
                  }}
                  onPointerUp={(event) =>
                    void saveBodyTransitionMs(
                      Number(event.currentTarget.value),
                    )
                  }
                  step="50"
                  style={singleRangeStyle(
                    settings.body_transition_ms,
                    50,
                    3000,
                  )}
                  type="range"
                  value={settings.body_transition_ms}
                />
                <div className="slider-labels">
                  <span>50ms · Fast</span>
                  <span>700ms</span>
                  <span>3000ms · Slow</span>
                </div>
              </label>
            </div>
          </section>
        </>
      )}
    </>
  );
}
