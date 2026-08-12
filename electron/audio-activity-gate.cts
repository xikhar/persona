export const DEFAULT_SPEECH_RELEASE_MS = 250;
export const DEFAULT_SPEECH_THRESHOLD = 0.018;

export type AudioActivity = 'listening' | 'speaking';

export interface AudioActivityGateOptions {
  onActivity?: (activity: AudioActivity) => void;
  onLevel?: (level: number) => void;
  shouldReturnToListening?: () => boolean;
  speechReleaseMs?: number;
  speechThreshold?: number;
}

export interface AudioActivityResetOptions {
  emitLevel?: boolean;
}

export class AudioActivityGate {
  private readonly onActivity: (activity: AudioActivity) => void;
  private readonly onLevel: (level: number) => void;
  private readonly shouldReturnToListening: () => boolean;
  private readonly speechReleaseMs: number;
  private readonly speechThreshold: number;
  private silenceTimer: NodeJS.Timeout | null = null;
  private speaking = false;

  constructor({
    onActivity = () => {},
    onLevel = () => {},
    shouldReturnToListening = () => true,
    speechReleaseMs = DEFAULT_SPEECH_RELEASE_MS,
    speechThreshold = DEFAULT_SPEECH_THRESHOLD,
  }: AudioActivityGateOptions = {}) {
    this.onActivity = onActivity;
    this.onLevel = onLevel;
    this.shouldReturnToListening = shouldReturnToListening;
    this.speechReleaseMs = speechReleaseMs;
    this.speechThreshold = speechThreshold;
  }

  handleLevel(level: number): void {
    const normalized = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
    this.onLevel(normalized);
    if (normalized > this.speechThreshold) {
      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
      if (!this.speaking) {
        this.speaking = true;
        this.onActivity("speaking");
      }
      return;
    }

    if (this.speaking && this.silenceTimer == null) {
      this.silenceTimer = setTimeout(() => {
        this.silenceTimer = null;
        this.speaking = false;
        this.onLevel(0);
        if (this.shouldReturnToListening()) this.onActivity("listening");
      }, this.speechReleaseMs);
      this.silenceTimer.unref?.();
    }
  }

  reset({ emitLevel = true }: AudioActivityResetOptions = {}): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this.speaking = false;
    if (emitLevel) this.onLevel(0);
  }
}
