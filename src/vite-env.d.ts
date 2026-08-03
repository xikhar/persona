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

interface PersonaModelSettings {
  id: string;
  model_name: string;
  origin: 'packaged' | 'user';
  removable: boolean;
  asset_url: string;
}

interface PersonaAnimationSettings {
  id: string;
  animation_name: string;
  animation_description: string;
  animation_trigger_scenario: string;
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

interface PersonaSettingsSnapshot {
  schema_version: number;
  default_model_id: string | null;
  character_size: number;
  developer_settings_enabled: boolean;
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
}

type AvatarBridgeEvent =
  | { type: 'state'; state: VoiceState }
  | { type: 'audio-level'; level: number; bands?: Record<string, number> }
  | {
      type: 'animation';
      animation: PersonaAnimationType | 'CUSTOM';
      animationName?: string;
      animationUrls?: string[];
      source?: 'command';
      requestId?: number;
    }
  | { type: 'listener-status'; status: AudioListenerStatus }
  | { type: 'bridge-status'; connected: boolean };

interface Window {
  personaBridge?: {
    getSnapshot(): Promise<AvatarBridgeEvent | null>;
    hide(): void;
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
    setSpeakingTransition(
      transition: PersonaSpeakingTransitionSettings,
    ): Promise<PersonaSettingsSnapshot>;
    setBodyTransitionMs(milliseconds: number): Promise<PersonaSettingsSnapshot>;
    setSpeakingDebounceMs(milliseconds: number): Promise<PersonaSettingsSnapshot>;
    setIdleInterimMs(milliseconds: number): Promise<PersonaSettingsSnapshot>;
    enableDeveloperSettings(): Promise<PersonaSettingsSnapshot>;
    resetDeveloperSettings(): Promise<PersonaSettingsSnapshot>;
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
}
