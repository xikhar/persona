import { singleRangeStyle } from '../../range-slider';
import {
  MAX_AVATAR_WINDOW_HEIGHT,
  MAX_AVATAR_WINDOW_WIDTH,
  MIN_AVATAR_WINDOW_HEIGHT,
  MIN_AVATAR_WINDOW_WIDTH,
  type LightingNumberField,
} from '../../settings-defaults';
import { THEME_OPTIONS, type ThemePreference } from '../../theme';

interface AppearanceSectionProps {
  avatarHeightInput: string;
  avatarWidthInput: string;
  avatarWindowSizeChanged: boolean;
  avatarWindowSizeValid: boolean;
  bridge: Window['personaSettings'];
  busy: boolean;
  chooseTheme: (preference: ThemePreference) => void;
  previewCharacterSize: (size: number) => void;
  previewLighting: PersonaLightingSettings;
  previewLightingField: <Field extends keyof PersonaLightingSettings>(
    field: Field,
    value: PersonaLightingSettings[Field],
  ) => void;
  previewLightingNumber: (
    field: LightingNumberField,
    input: HTMLInputElement,
  ) => void;
  resetLighting: () => Promise<void>;
  saveAvatarWindowSize: () => Promise<void>;
  saveCharacterSize: (size: number) => Promise<void>;
  saveLightingField: <Field extends keyof PersonaLightingSettings>(
    field: Field,
    value: PersonaLightingSettings[Field],
  ) => Promise<void>;
  saveLightingNumber: (
    field: LightingNumberField,
    input: HTMLInputElement,
  ) => void;
  selectedModel: PersonaModelSettings | undefined;
  setAvatarHeightInput: (height: string) => void;
  setAvatarWidthInput: (width: string) => void;
  settings: PersonaSettingsSnapshot;
  themePreference: ThemePreference;
}

export function AppearanceSection({
  avatarHeightInput,
  avatarWidthInput,
  avatarWindowSizeChanged,
  avatarWindowSizeValid,
  bridge,
  busy,
  chooseTheme,
  previewCharacterSize,
  previewLighting,
  previewLightingField,
  previewLightingNumber,
  resetLighting,
  saveAvatarWindowSize,
  saveCharacterSize,
  saveLightingField,
  saveLightingNumber,
  selectedModel,
  setAvatarHeightInput,
  setAvatarWidthInput,
  settings,
  themePreference,
}: AppearanceSectionProps) {
  return (
    <>
      <section className="settings-panel theme-panel">
        <div className="panel-heading">
          <div>
            <h2>Theme</h2>
            <p>
              Sets how this settings window looks. The character overlay
              stays transparent in every theme.
            </p>
          </div>
        </div>
        <div
          aria-label="Theme"
          className="theme-segmented"
          role="group"
        >
          {THEME_OPTIONS.map((option) => (
            <button
              aria-pressed={themePreference === option.id}
              data-testid={`theme-${option.id}`}
              key={option.id}
              onClick={() => chooseTheme(option.id)}
              type="button"
            >
              <span
                aria-hidden="true"
                className="theme-swatch"
                data-theme-preview={option.id}
              />
              {option.label}
            </button>
          ))}
        </div>
        <p className="theme-note">
          System follows your desktop appearance and updates when it
          changes.
        </p>
      </section>

      <section className="settings-panel appearance-panel">
        <div className="panel-heading">
          <div>
            <h2>Default character size</h2>
            <p>
              Set how large Persona appears when a model is first framed.
              You can still zoom and pan the live avatar manually.
            </p>
          </div>
          <strong className="size-value">
            {Math.round(settings.character_size * 100)}%
          </strong>
        </div>
        <input
          aria-label="Default character size"
          className="single-range-slider size-slider"
          max="1.6"
          min="0.7"
          onBlur={(event) =>
            void saveCharacterSize(Number(event.currentTarget.value))
          }
          onChange={(event) =>
            previewCharacterSize(Number(event.currentTarget.value))
          }
          onKeyUp={(event) => {
            if (event.key.startsWith('Arrow')) {
              void saveCharacterSize(
                Number(event.currentTarget.value),
              );
            }
          }}
          onPointerUp={(event) =>
            void saveCharacterSize(Number(event.currentTarget.value))
          }
          step="0.05"
          style={singleRangeStyle(settings.character_size, 0.7, 1.6)}
          type="range"
          value={settings.character_size}
        />
        <div className="slider-labels">
          <span>70%</span>
          <span>Default</span>
          <span>160%</span>
        </div>
      </section>

      <section className="settings-panel appearance-panel">
        <div className="panel-heading">
          <div>
            <h2>Avatar window size</h2>
            <p>
              Set the pixel width and height of the Avatar window.
            </p>
          </div>
        </div>
        <div className="avatar-window-size-row">
          <label>
            Width
            <input
              aria-label="Avatar window width"
              max={MAX_AVATAR_WINDOW_WIDTH}
              min={MIN_AVATAR_WINDOW_WIDTH}
              onChange={(event) =>
                setAvatarWidthInput(event.currentTarget.value)
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveAvatarWindowSize();
              }}
              step="1"
              type="number"
              value={avatarWidthInput}
            />
          </label>
          <label>
            Height
            <input
              aria-label="Avatar window height"
              max={MAX_AVATAR_WINDOW_HEIGHT}
              min={MIN_AVATAR_WINDOW_HEIGHT}
              onChange={(event) =>
                setAvatarHeightInput(event.currentTarget.value)
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveAvatarWindowSize();
              }}
              step="1"
              type="number"
              value={avatarHeightInput}
            />
          </label>
        </div>
        <button
          className="primary-button"
          disabled={
            busy ||
            !bridge ||
            !avatarWindowSizeValid ||
            !avatarWindowSizeChanged
          }
          onClick={() => void saveAvatarWindowSize()}
          type="button"
        >
          Apply
        </button>
        {!bridge && (
          <p className="desktop-note">
            Resizing the avatar window is available in the Persona
            desktop app.
          </p>
        )}
      </section>

      <section className="settings-panel lighting-panel">
        <div className="panel-heading">
          <div>
            <h2>Lighting</h2>
            <p>
              Adjust environment and key light for VRM models that look
              overexposed or too dark.
            </p>
          </div>
          <button
            className="lighting-reset-button"
            disabled={busy || !bridge || !selectedModel}
            onClick={() => void resetLighting()}
            type="button"
          >
            Reset lighting
          </button>
        </div>

        <div className="lighting-select-row">
          <span>Tone mapping</span>
          <select
            disabled={busy || !bridge || !selectedModel}
            onChange={(e) => {
              const value = e.currentTarget.value as
                | 'none'
                | 'aces';
              previewLightingField('tone_mapping', value);
              void saveLightingField('tone_mapping', value);
            }}
            value={previewLighting.tone_mapping}
          >
            <option value="none">None</option>
            <option value="aces">ACES Filmic</option>
          </select>
        </div>

        <div className="lighting-toggle-row">
          <span>HDR environment</span>
          <button
            aria-checked={previewLighting.environment_enabled}
            className={`toggle-switch${previewLighting.environment_enabled ? ' active' : ''}`}
            disabled={busy || !bridge || !selectedModel}
            onClick={() => {
              const next = !previewLighting.environment_enabled;
              previewLightingField('environment_enabled', next);
              void saveLightingField('environment_enabled', next);
            }}
            role="switch"
            type="button"
          />
        </div>

        <div className="lighting-row">
          <label>
            <span>Environment intensity</span>
            <input
              className="single-range-slider"
              disabled={busy || !bridge || !selectedModel}
              max="2"
              min="0"
              onChange={(event) =>
                previewLightingNumber(
                  'environment_intensity',
                  event.currentTarget,
                )
              }
              onKeyUp={(event) =>
                saveLightingNumber(
                  'environment_intensity',
                  event.currentTarget,
                )
              }
              onPointerUp={(event) =>
                saveLightingNumber(
                  'environment_intensity',
                  event.currentTarget,
                )
              }
              step="0.01"
              style={singleRangeStyle(
                previewLighting.environment_intensity,
                0,
                2,
              )}
              type="range"
              value={previewLighting.environment_intensity}
            />
            <div className="slider-labels">
              <span>0.00</span>
              <span>1.00</span>
              <span>2.00</span>
            </div>
          </label>
          <input
            className="lighting-value"
            disabled={busy || !bridge || !selectedModel}
            max="2"
            min="0"
            onBlur={(event) =>
              saveLightingNumber(
                'environment_intensity',
                event.currentTarget,
              )
            }
            onChange={(event) =>
              previewLightingNumber(
                'environment_intensity',
                event.currentTarget,
              )
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            step="0.01"
            type="number"
            value={previewLighting.environment_intensity}
          />
        </div>

        <div className="lighting-row">
          <label>
            <span>Key light intensity</span>
            <input
              className="single-range-slider"
              disabled={busy || !bridge || !selectedModel}
              max="4"
              min="0"
              onChange={(event) =>
                previewLightingNumber(
                  'key_light_intensity',
                  event.currentTarget,
                )
              }
              onKeyUp={(event) =>
                saveLightingNumber(
                  'key_light_intensity',
                  event.currentTarget,
                )
              }
              onPointerUp={(event) =>
                saveLightingNumber(
                  'key_light_intensity',
                  event.currentTarget,
                )
              }
              step="0.01"
              style={singleRangeStyle(
                previewLighting.key_light_intensity,
                0,
                4,
              )}
              type="range"
              value={previewLighting.key_light_intensity}
            />
            <div className="slider-labels">
              <span>0.00</span>
              <span>{Math.PI.toFixed(2)}</span>
              <span>4.00</span>
            </div>
          </label>
          <input
            className="lighting-value"
            disabled={busy || !bridge || !selectedModel}
            max="4"
            min="0"
            onBlur={(event) =>
              saveLightingNumber(
                'key_light_intensity',
                event.currentTarget,
              )
            }
            onChange={(event) =>
              previewLightingNumber(
                'key_light_intensity',
                event.currentTarget,
              )
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            step="0.01"
            type="number"
            value={previewLighting.key_light_intensity}
          />
        </div>

        <div className="lighting-row">
          <label>
            <span>Ambient / fill intensity</span>
            <input
              className="single-range-slider"
              disabled={busy || !bridge || !selectedModel}
              max="4"
              min="0"
              onChange={(event) =>
                previewLightingNumber(
                  'ambient_intensity',
                  event.currentTarget,
                )
              }
              onKeyUp={(event) =>
                saveLightingNumber(
                  'ambient_intensity',
                  event.currentTarget,
                )
              }
              onPointerUp={(event) =>
                saveLightingNumber(
                  'ambient_intensity',
                  event.currentTarget,
                )
              }
              step="0.01"
              style={singleRangeStyle(
                previewLighting.ambient_intensity,
                0,
                4,
              )}
              type="range"
              value={previewLighting.ambient_intensity}
            />
            <div className="slider-labels">
              <span>0.00</span>
              <span>{Math.PI.toFixed(2)}</span>
              <span>4.00</span>
            </div>
          </label>
          <input
            className="lighting-value"
            disabled={busy || !bridge || !selectedModel}
            max="4"
            min="0"
            onBlur={(event) =>
              saveLightingNumber(
                'ambient_intensity',
                event.currentTarget,
              )
            }
            onChange={(event) =>
              previewLightingNumber(
                'ambient_intensity',
                event.currentTarget,
              )
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            step="0.01"
            type="number"
            value={previewLighting.ambient_intensity}
          />
        </div>

        <div className="lighting-row">
          <label>
            <span>Exposure</span>
            <input
              className="single-range-slider"
              disabled={busy || !bridge || !selectedModel}
              max="3"
              min="0.1"
              onChange={(event) =>
                previewLightingNumber(
                  'exposure',
                  event.currentTarget,
                )
              }
              onKeyUp={(event) =>
                saveLightingNumber(
                  'exposure',
                  event.currentTarget,
                )
              }
              onPointerUp={(event) =>
                saveLightingNumber(
                  'exposure',
                  event.currentTarget,
                )
              }
              step="0.01"
              style={singleRangeStyle(
                previewLighting.exposure,
                0.1,
                3,
              )}
              type="range"
              value={previewLighting.exposure}
            />
            <div className="slider-labels">
              <span>0.10</span>
              <span>1.00</span>
              <span>3.00</span>
            </div>
          </label>
          <input
            className="lighting-value"
            disabled={busy || !bridge || !selectedModel}
            max="3"
            min="0.1"
            onBlur={(event) =>
              saveLightingNumber('exposure', event.currentTarget)
            }
            onChange={(event) =>
              previewLightingNumber('exposure', event.currentTarget)
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            step="0.01"
            type="number"
            value={previewLighting.exposure}
          />
        </div>
      </section>
    </>
  );
}
