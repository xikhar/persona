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
  PersonaBridgeApi,
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

const personaBridge = {
  getSnapshot: (): Promise<AvatarRendererEvent | null> =>
    invoke<AvatarRendererEvent | null>('persona:get-snapshot'),
  hide: (): void => ipcRenderer.send('persona:hide'),
  moveBy: (dx: number, dy: number): void =>
    ipcRenderer.send('persona:move-by', dx, dy),
  subscribe: (listener: (event: AvatarRendererEvent) => void): Unsubscribe =>
    subscribe('persona:event', listener),
} satisfies PersonaBridgeApi;

const personaSettings = {
  get: (): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-get'),
  importModel: (metadata: { model_name: string }): Promise<SettingsSnapshot | null> =>
    invoke<SettingsSnapshot | null>('persona:settings-import-model', metadata),
  createAnimation: (metadata: AnimationMetadata): Promise<SettingsSnapshot> =>
    invoke<SettingsSnapshot>('persona:settings-create-animation', metadata),
  addAnimationClips: (animationId: string): Promise<SettingsSnapshot | null> =>
    invoke<SettingsSnapshot | null>(
      'persona:settings-add-animation-clips',
      animationId,
    ),
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
  setWindowTheme: (theme: 'light' | 'dark'): void =>
    ipcRenderer.send('persona:settings-set-window-theme', theme),
  subscribe: (
    listener: (snapshot: SettingsSnapshot) => void,
  ): Unsubscribe => subscribe('persona:settings-updated', listener),
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
