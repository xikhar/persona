import type {
  AudioListenerStatus,
  BridgeEvent,
} from '../shared/persona-api.js';

export type {
  AnimationPlaybackEvent,
  AudioLevelEvent,
  AudioListenerStatus,
  AvatarRendererEvent,
  BridgeEvent,
  ListenerStatusEvent,
  VoiceActivity,
  VoicePhase,
  VoicePlatform,
  VoiceSourceMode,
  PersonaVoiceSource as VoiceSource,
  PersonaVoiceSourceSettings as VoiceSourceSettings,
  VoiceState,
  VoiceStateEvent,
} from '../shared/persona-api.js';

export interface ProcessInfo {
  executable: string;
  name: string;
  parentId: number;
  pid: number;
  command: string;
}

export type PipeWireProperties = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface PipeWireObject {
  id: number | string;
  info?: {
    props?: PipeWireProperties;
    state?: unknown;
  };
  type?: string;
}

export interface ModelSnapshot {
  id: string;
}

export interface AnimationSnapshot {
  animation_name: string;
  asset_urls: string[];
}

export interface SettingsSnapshotLike {
  animations?: AnimationSnapshot[];
  default_model_id?: string | null;
  models?: ModelSnapshot[];
}

export interface ListenerCallbacks {
  onEvent?: (event: BridgeEvent) => void;
  onStatus?: (status: AudioListenerStatus) => void;
}

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonObject
  | JsonValue[];

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
