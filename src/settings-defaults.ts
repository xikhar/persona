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

export const DEFAULT_LIGHTING: PersonaLightingSettings = {
  tone_mapping: 'none',
  exposure: 1,
  environment_enabled: true,
  environment_intensity: 1,
  key_light_intensity: Math.PI,
  ambient_intensity: Math.PI,
};

export function resolveLightingSettings(
  lighting?: Partial<PersonaLightingSettings> | null,
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
  schema_version: 3,
  default_model_id: null,
  character_size: 1,
  packaged_animation_change_count: 0,
  models: [],
  animations: SYSTEM_ACTIONS,
  model_lighting: {},
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
