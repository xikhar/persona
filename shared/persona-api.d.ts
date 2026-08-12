export type VoicePhase = 'inactive' | 'starting' | 'active' | 'stopping';
export type VoiceActivity = 'idle' | 'listening' | 'speaking';
export type VoicePlatform = 'linux' | 'darwin' | 'win32';
export type VoiceSourceMode =
  | 'default'
  | 'application'
  | 'custom'
  | 'external';

export interface VoiceState {
  activity: VoiceActivity;
  locator?: { conversationId?: string; hostId?: string } | null;
  microphoneMuted: boolean;
  outputMuted: boolean;
  phase: VoicePhase;
  preferredPresentationSurface?: string | null;
  sessionId?: string | null;
}

export interface AudioListenerStatus {
  available: boolean;
  capturing: boolean;
  error?: string;
  monitoring: boolean;
  source: string | null;
}

export interface PersonaVoiceSourceSettings {
  mode: VoiceSourceMode;
  process_pattern: string | null;
  source_id: string | null;
  source_name: string | null;
}

export interface PersonaVoiceSource {
  id: string;
  name: string;
  detail: string;
  platform: VoicePlatform;
}

export interface VoiceStateEvent {
  type: 'state';
  state: VoiceState;
}

export interface AudioLevelEvent {
  type: 'audio-level';
  level: number;
  bands?: Record<string, unknown>;
}

export interface ListenerStatusEvent {
  type: 'listener-status';
  status: AudioListenerStatus;
}

export type BridgeEvent =
  | VoiceStateEvent
  | AudioLevelEvent
  | ListenerStatusEvent;

export type PersonaAnimationType =
  | 'IDLE'
  | 'GREETING'
  | 'TALK'
  | 'HAPPY'
  | 'FINGER_GUN'
  | 'DANCE';

export type PersonaExpressionName = string;

export interface AnimationPlaybackEvent {
  type: 'animation';
  animation: PersonaAnimationType | 'CUSTOM';
  animationName: string;
  animationUrls: string[];
  expressionName: PersonaExpressionName | null;
  expressionWeight: number;
  source: 'command';
  requestId: number;
}

export type AvatarRendererEvent = BridgeEvent | AnimationPlaybackEvent;

export interface PersonaLightingSettings {
  tone_mapping: 'none' | 'aces';
  exposure: number;
  environment_enabled: boolean;
  environment_intensity: number;
  key_light_intensity: number;
  ambient_intensity: number;
}

export interface PersonaSpeakingTransitionSettings {
  entry_ms: [number, number];
  exit_ms: [number, number];
}

export interface PersonaModelSettings {
  id: string;
  model_name: string;
  origin: 'packaged' | 'user' | 'hub';
  removable: boolean;
  asset_url: string;
}

export interface PersonaAnimationClipSettings {
  id: string;
  animation_name: string;
  origin: 'packaged' | 'user';
  removable: boolean;
  asset_url: string;
}

export interface CustomAnimationMetadata {
  animation_name: string;
  animation_description: string;
  animation_trigger_scenario: string;
  expression_name: PersonaExpressionName | null;
  expression_weight: number;
}

export interface PersonaAnimationSettings extends CustomAnimationMetadata {
  id: string;
  animation_type: PersonaAnimationType | null;
  origin: 'packaged' | 'user';
  system: boolean;
  editable: boolean;
  modified: boolean;
  removable: boolean;
  clips: PersonaAnimationClipSettings[];
  asset_urls: string[];
}

export interface PersonaAvatarWindowSize {
  width: number;
  height: number;
}

export interface PersonaSettingsSnapshot {
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

export interface PersonaVoiceSourceCatalog {
  error: string | null;
  events_url: string;
  listener: AudioListenerStatus | null;
  platform: string;
  sources: PersonaVoiceSource[];
}

export interface PersonaMcpStatus {
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

export interface PersonaVroidHubStatus {
  configured: boolean;
  connected: boolean;
  redirect_uri: string;
}

export interface PersonaVroidHubCredentials {
  clientId: string | null;
  hasClientSecret: boolean;
}

export type VroidHubUsagePermission = 'default' | 'disallow' | 'allow';

export interface PersonaVroidHubCharacterLicenseV0 {
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

export interface PersonaVroidHubCharacterLicenseV1 {
  spec_version: '1.0';
  avatarPermission?: 'onlyAuthor' | 'onlySeparatelyLicensedPerson' | 'everyone';
  allowExcessivelyViolentUsage?: boolean;
  allowExcessivelySexualUsage?: boolean;
  commercialUsage?: 'personalNonProfit' | 'personalProfit' | 'corporation';
  allowPoliticalOrReligiousUsage?: boolean;
  allowAntisocialOrHateUsage?: boolean;
  creditNotation?: 'required' | 'unnecessary';
  allowRedistribution?: boolean;
  modification?:
    | 'prohibited'
    | 'allowModification'
    | 'allowModificationRedistribution';
}

export type PersonaVroidHubCharacterLicense =
  | PersonaVroidHubCharacterLicenseV0
  | PersonaVroidHubCharacterLicenseV1;

export interface PersonaVroidHubCharacter {
  id: string;
  character_id: string | null;
  name: string;
  is_downloadable: boolean;
  portrait_url: string | null;
  origin: 'own' | 'hearted';
  license: PersonaVroidHubCharacterLicense | null;
}

export interface PersonaBridgeApi {
  getSnapshot(): Promise<AvatarRendererEvent | null>;
  hide(): void;
  moveBy(dx: number, dy: number): void;
  subscribe(listener: (event: AvatarRendererEvent) => void): () => void;
}

export interface PersonaSettingsApi {
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
}

export interface PersonaVroidHubApi {
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
}
