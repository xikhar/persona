import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Scene } from './Scene';
import {
  animationExpression,
  animationUrlsForType,
  type PlayableAnimationType,
} from '../animation-catalog';
import {
  loadPackagedSettingsFallback,
  MAX_AVATAR_WINDOW_HEIGHT,
  MAX_AVATAR_WINDOW_WIDTH,
  MIN_AVATAR_WINDOW_HEIGHT,
  MIN_AVATAR_WINDOW_WIDTH,
  SETTINGS_FALLBACK,
  resolveLightingSettings,
} from '../settings-defaults';
import {
  applyTheme,
  LIGHT_QUERY,
  readStoredTheme,
  storeTheme,
  THEME_OPTIONS,
  type ThemePreference,
} from '../theme';
import { vroidLicenseRows } from '../vroid-license-fields';
import {
  expressionsForModel,
  type ModelExpressionReport,
} from '../model-expression-catalog';

type SettingsSection =
  | 'models'
  | 'animations'
  | 'appearance'
  | 'voice'
  | 'mcp'
  | 'developer';
type LightingNumberField =
  | 'exposure'
  | 'environment_intensity'
  | 'key_light_intensity'
  | 'ambient_intensity';

const LIGHTING_NUMBER_RANGES: Record<
  LightingNumberField,
  readonly [number, number]
> = {
  exposure: [0.1, 3],
  environment_intensity: [0, 2],
  key_light_intensity: [0, 4],
  ambient_intensity: [0, 4],
};

const SYSTEM_EXPRESSION_NAMES = new Set([
  'neutral',
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'blink',
  'blinkLeft',
  'blinkRight',
  'lookUp',
  'lookDown',
  'lookLeft',
  'lookRight',
]);

interface ConfirmationRequest {
  confirmLabel: string;
  detail: ReactNode;
  onConfirm: () => Promise<void>;
  title: string;
}

// Portraits arrive from the main process as data: URLs, one request per card,
// and stay cached: they're immutable enough that re-downloading them on every
// "Refresh list" would only cost time. Module scope rather than component
// state so the cache survives leaving and re-entering the Models section.
const vroidPortraitCache = new Map<string, string | null>();
// In-flight requests, so the same model is only ever fetched once at a time.
// Without this, StrictMode's double-mounted effects in development — and any
// future card that repeats a model — would each open their own request.
const vroidPortraitRequests = new Map<string, Promise<string | null>>();

function requestVroidPortrait(
  bridge: NonNullable<Window['personaVroidHub']>,
  characterId: string,
): Promise<string | null> {
  const pending = vroidPortraitRequests.get(characterId);
  if (pending) return pending;
  const request = bridge
    .getCharacterPortrait(characterId)
    // A portrait that won't load is cosmetic, so a failure settles the card on
    // its placeholder rather than surfacing an error. The miss is remembered
    // only until the next "Refresh list", which clears misses so a transient
    // failure — or a portrait the main process hadn't listed yet — isn't
    // remembered for the window's lifetime.
    .catch(() => null)
    .then((dataUrl) => {
      vroidPortraitCache.set(characterId, dataUrl);
      return dataUrl;
    })
    .finally(() => vroidPortraitRequests.delete(characterId));
  vroidPortraitRequests.set(characterId, request);
  return request;
}

// Drops remembered misses while keeping portraits that already loaded, so a
// refresh is also the user's "try again" for cards stuck on the placeholder.
// Deleting during iteration is well defined for a Map.
function forgetMissingVroidPortraits() {
  for (const [characterId, portrait] of vroidPortraitCache) {
    if (portrait == null) vroidPortraitCache.delete(characterId);
  }
}

function VroidCharacterPortrait({
  character,
}: {
  character: PersonaVroidHubCharacter;
}) {
  const [portrait, setPortrait] = useState<string | null>(
    () => vroidPortraitCache.get(character.id) ?? null,
  );

  useEffect(() => {
    const bridge = window.personaVroidHub;
    // No portrait_url means VRoid Hub has no image for this model, so there's
    // nothing to ask the main process for.
    if (!bridge || character.portrait_url == null) {
      setPortrait(null);
      return;
    }
    if (vroidPortraitCache.has(character.id)) {
      setPortrait(vroidPortraitCache.get(character.id) ?? null);
      return;
    }
    let cancelled = false;
    void requestVroidPortrait(bridge, character.id).then((dataUrl) => {
      if (!cancelled) setPortrait(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [character.id, character.portrait_url]);

  if (portrait == null) {
    return (
      <span aria-hidden="true" className="asset-portrait asset-portrait-empty">
        VRM
      </span>
    );
  }
  return (
    <img
      alt={`${character.name} portrait`}
      className="asset-portrait"
      src={portrait}
    />
  );
}

function vroidConditionsOfUse(
  character: PersonaVroidHubCharacter,
  onOpenHubPage: (() => void) | null,
): ReactNode {
  const rows = vroidLicenseRows(character.license);

  return (
    <>
      <p>
        {character.name} belongs to another VRoid Hub creator, not your
        connected account. Review its conditions of use before Persona
        downloads and uses it.
      </p>
      {rows.length > 0 ? (
        <dl className="vroid-license-terms">
          {rows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p>
          Persona could not read this character&rsquo;s conditions of use from
          VRoid Hub.
        </p>
      )}
      {/* Only offered when VRoid Hub gave us the owning character's id: the
          model's page lives under it, so without it there's no address to
          open and a link would only lead to a 404. */}
      {onOpenHubPage && (
        <p>
          <button
            className="link-button"
            onClick={onOpenHubPage}
            type="button"
          >
            View {character.name} on VRoid Hub
          </button>
        </p>
      )}
    </>
  );
}

const SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  description: string;
}> = [
  { id: 'models', label: 'Models', description: 'Character library' },
  { id: 'animations', label: 'Actions', description: 'Motion library' },
  { id: 'appearance', label: 'Appearance', description: 'Visual tuning' },
  { id: 'voice', label: 'Voice', description: 'Audio source' },
  { id: 'mcp', label: 'MCP', description: 'Agent connection' },
  { id: 'developer', label: 'Developer', description: 'Advanced tuning' },
];

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.4"
      viewBox="0 0 16 16"
    >
      {children}
    </svg>
  );
}

function singleRangeStyle(
  value: number,
  minimum: number,
  maximum: number,
): CSSProperties {
  const progress =
    ((Math.min(maximum, Math.max(minimum, value)) - minimum) /
      (maximum - minimum)) *
    100;
  return {
    '--range-progress': `${progress}%`,
  } as CSSProperties;
}

function MillisecondRangeSlider({
  disabled,
  label,
  maximum = 3600,
  minimum = 45,
  onCommit,
  onPreview,
  step = 5,
  value,
}: {
  disabled: boolean;
  label: string;
  maximum?: number;
  minimum?: number;
  onCommit: (range: readonly [number, number]) => void;
  onPreview: (range: readonly [number, number]) => void;
  step?: number;
  value: readonly [number, number];
}) {
  const rangeFor = (index: 0 | 1, nextValue: number) => {
    return index === 0
      ? [Math.min(nextValue, value[1]), value[1]] as const
      : [value[0], Math.max(nextValue, value[0])] as const;
  };
  const percentage = (point: number) =>
    ((point - minimum) / (maximum - minimum)) * 100;
  const style = {
    '--range-start': `${percentage(value[0])}%`,
    '--range-end': `${percentage(value[1])}%`,
  } as CSSProperties;

  return (
    <div className="dual-range-slider" style={style}>
      <div className="dual-range-track" aria-hidden="true">
        <i />
      </div>
      {([0, 1] as const).map((index) => (
        <input
          aria-label={`${label} ${index === 0 ? 'minimum' : 'maximum'}`}
          className={`dual-range-input dual-range-input-${index === 0 ? 'minimum' : 'maximum'}`}
          disabled={disabled}
          key={index}
          max={maximum}
          min={minimum}
          onChange={(event) =>
            onPreview(rangeFor(index, Number(event.currentTarget.value)))
          }
          onKeyUp={(event) => {
            if (event.key.startsWith('Arrow')) {
              onCommit(rangeFor(index, Number(event.currentTarget.value)));
            }
          }}
          onPointerUp={(event) =>
            onCommit(rangeFor(index, Number(event.currentTarget.value)))
          }
          step={step}
          type="range"
          value={value[index]}
        />
      ))}
    </div>
  );
}

function expressionWeightFrom(input: HTMLInputElement): number | null {
  const weight = input.valueAsNumber;
  return Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : null;
}

/** The expression overlay fields shared by the create and edit action forms. */
function ExpressionFields({
  metadata,
  onChange,
  availableExpressions,
}: {
  metadata: CustomAnimationMetadata;
  onChange: (patch: Partial<CustomAnimationMetadata>) => void;
  availableExpressions: readonly string[];
}) {

  const expressionOptions = availableExpressions.filter(
    (expression) => !SYSTEM_EXPRESSION_NAMES.has(expression),
  );

  return (
    <>
      <label>
        Expression <code>expression_name</code>
        <select
          onChange={(event) =>
            onChange({
              expression_name: event.target.value || null,
            })
          }
          value={metadata.expression_name ?? ''}
        >
          <option value="">None</option>
          {expressionOptions.map((expression) => (
            <option key={expression} value={expression}>
              {expression}
            </option>
          ))}
        </select>
        <small>
          Blends a VRM expression over the face while the action plays.
        </small>
      </label>
      {metadata.expression_name && (
        <div className="expression-weight-field">
          <div className="expression-weight-row">
            <label>
              <span>
                Expression weight <code>expression_weight</code>
              </span>
              <input
                className="single-range-slider"
                max="1"
                min="0"
                onChange={(event) =>
                  onChange({ expression_weight: Number(event.target.value) })
                }
                step="0.05"
                style={singleRangeStyle(metadata.expression_weight, 0, 1)}
                type="range"
                value={metadata.expression_weight}
              />
              <div className="slider-labels">
                <span>0.00</span>
                <span>0.50</span>
                <span>1.00</span>
              </div>
            </label>
            {/* Out-of-range and half-typed values are ignored while editing,
                then the field snaps back to the stored weight on blur. */}
            <input
              aria-label="Expression weight value"
              className="expression-weight-value"
              max="1"
              min="0"
              onBlur={(event) => {
                const weight = expressionWeightFrom(event.currentTarget);
                if (weight == null) {
                  event.currentTarget.value = String(
                    metadata.expression_weight,
                  );
                }
              }}
              onChange={(event) => {
                const weight = expressionWeightFrom(event.currentTarget);
                if (weight != null) onChange({ expression_weight: weight });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              step="0.05"
              type="number"
              value={metadata.expression_weight}
            />
          </div>
          <small className="field-hint">
            Between 0.00 (expression off) and 1.00 (full strength).
          </small>
        </div>
      )}
    </>
  );
}

const SECTION_ICONS: Record<SettingsSection, ReactNode> = {
  models: (
    <Icon>
      <circle cx="8" cy="5.5" r="2.6" />
      <path d="M2.9 13.6c0-2.3 2.28-4.1 5.1-4.1s5.1 1.8 5.1 4.1" />
    </Icon>
  ),
  animations: (
    <Icon>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M6.8 5.8 10.9 8l-4.1 2.2z" />
    </Icon>
  ),
  appearance: (
    <Icon>
      <path d="M2.6 5.6v-2a1 1 0 0 1 1-1h2M10.4 2.6h2a1 1 0 0 1 1 1v2M13.4 10.4v2a1 1 0 0 1-1 1h-2M5.6 13.4h-2a1 1 0 0 1-1-1v-2" />
    </Icon>
  ),
  voice: (
    <Icon>
      <path d="M3.2 6.4v3.2M5.4 4.8v6.4M7.6 3.6v8.8M9.8 5.2v5.6M12.8 6.8v2.4" />
    </Icon>
  ),
  mcp: (
    <Icon>
      <path d="M6 2.4v2.6M10 2.4v2.6M4.6 5h6.8v2.9A3.4 3.4 0 0 1 8 11.3 3.4 3.4 0 0 1 4.6 7.9z" />
      <path d="M8 11.3v2.3" />
    </Icon>
  ),
  developer: (
    <Icon>
      <path d="M5.2 2.8 2.4 8l2.8 5.2M10.8 2.8 13.6 8l-2.8 5.2M9.2 2.2 6.8 13.8" />
    </Icon>
  ),
};

/** Tracks the stored preference and keeps the applied theme in sync with it. */
function useThemePreference() {
  const [preference, setPreference] =
    useState<ThemePreference>(readStoredTheme);
  const [systemPrefersLight, setSystemPrefersLight] = useState(
    () => window.matchMedia(LIGHT_QUERY).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(LIGHT_QUERY);
    const sync = (event: MediaQueryListEvent) =>
      setSystemPrefersLight(event.matches);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  const resolved =
    preference === 'system' ? (systemPrefersLight ? 'light' : 'dark') : preference;

  useEffect(() => applyTheme(resolved), [resolved]);

  const chooseTheme = useCallback((next: ThemePreference) => {
    setPreference(next);
    storeTheme(next);
  }, []);

  return { chooseTheme, preference, resolved };
}

const MCP_TOOL_DESCRIPTIONS: Record<string, string> = {
  play_animation: 'Play any configured action with at least one animation clip.',
  list_animations: 'Read the latest playable actions and their usage details.',
  control_window: 'Show, hide, or toggle the Persona character window.',
  get_status: 'Read window, model, voice, and listener readiness.',
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '');
}

export function SettingsPage() {
  const bridge = window.personaSettings;
  const vroidHubBridge = window.personaVroidHub;
  const { chooseTheme, preference: themePreference } = useThemePreference();
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [settings, setSettings] =
    useState<PersonaSettingsSnapshot>(SETTINGS_FALLBACK);
  const [section, setSection] = useState<SettingsSection>('models');
  const [selectedModelId, setSelectedModelId] = useState(
    SETTINGS_FALLBACK.default_model_id,
  );
  const [avatarWidthInput, setAvatarWidthInput] = useState(
    String(SETTINGS_FALLBACK.avatar_window.width),
  );
  const [avatarHeightInput, setAvatarHeightInput] = useState(
    String(SETTINGS_FALLBACK.avatar_window.height),
  );
  const [previewAnimation, setPreviewAnimation] =
    useState<PersonaAnimationSettings | null>(null);
  const [expressionReport, setExpressionReport] =
    useState<ModelExpressionReport | null>(null);
  const [previewClipId, setPreviewClipId] = useState<string | null>(null);
  const [previewRequest, setPreviewRequest] = useState(0);
  const [modelName, setModelName] = useState('');
  const [animationMetadata, setAnimationMetadata] =
    useState<CustomAnimationMetadata>({
      animation_name: '',
      animation_description: '',
      animation_trigger_scenario: '',
      expression_name: null,
      expression_weight: 1,
    });
  const [editingAnimationId, setEditingAnimationId] = useState<string | null>(
    null,
  );
  const [editingAnimationMetadata, setEditingAnimationMetadata] =
    useState<CustomAnimationMetadata>({
      animation_name: '',
      animation_description: '',
      animation_trigger_scenario: '',
      expression_name: null,
      expression_weight: 1,
    });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [mcpStatus, setMcpStatus] = useState<PersonaMcpStatus | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [voiceMode, setVoiceMode] = useState<
    PersonaVoiceSourceSettings['mode']
  >(
    SETTINGS_FALLBACK.voice_source.mode,
  );
  const [voicePattern, setVoicePattern] = useState(
    SETTINGS_FALLBACK.voice_source.process_pattern ?? '',
  );
  const [voiceCatalog, setVoiceCatalog] =
    useState<PersonaVoiceSourceCatalog | null>(null);
  const [voiceSourcesLoading, setVoiceSourcesLoading] = useState(false);
  const [voiceSourceSearch, setVoiceSourceSearch] = useState('');
  const [confirmation, setConfirmation] =
    useState<ConfirmationRequest | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [vroidStatus, setVroidStatus] = useState<PersonaVroidHubStatus | null>(
    null,
  );
  const [vroidCredentials, setVroidCredentials] =
    useState<PersonaVroidHubCredentials | null>(null);
  const [vroidClientIdInput, setVroidClientIdInput] = useState('');
  const [vroidClientSecretInput, setVroidClientSecretInput] = useState('');
  const [vroidCredentialsSaving, setVroidCredentialsSaving] = useState(false);
  const [vroidCharacters, setVroidCharacters] = useState<
    PersonaVroidHubCharacter[] | null
  >(null);
  const [vroidLoading, setVroidLoading] = useState(false);
  // Remounts the portrait of every card when it changes — see
  // refreshVroidCharacters.
  const [vroidPortraitEpoch, setVroidPortraitEpoch] = useState(0);
  const confirmationDialogRef = useRef<HTMLDivElement>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement>(null);
  const confirmationConfirmRef = useRef<HTMLButtonElement>(null);
  const settingsContentRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    document.title = 'Persona Settings';
    if (!bridge) {
      void loadPackagedSettingsFallback()
        .then((snapshot) => {
          setSettings(snapshot);
          setSelectedModelId(snapshot.default_model_id);
        })
        .catch((error: unknown) => setNotice(errorMessage(error)));
      return;
    }
    void bridge
      .get()
      .then((snapshot) => {
        setSettings(snapshot);
        setSelectedModelId(snapshot.default_model_id);
      })
      .catch((error: unknown) => setNotice(errorMessage(error)));
    return bridge.subscribe(setSettings);
  }, [bridge]);

  useEffect(() => {
    if (!vroidHubBridge) return;
    void vroidHubBridge
      .getStatus()
      .then(setVroidStatus)
      .catch((error: unknown) => setNotice(errorMessage(error)));
    void vroidHubBridge
      .getCredentials()
      .then((credentials) => {
        setVroidCredentials(credentials);
        setVroidClientIdInput(credentials.clientId ?? '');
      })
      .catch((error: unknown) => setNotice(errorMessage(error)));
    return vroidHubBridge.subscribe(setVroidStatus);
  }, [vroidHubBridge]);

  const refreshVroidCharacters = useCallback(async () => {
    if (!vroidHubBridge) return;
    setVroidLoading(true);
    forgetMissingVroidPortraits();
    // Bumped so every card's portrait effect runs again against the freshened
    // cache; the character ids a refresh returns are usually identical, which
    // on its own would leave the effects — and any stuck placeholder — alone.
    setVroidPortraitEpoch((epoch) => epoch + 1);
    try {
      setVroidCharacters(await vroidHubBridge.listCharacters());
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setVroidLoading(false);
    }
  }, [vroidHubBridge]);

  useEffect(() => {
    if (vroidStatus?.connected) void refreshVroidCharacters();
    else setVroidCharacters(null);
  }, [vroidStatus?.connected, refreshVroidCharacters]);

  useEffect(() => {
    setVoiceMode(settings.voice_source.mode);
    setVoicePattern(settings.voice_source.process_pattern ?? '');
  }, [settings.voice_source.mode, settings.voice_source.process_pattern]);

  useEffect(() => {
    setPreviewAnimation((current) => {
      if (!current) return null;
      return (
        settings.animations.find((animation) => animation.id === current.id) ??
        null
      );
    });
    setPreviewClipId((current) => {
      if (!current) return null;
      return settings.animations.some((animation) =>
        animation.clips.some((clip) => clip.id === current),
      )
        ? current
        : null;
    });
  }, [settings.animations]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selectedModel =
    settings.models.find((model) => model.id === selectedModelId) ??
    settings.models.find((model) => model.id === settings.default_model_id) ??
    settings.models[0];
  const availableExpressions = expressionsForModel(
    expressionReport,
    selectedModel?.asset_url ?? null,
  );
  const handleExpressionsChange = useCallback(
    (modelUrl: string, expressions: readonly string[]) => {
      setExpressionReport({ modelUrl, expressions });
    },
    [],
  );

  const customModelCount = settings.models.filter(
    (model) => model.origin === 'user',
  ).length;
  const customAnimationCount = settings.animations.filter(
    (animation) => animation.origin === 'user',
  ).length;

  const previewType: PlayableAnimationType =
    previewAnimation?.animation_type ??
    (previewAnimation ? 'CUSTOM' : 'IDLE');
  const previewExpression = animationExpression(previewAnimation);
  const idleAnimationUrls = useMemo(
    () => animationUrlsForType(settings.animations, 'IDLE'),
    [settings.animations],
  );
  const previewClip = previewAnimation?.clips.find(
    (clip) => clip.id === previewClipId,
  );
  const previewAnimationUrls = useMemo(
    () => (previewClip ? [previewClip.asset_url] : idleAnimationUrls),
    [idleAnimationUrls, previewClip],
  );

  const previewTitle = useMemo(() => {
    if (previewClip) return previewClip.animation_name;
    return 'Character preview';
  }, [previewClip]);

  const updateSnapshot = useCallback((snapshot: PersonaSettingsSnapshot) => {
    setSettings(snapshot);
    return snapshot;
  }, []);

  const run = useCallback(
    async (
      operation: () => Promise<PersonaSettingsSnapshot | null>,
      success: string,
    ) => {
      setBusy(true);
      setNotice(null);
      try {
        const snapshot = await operation();
        if (snapshot) {
          updateSnapshot(snapshot);
          setNotice(success);
        }
        return snapshot;
      } catch (error) {
        setNotice(errorMessage(error));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [updateSnapshot],
  );

  const persistAppearance = useCallback(
    async (
      operation: () => Promise<PersonaSettingsSnapshot>,
      success: string,
    ) => {
      setNotice(null);
      try {
        const snapshot = await operation();
        updateSnapshot(snapshot);
        setNotice(success);
        return snapshot;
      } catch (error) {
        setNotice(errorMessage(error));
        return null;
      }
    },
    [updateSnapshot],
  );

  const refreshMcpStatus = useCallback(async () => {
    setMcpLoading(true);
    try {
      if (!bridge) {
        setMcpStatus(null);
        return;
      }
      setMcpStatus(await bridge.getMcpStatus());
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setMcpLoading(false);
    }
  }, [bridge]);

  const refreshVoiceSources = useCallback(async () => {
    setVoiceSourcesLoading(true);
    try {
      if (!bridge) {
        setVoiceCatalog(null);
        return;
      }
      setVoiceCatalog(await bridge.listVoiceSources());
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setVoiceSourcesLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    if (section !== 'mcp') return;
    void refreshMcpStatus();
  }, [refreshMcpStatus, section, settings.animations]);

  useEffect(() => {
    if (section !== 'voice') return;
    void refreshVoiceSources();
  }, [refreshVoiceSources, section]);

  const copyText = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied.`);
    } catch {
      setNotice(`Unable to copy ${label.toLowerCase()}.`);
    }
  }, []);

  const saveVoiceSource = async (
    source: PersonaVoiceSourceSettings,
    success: string,
  ) => {
    if (!bridge) return null;
    const snapshot = await run(
      () => bridge.setVoiceSource(source),
      success,
    );
    if (!snapshot) {
      setVoiceMode(settings.voice_source.mode);
      return null;
    }
    setVoiceMode(snapshot.voice_source.mode);
    void refreshVoiceSources();
    return snapshot;
  };

  const chooseVoiceMode = (
    mode: PersonaVoiceSourceSettings['mode'],
  ) => {
    setVoiceMode(mode);
    if (mode === 'default' || mode === 'external') {
      void saveVoiceSource(
        {
          mode,
          process_pattern: null,
          source_id: null,
          source_name: null,
        },
        mode === 'default'
          ? 'Automatic ChatGPT and Codex detection enabled.'
          : 'External voice integration enabled.',
      );
    }
  };

  const chooseApplicationSource = (source: PersonaVoiceSource) => {
    void saveVoiceSource(
      {
        mode: 'application',
        process_pattern: null,
        source_id: source.id,
        source_name: source.name,
      },
      `Voice output source set to ${source.name}.`,
    );
  };

  const saveCustomVoiceSource = () => {
    void saveVoiceSource(
      {
        mode: 'custom',
        process_pattern: voicePattern,
        source_id: null,
        source_name: null,
      },
      'Advanced process pattern saved.',
    );
  };

  const openConfirmation = useCallback((request: ConfirmationRequest) => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setConfirmation(request);
  }, []);

  const closeConfirmation = useCallback(() => {
    const previousFocus = previousFocusRef.current;
    setConfirmation(null);
    setConfirming(false);
    window.requestAnimationFrame(() => {
      if (
        previousFocus?.isConnected &&
        !previousFocus.matches(':disabled')
      ) {
        previousFocus.focus();
      } else {
        settingsContentRef.current?.focus();
      }
    });
  }, []);

  useEffect(() => {
    if (!confirmation) return;
    const frame = window.requestAnimationFrame(() =>
      confirmationCancelRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [confirmation]);

  const confirmPendingAction = async () => {
    if (!confirmation || confirming) return;
    setConfirming(true);
    try {
      await confirmation.onConfirm();
    } finally {
      closeConfirmation();
    }
  };

  const importModel = async () => {
    if (!bridge) return;
    const existingModelIds = new Set(settings.models.map((model) => model.id));
    const snapshot = await run(
      () => bridge.importModel({ model_name: modelName }),
      'Model added to your library.',
    );
    if (!snapshot) return;
    const imported = snapshot.models.find(
      (model) => !existingModelIds.has(model.id),
    );
    if (imported) setSelectedModelId(imported.id);
    setModelName('');
  };

  const createAnimation = async () => {
    if (!bridge) return;
    const snapshot = await run(
      () => bridge.createAnimation(animationMetadata),
      'Animation action created. Add one or more VRMA clips to make it playable.',
    );
    if (!snapshot) return;
    setAnimationMetadata({
      animation_name: '',
      animation_description: '',
      animation_trigger_scenario: '',
      expression_name: null,
      expression_weight: 1,
    });
  };

  const addAnimationClips = async (animation: PersonaAnimationSettings) => {
    if (!bridge) return;
    const snapshot = await run(
      () => bridge.addAnimationClips(animation.id),
      `VRMA clips added to ${animation.animation_name}.`,
    );
    if (!snapshot) return;
    const updated = snapshot.animations.find(
      (candidate) => candidate.id === animation.id,
    );
    if (previewAnimation?.id === animation.id) {
      setPreviewAnimation(updated ?? null);
    }
  };

  const setDefaultModel = async (modelId: string) => {
    if (!bridge) return;
    const snapshot = await run(
      () => bridge.setDefaultModel(modelId),
      'Default model updated.',
    );
    if (snapshot) setSelectedModelId(modelId);
  };

  const deleteModel = (model: PersonaModelSettings) => {
    if (!bridge || !model.removable) return;
    openConfirmation({
      confirmLabel: 'Delete',
      title: `Delete “${model.model_name}”?`,
      detail: 'The model and its locally stored VRM file will be removed.',
      onConfirm: async () => {
        const snapshot = await run(
          () => bridge.deleteModel(model.id),
          'Model deleted from your library.',
        );
        if (snapshot && selectedModelId === model.id) {
          setSelectedModelId(snapshot.default_model_id);
        }
      },
    });
  };

  const saveVroidCredentials = async () => {
    if (!vroidHubBridge) return;
    const clientId = vroidClientIdInput.trim();
    const clientSecret = vroidClientSecretInput.trim();
    if (!clientId || !clientSecret) {
      setNotice('Enter both a client ID and client secret.');
      return;
    }
    setVroidCredentialsSaving(true);
    setNotice(null);
    try {
      setVroidStatus(await vroidHubBridge.setCredentials(clientId, clientSecret));
      setVroidCredentials(await vroidHubBridge.getCredentials());
      setVroidClientSecretInput('');
      setVroidCharacters(null);
      setNotice('VRoid Hub app credentials saved.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setVroidCredentialsSaving(false);
    }
  };

  const clearVroidCredentials = () => {
    if (!vroidHubBridge) return;
    openConfirmation({
      confirmLabel: 'Remove',
      title: 'Remove VRoid Hub app credentials?',
      detail:
        'Persona forgets this OAuth app and disconnects your VRoid Hub sign-in. A character currently in use from Hub is removed.',
      onConfirm: async () => {
        try {
          setVroidStatus(await vroidHubBridge.clearCredentials());
          setVroidCredentials({ clientId: null, hasClientSecret: false });
          setVroidClientIdInput('');
          setVroidClientSecretInput('');
          setVroidCharacters(null);
        } catch (error) {
          setNotice(errorMessage(error));
        }
      },
    });
  };

  const connectVroidHub = async () => {
    if (!vroidHubBridge) return;
    setBusy(true);
    setNotice(null);
    try {
      setVroidStatus(await vroidHubBridge.connect());
      setNotice('Continue signing in to VRoid Hub in your browser.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const disconnectVroidHub = () => {
    if (!vroidHubBridge) return;
    openConfirmation({
      confirmLabel: 'Disconnect',
      title: 'Disconnect VRoid Hub?',
      detail:
        'Persona forgets your VRoid Hub sign-in. A character currently in use from Hub is removed until you reconnect and choose it again.',
      onConfirm: async () => {
        try {
          setVroidStatus(await vroidHubBridge.disconnect());
          setVroidCharacters(null);
        } catch (error) {
          setNotice(errorMessage(error));
        }
      },
    });
  };

  const activateVroidCharacter = async (character: PersonaVroidHubCharacter) => {
    if (!vroidHubBridge) return;
    const snapshot = await run(
      () => vroidHubBridge.selectCharacter(character.id, character.name),
      `${character.name} is ready to use.`,
    );
    if (!snapshot) return;
    const hubModel = snapshot.models.find((model) => model.origin === 'hub');
    if (hubModel) setSelectedModelId(hubModel.id);
  };

  const selectVroidCharacter = (character: PersonaVroidHubCharacter) => {
    if (!vroidHubBridge) return;
    if (character.origin === 'own') {
      void activateVroidCharacter(character);
      return;
    }
    // VRoid Hub's third-party integration guidelines require a conditions-
    // of-use confirmation before a hearted (not-owned) model is used.
    const owningCharacterId = character.character_id;
    openConfirmation({
      confirmLabel: 'Use this character',
      title: 'Model Data Conditions of Use',
      detail: vroidConditionsOfUse(
        character,
        owningCharacterId == null
          ? null
          : () =>
              void vroidHubBridge.openCharacterPage(
                owningCharacterId,
                character.id,
              ),
      ),
      onConfirm: () => activateVroidCharacter(character),
    });
  };

  const beginEditingAnimation = (animation: PersonaAnimationSettings) => {
    if (!animation.editable) return;
    setEditingAnimationId(animation.id);
    setEditingAnimationMetadata({
      animation_name: animation.animation_name,
      animation_description: animation.animation_description,
      animation_trigger_scenario: animation.animation_trigger_scenario,
      expression_name: animation.expression_name,
      expression_weight: animation.expression_weight,
    });
  };

  const saveAnimation = async () => {
    if (!bridge || !editingAnimationId) return;
    const snapshot = await run(
      () =>
        bridge.updateAnimation(
          editingAnimationId,
          editingAnimationMetadata,
        ),
      'Animation details updated.',
    );
    if (!snapshot) return;
    const updated = snapshot.animations.find(
      (animation) => animation.id === editingAnimationId,
    );
    if (previewAnimation?.id === editingAnimationId) {
      setPreviewAnimation(updated ?? null);
    }
    setEditingAnimationId(null);
  };

  const deleteAnimation = (animation: PersonaAnimationSettings) => {
    if (!bridge || !animation.removable) return;
    openConfirmation({
      confirmLabel: 'Delete',
      title: `Delete “${animation.animation_name}”?`,
      detail:
        animation.origin === 'packaged'
          ? 'The action will be removed from your active library. Reset packaged actions can restore it.'
          : 'The action and all of its locally stored VRMA clips will be removed.',
      onConfirm: async () => {
        const snapshot = await run(
          () => bridge.deleteAnimation(animation.id),
          'Animation action removed from your active library.',
        );
        if (!snapshot) return;
        if (previewAnimation?.id === animation.id) {
          setPreviewAnimation(null);
          setPreviewClipId(null);
        }
        if (editingAnimationId === animation.id) {
          setEditingAnimationId(null);
        }
      },
    });
  };

  const deleteAnimationClip = (
    animation: PersonaAnimationSettings,
    clip: PersonaAnimationClipSettings,
  ) => {
    if (!bridge || !clip.removable) return;
    openConfirmation({
      confirmLabel: 'Delete',
      title: `Delete “${clip.animation_name}”?`,
      detail: 'The locally stored VRMA clip will be removed.',
      onConfirm: async () => {
        const snapshot = await run(
          () => bridge.deleteAnimationClip(animation.id, clip.id),
          `${clip.animation_name} removed.`,
        );
        if (!snapshot) return;
        const updated = snapshot.animations.find(
          (candidate) => candidate.id === animation.id,
        );
        if (previewAnimation?.id === animation.id) {
          setPreviewAnimation(updated ?? null);
        }
        if (previewClipId === clip.id) {
          setPreviewClipId(null);
        }
      },
    });
  };

  const resetPackagedAnimations = () => {
    if (
      !bridge ||
      settings.packaged_animation_change_count === 0
    ) {
      return;
    }
    openConfirmation({
      confirmLabel: 'Reset',
      title: 'Reset packaged actions?',
      detail:
        'Packaged names, descriptions, triggers, and visibility will be restored. User-created actions and uploaded clips will not change.',
      onConfirm: async () => {
        const snapshot = await run(
          () => bridge.resetPackagedAnimations(),
          'Packaged animation actions restored.',
        );
        if (!snapshot) return;
        setEditingAnimationId(null);
        setPreviewAnimation(null);
        setPreviewClipId(null);
      },
    });
  };

  const previewCharacterSize = (size: number) => {
    setSettings((current) => ({ ...current, character_size: size }));
  };

  const saveCharacterSize = async (size: number) => {
    if (!bridge) return;
    await persistAppearance(
      () => bridge.setCharacterSize(size),
      `Default character size set to ${Math.round(size * 100)}%.`,
    );
  };

  useEffect(() => {
    setAvatarWidthInput(String(settings.avatar_window.width));
    setAvatarHeightInput(String(settings.avatar_window.height));
  }, [settings.avatar_window]);

  const avatarWidth = Math.round(Number(avatarWidthInput));
  const avatarHeight = Math.round(Number(avatarHeightInput));
  const avatarWindowSizeValid =
    Number.isFinite(avatarWidth) &&
    avatarWidth >= MIN_AVATAR_WINDOW_WIDTH &&
    avatarWidth <= MAX_AVATAR_WINDOW_WIDTH &&
    Number.isFinite(avatarHeight) &&
    avatarHeight >= MIN_AVATAR_WINDOW_HEIGHT &&
    avatarHeight <= MAX_AVATAR_WINDOW_HEIGHT;
  const avatarWindowSizeChanged =
    avatarWidth !== settings.avatar_window.width ||
    avatarHeight !== settings.avatar_window.height;

  const saveAvatarWindowSize = async () => {
    if (!bridge || !avatarWindowSizeValid) return;
    await run(
      () => bridge.setAvatarWindowSize(avatarWidth, avatarHeight),
      `Avatar window resized to ${avatarWidth}×${avatarHeight}.`,
    );
  };

  const previewSpeakingTransition = (
    field: keyof PersonaSpeakingTransitionSettings,
    range: readonly [number, number],
  ) => {
    setSettings((current) => ({
      ...current,
      speaking_transition: {
        ...current.speaking_transition,
        [field]: range,
      },
    }));
  };

  const saveSpeakingTransition = async (
    field: keyof PersonaSpeakingTransitionSettings,
    range: readonly [number, number],
  ) => {
    if (!bridge) return;
    await persistAppearance(
      () =>
        bridge.setSpeakingTransition({
          ...settings.speaking_transition,
          [field]: range,
        }),
      'Speaking transition updated.',
    );
  };

  const previewBodyTransitionMs = (value: number) => {
    setSettings((current) => ({
      ...current,
      body_transition_ms: value,
    }));
  };

  const saveBodyTransitionMs = async (value: number) => {
    if (!bridge) return;
    await persistAppearance(
      () => bridge.setBodyTransitionMs(value),
      'Body transition duration updated.',
    );
  };

  const previewSpeakingDebounceMs = (value: number) => {
    setSettings((current) => ({
      ...current,
      speaking_debounce_ms: value,
    }));
  };

  const saveSpeakingDebounceMs = async (value: number) => {
    if (!bridge) return;
    await persistAppearance(
      () => bridge.setSpeakingDebounceMs(value),
      'Speaking debounce updated.',
    );
  };

  const previewIdleInterimMs = (value: number) => {
    setSettings((current) => ({
      ...current,
      idle_interim_ms: value,
    }));
  };

  const saveIdleInterimMs = async (value: number) => {
    if (!bridge) return;
    await persistAppearance(
      () => bridge.setIdleInterimMs(value),
      'Idle interim updated.',
    );
  };

  const previewVroidHubPlaintextStorageAllowed = (allowed: boolean) => {
    setSettings((current) => ({
      ...current,
      vroid_hub_allow_plaintext_storage: allowed,
    }));
  };

  const saveVroidHubPlaintextStorageAllowed = async (allowed: boolean) => {
    if (!bridge) return;
    await persistAppearance(
      () => bridge.setVroidHubPlaintextStorageAllowed(allowed),
      allowed
        ? 'VRoid Hub Linux override enabled.'
        : 'VRoid Hub Linux override disabled.',
    );
  };

  const requestDeveloperSettingsAccess = () => {
    if (!bridge || settings.developer_settings_enabled) return;
    openConfirmation({
      confirmLabel: 'Enable developer settings',
      title: 'Enable developer settings?',
      detail:
        'These controls change low-level animation behavior and may make motion look unstable or unnatural. Continue only if you are comfortable restoring the packaged defaults.',
      onConfirm: async () => {
        await run(
          () => bridge.enableDeveloperSettings(),
          'Developer settings enabled.',
        );
      },
    });
  };

  const resetDeveloperSettings = () => {
    if (!bridge || !settings.developer_settings_enabled) return;
    openConfirmation({
      confirmLabel: 'Reset',
      title: 'Reset developer settings?',
      detail:
        'All developer-only values will return to the defaults packaged with Persona.',
      onConfirm: async () => {
        await run(
          () => bridge.resetDeveloperSettings(),
          'Developer settings reset to packaged defaults.',
        );
      },
    });
  };

  const previewLighting: PersonaLightingSettings = useMemo(() => {
    return resolveLightingSettings(
      selectedModel ? settings.model_lighting[selectedModel.id] : null,
    );
  }, [selectedModel, settings.model_lighting]);

  const previewLightingField = <
    Field extends keyof PersonaLightingSettings,
  >(
    field: Field,
    value: PersonaLightingSettings[Field],
  ) => {
    if (!selectedModel) return;
    setSettings((current) => ({
      ...current,
      model_lighting: {
        ...current.model_lighting,
        [selectedModel.id]: {
          ...previewLighting,
          [field]: value,
        },
      },
    }));
  };

  const saveLightingField = async <
    Field extends keyof PersonaLightingSettings,
  >(
    field: Field,
    value: PersonaLightingSettings[Field],
  ) => {
    if (!bridge || !selectedModel) return;
    const snapshot = await persistAppearance(
      () =>
        bridge.setModelLighting(selectedModel.id, {
          ...previewLighting,
          [field]: value,
        }),
      'Lighting updated.',
    );
    if (snapshot) return;
    try {
      updateSnapshot(await bridge.get());
    } catch {
      // Keep the original validation error visible.
    }
  };

  const lightingNumber = (
    field: LightingNumberField,
    input: HTMLInputElement,
  ) => {
    const value = input.valueAsNumber;
    const [minimum, maximum] = LIGHTING_NUMBER_RANGES[field];
    return Number.isFinite(value) && value >= minimum && value <= maximum
      ? value
      : null;
  };

  const previewLightingNumber = (
    field: LightingNumberField,
    input: HTMLInputElement,
  ) => {
    const value = lightingNumber(field, input);
    if (value != null) previewLightingField(field, value);
  };

  const saveLightingNumber = (
    field: LightingNumberField,
    input: HTMLInputElement,
  ) => {
    const value = lightingNumber(field, input);
    if (value == null) {
      input.value = String(previewLighting[field]);
      return;
    }
    void saveLightingField(field, value);
  };

  const resetLighting = async () => {
    if (!bridge || !selectedModel) return;
    await run(
      () => bridge.resetModelLighting(selectedModel.id),
      'Lighting reset to Persona defaults.',
    );
  };

  const playAnimationClip = (
    animation: PersonaAnimationSettings,
    clip: PersonaAnimationClipSettings,
  ) => {
    setPreviewAnimation(animation);
    setPreviewClipId(clip.id);
    setPreviewRequest((request) => request + 1);
  };

  const normalizedVoiceSearch = voiceSourceSearch.trim().toLowerCase();
  const visibleVoiceSources = (voiceCatalog?.sources ?? []).filter(
    (source) =>
      !normalizedVoiceSearch ||
      `${source.name} ${source.detail}`
        .toLowerCase()
        .includes(normalizedVoiceSearch),
  );
  const selectedVoiceSourceAvailable = (voiceCatalog?.sources ?? []).some(
    (source) => source.id === settings.voice_source.source_id,
  );
  const listenerStatus = voiceCatalog?.listener;
  const voiceSourceDirty =
    voiceMode !== settings.voice_source.mode ||
    (voiceMode === 'custom' &&
      voicePattern.trim() !==
        (settings.voice_source.process_pattern ?? ''));
  const voiceHeading =
    settings.voice_source.mode === 'application'
      ? settings.voice_source.source_name ?? 'Selected application'
      : settings.voice_source.mode === 'custom'
        ? 'Advanced process pattern'
        : settings.voice_source.mode === 'external'
          ? 'External events'
          : 'Automatic detection';
  const developerSettingsModified =
    settings.body_transition_ms !== SETTINGS_FALLBACK.body_transition_ms ||
    settings.speaking_debounce_ms !==
      SETTINGS_FALLBACK.speaking_debounce_ms ||
    settings.idle_interim_ms !== SETTINGS_FALLBACK.idle_interim_ms ||
    settings.vroid_hub_allow_plaintext_storage !==
      SETTINGS_FALLBACK.vroid_hub_allow_plaintext_storage ||
    (['entry_ms', 'exit_ms'] as const).some((field) =>
      settings.speaking_transition[field].some(
        (milliseconds, index) =>
          milliseconds !==
          SETTINGS_FALLBACK.speaking_transition[field][index],
      ),
    );

  const headingSummary =
    section === 'mcp'
      ? mcpStatus
        ? `${mcpStatus.tools.length} tools · ${mcpStatus.playable_actions.length} playable actions`
        : 'Local agent connection'
      : section === 'voice'
        ? voiceHeading
        : section === 'developer'
          ? settings.developer_settings_enabled
            ? 'Developer settings enabled'
            : 'Developer settings locked'
        : `${customModelCount} custom models · ${customAnimationCount} custom actions`;
  const mcpHealth = mcpStatus?.health ?? (mcpLoading ? 'starting' : 'unavailable');
  const mcpServerUrl =
    mcpStatus?.server_url ?? 'http://127.0.0.1:47831/mcp';
  const mcpSetupCommand =
    mcpStatus?.setup_command ??
    `codex mcp add persona --url ${mcpServerUrl}`;

  return (
    <main
      className={`settings-app ${
        previewCollapsed ? 'preview-collapsed' : ''
      }`}
    >
      <aside className="settings-sidebar">
        <div className="settings-brand">
          <img src="./assets/avatar.png" alt="" />
          <div className="settings-brand-copy">
            <strong>Persona</strong>
            <span>Settings</span>
          </div>
        </div>

        <nav aria-label="Settings sections">
          {SECTIONS.map((item) => (
            <button
              className={section === item.id ? 'active' : ''}
              data-testid={`section-${item.id}`}
              key={item.id}
              onClick={() => setSection(item.id)}
              type="button"
              title={item.label}
            >
              <span className="nav-glyph" aria-hidden="true">
                {SECTION_ICONS[item.id]}
              </span>
              <span className="settings-nav-copy">
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </nav>

        <div className="settings-sidebar-status">
          <span className="status-dot" />
          <span className="settings-status-copy">Changes save automatically</span>
        </div>
      </aside>

      <section
        className="settings-content"
        ref={settingsContentRef}
        tabIndex={-1}
      >
        <header className="settings-heading">
          <div>
            <span className="eyebrow">
              {section === 'mcp'
                ? 'Local integration'
                : section === 'voice'
                  ? 'Voice output listener'
                  : section === 'developer'
                    ? 'Advanced configuration'
                  : 'Character configuration'}
            </span>
            <h1>{SECTIONS.find((item) => item.id === section)?.label}</h1>
          </div>
          <span className="library-count">{headingSummary}</span>
        </header>

        {notice && (
          <div className="settings-notice" role="status">
            <span>{notice}</span>
            <button
              aria-label="Dismiss notification"
              onClick={() => setNotice(null)}
              type="button"
            >
              ×
            </button>
          </div>
        )}

        <div className="settings-scroll">
          {section === 'models' && (
            <>
              <section className="settings-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Model library</h2>
                    <p>Select a model to inspect it in the preview.</p>
                  </div>
                </div>
                <div className="asset-grid">
                  {settings.models.length === 0 && (
                    <div className="empty-library">
                      <strong>No model configured</strong>
                      <p>
                        Add a VRM file below. Persona stays inactive until a
                        model is available and selected as the default.
                      </p>
                    </div>
                  )}
                  {settings.models.map((model) => {
                    const selected = model.id === selectedModel?.id;
                    const isDefault = model.id === settings.default_model_id;
                    return (
                      <article
                        className={`asset-card ${selected ? 'selected' : ''}`}
                        key={model.id}
                      >
                        <button
                          className="asset-card-main"
                          onClick={() => setSelectedModelId(model.id)}
                          type="button"
                        >
                          <span className="asset-icon">VRM</span>
                          <span>
                            <strong>{model.model_name}</strong>
                            <small>
                              {model.origin === 'packaged'
                                ? 'Packaged model'
                                : model.origin === 'hub'
                                  ? 'From VRoid Hub'
                                  : 'User model'}
                            </small>
                          </span>
                        </button>
                        <div className="asset-card-footer">
                          {isDefault ? (
                            <span className="default-badge">Default</span>
                          ) : (
                            <button
                              disabled={busy || !bridge}
                              onClick={() => void setDefaultModel(model.id)}
                              type="button"
                            >
                              Make default
                            </button>
                          )}
                          <div className="asset-card-actions">
                            <button
                              onClick={() => setSelectedModelId(model.id)}
                              type="button"
                            >
                              Preview
                            </button>
                            {model.removable && (
                              <button
                                className="danger-text-button"
                                disabled={busy || !bridge}
                                onClick={() => void deleteModel(model)}
                                type="button"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              <section className="settings-panel import-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Add a custom model</h2>
                    <p>Persona copies the selected VRM into your local library.</p>
                  </div>
                  <span className="file-pill">.vrm</span>
                </div>
                <label>
                  Model name <code>model_name</code>
                  <input
                    maxLength={80}
                    onChange={(event) => setModelName(event.target.value)}
                    placeholder="e.g. Studio Assistant"
                    value={modelName}
                  />
                </label>
                <button
                  className="primary-button"
                  disabled={busy || !bridge || !modelName.trim()}
                  onClick={() => void importModel()}
                  type="button"
                >
                  Choose VRM file
                </button>
                {!bridge && (
                  <p className="desktop-note">
                    File import is available in the Persona desktop app.
                  </p>
                )}
              </section>

              <section className="settings-panel">
                <div className="panel-heading">
                  <div>
                    <h2>VRoid Hub</h2>
                    <p>
                      Use a character that&rsquo;s only available through
                      your VRoid Hub account, without downloading it
                      yourself.
                    </p>
                  </div>
                  {vroidStatus?.connected && (
                    <span className="default-badge">Connected</span>
                  )}
                </div>
                {!vroidHubBridge && (
                  <p className="desktop-note">
                    VRoid Hub sign-in is available in the Persona desktop
                    app.
                  </p>
                )}
                {vroidHubBridge && (
                  <details
                    className="settings-disclosure"
                    open={vroidStatus != null && !vroidStatus.configured}
                  >
                    <summary>
                      Advanced: connect your own VRoid Hub OAuth app
                    </summary>
                    <div className="settings-disclosure-body">
                      <p className="desktop-note">
                        Register your own OAuth app at{' '}
                        <code>hub.vroid.com/oauth/applications</code>, set
                        its redirect URI to the value below, then paste the
                        app&rsquo;s client ID and secret here.
                      </p>
                      <div className="mcp-copy-field">
                        <div>
                          <span>Redirect URI to register</span>
                          <code>{vroidStatus?.redirect_uri ?? '—'}</code>
                        </div>
                        <button
                          className="secondary-button"
                          disabled={!vroidStatus}
                          onClick={() =>
                            vroidStatus &&
                            void copyText(
                              vroidStatus.redirect_uri,
                              'Redirect URI',
                            )
                          }
                          type="button"
                        >
                          Copy
                        </button>
                      </div>
                      <div className="form-stack">
                        <label>
                          Client ID
                          <input
                            onChange={(event) =>
                              setVroidClientIdInput(event.target.value)
                            }
                            placeholder="OAuth app client ID"
                            value={vroidClientIdInput}
                          />
                        </label>
                        <label>
                          Client secret
                          <input
                            onChange={(event) =>
                              setVroidClientSecretInput(event.target.value)
                            }
                            placeholder={
                              vroidCredentials?.hasClientSecret
                                ? 'Saved — enter a new value to replace it'
                                : 'OAuth app client secret'
                            }
                            type="password"
                            value={vroidClientSecretInput}
                          />
                        </label>
                      </div>
                      <div className="form-actions">
                        <button
                          className="primary-button"
                          disabled={
                            vroidCredentialsSaving ||
                            !vroidClientIdInput.trim() ||
                            !vroidClientSecretInput.trim()
                          }
                          onClick={() => void saveVroidCredentials()}
                          type="button"
                        >
                          {vroidCredentialsSaving
                            ? 'Saving…'
                            : 'Save credentials'}
                        </button>
                        {vroidStatus?.configured && (
                          <button
                            className="secondary-button danger-text-button"
                            disabled={busy}
                            onClick={clearVroidCredentials}
                            type="button"
                          >
                            Remove credentials
                          </button>
                        )}
                      </div>
                    </div>
                  </details>
                )}
                {vroidHubBridge && vroidStatus?.configured && !vroidStatus.connected && (
                  <button
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void connectVroidHub()}
                    type="button"
                  >
                    Connect VRoid Hub account
                  </button>
                )}
                {vroidHubBridge && vroidStatus?.connected && (
                  <>
                    <div className="asset-grid">
                      {vroidLoading && <p>Loading your characters…</p>}
                      {!vroidLoading && vroidCharacters?.length === 0 && (
                        <div className="empty-library">
                          <strong>No characters available yet</strong>
                          <p>
                            Mark a character available to other users on
                            VRoid Hub, or heart one that already is, then
                            refresh.
                          </p>
                        </div>
                      )}
                      {vroidCharacters?.map((character) => (
                        <article className="asset-card" key={character.id}>
                          <VroidCharacterPortrait
                            character={character}
                            key={vroidPortraitEpoch}
                          />
                          <span className="asset-card-main">
                            <span>
                              <strong>{character.name}</strong>
                              <small>
                                {character.is_downloadable
                                  ? 'Downloadable on Hub'
                                  : 'Hub only'}
                              </small>
                            </span>
                          </span>
                          <div className="asset-card-footer">
                            <button
                              disabled={busy}
                              onClick={() =>
                                void selectVroidCharacter(character)
                              }
                              type="button"
                            >
                              Use this character
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                    <div className="form-actions">
                      <button
                        className="secondary-button"
                        disabled={busy || vroidLoading}
                        onClick={() => void refreshVroidCharacters()}
                        type="button"
                      >
                        Refresh list
                      </button>
                      <button
                        className="secondary-button danger-text-button"
                        disabled={busy}
                        onClick={disconnectVroidHub}
                        type="button"
                      >
                        Disconnect
                      </button>
                    </div>
                  </>
                )}
              </section>
            </>
          )}

          {section === 'animations' && (
            <>
              <section className="settings-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Animation actions</h2>
                    <p>
                      Click a VRMA clip to preview that exact animation. Persona
                      chooses randomly between them when the action runs.
                    </p>
                  </div>
                  <button
                    className="secondary-button"
                    disabled={
                      busy ||
                      !bridge ||
                      settings.packaged_animation_change_count === 0
                    }
                    onClick={() => void resetPackagedAnimations()}
                    type="button"
                  >
                    Reset packaged actions
                  </button>
                </div>
                <div className="animation-list">
                  {settings.animations.map((animation) => (
                    <article
                      className={`animation-card ${
                        animation.system ? 'system-action-card' : ''
                      }`}
                      key={animation.id}
                    >
                      <div className="animation-card-header">
                        <div className="animation-card-copy">
                          <div>
                            <strong>
                              {animation.system
                                ? animation.animation_type === 'IDLE'
                                  ? 'Idle'
                                  : 'Speaking'
                                : animation.animation_name}
                            </strong>
                            <span>
                              {animation.system
                                ? 'System action'
                                : animation.origin === 'packaged'
                                  ? animation.modified
                                    ? 'Packaged · modified'
                                    : 'Packaged'
                                  : 'Custom action'}
                            </span>
                          </div>
                          <p>{animation.animation_description}</p>
                          <small>
                            <b>Trigger:</b>{' '}
                            {animation.animation_trigger_scenario}
                          </small>
                          <small className="animation-card-expression">
                            <b>Expression:</b>{' '}
                            {animation.expression_name ? (
                              <>
                                {animation.expression_name}
                                <span className="expression-weight-tag">
                                  {animation.expression_weight.toFixed(2)}
                                </span>
                              </>
                            ) : (
                              'None'
                            )}
                          </small>
                        </div>
                        <div className="animation-card-actions">
                          {animation.editable && (
                            <button
                              disabled={busy || !bridge}
                              onClick={() => beginEditingAnimation(animation)}
                              type="button"
                            >
                              Edit
                            </button>
                          )}
                          {animation.removable && (
                            <button
                              className="danger-text-button"
                              disabled={busy || !bridge}
                              onClick={() => void deleteAnimation(animation)}
                              type="button"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="animation-clips">
                        <div className="animation-clips-heading">
                          <div>
                            <strong>VRMA clips</strong>
                            <span>
                              {animation.clips.length === 0
                                ? 'No clips added'
                                : `${animation.clips.length} ${
                                    animation.clips.length === 1
                                      ? 'clip'
                                      : 'clips'
                                  }`}
                            </span>
                          </div>
                          <button
                            className="secondary-button add-clips-button"
                            disabled={busy || !bridge}
                            onClick={() => void addAnimationClips(animation)}
                            type="button"
                          >
                            + Add VRMA files
                          </button>
                        </div>
                        {animation.clips.length === 0 ? (
                          <p className="empty-clips">
                            {animation.system
                              ? `Upload one or more clips for the ${
                                  animation.animation_type === 'IDLE'
                                    ? 'idle'
                                    : 'speaking'
                                } state. Persona uses the model pose until then.`
                              : 'Upload one or more clips to make this action available to MCP.'}
                          </p>
                        ) : (
                          <div className="clip-list">
                            {animation.clips.map((clip) => (
                              <div
                                aria-label={`Preview ${clip.animation_name}`}
                                className={`clip-chip ${
                                  previewClipId === clip.id ? 'playing' : ''
                                }`}
                                key={clip.id}
                                onClick={(event) => {
                                  if (
                                    (event.target as Element).closest('button')
                                  ) {
                                    return;
                                  }
                                  playAnimationClip(animation, clip);
                                }}
                                onKeyDown={(event) => {
                                  if (
                                    event.target !== event.currentTarget ||
                                    (event.key !== 'Enter' && event.key !== ' ')
                                  ) {
                                    return;
                                  }
                                  event.preventDefault();
                                  playAnimationClip(animation, clip);
                                }}
                                tabIndex={0}
                                title={`Preview ${clip.animation_name}`}
                              >
                                <span className="clip-file-icon">VRMA</span>
                                <strong>{clip.animation_name}</strong>
                                <small>
                                  {clip.origin === 'packaged'
                                    ? 'Packaged'
                                    : 'Uploaded'}
                                </small>
                                {clip.removable && (
                                  <button
                                    aria-label={`Delete ${clip.animation_name}`}
                                    className="clip-delete"
                                    disabled={busy || !bridge}
                                    onClick={() =>
                                      void deleteAnimationClip(animation, clip)
                                    }
                                    title={`Delete ${clip.animation_name}`}
                                    type="button"
                                  >
                                    ×
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              {editingAnimationId && (
                <section className="settings-panel import-panel edit-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Edit action details</h2>
                      <p>
                        These details describe the action to the Persona MCP
                        tool. Clips remain grouped under the action if its name
                        changes.
                      </p>
                    </div>
                  </div>
                  <div className="form-stack">
                    <label>
                      Action name <code>animation_name</code>
                      <input
                        maxLength={48}
                        onChange={(event) =>
                          setEditingAnimationMetadata((current) => ({
                            ...current,
                            animation_name: event.target.value,
                          }))
                        }
                        value={editingAnimationMetadata.animation_name}
                      />
                    </label>
                    <label>
                      Description <code>animation_description</code>
                      <textarea
                        maxLength={240}
                        onChange={(event) =>
                          setEditingAnimationMetadata((current) => ({
                            ...current,
                            animation_description: event.target.value,
                          }))
                        }
                        rows={3}
                        value={
                          editingAnimationMetadata.animation_description
                        }
                      />
                    </label>
                    <label>
                      Trigger scenario{' '}
                      <code>animation_trigger_scenario</code>
                      <textarea
                        maxLength={240}
                        onChange={(event) =>
                          setEditingAnimationMetadata((current) => ({
                            ...current,
                            animation_trigger_scenario: event.target.value,
                          }))
                        }
                        rows={3}
                        value={
                          editingAnimationMetadata.animation_trigger_scenario
                        }
                      />
                    </label>
                    <ExpressionFields
                      metadata={editingAnimationMetadata}
                      onChange={(patch) =>
                        setEditingAnimationMetadata((current) => ({
                          ...current,
                          ...patch,
                        }))
                      }
                      availableExpressions={availableExpressions}
                    />
                  </div>
                  <div className="form-actions">
                    <button
                      className="primary-button"
                      disabled={
                        busy ||
                        !editingAnimationMetadata.animation_name.trim() ||
                        !editingAnimationMetadata.animation_description.trim() ||
                        !editingAnimationMetadata.animation_trigger_scenario.trim()
                      }
                      onClick={() => void saveAnimation()}
                      type="button"
                    >
                      Save changes
                    </button>
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => setEditingAnimationId(null)}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                </section>
              )}

              <section className="settings-panel import-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Create a custom action</h2>
                    <p>
                      Create the MCP-visible action first, then add any number
                      of VRMA clips from its card above.
                    </p>
                  </div>
                  <span className="file-pill">Action</span>
                </div>
                <div className="form-stack">
                  <label>
                    Action name <code>animation_name</code>
                    <input
                      maxLength={48}
                      onChange={(event) =>
                        setAnimationMetadata((current) => ({
                          ...current,
                          animation_name: event.target.value,
                        }))
                      }
                      placeholder="e.g. wave-hello"
                      value={animationMetadata.animation_name}
                    />
                    <small>
                      Lowercase letters, numbers, and hyphens. Clips added to
                      this action are named automatically, such as wave-hello1
                      and wave-hello2.
                    </small>
                  </label>
                  <label>
                    Description <code>animation_description</code>
                    <textarea
                      maxLength={240}
                      onChange={(event) =>
                        setAnimationMetadata((current) => ({
                          ...current,
                          animation_description: event.target.value,
                        }))
                      }
                      placeholder="Describe what the movement looks and feels like."
                      rows={3}
                      value={animationMetadata.animation_description}
                    />
                  </label>
                  <label>
                    Trigger scenario <code>animation_trigger_scenario</code>
                    <textarea
                      maxLength={240}
                      onChange={(event) =>
                        setAnimationMetadata((current) => ({
                          ...current,
                          animation_trigger_scenario: event.target.value,
                        }))
                      }
                      placeholder="Explain when an agent should choose this action."
                      rows={3}
                      value={animationMetadata.animation_trigger_scenario}
                    />
                  </label>
                  <ExpressionFields
                    metadata={animationMetadata}
                    onChange={(patch) =>
                      setAnimationMetadata((current) => ({
                        ...current,
                        ...patch,
                      }))
                    }
                    availableExpressions={availableExpressions}
                  />
                </div>
                <button
                  className="primary-button"
                  disabled={
                    busy ||
                    !bridge ||
                    !animationMetadata.animation_name.trim() ||
                    !animationMetadata.animation_description.trim() ||
                    !animationMetadata.animation_trigger_scenario.trim()
                  }
                  onClick={() => void createAnimation()}
                  type="button"
                >
                  Create action
                </button>
              </section>
            </>
          )}

          {section === 'appearance' && (
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
          )}

          {section === 'developer' && (
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
                      className="primary-button"
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
                          behavior. Changes save automatically.
                        </p>
                      </div>
                      <button
                        className="lighting-reset-button"
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
                          animations. Changes apply live.
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
          )}

          {section === 'voice' && (
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
                  <p className="theme-note">
                    The expression is case-insensitive and works across Linux,
                    macOS, and Windows.{' '}
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
                        !voicePattern.trim()
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
          )}

          {section === 'mcp' && (
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
                  {(mcpStatus?.tools ?? Object.keys(MCP_TOOL_DESCRIPTIONS)).map(
                    (tool) => (
                      <article key={tool}>
                        <code>{tool}</code>
                        <p>
                          {MCP_TOOL_DESCRIPTIONS[tool] ??
                            'Persona MCP tool'}
                        </p>
                      </article>
                    ),
                  )}
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
          )}
        </div>
      </section>

      <aside className="settings-preview">
        <button
          aria-expanded={!previewCollapsed}
          aria-label={
            previewCollapsed ? 'Expand preview pane' : 'Collapse preview pane'
          }
          className="settings-preview-toggle"
          onClick={() => setPreviewCollapsed((collapsed) => !collapsed)}
          title={previewCollapsed ? 'Expand preview' : 'Collapse preview'}
          type="button"
        >
          <span aria-hidden="true">{previewCollapsed ? '‹' : '›'}</span>
        </button>

        {!previewCollapsed && (
          <>
            <div className="preview-header">
              <div>
                <span className="eyebrow">Live preview</span>
                <strong>{selectedModel?.model_name ?? 'Persona'}</strong>
              </div>
              <span className="preview-live">
                <i />
                Live
              </span>
            </div>
            <div className="preview-stage" data-testid="settings-preview">
              {selectedModel && (
                <Scene
                  animation={previewType}
                  animationRequest={previewRequest}
                  animationUrls={previewAnimationUrls}
                  fallbackAnimationUrls={idleAnimationUrls}
                  expressionName={previewExpression.expressionName}
                  expressionWeight={previewExpression.expressionWeight}
                  onExpressionsChange={handleExpressionsChange}
                  audioLevel={0}
                  bodySpeaking={previewType === 'TALK'}
                  characterSize={settings.character_size}
                  lighting={previewLighting}
                  enablePan={false}
                  framingMargin={1.22}
                  groundShadow
                  modelUrl={selectedModel.asset_url}
                  onAnimationComplete={() => {
                    setPreviewAnimation(null);
                    setPreviewClipId(null);
                  }}
                  playback={previewClip ? 'once' : 'loop'}
                  speaking={previewType === 'TALK'}
                  bodyTransitionMs={settings.body_transition_ms}
                  speakingDebounceMs={settings.speaking_debounce_ms}
                  idleInterimMs={settings.idle_interim_ms}
                  speakingTransition={settings.speaking_transition}
                />
              )}
              <div className="preview-hint">
                Drag to rotate · Scroll to zoom
              </div>
            </div>
            <div className="preview-now-playing">
              <span>Now previewing</span>
              <strong>{previewTitle}</strong>
              {previewAnimation && (
                <small>{previewAnimation.animation_description}</small>
              )}
            </div>
          </>
        )}
      </aside>

      {confirmation && (
        <div
          className="settings-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !confirming) {
              closeConfirmation();
            }
          }}
        >
          <div
            aria-busy={confirming}
            aria-describedby="settings-confirmation-detail"
            aria-labelledby="settings-confirmation-title"
            aria-modal="true"
            className="settings-dialog"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !confirming) {
                event.preventDefault();
                closeConfirmation();
                return;
              }
              if (event.key !== 'Tab') return;
              const first = confirmationCancelRef.current;
              const last = confirmationConfirmRef.current;
              if (!first || !last) return;
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (
                !event.shiftKey &&
                document.activeElement === last
              ) {
                event.preventDefault();
                first.focus();
              }
            }}
            ref={confirmationDialogRef}
            role="dialog"
          >
            <div className="settings-dialog-icon" aria-hidden="true">
              !
            </div>
            <div className="settings-dialog-copy">
              <span className="eyebrow">Confirm change</span>
              <h2 id="settings-confirmation-title">
                {confirmation.title}
              </h2>
              <div
                className="settings-dialog-detail"
                id="settings-confirmation-detail"
              >
                {confirmation.detail}
              </div>
            </div>
            <div className="settings-dialog-actions">
              <button
                className="secondary-button"
                disabled={confirming}
                onClick={closeConfirmation}
                ref={confirmationCancelRef}
                type="button"
              >
                Cancel
              </button>
              <button
                className="settings-dialog-confirm"
                disabled={confirming}
                onClick={() => void confirmPendingAction()}
                ref={confirmationConfirmRef}
                type="button"
              >
                {confirming ? 'Working…' : confirmation.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
