import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AnimationMetadata,
  AvatarWindowSize,
  ModelLighting,
  SettingsSnapshot,
  SpeakingTransition,
} from './settings-store.cjs';
import type {
  VoiceSourceSettings,
} from './types.cjs';
import type { VroidHubClient } from './vroid-hub-client.cjs';
import type {
  AvatarRendererEvent,
  ClickThroughMode,
  ClickThroughSnapshot,
  PersonaBridgeApi,
  PersonaAnimationGenerationJob,
  PersonaAnimationGenerationRequest,
  PersonaAnimationGeneratorConfig,
  PersonaAnimationGeneratorStatus,
  PersonaMcpStatus,
  PersonaSettingsApi,
  PersonaVroidHubApi,
  PersonaVroidHubCredentials,
  PersonaVroidHubStatus,
  PersonaVoiceSourceCatalog,
} from '../shared/persona-api.js';

type Unsubscribe = () => void;
type VroidHubCharacter = Awaited<
  ReturnType<VroidHubClient['listCharacters']>
>[number];

function subscribe<T>(
  channel: string,
  listener: (value: T) => void,
): Unsubscribe {
  const handler = (_event: IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

function invoke<TResult>(channel: string, ...args: unknown[]): Promise<TResult> {
  // Electron intentionally returns an untyped cross-process promise. Each
  // exposed method below supplies the result contract, and the complete
  // objects are checked with `satisfies` against the shared renderer API.
  return ipcRenderer.invoke(channel, ...args) as Promise<TResult>;
}

// The main process flushes startup events at `did-finish-load`, before React's
// effects have necessarily subscribed. Listen from preload startup and retain
// the latest value per state slot until the renderer attaches, otherwise a
// cold-start animation command can disappear between page load and mount.
const pendingPersonaEvents = new Map<string, AvatarRendererEvent>();
const personaEventListeners = new Set<(event: AvatarRendererEvent) => void>();

function personaEventKey(event: AvatarRendererEvent): string {
  return event.type === 'expression-hold' || event.type === 'expression-release'
    ? 'expression'
    : event.type;
}

ipcRenderer.on(
  'persona:event',
  (_event: IpcRendererEvent, value: AvatarRendererEvent) => {
    if (personaEventListeners.size === 0) {
      pendingPersonaEvents.set(personaEventKey(value), value);
      return;
    }
    for (const listener of personaEventListeners) listener(value);
  },
);

function subscribePersonaEvents(
  listener: (event: AvatarRendererEvent) => void,
): Unsubscribe {
  personaEventListeners.add(listener);
  if (pendingPersonaEvents.size > 0) {
    const pending = [...pendingPersonaEvents.values()];
    pendingPersonaEvents.clear();
    for (const event of pending) listener(event);
  }
  return () => personaEventListeners.delete(listener);
}

const personaBridge = {
  getClickThrough: (): Promise<ClickThroughSnapshot> =>
    invoke<ClickThroughSnapshot>('persona:get-click-through'),
  getSnapshot: (): Promise<AvatarRendererEvent | null> =>
    invoke<AvatarRendererEvent | null>('persona:get-snapshot'),
  hide: (): void => ipcRenderer.send('persona:hide'),
  moveBy: (dx: number, dy: number): void =>
    ipcRenderer.send('persona:move-by', dx, dy),
  setMousePassthrough: (ignore: boolean): void =>
    ipcRenderer.send('persona:set-mouse-passthrough', ignore),
  subscribe: (listener: (event: AvatarRendererEvent) => void): Unsubscribe =>
    subscribePersonaEvents(listener),
} satisfies PersonaBridgeApi;

const personaSettings = {
  get: (): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-get'),
  importModel: (metadata: { model_name: string }): Promise<SettingsSnapshot | null> =>
    invoke<SettingsSnapshot | null>('persona:settings-import-model', metadata),
  createAnimation: (metadata: AnimationMetadata): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-create-animation', metadata),
  createAnimationWithClips: (
    metadata: AnimationMetadata,
    clipIds: string[],
  ): Promise<SettingsSnapshot> => invoke<SettingsSnapshot>(
    'persona:settings-create-animation-with-clips',
    metadata,
    clipIds,
  ),
  addAnimationClips: (animationId: string): Promise<SettingsSnapshot | null> =>
    invoke<SettingsSnapshot | null>(
      'persona:settings-add-animation-clips',
      animationId,
    ),
  importAnimationClips: (): Promise<SettingsSnapshot | null> =>
    invoke<SettingsSnapshot | null>('persona:settings-import-animation-clips'),
  attachAnimationClip: (
    animationId: string,
    clipId: string,
  ): Promise<SettingsSnapshot> => invoke<SettingsSnapshot>(
    'persona:settings-attach-animation-clip',
    animationId,
    clipId,
  ),
  attachAnimationClips: (
    animationId: string,
    clipIds: string[],
  ): Promise<SettingsSnapshot> => invoke<SettingsSnapshot>(
    'persona:settings-attach-animation-clips',
    animationId,
    clipIds,
  ),
  detachAnimationClip: (
    animationId: string,
    clipId: string,
  ): Promise<SettingsSnapshot> => invoke<SettingsSnapshot>(
    'persona:settings-delete-animation-clip',
    animationId,
    clipId,
  ),
  deleteAnimationLibraryClip: (clipId: string): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-delete-animation-library-clip', clipId),
  exportAnimationLibraryClip: (clipId: string): Promise<boolean> =>
    invoke<boolean>('persona:settings-export-animation-library-clip', clipId),
  updateAnimation: (
    animationId: string,
    metadata: AnimationMetadata,
  ): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>(
      'persona:settings-update-animation',
      animationId,
      metadata,
    ),
  deleteAnimation: (animationId: string): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-delete-animation', animationId),
  deleteAnimationClip: (
    animationId: string,
    clipId: string,
  ): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>(
      'persona:settings-delete-animation-clip',
      animationId,
      clipId,
    ),
  resetPackagedAnimations: (): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-reset-packaged-animations'),
  deleteModel: (modelId: string): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-delete-model', modelId),
  setDefaultModel: (modelId: string): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-set-default-model', modelId),
  setCharacterSize: (size: number): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-set-character-size', size),
  setAvatarWindowSize: (
    width: AvatarWindowSize['width'],
    height: AvatarWindowSize['height'],
  ): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>(
      'persona:settings-set-avatar-window-size',
      width,
      height,
    ),
  getClickThroughMode: (): Promise<ClickThroughMode> =>
    invoke<ClickThroughMode>('persona:settings-get-click-through-mode'),
  setClickThroughEnabled: (enabled: boolean): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-set-click-through', enabled),
  setLookAtCursor: (enabled: boolean): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-set-look-at-cursor', enabled),
  setSpeakingTransition: (
    transition: SpeakingTransition,
  ): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>(
      'persona:settings-set-speaking-transition',
      transition,
    ),
  setBodyTransitionMs: (milliseconds: number): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-set-body-transition-ms', milliseconds),
  setSpeakingDebounceMs: (milliseconds: number): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-set-speaking-debounce-ms', milliseconds),
  setIdleInterimMs: (milliseconds: number): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-set-idle-interim-ms', milliseconds),
  enableDeveloperSettings: (): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-enable-developer'),
  resetDeveloperSettings: (): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-reset-developer'),
  setVroidHubPlaintextStorageAllowed: (
    allowed: boolean,
  ): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>(
      'persona:settings-set-vroid-plaintext-storage',
      allowed,
    ),
  setVoiceSource: (
    voiceSource: VoiceSourceSettings,
  ): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-set-voice-source', voiceSource),
  listVoiceSources: (): Promise<PersonaVoiceSourceCatalog> =>
    invoke<PersonaVoiceSourceCatalog>('persona:settings-list-voice-sources'),
  setModelLighting: (
    modelId: string,
    lighting: Partial<ModelLighting>,
  ): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>(
      'persona:settings-set-model-lighting',
      modelId,
      lighting,
    ),
  resetModelLighting: (modelId: string): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-reset-model-lighting', modelId),
  getMcpStatus: (): Promise<PersonaMcpStatus> =>
    invoke<PersonaMcpStatus>('persona:settings-get-mcp-status'),
  openKimodoRepository: (): Promise<void> =>
    invoke<void>('persona:settings-open-kimodo-repository'),
  getAnimationGeneratorStatus: (): Promise<PersonaAnimationGeneratorStatus> =>
    invoke<PersonaAnimationGeneratorStatus>('persona:settings-animation-generator-status'),
  setAnimationGeneratorConfig: (
    config: PersonaAnimationGeneratorConfig,
  ): Promise<PersonaAnimationGeneratorStatus> =>
    invoke<PersonaAnimationGeneratorStatus>(
      'persona:settings-animation-generator-set-config',
      config,
    ),
  checkAnimationGenerator: (): Promise<PersonaAnimationGeneratorStatus> =>
    invoke<PersonaAnimationGeneratorStatus>('persona:settings-animation-generator-check'),
  generateAnimation: (
    request: PersonaAnimationGenerationRequest,
  ): Promise<PersonaAnimationGenerationJob> =>
    invoke<PersonaAnimationGenerationJob>(
      'persona:settings-animation-generator-start',
      request,
    ),
  retryAnimationGeneration: (jobId: string): Promise<PersonaAnimationGenerationJob> =>
    invoke<PersonaAnimationGenerationJob>(
      'persona:settings-animation-generator-retry',
      jobId,
    ),
  discardAnimationGeneration: (jobId: string): Promise<PersonaAnimationGenerationJob[]> =>
    invoke<PersonaAnimationGenerationJob[]>(
      'persona:settings-animation-generator-discard',
      jobId,
    ),
  listAnimationGenerations: (): Promise<PersonaAnimationGenerationJob[]> =>
    invoke<PersonaAnimationGenerationJob[]>('persona:settings-animation-generator-list'),
  clearAnimationGenerations: (): Promise<PersonaAnimationGenerationJob[]> =>
    invoke<PersonaAnimationGenerationJob[]>('persona:settings-animation-generator-clear'),
  setWindowTheme: (theme: 'light' | 'dark'): void =>
    ipcRenderer.send('persona:settings-set-window-theme', theme),
  subscribe: (
    listener: (snapshot: SettingsSnapshot) => void,
  ): Unsubscribe => subscribe('persona:settings-updated', listener),
  subscribeAnimationGenerations: (
    listener: (job: PersonaAnimationGenerationJob) => void,
  ): Unsubscribe => subscribe('persona:animation-generation-updated', listener),
} satisfies PersonaSettingsApi;

const personaVroidHub = {
  getStatus: (): Promise<PersonaVroidHubStatus> =>
    invoke<PersonaVroidHubStatus>('persona:vroid-get-status'),
  getCredentials: (): Promise<PersonaVroidHubCredentials> =>
    invoke<PersonaVroidHubCredentials>('persona:vroid-get-credentials'),
  setCredentials: (
    clientId: string,
    clientSecret: string,
  ): Promise<PersonaVroidHubStatus> =>
    invoke<PersonaVroidHubStatus>(
      'persona:vroid-set-credentials',
      clientId,
      clientSecret,
    ),
  clearCredentials: (): Promise<PersonaVroidHubStatus> =>
    invoke<PersonaVroidHubStatus>('persona:vroid-clear-credentials'),
  connect: (): Promise<PersonaVroidHubStatus> =>
    invoke<PersonaVroidHubStatus>('persona:vroid-connect'),
  disconnect: (): Promise<PersonaVroidHubStatus> =>
    invoke<PersonaVroidHubStatus>('persona:vroid-disconnect'),
  listCharacters: (): Promise<VroidHubCharacter[]> =>
    invoke<VroidHubCharacter[]>('persona:vroid-list-characters'),
  getCharacterPortrait: (characterId: string): Promise<string | null> =>
    invoke<string | null>('persona:vroid-character-portrait', characterId),
  selectCharacter: (
    characterId: string,
    characterName: string,
  ): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>(
      'persona:vroid-select-character',
      characterId,
      characterName,
    ),
  openCharacterPage: (
    characterId: string,
    characterModelId: string,
  ): Promise<void> =>
    invoke<void>(
      'persona:vroid-open-character-page',
      characterId,
      characterModelId,
    ),
  subscribe: (listener: (status: PersonaVroidHubStatus) => void): Unsubscribe =>
    subscribe('persona:vroid-status-updated', listener),
} satisfies PersonaVroidHubApi;

contextBridge.exposeInMainWorld('personaBridge', personaBridge);
contextBridge.exposeInMainWorld('personaSettings', personaSettings);
contextBridge.exposeInMainWorld('personaVroidHub', personaVroidHub);
