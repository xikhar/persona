import path from 'node:path';
import type {
  PipeWireProperties,
  ProcessInfo,
  VoicePlatform,
  VoiceSource,
  VoiceSourceMode,
  VoiceSourceSettings,
} from './types.cjs';
import { isRecord } from './types.cjs';

export const VOICE_SOURCE_MODES: ReadonlySet<VoiceSourceMode> = new Set([
  'default',
  'application',
  'custom',
  'external',
]);
export const VOICE_SOURCE_ID_PATTERN =
  /^(?:process:(?:darwin|win32)|pipewire:(?:application|binary|node|stream)):[A-Za-z0-9_-]{1,2048}$/;
export const MAX_VOICE_SOURCE_NAME_LENGTH = 120;

export const DEFAULT_VOICE_SOURCE: Readonly<VoiceSourceSettings> = Object.freeze({
  mode: 'default',
  process_pattern: null,
  source_id: null,
  source_name: null,
});

export const DEFAULT_VOICE_APP_PATTERN_SOURCE =
  '(?:^|[\\\\/\\s._=-])(?:codex(?:-desktop)?|chatgpt|openai(?:-codex)?)(?=$|[\\\\/\\s._=-])';

export const DEFAULT_VOICE_APP_PATTERN = new RegExp(
  DEFAULT_VOICE_APP_PATTERN_SOURCE,
  'i',
);

export const MAX_VOICE_SOURCE_PATTERN_LENGTH = 200;

function isVoiceSourceMode(value: unknown): value is VoiceSourceMode {
  return (
    typeof value === 'string' &&
    [...VOICE_SOURCE_MODES].some((mode) => mode === value)
  );
}

interface ProcessLike {
  executable?: unknown;
  name?: unknown;
}

interface PipeWireIdentity {
  application: string | null;
  binary: string | null;
  node: string | null;
}

export function emptyVoiceSource(
  mode: VoiceSourceMode = 'default',
): VoiceSourceSettings {
  return {
    mode,
    process_pattern: null,
    source_id: null,
    source_name: null,
  };
}

export function cleanSourceName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > MAX_VOICE_SOURCE_NAME_LENGTH) {
    return null;
  }
  return normalized;
}

export function compileVoiceSourcePattern(source: unknown): RegExp {
  if (typeof source !== 'string' || !source.trim()) {
    return DEFAULT_VOICE_APP_PATTERN;
  }
  try {
    return new RegExp(source, 'i');
  } catch {
    return DEFAULT_VOICE_APP_PATTERN;
  }
}

export function sanitizeVoiceSourcePattern(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Process pattern is required.');
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error('Process pattern is required.');
  }
  if (normalized.length > MAX_VOICE_SOURCE_PATTERN_LENGTH) {
    throw new Error(
      `Process pattern must be ${MAX_VOICE_SOURCE_PATTERN_LENGTH} characters or fewer.`,
    );
  }
  try {
    new RegExp(normalized, 'i');
  } catch {
    throw new Error('Process pattern must be a valid regular expression.');
  }
  return normalized;
}

export function encodeIdentity(value: unknown): string {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

export function decodeIdentity(value: string): string | null {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function validDecodedIdentity(value: string | undefined): boolean {
  return value !== undefined && Boolean(decodeIdentity(value)?.trim());
}

export function isValidVoiceSourceId(value: unknown): value is string {
  if (typeof value !== 'string' || !VOICE_SOURCE_ID_PATTERN.test(value)) {
    return false;
  }
  const processMatch = /^process:(?:darwin|win32):([A-Za-z0-9_-]+)$/.exec(value);
  if (processMatch) return validDecodedIdentity(processMatch[1]);

  const legacyMatch =
    /^pipewire:(?:application|binary|node):([A-Za-z0-9_-]+)$/.exec(value);
  if (legacyMatch) return validDecodedIdentity(legacyMatch[1]);

  const streamMatch = /^pipewire:stream:([A-Za-z0-9_-]+)$/.exec(value);
  if (!streamMatch?.[1]) return false;
  try {
    const decoded = decodeIdentity(streamMatch[1]);
    const identity: unknown = decoded == null ? null : JSON.parse(decoded);
    if (!isRecord(identity)) return false;
    return ['application', 'binary', 'node'].some(
      (field) =>
        typeof identity[field] === 'string' &&
        cleanSourceName(identity[field]) === identity[field],
    );
  } catch {
    return false;
  }
}

export function sanitizeVoiceSource(value: unknown): VoiceSourceSettings {
  if (!isRecord(value) || !isVoiceSourceMode(value.mode)) {
    throw new Error('Voice source mode is invalid.');
  }
  const mode = value.mode;
  if (mode === 'custom') {
    return {
      ...emptyVoiceSource('custom'),
      process_pattern: sanitizeVoiceSourcePattern(value.process_pattern),
    };
  }
  if (mode === 'application') {
    const sourceId = isValidVoiceSourceId(value.source_id)
      ? value.source_id
      : null;
    const sourceName = cleanSourceName(value.source_name);
    if (!sourceId || !sourceName) {
      throw new Error('Select a valid application voice source.');
    }
    return {
      ...emptyVoiceSource('application'),
      source_id: sourceId,
      source_name: sourceName,
    };
  }
  return emptyVoiceSource(mode);
}

export function normalizeVoiceSource(value: unknown): VoiceSourceSettings {
  try {
    return sanitizeVoiceSource(value);
  } catch {
    return { ...DEFAULT_VOICE_SOURCE };
  }
}

export function settingsPatternFromVoiceSource(
  voiceSource: unknown,
): string | null {
  const normalized = normalizeVoiceSource(voiceSource);
  return normalized.mode === 'custom' ? normalized.process_pattern : null;
}

export interface ResolveVoiceSourcePatternOptions {
  environment?: NodeJS.ProcessEnv;
  settingsPattern?: string | null;
}

export function resolveVoiceSourcePattern({
  environment = process.env,
  settingsPattern = null,
}: ResolveVoiceSourcePatternOptions = {}): RegExp {
  const envSource = environment.PERSONA_TARGET_PROCESS_PATTERN;
  if (typeof envSource === 'string' && envSource.trim()) {
    return compileVoiceSourcePattern(envSource);
  }
  if (typeof settingsPattern === 'string' && settingsPattern.trim()) {
    return compileVoiceSourcePattern(settingsPattern);
  }
  return DEFAULT_VOICE_APP_PATTERN;
}

export function configuredPattern(
  environment: NodeJS.ProcessEnv = process.env,
): RegExp {
  return resolveVoiceSourcePattern({ environment });
}

export function normalizeProcessIdentity(
  value: unknown,
  platform: NodeJS.Platform,
): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function processIdentity(
  processInfo: ProcessLike,
  platform: NodeJS.Platform,
): string {
  return normalizeProcessIdentity(
    processInfo.executable || processInfo.name,
    platform,
  );
}

export function processSourceId(
  platform: NodeJS.Platform,
  processInfo: ProcessLike,
): string | null {
  if (platform !== 'darwin' && platform !== 'win32') return null;
  const identity = processIdentity(processInfo, platform);
  return identity ? `process:${platform}:${encodeIdentity(identity)}` : null;
}

export function processSourceLabel(
  platform: NodeJS.Platform,
  processInfo: ProcessLike,
): string {
  const executable = String(
    processInfo.executable || processInfo.name || '',
  ).trim();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const filename = pathApi.basename(executable) || String(processInfo.name || '');
  return filename.replace(/\.exe$/i, '') || 'Application';
}

export function sourceFromProcess(
  platform: NodeJS.Platform,
  processInfo: ProcessLike,
): VoiceSource | null {
  const id = processSourceId(platform, processInfo);
  if (!id || (platform !== 'darwin' && platform !== 'win32')) return null;
  const executable = String(
    processInfo.executable || processInfo.name || '',
  ).trim();
  return {
    id,
    name: processSourceLabel(platform, processInfo),
    detail: executable,
    platform,
  };
}

export function processMatchesSource(
  processInfo: ProcessLike,
  platform: NodeJS.Platform,
  sourceId: string,
): boolean {
  return processSourceId(platform, processInfo) === sourceId;
}

export function cleanPipeWireIdentity(
  properties: PipeWireProperties | null | undefined,
): PipeWireIdentity | null {
  const identity: PipeWireIdentity = {
    application: cleanSourceName(properties?.['application.name']),
    binary: cleanSourceName(properties?.['application.process.binary']),
    node: cleanSourceName(properties?.['node.name']),
  };
  return Object.values(identity).some(Boolean) ? identity : null;
}

export function pipeWireSourceFromProperties(
  properties: PipeWireProperties,
): VoiceSource | null {
  const identity = cleanPipeWireIdentity(properties);
  if (!identity) return null;
  const detailParts = [identity.binary, identity.node].filter(
    (value, index, values): value is string =>
      Boolean(value) && values.indexOf(value) === index,
  );
  return {
    id: `pipewire:stream:${encodeIdentity(JSON.stringify(identity))}`,
    name:
      identity.application ??
      cleanSourceName(properties['node.description']) ??
      identity.binary ??
      identity.node ??
      'Audio stream',
    detail: detailParts.join(' · ') || identity.application || 'Playback stream',
    platform: 'linux',
  };
}

function matchesLegacyPipeWireSource(
  properties: PipeWireProperties,
  kind: string,
  encodedValue: string,
): boolean {
  const value = decodeIdentity(encodedValue);
  if (value == null) return false;
  const property =
    kind === 'application'
      ? 'application.name'
      : kind === 'binary'
        ? 'application.process.binary'
        : 'node.name';
  return properties[property] === value;
}

export function pipeWirePropertiesMatchSource(
  properties: PipeWireProperties,
  sourceId: string,
): boolean {
  const legacy = /^pipewire:(application|binary|node):([A-Za-z0-9_-]+)$/.exec(
    String(sourceId),
  );
  if (legacy?.[1] && legacy[2]) {
    return matchesLegacyPipeWireSource(properties, legacy[1], legacy[2]);
  }

  const match = /^pipewire:stream:([A-Za-z0-9_-]+)$/.exec(String(sourceId));
  if (!match?.[1]) return false;
  try {
    const decoded = decodeIdentity(match[1]);
    const expected: unknown = decoded == null ? null : JSON.parse(decoded);
    const actual = cleanPipeWireIdentity(properties);
    if (!isRecord(expected) || !actual) return false;
    return (['application', 'binary', 'node'] as const).every(
      (field) => expected[field] == null || expected[field] === actual[field],
    );
  } catch {
    return false;
  }
}

export type { ProcessInfo, VoicePlatform, VoiceSource, VoiceSourceSettings };
