import {
  DEFAULT_BODY_TRANSITION_MS,
  DEFAULT_IDLE_INTERIM_MS,
  DEFAULT_SPEAKING_DEBOUNCE_MS,
  DEFAULT_SPEAKING_TRANSITION,
} from './animation-scheduler';

interface PackagedLibraryDocument {
  schema_version: number;
  default_model_id: string | null;
  models: Array<{
    id: string;
    model_name: string;
    asset_path: string;
  }>;
  animations: Array<{
    id: string;
    animation_name: string;
    animation_description: string;
    animation_trigger_scenario: string;
    animation_type: PersonaAnimationType | null;
    expression_name?: PersonaExpressionName | null;
    expression_weight?: number;
    asset_paths: string[];
  }>;
}

const SYSTEM_ACTIONS: PersonaAnimationSettings[] = [
  {
    id: 'system-idle',
    animation_name: 'idle',
    animation_description: 'A calm resting motion for the character.',
    animation_trigger_scenario:
      'Used automatically while Persona is waiting and not speaking.',
    expression_name: null,
    expression_weight: 1,
    animation_type: 'IDLE',
    origin: 'packaged',
    system: true,
    editable: false,
    modified: false,
    removable: false,
    clips: [],
    asset_urls: [],
  },
  {
    id: 'system-speaking',
    animation_name: 'speaking',
    animation_description:
      'Natural conversational body movement while the character speaks.',
    animation_trigger_scenario:
      'Used automatically while supported voice output is active.',
    expression_name: null,
    expression_weight: 1,
    animation_type: 'TALK',
    origin: 'packaged',
    system: true,
    editable: false,
    modified: false,
    removable: false,
    clips: [],
    asset_urls: [],
  },
];

export const MIN_AVATAR_WINDOW_WIDTH = 320;
export const MAX_AVATAR_WINDOW_WIDTH = 2160;
export const MIN_AVATAR_WINDOW_HEIGHT = 480;
export const MAX_AVATAR_WINDOW_HEIGHT = 3840;
export const DEFAULT_AVATAR_WINDOW_SIZE: PersonaAvatarWindowSize = {
  width: 430,
  height: 680,
};

export const DEFAULT_LIGHTING: PersonaLightingSettings = {
  tone_mapping: 'none',
  exposure: 1,
  environment_enabled: true,
  environment_intensity: 1,
  key_light_intensity: Math.PI,
  ambient_intensity: Math.PI,
};

export type LightingNumberField =
  | 'exposure'
  | 'environment_intensity'
  | 'key_light_intensity'
  | 'ambient_intensity';

/**
 * Mirrors MODEL_LIGHTING_RANGES in electron/settings-store.cts. The store is
 * the authority and clamps again on save; these bound the controls so a value
 * the store would reject never reaches it in the first place.
 */
export const LIGHTING_NUMBER_RANGES: Record<
  LightingNumberField,
  readonly [number, number]
> = {
  exposure: [0.1, 3],
  environment_intensity: [0, 2],
  key_light_intensity: [0, 4],
  ambient_intensity: [0, 4],
};

/** The value if the field can take it, or null while the input is unusable. */
export function lightingNumberInRange(
  field: LightingNumberField,
  value: number,
): number | null {
  const [minimum, maximum] = LIGHTING_NUMBER_RANGES[field];
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

/**
 * Every field independently absent *or* explicitly undefined. Stored profiles
 * are parsed JSON that may carry either, and this function's whole job is to
 * fill both in.
 */
export type StoredLightingSettings = {
  [Field in keyof PersonaLightingSettings]?:
    | PersonaLightingSettings[Field]
    | undefined;
};

export function resolveLightingSettings(
  lighting?: StoredLightingSettings | null,
): PersonaLightingSettings {
  return {
    tone_mapping:
      lighting?.tone_mapping ?? DEFAULT_LIGHTING.tone_mapping,
    exposure: lighting?.exposure ?? DEFAULT_LIGHTING.exposure,
    environment_enabled:
      lighting?.environment_enabled ??
      DEFAULT_LIGHTING.environment_enabled,
    environment_intensity:
      lighting?.environment_intensity ??
      DEFAULT_LIGHTING.environment_intensity,
    key_light_intensity:
      lighting?.key_light_intensity ??
      DEFAULT_LIGHTING.key_light_intensity,
    ambient_intensity:
      lighting?.ambient_intensity ??
      DEFAULT_LIGHTING.ambient_intensity,
  };
}

export const SETTINGS_FALLBACK: PersonaSettingsSnapshot = {
  schema_version: 10,
  default_model_id: null,
  character_size: 1,
  avatar_window: { ...DEFAULT_AVATAR_WINDOW_SIZE },
  click_through_enabled: false,
  look_at_cursor: true,
  developer_settings_enabled: false,
  vroid_hub_allow_plaintext_storage: false,
  body_transition_ms: DEFAULT_BODY_TRANSITION_MS,
  speaking_debounce_ms: DEFAULT_SPEAKING_DEBOUNCE_MS,
  idle_interim_ms: DEFAULT_IDLE_INTERIM_MS,
  speaking_transition: { ...DEFAULT_SPEAKING_TRANSITION },
  packaged_animation_change_count: 0,
  models: [],
  animations: SYSTEM_ACTIONS,
  animation_clips: [],
  model_lighting: {},
  voice_source: {
    mode: 'default',
    process_pattern: null,
    source_id: null,
    source_name: null,
  },
};

function packagedAssetUrl(relativePath: string): string {
  return `./assets/${relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

export async function loadPackagedSettingsFallback(): Promise<PersonaSettingsSnapshot> {
  const response = await fetch('./assets/library.json');
  if (!response.ok) throw new Error('Unable to load the packaged library.');
  const library = (await response.json()) as PackagedLibraryDocument;
  const defaultModelId =
    library.default_model_id ?? library.models[0]?.id ?? null;
  const configuredAnimations = library.animations.map((animation) => ({
    id: animation.id,
    animation_name: animation.animation_name,
    animation_description: animation.animation_description,
    animation_trigger_scenario: animation.animation_trigger_scenario,
    expression_name: animation.expression_name ?? null,
    expression_weight: animation.expression_weight ?? 1,
    animation_type: animation.animation_type,
    origin: 'packaged' as const,
    system:
      animation.id === 'system-idle' ||
      animation.id === 'system-speaking',
    editable:
      animation.id !== 'system-idle' &&
      animation.id !== 'system-speaking',
    modified: false,
    removable:
      animation.id !== 'system-idle' &&
      animation.id !== 'system-speaking',
    clips: animation.asset_paths.map((assetPath, index) => ({
      id: `${animation.id}:packaged:${index + 1}`,
      animation_name: `${animation.animation_name}${index + 1}`,
      origin: 'packaged' as const,
      source: 'packaged' as const,
      removable: false,
      asset_url: packagedAssetUrl(assetPath),
    })),
    asset_urls: animation.asset_paths.map(packagedAssetUrl),
  }));
  const configuredIds = new Set(
    configuredAnimations.map((animation) => animation.id),
  );
  return {
    ...SETTINGS_FALLBACK,
    default_model_id: defaultModelId,
    models: library.models.map((model) => ({
      id: model.id,
      model_name: model.model_name,
      origin: 'packaged',
      removable: false,
      asset_url: packagedAssetUrl(model.asset_path),
    })),
    animations: [
      ...SYSTEM_ACTIONS.filter((animation) => !configuredIds.has(animation.id)),
      ...configuredAnimations,
    ],
  };
}
