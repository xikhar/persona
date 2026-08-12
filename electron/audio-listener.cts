import {
  LinuxPipeWireListener,
  type LinuxPipeWireListenerOptions,
} from './linux-pipewire-listener.cjs';
import {
  NativeProcessAudioListener,
  type NativeProcessAudioListenerOptions,
} from './native-process-audio-listener.cjs';
import { normalizeVoiceSource } from './voice-source.cjs';

export interface AudioListener {
  start(): Promise<void>;
  stop(): void;
}

export type CreateAudioListenerOptions = LinuxPipeWireListenerOptions &
  NativeProcessAudioListenerOptions & {
    platform?: NodeJS.Platform;
  };

export function createAudioListener({
  platform = process.platform,
  ...options
}: CreateAudioListenerOptions = {}): AudioListener | null {
  if (normalizeVoiceSource(options.voiceSource).mode === 'external') return null;
  if (platform === 'linux') return new LinuxPipeWireListener(options);
  if (platform === 'darwin' || platform === 'win32') {
    return new NativeProcessAudioListener({ platform, ...options });
  }
  return null;
}
