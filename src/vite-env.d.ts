/// <reference types="vite/client" />

type VoicePhase = 'inactive' | 'starting' | 'active' | 'stopping';
type VoiceActivity = 'idle' | 'listening' | 'speaking';

interface VoiceState {
  activity: VoiceActivity;
  locator?: { conversationId?: string; hostId?: string } | null;
  microphoneMuted: boolean;
  outputMuted: boolean;
  phase: VoicePhase;
  preferredPresentationSurface?: string | null;
  sessionId?: string | null;
}

interface AudioListenerStatus {
  available: boolean;
  capturing: boolean;
  error?: string;
  monitoring: boolean;
  source: string | null;
}

interface PersonaLightingSettings {
  tone_mapping: 'none' | 'aces';
  exposure: number;
  environment_enabled: boolean;
  environment_intensity: number;
  key_light_intensity: number;
  ambient_intensity: number;
}

interface PersonaSpeakingTransitionSettings {
  entry_ms: readonly [number, number];
  exit_ms: readonly [number, number];
}

type PersonaAnimationType =
  | 'IDLE'
  | 'GREETING'
  | 'TALK'
  | 'HAPPY'
  | 'FINGER_GUN'
  | 'DANCE';


type PersonaExpressionName =
  | 'happy'
  | 'angry'
  | 'sad'
  | 'relaxed'
  | 'surprised';

interface PersonaModelSettings {
  id: string;
  model_name: string;
  origin: 'packaged' | 'user' | 'hub';
  removable: boolean;
  asset_url: string;
}

interface PersonaAnimationSettings {
  id: string;
  animation_name: string;
  animation_description: string;
  animation_trigger_scenario: string;
  expression_name: PersonaExpressionName | null;
  expression_weight: number;
  animation_type: PersonaAnimationType | null;
  origin: 'packaged' | 'user';
  system: boolean;
  editable: boolean;
  modified: boolean;
  removable: boolean;
  clips: PersonaAnimationClipSettings[];
  asset_urls: string[];
}

interface PersonaAnimationClipSettings {
  id: string;
  animation_name: string;
  origin: 'packaged' | 'user';
  removable: boolean;
  asset_url: string;
}

interface PersonaVoiceSourceSettings {
  mode: 'default' | 'application' | 'custom' | 'external';
  process_pattern: string | null;
  source_id: string | null;
  source_name: string | null;
}

interface PersonaVoiceSource {
  id: string;
  name: string;
  detail: string;
  platform: 'linux' | 'darwin' | 'win32';
}

interface PersonaVoiceSourceCatalog {
  error: string | null;
  events_url: string;
  listener: AudioListenerStatus | null;
  platform: string;
  sources: PersonaVoiceSource[];
}

interface PersonaAvatarWindowSize {
  width: number;
  height: number;
}

interface PersonaSettingsSnapshot {
  schema_version: number;
  default_model_id: string | null;
  character_size: number;
  avatar_window: PersonaAvatarWindowSize;
  developer_settings_enabled: boolean;
  vroid_hub_allow_plaintext_storage: boolean;
  body_transition_ms: number;
  speaking_debounce_ms: number;
  idle_interim_ms: number;
  speaking_transition: PersonaSpeakingTransitionSettings;
  packaged_animation_change_count: number;
  models: PersonaModelSettings[];
  animations: PersonaAnimationSettings[];
  model_lighting: Record<string, PersonaLightingSettings>;
  voice_source: PersonaVoiceSourceSettings;
}

interface PersonaMcpStatus {
  checked_at: string;
  error: string | null;
  health: 'starting' | 'online' | 'unavailable';
  health_url: string;
  local_only: boolean;
  playable_actions: string[];
  server_url: string;
  setup_command: string;
  tools: string[];
  transport: string;
  version: string;
}

interface CustomAnimationMetadata {
  animation_name: string;
  animation_description: string;
  animation_trigger_scenario: string;
  expression_name: PersonaExpressionName | null;
  expression_weight: number;
}

interface PersonaVroidHubStatus {
  configured: boolean;
  connected: boolean;
  redirect_uri: string;
}

interface PersonaVroidHubCredentials {
  clientId: string | null;
  hasClientSecret: boolean;
}

type VroidHubUsagePermission = 'default' | 'disallow' | 'allow';

// VRM 0.0's conditions of use: a top-level `license` object on the character
// model, snake_case, VRoid-Hub-specific vocabulary.
interface PersonaVroidHubCharacterLicenseV0 {
  spec_version: '0.0';
  characterization_allowed_user?: 'default' | 'author' | 'everyone';
  personal_commercial_use?: 'default' | 'disallow' | 'profit' | 'nonprofit';
  corporate_commercial_use?: VroidHubUsagePermission;
  modification?: VroidHubUsagePermission;
  redistribution?: VroidHubUsagePermission;
  credit?: 'default' | 'necessary' | 'unnecessary';
  violent_expression?: VroidHubUsagePermission;
  sexual_expression?: VroidHubUsagePermission;
}

// VRM 1.0's conditions of use: flat fields on vrm_meta (VRM1Meta), camelCase,
// the VRM spec's own vocabulary — no shared shape with the V0 license above.
// See node_modules/@pixiv/three-vrm-core/types/meta/VRM1Meta.d.ts.
interface PersonaVroidHubCharacterLicenseV1 {
  spec_version: '1.0';
  avatarPermission?: 'onlyAuthor' | 'onlySeparatelyLicensedPerson' | 'everyone';
  allowExcessivelyViolentUsage?: boolean;
  allowExcessivelySexualUsage?: boolean;
  commercialUsage?: 'personalNonProfit' | 'personalProfit' | 'corporation';
  allowPoliticalOrReligiousUsage?: boolean;
  allowAntisocialOrHateUsage?: boolean;
  creditNotation?: 'required' | 'unnecessary';
  allowRedistribution?: boolean;
  modification?: 'prohibited' | 'allowModification' | 'allowModificationRedistribution';
}

type PersonaVroidHubCharacterLicense =
  | PersonaVroidHubCharacterLicenseV0
  | PersonaVroidHubCharacterLicenseV1;

interface PersonaVroidHubCharacter {
  // The character *model*'s id — what downloads and page links are keyed by.
  id: string;
  // The id of the character the model belongs to, needed alongside `id` to
  // address the model's page on hub.vroid.com. Null when VRoid Hub omitted it.
  character_id: string | null;
  name: string;
  is_downloadable: boolean;
  portrait_url: string | null;
  origin: 'own' | 'hearted';
  license: PersonaVroidHubCharacterLicense | null;
}

type AvatarBridgeEvent =
  | { type: 'state'; state: VoiceState }
  | { type: 'audio-level'; level: number; bands?: Record<string, number> }
  | {
      type: 'animation';
      animation: PersonaAnimationType | 'CUSTOM';
      animationName?: string;
      animationUrls?: string[];
      expressionName?: PersonaExpressionName | null;
      expressionWeight?: number;
      source?: 'command';
      requestId?: number;
    }
  | { type: 'listener-status'; status: AudioListenerStatus }
  | { type: 'bridge-status'; connected: boolean };

interface Window {
  personaBridge?: {
    getSnapshot(): Promise<AvatarBridgeEvent | null>;
    hide(): void;
    moveBy(dx: number, dy: number): void;
    subscribe(listener: (event: AvatarBridgeEvent) => void): () => void;
  };
  personaSettings?: {
    get(): Promise<PersonaSettingsSnapshot>;
    importModel(
      metadata: { model_name: string },
    ): Promise<PersonaSettingsSnapshot | null>;
    createAnimation(
      metadata: CustomAnimationMetadata,
    ): Promise<PersonaSettingsSnapshot>;
    addAnimationClips(
      animationId: string,
    ): Promise<PersonaSettingsSnapshot | null>;
    updateAnimation(
      animationId: string,
      metadata: CustomAnimationMetadata,
    ): Promise<PersonaSettingsSnapshot>;
    deleteAnimation(animationId: string): Promise<PersonaSettingsSnapshot>;
    deleteAnimationClip(
      animationId: string,
      clipId: string,
    ): Promise<PersonaSettingsSnapshot>;
    resetPackagedAnimations(): Promise<PersonaSettingsSnapshot>;
    deleteModel(modelId: string): Promise<PersonaSettingsSnapshot>;
    setDefaultModel(modelId: string): Promise<PersonaSettingsSnapshot>;
    setCharacterSize(size: number): Promise<PersonaSettingsSnapshot>;
    setAvatarWindowSize(
      width: number,
      height: number,
    ): Promise<PersonaSettingsSnapshot>;
    setSpeakingTransition(
      transition: PersonaSpeakingTransitionSettings,
    ): Promise<PersonaSettingsSnapshot>;
    setBodyTransitionMs(milliseconds: number): Promise<PersonaSettingsSnapshot>;
    setSpeakingDebounceMs(milliseconds: number): Promise<PersonaSettingsSnapshot>;
    setIdleInterimMs(milliseconds: number): Promise<PersonaSettingsSnapshot>;
    enableDeveloperSettings(): Promise<PersonaSettingsSnapshot>;
    resetDeveloperSettings(): Promise<PersonaSettingsSnapshot>;
    setVroidHubPlaintextStorageAllowed(
      allowed: boolean,
    ): Promise<PersonaSettingsSnapshot>;
    setVoiceSource(
      voiceSource: PersonaVoiceSourceSettings,
    ): Promise<PersonaSettingsSnapshot>;
    listVoiceSources(): Promise<PersonaVoiceSourceCatalog>;
    setModelLighting(
      modelId: string,
      lighting: Partial<PersonaLightingSettings>,
    ): Promise<PersonaSettingsSnapshot>;
    resetModelLighting(modelId: string): Promise<PersonaSettingsSnapshot>;
    getMcpStatus(): Promise<PersonaMcpStatus>;
    setWindowTheme(theme: 'light' | 'dark'): void;
    subscribe(
      listener: (snapshot: PersonaSettingsSnapshot) => void,
    ): () => void;
  };
  personaVroidHub?: {
    getStatus(): Promise<PersonaVroidHubStatus>;
    getCredentials(): Promise<PersonaVroidHubCredentials>;
    setCredentials(
      clientId: string,
      clientSecret: string,
    ): Promise<PersonaVroidHubStatus>;
    clearCredentials(): Promise<PersonaVroidHubStatus>;
    connect(): Promise<PersonaVroidHubStatus>;
    disconnect(): Promise<PersonaVroidHubStatus>;
    listCharacters(): Promise<PersonaVroidHubCharacter[]>;
    // Resolves to a data: URL for the character's portrait, or null when the
    // model has none — the renderer's CSP forbids loading it from VRoid Hub's
    // image CDN directly.
    getCharacterPortrait(characterId: string): Promise<string | null>;
    selectCharacter(
      characterId: string,
      characterName: string,
    ): Promise<PersonaSettingsSnapshot>;
    openCharacterPage(
      characterId: string,
      characterModelId: string,
    ): Promise<void>;
    subscribe(
      listener: (status: PersonaVroidHubStatus) => void,
    ): () => void;
  };
}
