import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  AudioActivityGate,
  DEFAULT_SPEECH_RELEASE_MS,
  type AudioActivity,
} from './audio-activity-gate.cjs';
import {
  discoverVoiceProcesses,
  type DiscoverVoiceProcessesOptions,
  type VoiceProcessTree,
} from './process-discovery.cjs';
import type { AudioListenerStatus, VoiceSourceSettings } from './types.cjs';
import { isRecord } from './types.cjs';
import { normalizeVoiceSource } from './voice-source.cjs';

export const SESSION_IDLE_MS = 8_000;

export interface CaptureProcess extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill(): boolean;
}

export type ProcessDiscovery = (
  options: DiscoverVoiceProcessesOptions,
) => Promise<VoiceProcessTree>;
export type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: {
    stdio: ['ignore', 'pipe', 'pipe'];
    windowsHide: boolean;
  },
) => CaptureProcess;

const spawnProcessDefault: SpawnProcess = (executable, args, options) =>
  spawn(executable, args, options);

export interface ResolveNativeHelperPathOptions {
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  resourcesPath?: string;
  projectRoot?: string;
}

export interface NativeProcessAudioListenerOptions {
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  resourcesPath?: string;
  helperPath?: string | null;
  processDiscovery?: ProcessDiscovery;
  spawnProcess?: SpawnProcess;
  onActivity?: (activity: AudioActivity) => void;
  onDebug?: ((...values: unknown[]) => void) | null;
  onLevel?: (level: number) => void;
  onSession?: (active: boolean) => void;
  onStatus?: (status: AudioListenerStatus) => void;
  pollIntervalMs?: number;
  sessionIdleMs?: number;
  speechReleaseMs?: number;
  processPattern?: RegExp | null;
  voiceSource?: unknown;
}

export function helperExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? 'persona-audio-listener.exe'
    : 'persona-audio-listener';
}

export function resolveNativeHelperPath({
  platform = process.platform,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  projectRoot = path.join(__dirname, '..'),
}: ResolveNativeHelperPathOptions = {}): string {
  const executable = helperExecutableName(platform);
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  return isPackaged
    ? platformPath.join(resourcesPath, 'native', platform, executable)
    : platformPath.join(projectRoot, 'native', 'bin', platform, executable);
}

export function createNdjsonParser(
  onMessage: (message: unknown) => void,
  onInvalid: (line: string) => void = () => {},
): (chunk: Buffer | string) => void {
  let pending = '';
  return (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        onInvalid(line);
      }
    }
  };
}

export class NativeProcessAudioListener {
  private readonly platform: NodeJS.Platform;
  private readonly helperPath: string;
  private readonly processDiscovery: ProcessDiscovery;
  private readonly processPattern: RegExp | null;
  private readonly voiceSource: VoiceSourceSettings;
  private readonly spawnProcess: SpawnProcess;
  private readonly onActivity: (activity: AudioActivity) => void;
  private readonly onDebug: ((...values: unknown[]) => void) | null;
  private readonly onSession: (active: boolean) => void;
  private readonly onStatus: (status: AudioListenerStatus) => void;
  private readonly pollIntervalMs: number;
  private readonly sessionIdleMs: number;
  private readonly gate: AudioActivityGate;
  private capture: CaptureProcess | null = null;
  private captureKey: string | null = null;
  private captureRootPids = new Set<number>();
  private resolvedPids = new Set<number>();
  private pollTimer: NodeJS.Timeout | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private sessionActive = false;
  private stopped = true;
  private pollInFlight = false;
  private lastStatusKey: string | null = null;

  constructor({
    platform = process.platform,
    isPackaged = false,
    resourcesPath = process.resourcesPath,
    helperPath = null,
    processDiscovery = discoverVoiceProcesses,
    spawnProcess = spawnProcessDefault,
    onActivity = () => {},
    onDebug = null,
    onLevel = () => {},
    onSession = () => {},
    onStatus = () => {},
    pollIntervalMs = 1_500,
    sessionIdleMs = SESSION_IDLE_MS,
    speechReleaseMs = DEFAULT_SPEECH_RELEASE_MS,
    processPattern = null,
    voiceSource = null,
  }: NativeProcessAudioListenerOptions = {}) {
    this.platform = platform;
    this.helperPath =
      helperPath ??
      resolveNativeHelperPath({ platform, isPackaged, resourcesPath });
    this.processDiscovery = processDiscovery;
    this.processPattern = processPattern;
    this.voiceSource = normalizeVoiceSource(voiceSource);
    this.spawnProcess = spawnProcess;
    this.onActivity = onActivity;
    this.onDebug = onDebug;
    this.onSession = onSession;
    this.onStatus = onStatus;
    this.pollIntervalMs = pollIntervalMs;
    this.sessionIdleMs = sessionIdleMs;
    this.gate = new AudioActivityGate({
      onActivity,
      onLevel,
      shouldReturnToListening: () => this.sessionActive,
      speechReleaseMs,
    });
  }

  private reportStatus(status: AudioListenerStatus): void {
    const key = JSON.stringify(status);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.onStatus(status);
  }

  async start(): Promise<void> {
    if (
      (this.platform !== 'darwin' && this.platform !== 'win32') ||
      !this.stopped
    ) {
      return;
    }
    this.stopped = false;
    if (!fs.existsSync(this.helperPath)) {
      this.reportStatus({
        available: false,
        capturing: false,
        monitoring: false,
        source: null,
        error: `Native listener is missing: ${this.helperPath}`,
      });
      return;
    }
    this.reportStatus({
      available: true,
      capturing: false,
      monitoring: true,
      source: null,
    });
    await this.poll();
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.pollTimer.unref();
  }

  async poll(): Promise<void> {
    if (this.stopped || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const processes = await this.processDiscovery({
        platform: this.platform,
        voiceSource: this.voiceSource,
        ...(this.processPattern ? { pattern: this.processPattern } : {}),
      });
      if (this.stopped) return;
      const spawnPids =
        this.platform === 'win32'
          ? processes.rootPids.slice(0, 1)
          : processes.pids;
      if (spawnPids.length === 0) {
        this.detach();
        return;
      }
      const stablePids = this.stableCapturePids(processes);
      const key = stablePids.join(',');
      if (this.capture && this.captureKey === key) return;
      this.detach({ sessionEnded: false });
      this.startCapture(spawnPids, key, processes.rootPids);
    } catch (error) {
      this.reportStatus({
        available: true,
        capturing: false,
        monitoring: true,
        source: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.pollInFlight = false;
    }
  }

  private stableCapturePids(processes: VoiceProcessTree): number[] {
    if (this.platform === 'win32') {
      return processes.rootPids.slice(0, 1);
    }
    const matched = new Set(processes.pids);
    const stable = new Set(processes.rootPids);
    for (const pid of this.resolvedPids) {
      if (matched.has(pid)) stable.add(pid);
    }
    return [...stable].sort((left, right) => left - right);
  }

  private startCapture(
    processIds: readonly number[],
    key: string,
    rootPids: readonly number[] = [],
  ): void {
    const args = processIds.flatMap((processId) => [
      '--pid',
      String(processId),
    ]);
    const child = this.spawnProcess(this.helperPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.capture = child;
    this.captureKey = key;
    this.captureRootPids = new Set(rootPids);
    const parse = createNdjsonParser(
      (message) => this.handleHelperMessage(child, message),
      (line) => this.onDebug?.('native listener emitted invalid JSON', line),
    );
    child.stdout.on('data', parse);
    child.stderr.on('data', (chunk: Buffer) =>
      this.onDebug?.('native listener stderr', chunk.toString()),
    );
    child.once('error', (error) => {
      if (this.capture !== child) return;
      this.capture = null;
      this.captureKey = null;
      this.captureRootPids = new Set();
      this.resolvedPids = new Set();
      this.reportStatus({
        available: false,
        capturing: false,
        monitoring: true,
        source: null,
        error: error.message,
      });
    });
    child.once('exit', (code, signal) => {
      if (this.capture !== child) return;
      this.capture = null;
      this.captureKey = null;
      this.captureRootPids = new Set();
      this.resolvedPids = new Set();
      this.gate.reset();
      this.reportStatus({
        available: true,
        capturing: false,
        monitoring: !this.stopped,
        source: null,
        ...(code && !this.stopped
          ? {
              error: `Native listener exited with code ${code}${signal ? ` (${signal})` : ''}.`,
            }
          : {}),
      });
    });
  }

  private handleHelperMessage(child: CaptureProcess, message: unknown): void {
    if (this.capture !== child || !isRecord(message)) return;
    if (message.type === 'ready') {
      const resolved = Array.isArray(message.pids)
        ? message.pids.filter(
            (pid): pid is number =>
              typeof pid === 'number' && Number.isInteger(pid) && pid > 0,
          )
        : [];
      this.resolvedPids = new Set(resolved);
      if (this.platform === 'darwin') {
        this.captureKey = [...new Set([...this.captureRootPids, ...resolved])]
          .sort((left, right) => left - right)
          .join(',');
      }
      this.reportStatus({
        available: true,
        capturing: true,
        monitoring: true,
        source:
          typeof message.source === 'string' && message.source
            ? message.source
            : 'Supported voice app',
      });
      return;
    }
    if (message.type === 'error') {
      this.reportStatus({
        available: false,
        capturing: false,
        monitoring: true,
        source: null,
        error: String(message.message || 'Native listener failed.'),
      });
      return;
    }
    if (message.type !== 'level' || !Number.isFinite(message.level)) return;

    const level = Math.max(0, Math.min(1, Number(message.level)));
    if (level > 0.008) {
      if (this.sessionTimer) clearTimeout(this.sessionTimer);
      this.sessionTimer = setTimeout(() => this.endSession(), this.sessionIdleMs);
      this.sessionTimer.unref();
      if (!this.sessionActive) {
        this.sessionActive = true;
        this.onSession(true);
        this.onActivity('listening');
      }
    }
    this.gate.handleLevel(level);
  }

  private endSession(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    if (!this.sessionActive) return;
    this.sessionActive = false;
    this.gate.reset();
    this.onSession(false);
  }

  detach({ sessionEnded = true }: { sessionEnded?: boolean } = {}): void {
    if (this.capture) {
      const child = this.capture;
      this.capture = null;
      this.captureKey = null;
      this.captureRootPids = new Set();
      child.kill();
    }
    if (sessionEnded) this.resolvedPids = new Set();
    this.gate.reset();
    if (sessionEnded) this.endSession();
    this.reportStatus({
      available: true,
      capturing: false,
      monitoring: !this.stopped,
      source: null,
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.detach();
  }
}
