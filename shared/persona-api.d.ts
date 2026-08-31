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

/**
 * Renderer-facing form of a hold. Integrations post `{ type:
 * 'expression-hold', animation_name }` to the bridge; the main process
 * resolves that action's configured expression and forwards this event, so the
 * renderer never has to look at animation metadata.
 */
export interface ExpressionHoldEvent {
  type: 'expression-hold';
  expressionName: PersonaExpressionName;
  expressionWeight?: number;
}

/**
 * Emitted when an integration posts `{ type: 'expression-release' }`, and also
 * when the main process drops a hold on its own (hold timeout, or the model
 * being unconfigured).
 */
export interface ExpressionReleaseEvent {
  type: 'expression-release';
}

/**
 * `silhouette` hands input back over the character and passes the transparent
 * gaps through; `whole-window` ignores the mouse everywhere, which is all a
 * platform without Electron's mouse-move forwarding can offer.
 */
export type ClickThroughMode = 'silhouette' | 'whole-window';

export interface ClickThroughSnapshot {
  enabled: boolean;
  mode: ClickThroughMode;
}

// Tells the renderer how the avatar window is behaving rather than what the
// voice is doing, so it travels the renderer channel without becoming the
// snapshot the renderer reads for its initial voice state.
export interface ClickThroughEvent extends ClickThroughSnapshot {
  type: 'click-through';
}

/**
 * Asks the renderer to frame the character again. A pan can put it outside the
 * viewport with no way back, and the camera is the renderer's half of the fix.
 */
export interface ResetViewEvent {
  type: 'reset-view';
}

export type AvatarRendererEvent =
  | BridgeEvent
  | AnimationPlaybackEvent
  | ExpressionHoldEvent
  | ExpressionReleaseEvent
  | ClickThroughEvent
  | ResetViewEvent;

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
  source: 'packaged' | 'imported' | 'kimodo';
  removable: boolean;
  asset_url: string;
}

export interface PersonaAnimationLibraryClip {
  id: string;
  clip_name: string;
  source: 'imported' | 'kimodo';
  asset_url: string;
  created_at: string;
  prompt: string | null;
  generation_job_id: string | null;
  linked_action_ids: string[];
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
  click_through_enabled: boolean;
  /** Whether the character watches the cursor. Its tuning is not offered. */
  look_at_cursor: boolean;
  developer_settings_enabled: boolean;
  vroid_hub_allow_plaintext_storage: boolean;
  body_transition_ms: number;
  speaking_debounce_ms: number;
  idle_interim_ms: number;
  speaking_transition: PersonaSpeakingTransitionSettings;
  packaged_animation_change_count: number;
  models: PersonaModelSettings[];
  animations: PersonaAnimationSettings[];
  /** Reusable user-owned VRMA files. Actions only link to these records. */
  animation_clips: PersonaAnimationLibraryClip[];
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

export interface PersonaAnimationGeneratorConfig {
  enabled: boolean;
  server_url: string;
  model: string;
  mcp_enabled: boolean;
}

export interface PersonaKimodoModel {
  id: string;
  label: string;
  skeleton_key: string;
  available: boolean;
  reason: string | null;
  license: string | null;
  license_url: string | null;
}

export interface PersonaAnimationGeneratorStatus {
  checked_at: string;
  config: PersonaAnimationGeneratorConfig;
  error: string | null;
  health: 'disabled' | 'ready' | 'unavailable';
  models: PersonaKimodoModel[];
}

export type PersonaAnimationGenerationPhase =
  | 'queued'
  | 'submitting'
  | 'generating'
  | 'downloading'
  | 'converting'
  | 'installing'
  | 'ready'
  | 'failed'
  | 'interrupted';

export type PersonaAnimationGenerationErrorCode =
  | 'GENERATOR_CAPACITY_REACHED'
  | 'GENERATOR_INCOMPATIBLE'
  | 'GENERATOR_INTERRUPTED'
  | 'GENERATOR_MODEL_UNAVAILABLE'
  | 'GENERATOR_OFFLINE'
  | 'GENERATOR_OUTPUT_INVALID'
  | 'GENERATOR_QUEUE_REJECTED'
  | 'GENERATOR_STORAGE_FULL'
  | 'GENERATOR_TIMED_OUT'
  | 'CONVERTER_FAILED'
  | 'VRMA_VALIDATION_FAILED'
  | 'ASSET_INSTALL_FAILED';

export interface PersonaAnimationGenerationRequest {
  prompt: string;
  clip_name?: string;
  /** @deprecated Generation now creates a reusable clip, not an action. */
  animation_name?: string;
  animation_description?: string;
  animation_trigger_scenario?: string;
  expression_name?: PersonaExpressionName | null;
  expression_weight?: number;
  frames?: number;
  steps?: number;
  seed?: number;
}

export interface PersonaAnimationGenerationJob {
  id: string;
  /** Legacy v1 fields. New jobs are not coupled to an action. */
  action_id: string | null;
  action_name: string | null;
  clip_id: string | null;
  clip_name: string;
  prompt: string;
  phase: PersonaAnimationGenerationPhase;
  error: string | null;
  error_code: PersonaAnimationGenerationErrorCode | null;
  /** The active stage that failed or was interrupted, used for safe recovery. */
  failure_phase: Exclude<PersonaAnimationGenerationPhase, 'ready' | 'failed' | 'interrupted'> | null;
  /** Starts at one and increases only after an explicit retry. */
  attempt: number;
  provider_animation_id: string | null;
  frames: number;
  steps: number;
  seed: number;
  model: string;
  model_license: string | null;
  source_sha256: string | null;
  vrma_sha256: string | null;
  converter_version: string;
  created_at: string;
  updated_at: string;
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
  getClickThrough(): Promise<ClickThroughSnapshot>;
  getSnapshot(): Promise<AvatarRendererEvent | null>;
  hide(): void;
  moveBy(dx: number, dy: number): void;
  setMousePassthrough(ignore: boolean): void;
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
  createAnimationWithClips(
    metadata: CustomAnimationMetadata,
    clipIds: string[],
  ): Promise<PersonaSettingsSnapshot>;
  addAnimationClips(
    animationId: string,
  ): Promise<PersonaSettingsSnapshot | null>;
  importAnimationClips(): Promise<PersonaSettingsSnapshot | null>;
  attachAnimationClip(
    animationId: string,
    clipId: string,
  ): Promise<PersonaSettingsSnapshot>;
  attachAnimationClips(
    animationId: string,
    clipIds: string[],
  ): Promise<PersonaSettingsSnapshot>;
  detachAnimationClip(
    animationId: string,
    clipId: string,
  ): Promise<PersonaSettingsSnapshot>;
  deleteAnimationLibraryClip(clipId: string): Promise<PersonaSettingsSnapshot>;
  exportAnimationLibraryClip(clipId: string): Promise<boolean>;
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
  /**
   * The mode the running platform can offer. Derived from the platform rather
   * than stored, so it is read separately from the snapshot that persists
   * whether click-through is on.
   */
  getClickThroughMode(): Promise<ClickThroughMode>;
  setClickThroughEnabled(enabled: boolean): Promise<PersonaSettingsSnapshot>;
  setLookAtCursor(enabled: boolean): Promise<PersonaSettingsSnapshot>;
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
  openKimodoRepository(): Promise<void>;
  getAnimationGeneratorStatus(): Promise<PersonaAnimationGeneratorStatus>;
  setAnimationGeneratorConfig(
    config: PersonaAnimationGeneratorConfig,
  ): Promise<PersonaAnimationGeneratorStatus>;
  checkAnimationGenerator(): Promise<PersonaAnimationGeneratorStatus>;
  generateAnimation(
    request: PersonaAnimationGenerationRequest,
  ): Promise<PersonaAnimationGenerationJob>;
  retryAnimationGeneration(jobId: string): Promise<PersonaAnimationGenerationJob>;
  discardAnimationGeneration(jobId: string): Promise<PersonaAnimationGenerationJob[]>;
  listAnimationGenerations(): Promise<PersonaAnimationGenerationJob[]>;
  clearAnimationGenerations(): Promise<PersonaAnimationGenerationJob[]>;
  setWindowTheme(theme: 'light' | 'dark'): void;
  subscribe(
    listener: (snapshot: PersonaSettingsSnapshot) => void,
  ): () => void;
  subscribeAnimationGenerations(
    listener: (job: PersonaAnimationGenerationJob) => void,
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
