import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  AudioActivityGate,
  DEFAULT_SPEECH_RELEASE_MS,
  type AudioActivity,
} from './audio-activity-gate.cjs';
import type {
  AudioListenerStatus,
  PipeWireObject,
  PipeWireProperties,
  VoiceSourceSettings,
} from './types.cjs';
import { isRecord } from './types.cjs';
import {
  DEFAULT_VOICE_APP_PATTERN,
  normalizeVoiceSource,
  pipeWirePropertiesMatchSource,
} from './voice-source.cjs';

const execFileAsync = promisify(execFile);
export const SPEECH_RELEASE_MS = DEFAULT_SPEECH_RELEASE_MS;
export const CODEX_IDENTITY = DEFAULT_VOICE_APP_PATTERN;

interface ProcessIdentity {
  identity: string;
  parentId: number;
}

type ProcessReader = (processId: number) => ProcessIdentity;
type ProcessMatcher = (processId: string | number) => boolean;
type CaptureProcess = ChildProcessByStdio<null, Readable, null>;

export interface LinuxPipeWireListenerOptions {
  onActivity?: (activity: AudioActivity) => void;
  onDebug?: ((...values: unknown[]) => void) | null;
  onLevel?: (level: number) => void;
  onSession?: (active: boolean) => void;
  onStatus?: (status: AudioListenerStatus) => void;
  pollIntervalMs?: number;
  speechReleaseMs?: number;
  processPattern?: RegExp | null;
  voiceSource?: unknown;
}

function isPipeWireObject(value: unknown): value is PipeWireObject {
  return isRecord(value) && (typeof value.id === 'number' || typeof value.id === 'string');
}

export function nodeProperties(
  node: PipeWireObject | null | undefined,
): PipeWireProperties {
  return node?.info?.props ?? {};
}

export function enrichPipeWireNodes(
  objects: readonly PipeWireObject[],
): PipeWireObject[] {
  const clients = new Map(
    objects
      .filter((object) => object.type === 'PipeWire:Interface:Client')
      .map((client) => [String(client.id), nodeProperties(client)]),
  );
  return objects.map((object) => {
    if (object.type !== 'PipeWire:Interface:Node') return object;
    const properties = nodeProperties(object);
    const client = clients.get(String(properties['client.id']));
    if (!client) return object;
    return {
      ...object,
      info: {
        ...object.info,
        props: {
          ...client,
          ...properties,
        },
      },
    };
  });
}

export function readProcessInfo(processId: number): ProcessIdentity {
  const root = `/proc/${processId}`;
  let cmdline = '';
  let comm = '';
  let executable = '';
  let status = '';
  try {
    cmdline = fs
      .readFileSync(`${root}/cmdline`, 'utf8')
      .replaceAll('\0', ' ')
      .trim();
  } catch {
    // Some AppImage sandboxes expose only part of another process's metadata.
  }
  try {
    comm = fs.readFileSync(`${root}/comm`, 'utf8').trim();
  } catch {
    // Keep any other readable identity fields.
  }
  try {
    executable = fs.readlinkSync(`${root}/exe`);
  } catch {
    // Executable symlinks can be restricted even when cmdline is readable.
  }
  try {
    status = fs.readFileSync(`${root}/status`, 'utf8');
  } catch {
    // Parent traversal is optional when the current process already matches.
  }
  if (!cmdline && !comm && !executable) {
    throw new Error(`Process ${processId} is not readable`);
  }
  const parentMatch = /^PPid:\s+(\d+)$/m.exec(status);
  return {
    identity: `${comm} ${executable} ${cmdline}`,
    parentId: parentMatch?.[1] ? Number(parentMatch[1]) : 0,
  };
}

function identityMatchesPattern(
  identity: string,
  pattern = DEFAULT_VOICE_APP_PATTERN,
): boolean {
  pattern.lastIndex = 0;
  return pattern.test(identity);
}

export function isCodexProcessTree(
  processId: string | number,
  processReader: ProcessReader = readProcessInfo,
  pattern = DEFAULT_VOICE_APP_PATTERN,
): boolean {
  let currentId = Number(processId);
  const visited = new Set<number>();
  for (let depth = 0; depth < 10; depth += 1) {
    if (
      !Number.isInteger(currentId) ||
      currentId <= 1 ||
      visited.has(currentId)
    ) {
      return false;
    }
    visited.add(currentId);
    try {
      const processInfo = processReader(currentId);
      if (identityMatchesPattern(processInfo.identity, pattern)) return true;
      currentId = Number(processInfo.parentId);
    } catch {
      return false;
    }
  }
  return false;
}

export function isCodexOutputNode(
  node: PipeWireObject,
  processMatcher: ProcessMatcher | null = null,
  pattern = DEFAULT_VOICE_APP_PATTERN,
): boolean {
  return isVoiceOutputNode(node, null, processMatcher, pattern);
}

export function isVoiceOutputNode(
  node: PipeWireObject,
  voiceSource: unknown = null,
  processMatcher: ProcessMatcher | null = null,
  pattern = DEFAULT_VOICE_APP_PATTERN,
): boolean {
  if (node.type !== 'PipeWire:Interface:Node') return false;
  const properties = nodeProperties(node);
  if (properties['media.class'] !== 'Stream/Output/Audio') return false;
  const selected = normalizeVoiceSource(voiceSource);
  if (selected.mode === 'application') {
    return pipeWirePropertiesMatchSource(properties, selected.source_id ?? '');
  }
  if (selected.mode === 'external') return false;
  const identity = [
    properties['application.name'],
    properties['application.process.binary'],
    properties['application.process.id'],
    properties['node.name'],
    properties['node.description'],
  ]
    .filter((value) => value != null)
    .join(' ');
  if (identityMatchesPattern(identity, pattern)) return true;

  const processId = properties['application.process.id'];
  const matcher =
    processMatcher ??
    ((candidateId: string | number) =>
      isCodexProcessTree(candidateId, readProcessInfo, pattern));
  return (
    (typeof processId === 'string' || typeof processId === 'number') &&
    matcher(processId)
  );
}

export function findCodexOutputNode(
  nodes: readonly PipeWireObject[],
  processMatcher: ProcessMatcher | null = null,
  pattern = DEFAULT_VOICE_APP_PATTERN,
): PipeWireObject | null {
  return findVoiceOutputNode(nodes, null, processMatcher, pattern);
}

export function findVoiceOutputNode(
  nodes: readonly PipeWireObject[],
  voiceSource: unknown = null,
  processMatcher: ProcessMatcher | null = null,
  pattern = DEFAULT_VOICE_APP_PATTERN,
): PipeWireObject | null {
  const processCache = new Map<string, boolean>();
  const matcher =
    processMatcher ??
    ((processId: string | number) =>
      isCodexProcessTree(processId, readProcessInfo, pattern));
  const cachedMatcher: ProcessMatcher = (processId) => {
    const key = String(processId);
    if (!processCache.has(key)) processCache.set(key, matcher(processId));
    return processCache.get(key) ?? false;
  };
  const matches = nodes.filter((node) =>
    isVoiceOutputNode(node, voiceSource, cachedMatcher, pattern),
  );
  return (
    matches.find((node) => node.info?.state === 'running') ??
    matches.find((node) => node.info?.state === 'idle') ??
    matches[0] ??
    null
  );
}

export function pcm16Rms(buffer: Buffer): number {
  const sampleCount = Math.floor(buffer.length / 2);
  if (sampleCount === 0) return 0;
  let squareSum = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset) / 32768;
    squareSum += sample * sample;
  }
  return Math.sqrt(squareSum / sampleCount);
}

export function normalizeRms(rms: number): number {
  const noiseFloor = 0.0025;
  if (!Number.isFinite(rms) || rms <= noiseFloor) return 0;
  return Math.min(1, (rms - noiseFloor) * 7.5);
}

function displayName(node: PipeWireObject): string {
  const properties = nodeProperties(node);
  return String(
    properties['application.name'] ??
      properties['node.description'] ??
      properties['node.name'] ??
      'Voice app',
  );
}

export class LinuxPipeWireListener {
  private readonly onActivity: (activity: AudioActivity) => void;
  private readonly onDebug: ((...values: unknown[]) => void) | null;
  private readonly onSession: (active: boolean) => void;
  private readonly onStatus: (status: AudioListenerStatus) => void;
  private readonly pollIntervalMs: number;
  private readonly processPattern: RegExp;
  private readonly voiceSource: VoiceSourceSettings;
  private readonly gate: AudioActivityGate;
  private capture: CaptureProcess | null = null;
  private captureSerial: string | null = null;
  currentNode: PipeWireObject | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private sessionActive = false;
  private stopped = true;
  private pollInFlight = false;
  private lastStatusKey: string | null = null;
  private lastDebugKey: string | null = null;

  constructor({
    onActivity = () => {},
    onDebug = null,
    onLevel = () => {},
    onSession = () => {},
    onStatus = () => {},
    pollIntervalMs = 750,
    speechReleaseMs = SPEECH_RELEASE_MS,
    processPattern = DEFAULT_VOICE_APP_PATTERN,
    voiceSource = null,
  }: LinuxPipeWireListenerOptions = {}) {
    this.onActivity = onActivity;
    this.onDebug = onDebug;
    this.onSession = onSession;
    this.onStatus = onStatus;
    this.pollIntervalMs = pollIntervalMs;
    this.processPattern = processPattern ?? DEFAULT_VOICE_APP_PATTERN;
    this.voiceSource = normalizeVoiceSource(voiceSource);
    this.gate = new AudioActivityGate({
      onActivity,
      onLevel,
      shouldReturnToListening: () => this.currentNode != null,
      speechReleaseMs,
    });
  }

  reportStatus(status: AudioListenerStatus): void {
    const key = JSON.stringify(status);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.onStatus(status);
  }

  async start(): Promise<void> {
    if (process.platform !== 'linux' || !this.stopped) return;
    this.stopped = false;
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
      const { stdout } = await execFileAsync('pw-dump', {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 2_500,
      });
      if (this.stopped) return;
      const parsed: unknown = JSON.parse(stdout);
      const nodes = enrichPipeWireNodes(
        Array.isArray(parsed) ? parsed.filter(isPipeWireObject) : [],
      );
      if (this.onDebug) {
        const outputNodes = nodes
          .filter(
            (candidate) =>
              nodeProperties(candidate)['media.class'] === 'Stream/Output/Audio',
          )
          .map((candidate) => {
            const properties = nodeProperties(candidate);
            const processId = properties['application.process.id'] ?? null;
            return {
              application: properties['application.name'] ?? null,
              binary: properties['application.process.binary'] ?? null,
              node: properties['node.name'] ?? null,
              processId,
              processTreeMatches:
                (typeof processId === 'string' || typeof processId === 'number') &&
                isCodexProcessTree(
                  processId,
                  readProcessInfo,
                  this.processPattern,
                ),
              state: candidate.info?.state ?? null,
            };
          });
        const debugKey = JSON.stringify(outputNodes);
        if (debugKey !== this.lastDebugKey) {
          this.lastDebugKey = debugKey;
          this.onDebug(outputNodes);
        }
      }
      const node = findVoiceOutputNode(
        nodes,
        this.voiceSource,
        null,
        this.processPattern,
      );
      if (node == null) {
        this.detach();
        return;
      }

      const serial = String(nodeProperties(node)['object.serial'] ?? node.id);
      if (this.capture && this.captureSerial === serial) return;
      this.detach({ sessionEnded: false });
      this.currentNode = node;
      this.captureSerial = serial;
      if (!this.sessionActive) {
        this.sessionActive = true;
        this.onSession(true);
      }
      this.onActivity('listening');
      this.startCapture(node, serial);
    } catch (error) {
      this.reportStatus({
        available: false,
        capturing: false,
        monitoring: false,
        source: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.pollInFlight = false;
    }
  }

  private startCapture(node: PipeWireObject, serial: string): void {
    const child = spawn(
      'pw-record',
      [
        '--target',
        serial,
        '--raw',
        '--rate',
        '16000',
        '--channels',
        '2',
        '--format',
        's16',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    this.capture = child;
    this.reportStatus({
      available: true,
      capturing: true,
      monitoring: true,
      source: displayName(node),
    });

    child.stdout.on('data', (chunk: Buffer) => {
      if (this.capture === child) this.handleAudio(chunk);
    });
    child.once('error', (error) => {
      if (this.capture !== child) return;
      this.capture = null;
      this.reportStatus({
        available: false,
        capturing: false,
        monitoring: true,
        source: displayName(node),
        error: error.message,
      });
    });
    child.once('exit', () => {
      if (this.capture !== child) return;
      this.capture = null;
      this.reportStatus({
        available: true,
        capturing: false,
        monitoring: true,
        source: displayName(node),
      });
    });
  }

  handleAudio(chunk: Buffer): void {
    const level = normalizeRms(pcm16Rms(chunk));
    this.gate.handleLevel(level);
  }

  detach({ sessionEnded = true }: { sessionEnded?: boolean } = {}): void {
    this.currentNode = null;
    this.captureSerial = null;
    if (this.capture) {
      const child = this.capture;
      this.capture = null;
      child.kill('SIGTERM');
    }
    this.gate.reset();
    if (sessionEnded && this.sessionActive) {
      this.sessionActive = false;
      this.onSession(false);
    }
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
