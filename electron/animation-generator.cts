import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  convertKimodoGlbToVrma,
  KIMODO_VRMA_CONVERTER_VERSION,
  validateKimodoSomaModelDescriptor,
  validatePersonaVrma,
} from './kimodo-vrma.cjs';
import { validateCoreGlb } from './gltf-validation.cjs';
import { ANIMATION_NAME_PATTERN } from './library-catalog.cjs';
import { isRecord } from './types.cjs';
import type { SettingsSnapshot } from './settings-store.cjs';
import type {
  PersonaAnimationGenerationErrorCode,
  PersonaAnimationGenerationJob,
  PersonaAnimationGenerationPhase,
  PersonaAnimationGeneratorConfig,
  PersonaAnimationGeneratorStatus,
  PersonaKimodoModel,
} from '../shared/persona-api.js';

const STATE_SCHEMA_VERSION = 3;
const DEFAULT_CONFIG: Readonly<PersonaAnimationGeneratorConfig> = Object.freeze({
  enabled: false,
  server_url: 'http://127.0.0.1:8090',
  model: 'soma-rp-v1.1',
  mcp_enabled: false,
});
const MAX_PROMPT_LENGTH = 4096;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const GENERATION_TIMEOUT_MS = 4 * 60 * 60_000;
const POLL_INITIAL_INTERVAL_MS = 2_500;
const POLL_MAX_INTERVAL_MS = 15_000;
const MAX_MISSING_JOB_POLLS = 5;
const MAX_JOB_HISTORY = 100;
const GENERATION_STORAGE_RESERVE_BYTES = (MAX_RESPONSE_BYTES * 2) + (16 * 1024 * 1024);
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_JOB_ID_PATTERN = /^[a-zA-Z0-9-]{1,128}$/u;
const TERMINAL_PHASES = new Set<PersonaAnimationGenerationPhase>(['ready', 'failed', 'interrupted']);
const RECOVERABLE_PHASES = new Set<PersonaAnimationGenerationPhase>(['failed', 'interrupted']);
const SOURCE_FILENAME = 'source.glb';
const OUTPUT_FILENAME = 'animation.vrma';
const GENERATION_ERROR_MESSAGES: Readonly<Record<PersonaAnimationGenerationErrorCode, string>> = Object.freeze({
  GENERATOR_CAPACITY_REACHED: 'The reusable clip library does not have room for this generation.',
  GENERATOR_INCOMPATIBLE: 'The configured Kimodo endpoint is not compatible with this job.',
  GENERATOR_INTERRUPTED: 'Persona closed before generation completed. Retry to resume this job.',
  GENERATOR_MODEL_UNAVAILABLE: 'The supported Kimodo model is unavailable.',
  GENERATOR_OFFLINE: 'Persona could not reach or continue monitoring Kimodo.',
  GENERATOR_OUTPUT_INVALID: 'Kimodo did not provide a safe, supported motion file.',
  GENERATOR_QUEUE_REJECTED: 'Kimodo did not accept or complete the generation request.',
  GENERATOR_STORAGE_FULL: 'Persona could not reserve or write the required local storage.',
  GENERATOR_TIMED_OUT: 'Kimodo generation timed out.',
  CONVERTER_FAILED: 'The generated motion could not be converted to VRMA.',
  VRMA_VALIDATION_FAILED: 'The converted animation did not pass VRMA safety validation.',
  ASSET_INSTALL_FAILED: 'Persona could not save the generated VRMA clip.',
});

interface StoredGeneratorState {
  schema_version: number;
  config: PersonaAnimationGeneratorConfig;
  jobs: PersonaAnimationGenerationJob[];
}

type ActiveGenerationPhase = Exclude<
  PersonaAnimationGenerationPhase,
  'ready' | 'failed' | 'interrupted'
>;

class GenerationFailure extends Error {
  readonly code: PersonaAnimationGenerationErrorCode;

  constructor(code: PersonaAnimationGenerationErrorCode, message: string) {
    super(message);
    this.name = 'GenerationFailure';
    this.code = code;
  }
}

function generationFailure(
  code: PersonaAnimationGenerationErrorCode,
  message: string,
): GenerationFailure {
  return new GenerationFailure(code, message);
}

interface AnimationGeneratorDependencies {
  assertCanAddGeneratedClip(): void;
  addGeneratedClip(
    filePath: string,
    metadata: { clip_name: string; prompt: string; generation_job_id: string },
  ): SettingsSnapshot;
  findGeneratedClip(jobId: string): { id: string; clip_name: string } | null;
  publishSettings(snapshot: SettingsSnapshot): void;
  onJobUpdated(job: PersonaAnimationGenerationJob): void;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  convert?: (source: Buffer) => Buffer;
  validate?: (vrma: Buffer) => void;
  validateCore?: (vrma: Buffer) => Promise<void>;
  now?: () => Date;
  random?: () => number;
  availableStorageBytes?: () => number | bigint;
}

export interface AnimationGeneratorService {
  check(): Promise<PersonaAnimationGeneratorStatus>;
  clearJobs(): PersonaAnimationGenerationJob[];
  close(): void;
  discard(jobId: string): PersonaAnimationGenerationJob[];
  getJob(jobId: string): PersonaAnimationGenerationJob | null;
  getStatus(): PersonaAnimationGeneratorStatus;
  listJobs(): PersonaAnimationGenerationJob[];
  retry(jobId: string): PersonaAnimationGenerationJob;
  setConfig(config: unknown): Promise<PersonaAnimationGeneratorStatus>;
  start(request: unknown, source: 'settings' | 'mcp'): PersonaAnimationGenerationJob;
}

function loopbackServerUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Kimodo server URL is required.');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Kimodo server URL is invalid.');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new Error('Kimodo must use a plain HTTP loopback URL such as http://127.0.0.1:8090.');
  }
  url.pathname = '/';
  return url.href.replace(/\/$/u, '');
}

function modelId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== 'soma-rp-v1.1') {
    throw new Error('Persona currently supports only Kimodo soma-rp-v1.1.');
  }
  return 'soma-rp-v1.1';
}

function normalizeConfig(value: unknown): PersonaAnimationGeneratorConfig {
  const source = isRecord(value) ? value : {};
  return {
    enabled: source.enabled === true,
    server_url: loopbackServerUrl(source.server_url ?? DEFAULT_CONFIG.server_url),
    model: modelId(source.model ?? DEFAULT_CONFIG.model),
    mcp_enabled: source.mcp_enabled === true,
  };
}

function storedJob(value: unknown): PersonaAnimationGenerationJob | null {
  if (!isRecord(value)) return null;
  const phases = new Set([
    'queued', 'submitting', 'generating', 'downloading', 'converting',
    'installing', 'ready', 'failed', 'interrupted',
  ]);
  const activePhases = new Set([
    'queued', 'submitting', 'generating', 'downloading', 'converting', 'installing',
  ]);
  const errorCodes = new Set<PersonaAnimationGenerationErrorCode>([
    'GENERATOR_CAPACITY_REACHED',
    'GENERATOR_INCOMPATIBLE',
    'GENERATOR_INTERRUPTED',
    'GENERATOR_MODEL_UNAVAILABLE',
    'GENERATOR_OFFLINE',
    'GENERATOR_OUTPUT_INVALID',
    'GENERATOR_QUEUE_REJECTED',
    'GENERATOR_STORAGE_FULL',
    'GENERATOR_TIMED_OUT',
    'CONVERTER_FAILED',
    'VRMA_VALIDATION_FAILED',
    'ASSET_INSTALL_FAILED',
  ]);
  const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
  const createdAt = typeof value.created_at === 'string' ? value.created_at : '';
  const updatedAt = typeof value.updated_at === 'string' ? value.updated_at : '';
  if (
    typeof value.id !== 'string' ||
    !JOB_ID_PATTERN.test(value.id) ||
    !prompt ||
    Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_LENGTH ||
    typeof value.phase !== 'string' ||
    !phases.has(value.phase) ||
    createdAt.length > 64 ||
    updatedAt.length > 64 ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    !Number.isSafeInteger(value.frames) ||
    Number(value.frames) < 60 ||
    Number(value.frames) > 150 ||
    !Number.isSafeInteger(value.steps) ||
    Number(value.steps) < 1 ||
    Number(value.steps) > 1000 ||
    !Number.isSafeInteger(value.seed) ||
    Number(value.seed) < 0 ||
    value.model !== 'soma-rp-v1.1'
  ) {
    return null;
  }
  const hash = (candidate: unknown): string | null =>
    typeof candidate === 'string' && /^[0-9a-f]{64}$/u.test(candidate)
      ? candidate
      : null;
  const errorCode =
    typeof value.error_code === 'string' &&
    errorCodes.has(value.error_code as PersonaAnimationGenerationErrorCode)
      ? value.error_code as PersonaAnimationGenerationErrorCode
      : null;
  const phase = value.phase as PersonaAnimationGenerationJob['phase'];
  const storedClipName =
    typeof value.clip_name === 'string' &&
    value.clip_name.length <= 64 &&
    ANIMATION_NAME_PATTERN.test(value.clip_name)
      ? value.clip_name
      : typeof value.action_name === 'string' &&
          value.action_name.length <= 64 &&
          ANIMATION_NAME_PATTERN.test(value.action_name)
        ? value.action_name
        : slugFromPrompt(prompt);
  return {
    id: value.id,
    action_id: typeof value.action_id === 'string' && JOB_ID_PATTERN.test(value.action_id)
      ? value.action_id
      : null,
    action_name: typeof value.action_name === 'string' &&
      value.action_name.length <= 64 &&
      ANIMATION_NAME_PATTERN.test(value.action_name)
        ? value.action_name
        : null,
    clip_id: typeof value.clip_id === 'string' && JOB_ID_PATTERN.test(value.clip_id)
      ? value.clip_id
      : null,
    clip_name: storedClipName,
    prompt,
    phase,
    error: phase === 'failed' || phase === 'interrupted'
      ? errorCode
        ? GENERATION_ERROR_MESSAGES[errorCode]
        : 'A previous animation generation did not complete. Retry it or discard its history.'
      : null,
    error_code: errorCode,
    failure_phase:
      typeof value.failure_phase === 'string' && activePhases.has(value.failure_phase)
        ? value.failure_phase as ActiveGenerationPhase
        : null,
    attempt: Number.isSafeInteger(value.attempt) && Number(value.attempt) >= 1
      ? Number(value.attempt)
      : 1,
    provider_animation_id:
      typeof value.provider_animation_id === 'string' &&
      PROVIDER_JOB_ID_PATTERN.test(value.provider_animation_id)
        ? value.provider_animation_id
        : null,
    frames: Number(value.frames),
    steps: Number(value.steps),
    seed: Number(value.seed),
    model: value.model,
    model_license:
      typeof value.model_license === 'string' && value.model_license.length <= 256
        ? value.model_license
        : null,
    source_sha256: hash(value.source_sha256),
    vrma_sha256: hash(value.vrma_sha256),
    converter_version:
      typeof value.converter_version === 'string' && value.converter_version.length <= 64
        ? value.converter_version
        : 'unknown-legacy',
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function readState(statePath: string): StoredGeneratorState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!isRecord(parsed) || ![1, 2, STATE_SCHEMA_VERSION].includes(Number(parsed.schema_version))) throw new Error('invalid');
    const jobs = Array.isArray(parsed.jobs)
      ? parsed.jobs.flatMap((job) => {
          const normalized = storedJob(job);
          return normalized ? [normalized] : [];
        })
      : [];
    return {
      schema_version: STATE_SCHEMA_VERSION,
      config: normalizeConfig(parsed.config),
      jobs: jobs.slice(0, MAX_JOB_HISTORY),
    };
  } catch {
    return {
      schema_version: STATE_SCHEMA_VERSION,
      config: { ...DEFAULT_CONFIG },
      jobs: [],
    };
  }
}

function singleLine(value: unknown, field: string, maxLength: number, fallback: string): string {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${field} must be between 1 and ${maxLength} characters.`);
  }
  return normalized;
}

function normalizedPrompt(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Animation prompt is required.');
  const prompt = value.trim();
  if (!prompt || Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_LENGTH) {
    throw new Error('Animation prompt must be between 1 and 4096 UTF-8 bytes.');
  }
  return prompt;
}

function boundedInteger(value: unknown, field: string, fallback: number, minimum: number, maximum: number): number {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function slugFromPrompt(prompt: string): string {
  const slug = prompt.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 40).replace(/-$/u, '');
  return slug && ANIMATION_NAME_PATTERN.test(slug) ? slug : 'generated-motion';
}

function normalizeRequest(
  value: unknown,
): { clipName: string; prompt: string; frames: number; steps: number; seed: number } {
  const source = isRecord(value) ? value : {};
  const prompt = normalizedPrompt(source.prompt);
  const requestedName = singleLine(
    source.clip_name ?? source.animation_name,
    'Clip name',
    64,
    slugFromPrompt(prompt),
  ).toLowerCase();
  if (!ANIMATION_NAME_PATTERN.test(requestedName)) {
    throw new Error('Clip name must use lowercase letters, numbers, and single hyphens.');
  }
  return {
    prompt,
    clipName: requestedName,
    frames: boundedInteger(source.frames, 'Frames', 150, 60, 150),
    steps: boundedInteger(source.steps, 'Diffusion steps', 50, 1, 1000),
    seed: boundedInteger(source.seed, 'Seed', 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function copyJob(job: PersonaAnimationGenerationJob): PersonaAnimationGenerationJob {
  return { ...job };
}

function safeStatusError(error: unknown): string {
  if (error instanceof GenerationFailure) return error.message;
  return 'Persona could not verify the Kimodo endpoint.';
}

function safeJobFailure(
  error: unknown,
  phase: ActiveGenerationPhase,
  interrupted: boolean,
): GenerationFailure {
  if (interrupted) {
    return generationFailure(
      'GENERATOR_INTERRUPTED',
      'Persona closed before generation completed. Retry to resume this job.',
    );
  }
  if (error instanceof GenerationFailure) return error;
  switch (phase) {
    case 'queued':
    case 'submitting':
      return generationFailure(
        'GENERATOR_QUEUE_REJECTED',
        'Persona could not submit the animation request to Kimodo.',
      );
    case 'generating':
      return generationFailure(
        'GENERATOR_OFFLINE',
        'Persona could not continue monitoring the Kimodo generation.',
      );
    case 'downloading':
      return generationFailure(
        'GENERATOR_OUTPUT_INVALID',
        'Persona could not safely download the generated motion.',
      );
    case 'converting':
      return generationFailure(
        'CONVERTER_FAILED',
        'The generated motion could not be converted to VRMA.',
      );
    case 'installing':
      return generationFailure(
        'ASSET_INSTALL_FAILED',
        'Persona could not save the generated VRMA clip.',
      );
  }
}

function parseModels(value: unknown): PersonaKimodoModel[] {
  if (!Array.isArray(value)) throw new Error('Kimodo /api/models did not return an array.');
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string') return [];
    if (candidate.id === 'soma-rp-v1.1') validateKimodoSomaModelDescriptor(candidate);
    return [{
      id: candidate.id,
      label: typeof candidate.label === 'string' ? candidate.label : candidate.id,
      skeleton_key: typeof candidate.skeleton_key === 'string' ? candidate.skeleton_key : '',
      available: candidate.available === true,
      reason: typeof candidate.reason === 'string' && candidate.reason ? candidate.reason : null,
      license: typeof candidate.license === 'string' && candidate.license ? candidate.license : null,
      license_url: typeof candidate.license_url === 'string' && candidate.license_url ? candidate.license_url : null,
    }];
  });
}

async function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Generation interrupted.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function responseBuffer(response: Response, maximum: number): Promise<Buffer> {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maximum) {
    void response.body?.cancel().catch(() => {});
    throw generationFailure('GENERATOR_OUTPUT_INVALID', 'Kimodo returned an oversized response.');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      try { await reader.cancel(); } catch { /* Keep the bounded-response error authoritative. */ }
      throw generationFailure('GENERATOR_OUTPUT_INVALID', 'Kimodo returned an oversized response.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function writeBufferAtomically(filePath: string, contents: Buffer): void {
  const temporaryPath = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporaryPath, 'w', 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the original write error. */ }
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* Retried by exact-path cleanup. */ }
    throw error;
  }
}

async function writeResponseAtomically(
  response: Response,
  filePath: string,
  maximum: number,
): Promise<{ bytes: number; sha256: string }> {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > maximum) {
    void response.body?.cancel().catch(() => {});
    throw generationFailure('GENERATOR_OUTPUT_INVALID', 'Kimodo returned an oversized motion file.');
  }
  if (!response.body) {
    throw generationFailure('GENERATOR_OUTPUT_INVALID', 'Kimodo returned an empty motion file.');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp`;
  const reader = response.body.getReader();
  const hash = nodeCrypto.createHash('sha256');
  let descriptor: number | null = null;
  let total = 0;
  try {
    descriptor = fs.openSync(temporaryPath, 'w', 0o600);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        try { await reader.cancel(); } catch { /* Keep the bounded-download error authoritative. */ }
        throw generationFailure('GENERATOR_OUTPUT_INVALID', 'Kimodo returned an oversized motion file.');
      }
      const chunk = Buffer.from(value);
      fs.writeFileSync(descriptor, chunk);
      hash.update(chunk);
    }
    if (total === 0) {
      throw generationFailure('GENERATOR_OUTPUT_INVALID', 'Kimodo returned an empty motion file.');
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
    return { bytes: total, sha256: hash.digest('hex') };
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the original stream or write error. */ }
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the original write error. */ }
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* Retried by exact-path cleanup. */ }
    throw error;
  }
}

function boundedArtifact(filePath: string, maximum: number): Buffer {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0 || stat.size > maximum) {
    throw generationFailure('GENERATOR_OUTPUT_INVALID', 'A retained generation artifact is invalid.');
  }
  return fs.readFileSync(filePath);
}

export function createAnimationGenerator(
  userDataPath: string,
  dependencies: AnimationGeneratorDependencies,
): AnimationGeneratorService {
  const statePath = path.join(userDataPath, 'animation-generator.json');
  const workDirectory = path.join(userDataPath, 'animation-generation');
  const state = readState(statePath);
  const fetcher = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? defaultSleep;
  const convert = dependencies.convert ?? convertKimodoGlbToVrma;
  const validate = dependencies.validate ?? validatePersonaVrma;
  const validateCore = dependencies.validateCore ?? validateCoreGlb;
  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? Math.random;
  const shutdown = new AbortController();
  const running = new Set<string>();
  let lastCheckErrorCode: PersonaAnimationGenerationErrorCode | null = null;
  let status: PersonaAnimationGeneratorStatus = {
    checked_at: now().toISOString(),
    config: { ...state.config },
    error: null,
    health: state.config.enabled ? 'unavailable' : 'disabled',
    models: [],
  };

  function writeState(): void {
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const temporary = `${statePath}.tmp`;
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(temporary, 'w', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporary, statePath);
    } catch (error) {
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch { /* Preserve the original state-write error. */ }
      }
      try { fs.rmSync(temporary, { force: true }); } catch { /* A later state write reuses this exact path. */ }
      throw error;
    }
  }

  function jobArtifacts(jobId: string): {
    directory: string;
    outputPath: string;
    sourcePath: string;
  } {
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error('Animation generation job id is invalid.');
    const directory = path.join(workDirectory, jobId);
    return {
      directory,
      outputPath: path.join(directory, OUTPUT_FILENAME),
      sourcePath: path.join(directory, SOURCE_FILENAME),
    };
  }

  function removeJobArtifacts(jobId: string): void {
    const artifacts = jobArtifacts(jobId);
    try {
      fs.rmSync(artifacts.directory, { recursive: true, force: true });
    } catch {
      // The job record remains authoritative. A later history cleanup can
      // safely retry this exact per-job directory without widening scope.
    }
  }

  function removeOrphanedJobArtifacts(): void {
    if (!fs.existsSync(workDirectory)) return;
    const retained = new Set(
      state.jobs
        .filter((job) => job.phase !== 'ready')
        .map((job) => job.id),
    );
    try {
      for (const entry of fs.readdirSync(workDirectory, { withFileTypes: true })) {
        if (
          entry.isDirectory() &&
          JOB_ID_PATTERN.test(entry.name) &&
          !retained.has(entry.name)
        ) {
          removeJobArtifacts(entry.name);
        }
      }
    } catch {
      // Kimodo is optional. Cleanup is retried on the next launch and must not
      // prevent Persona from starting or using already installed clips.
    }
  }

  function availableStorageBytes(): bigint {
    if (dependencies.availableStorageBytes) {
      const available = dependencies.availableStorageBytes();
      if (
        (typeof available === 'number' && (!Number.isFinite(available) || available < 0)) ||
        (typeof available === 'bigint' && available < 0n)
      ) {
        throw new Error('Invalid available storage value.');
      }
      return typeof available === 'bigint' ? available : BigInt(Math.floor(available));
    }
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const statistics = fs.statfsSync(userDataPath, { bigint: true });
    return statistics.bavail * statistics.bsize;
  }

  function requiredStorageBytes(job?: PersonaAnimationGenerationJob): bigint {
    if (!job) return BigInt(GENERATION_STORAGE_RESERVE_BYTES);
    const artifacts = jobArtifacts(job.id);
    if (fs.existsSync(artifacts.outputPath)) {
      return BigInt(fs.statSync(artifacts.outputPath).size + (16 * 1024 * 1024));
    }
    if (fs.existsSync(artifacts.sourcePath)) {
      return BigInt((fs.statSync(artifacts.sourcePath).size * 2) + (16 * 1024 * 1024));
    }
    return BigInt(GENERATION_STORAGE_RESERVE_BYTES);
  }

  function assertGenerationPreflight(job?: PersonaAnimationGenerationJob): void {
    try {
      dependencies.assertCanAddGeneratedClip();
    } catch {
      throw generationFailure(
        'GENERATOR_CAPACITY_REACHED',
        'The reusable clip library is full. Delete a clip before generating another one.',
      );
    }
    try {
      if (availableStorageBytes() < requiredStorageBytes(job)) {
        throw generationFailure(
          'GENERATOR_STORAGE_FULL',
          'There is not enough free storage to generate and safely retain this clip.',
        );
      }
    } catch (error) {
      if (error instanceof GenerationFailure) throw error;
      throw generationFailure(
        'GENERATOR_STORAGE_FULL',
        'Persona could not verify enough free storage for this generation.',
      );
    }
  }

  for (const job of state.jobs) {
    if (!TERMINAL_PHASES.has(job.phase)) {
      const failurePhase = job.phase as ActiveGenerationPhase;
      job.phase = 'interrupted';
      job.failure_phase = failurePhase;
      job.error_code = 'GENERATOR_INTERRUPTED';
      job.error = 'Persona closed before generation completed. Retry to resume this job.';
      job.updated_at = now().toISOString();
    }
  }
  // A read-only or temporarily unavailable user-data directory must not make
  // the optional Kimodo integration prevent Persona from starting. Later
  // mutations still fail closed before network work begins.
  try { writeState(); } catch { /* A later explicit operation reports the storage failure. */ }
  removeOrphanedJobArtifacts();

  function updateJob(job: PersonaAnimationGenerationJob, patch: Partial<PersonaAnimationGenerationJob>): void {
    const previous = copyJob(job);
    Object.assign(job, patch, { updated_at: now().toISOString() });
    try {
      writeState();
    } catch (error) {
      Object.assign(job, previous);
      throw error;
    }
    dependencies.onJobUpdated(copyJob(job));
  }

  function recordFailure(
    job: PersonaAnimationGenerationJob,
    failurePhase: ActiveGenerationPhase,
    error: unknown,
  ): void {
    const failure = safeJobFailure(error, failurePhase, shutdown.signal.aborted);
    try {
      updateJob(job, {
        phase: shutdown.signal.aborted ? 'interrupted' : 'failed',
        failure_phase: failurePhase,
        error_code: failure.code,
        error: failure.message,
      });
    } catch {
      Object.assign(job, {
        phase: 'failed',
        failure_phase: failurePhase,
        error_code: 'GENERATOR_STORAGE_FULL',
        error: 'Persona could not save the generation status because local storage is unavailable.',
        updated_at: now().toISOString(),
      });
      dependencies.onJobUpdated(copyJob(job));
    }
  }

  async function request(
    endpoint: string,
    init: RequestInit,
    timeoutMs = REQUEST_TIMEOUT_MS,
    httpErrorCode: PersonaAnimationGenerationErrorCode = 'GENERATOR_OFFLINE',
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([shutdown.signal, timeout]);
    let response: Response;
    try {
      response = await fetcher(`${state.config.server_url}${endpoint}`, {
        ...init,
        signal,
        redirect: 'manual',
      });
    } catch {
      if (shutdown.signal.aborted) {
        throw generationFailure('GENERATOR_INTERRUPTED', 'Persona is closing.');
      }
      throw generationFailure('GENERATOR_OFFLINE', 'Persona could not reach the Kimodo endpoint.');
    }
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {});
      throw generationFailure('GENERATOR_INCOMPATIBLE', 'Kimodo redirects are not allowed.');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw generationFailure(httpErrorCode, `Kimodo rejected the request with HTTP ${response.status}.`);
    }
    return response;
  }

  async function requestJson(
    endpoint: string,
    init: RequestInit,
    timeoutMs?: number,
    httpErrorCode: PersonaAnimationGenerationErrorCode = 'GENERATOR_INCOMPATIBLE',
    expectedStatus?: number,
  ): Promise<unknown> {
    const response = await request(endpoint, init, timeoutMs, httpErrorCode);
    if (expectedStatus !== undefined && response.status !== expectedStatus) {
      void response.body?.cancel().catch(() => {});
      throw generationFailure(
        'GENERATOR_INCOMPATIBLE',
        `Kimodo returned HTTP ${response.status} where ${expectedStatus} was required.`,
      );
    }
    const body = await responseBuffer(response, MAX_JSON_BYTES);
    try {
      return JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      throw generationFailure('GENERATOR_INCOMPATIBLE', 'Kimodo returned an incompatible JSON response.');
    }
  }

  async function check(): Promise<PersonaAnimationGeneratorStatus> {
    if (!state.config.enabled) {
      lastCheckErrorCode = null;
      status = { checked_at: now().toISOString(), config: { ...state.config }, error: null, health: 'disabled', models: [] };
      return { ...status, config: { ...status.config }, models: [] };
    }
    try {
      const models = parseModels(await requestJson('/api/models', { method: 'GET' }));
      const selected = models.find((model) => model.id === state.config.model);
      if (!selected) {
        throw generationFailure('GENERATOR_MODEL_UNAVAILABLE', 'Kimodo does not advertise the supported SOMA model.');
      }
      if (selected.skeleton_key !== 'soma30') {
        throw generationFailure('GENERATOR_INCOMPATIBLE', 'The selected Kimodo model does not use the required SOMA30 skeleton.');
      }
      if (!selected.available) {
        throw generationFailure('GENERATOR_MODEL_UNAVAILABLE', 'Kimodo reports that the supported SOMA model is unavailable.');
      }
      lastCheckErrorCode = null;
      status = { checked_at: now().toISOString(), config: { ...state.config }, error: null, health: 'ready', models };
    } catch (error) {
      lastCheckErrorCode = error instanceof GenerationFailure
        ? error.code
        : 'GENERATOR_INCOMPATIBLE';
      status = { checked_at: now().toISOString(), config: { ...state.config }, error: safeStatusError(error), health: 'unavailable', models: [] };
    }
    return { ...status, config: { ...status.config }, models: status.models.map((model) => ({ ...model })) };
  }

  async function waitForProvider(providerAnimationId: string): Promise<void> {
    const deadline = Date.now() + GENERATION_TIMEOUT_MS;
    let interval = POLL_INITIAL_INTERVAL_MS;
    let missingPolls = 0;
    while (true) {
      if (Date.now() >= deadline) {
        throw generationFailure('GENERATOR_TIMED_OUT', 'Kimodo generation timed out after four hours.');
      }
      const jittered = Math.max(1, Math.round(interval * (0.85 + (Math.min(1, Math.max(0, random())) * 0.3))));
      await sleep(jittered, shutdown.signal);
      const animations = await requestJson(
        '/api/animations',
        { method: 'GET' },
        undefined,
        'GENERATOR_INCOMPATIBLE',
      );
      if (!Array.isArray(animations)) {
        throw generationFailure('GENERATOR_INCOMPATIBLE', 'Kimodo returned an incompatible animation list.');
      }
      const remote = animations.find(
        (candidate) => isRecord(candidate) && candidate.id === providerAnimationId,
      );
      if (!isRecord(remote)) {
        missingPolls += 1;
        if (missingPolls >= MAX_MISSING_JOB_POLLS) {
          throw generationFailure('GENERATOR_INCOMPATIBLE', 'Kimodo no longer reports this generation job.');
        }
      } else {
        missingPolls = 0;
        if (remote.status === 'failed') {
          throw generationFailure('GENERATOR_QUEUE_REJECTED', 'Kimodo reported that animation generation failed.');
        }
        if (remote.status === 'ready') return;
        if (remote.status !== 'queued' && remote.status !== 'running') {
          throw generationFailure('GENERATOR_INCOMPATIBLE', 'Kimodo returned an unknown generation state.');
        }
      }
      interval = Math.min(POLL_MAX_INTERVAL_MS, Math.round(interval * 1.5));
    }
  }

  async function runJob(job: PersonaAnimationGenerationJob): Promise<void> {
    running.add(job.id);
    const artifacts = jobArtifacts(job.id);
    let failurePhase: ActiveGenerationPhase = 'queued';
    try {
      const alreadyInstalled = dependencies.findGeneratedClip(job.id);
      if (alreadyInstalled) {
        updateJob(job, {
          phase: 'ready',
          error: null,
          error_code: null,
          failure_phase: null,
          clip_id: alreadyInstalled.id,
          clip_name: alreadyInstalled.clip_name,
        });
        return;
      }
      assertGenerationPreflight(job);

      let source: Buffer | null = null;
      let vrma: Buffer | null = null;
      if (fs.existsSync(artifacts.outputPath)) {
        try {
          const retainedOutput = boundedArtifact(
            artifacts.outputPath,
            MAX_RESPONSE_BYTES + (4 * 1024 * 1024),
          );
          validate(retainedOutput);
          await validateCore(retainedOutput);
          const retainedHash = nodeCrypto.createHash('sha256').update(retainedOutput).digest('hex');
          if (job.vrma_sha256 && retainedHash !== job.vrma_sha256) throw new Error('hash mismatch');
          vrma = retainedOutput;
          if (!job.vrma_sha256) updateJob(job, { vrma_sha256: retainedHash });
        } catch {
          fs.rmSync(artifacts.outputPath, { force: true });
        }
      }
      if (!vrma && fs.existsSync(artifacts.sourcePath)) {
        try {
          const retainedSource = boundedArtifact(artifacts.sourcePath, MAX_RESPONSE_BYTES);
          const sourceSha256 = nodeCrypto.createHash('sha256').update(retainedSource).digest('hex');
          if (job.source_sha256 && sourceSha256 !== job.source_sha256) throw new Error('hash mismatch');
          source = retainedSource;
          if (!job.source_sha256) updateJob(job, { source_sha256: sourceSha256 });
        } catch {
          fs.rmSync(artifacts.sourcePath, { force: true });
        }
      }

      if (!source && !vrma) {
        let providerAnimationId = job.provider_animation_id;
        if (!providerAnimationId) {
          const readiness = await check();
          if (readiness.health !== 'ready') {
            throw generationFailure(
              lastCheckErrorCode ?? 'GENERATOR_OFFLINE',
              readiness.error ?? 'Kimodo is not ready.',
            );
          }
          const selectedModel = readiness.models.find((model) => model.id === job.model);
          failurePhase = 'submitting';
          updateJob(job, {
            phase: 'submitting',
            error: null,
            error_code: null,
            failure_phase: null,
            model_license: selectedModel?.license ?? null,
          });
          const submitted = await requestJson(
            '/api/generate',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                prompt: job.prompt,
                frames: job.frames,
                steps: job.steps,
                seed: job.seed,
                model: job.model,
              }),
            },
            undefined,
            'GENERATOR_QUEUE_REJECTED',
            202,
          );
          if (
            !isRecord(submitted) ||
            typeof submitted.id !== 'string' ||
            !PROVIDER_JOB_ID_PATTERN.test(submitted.id)
          ) {
            throw generationFailure('GENERATOR_INCOMPATIBLE', 'Kimodo returned an invalid generation job id.');
          }
          providerAnimationId = submitted.id;
          updateJob(job, { provider_animation_id: providerAnimationId });
        }
        failurePhase = 'generating';
        updateJob(job, { phase: 'generating' });
        await waitForProvider(providerAnimationId);

        failurePhase = 'downloading';
        updateJob(job, { phase: 'downloading' });
        const sourceResponse = await request(
          `/api/animations/${encodeURIComponent(providerAnimationId)}/animation.glb`,
          { method: 'GET' },
          60_000,
          'GENERATOR_OUTPUT_INVALID',
        );
        const downloaded = await writeResponseAtomically(
          sourceResponse,
          artifacts.sourcePath,
          MAX_RESPONSE_BYTES,
        );
        updateJob(job, { source_sha256: downloaded.sha256 });
        source = boundedArtifact(artifacts.sourcePath, MAX_RESPONSE_BYTES);
      }

      if (!vrma) {
        if (!source) {
          throw generationFailure('GENERATOR_OUTPUT_INVALID', 'No Kimodo source motion is available to convert.');
        }
        failurePhase = 'converting';
        updateJob(job, { phase: 'converting' });
        try {
          vrma = convert(source);
        } catch {
          throw generationFailure('CONVERTER_FAILED', 'The generated motion could not be converted to VRMA.');
        }
        try {
          validate(vrma);
          await validateCore(vrma);
        } catch {
          throw generationFailure('VRMA_VALIDATION_FAILED', 'The converted animation did not pass VRMA safety validation.');
        }
        try {
          writeBufferAtomically(artifacts.outputPath, vrma);
        } catch {
          throw generationFailure('GENERATOR_STORAGE_FULL', 'Persona could not retain the converted VRMA on local storage.');
        }
        updateJob(job, {
          vrma_sha256: nodeCrypto.createHash('sha256').update(vrma).digest('hex'),
        });
      }

      failurePhase = 'installing';
      updateJob(job, { phase: 'installing' });
      assertGenerationPreflight(job);
      let snapshot: SettingsSnapshot;
      try {
        snapshot = dependencies.addGeneratedClip(artifacts.outputPath, {
          clip_name: job.clip_name,
          prompt: job.prompt,
          generation_job_id: job.id,
        });
      } catch {
        throw generationFailure('ASSET_INSTALL_FAILED', 'Persona could not save the generated VRMA clip.');
      }
      dependencies.publishSettings(snapshot);
      const installed = snapshot.animation_clips.find(
        (clip) => clip.generation_job_id === job.id,
      );
      if (!installed) throw new Error('Persona could not find the generated clip after installing it.');
      updateJob(job, {
        phase: 'ready',
        error: null,
        error_code: null,
        failure_phase: null,
        clip_id: installed.id,
        clip_name: installed.clip_name,
      });
    } catch (error) {
      if (!TERMINAL_PHASES.has(job.phase)) failurePhase = job.phase as ActiveGenerationPhase;
      recordFailure(job, failurePhase, error);
    } finally {
      running.delete(job.id);
      if (job.phase === 'ready') removeJobArtifacts(job.id);
    }
  }

  return {
    check,
    clearJobs(): PersonaAnimationGenerationJob[] {
      if (
        running.size > 0 ||
        state.jobs.some((job) => !TERMINAL_PHASES.has(job.phase))
      ) {
        throw new Error(
          'Wait for the active animation generation before clearing recent jobs.',
        );
      }
      const previousJobs = state.jobs;
      state.jobs = [];
      try {
        writeState();
      } catch {
        state.jobs = previousJobs;
        throw new Error('Persona could not clear the animation generation history.');
      }
      for (const job of previousJobs) removeJobArtifacts(job.id);
      return [];
    },
    close(): void {
      shutdown.abort(new Error('Persona is closing.'));
    },
    discard(jobId: string): PersonaAnimationGenerationJob[] {
      if (running.size > 0 || state.jobs.some((candidate) => !TERMINAL_PHASES.has(candidate.phase))) {
        throw new Error('Wait for the active animation generation before discarding job history.');
      }
      const index = state.jobs.findIndex((candidate) => candidate.id === jobId);
      if (index === -1) throw new Error('Animation generation job was not found.');
      const job = state.jobs[index];
      if (!job || !TERMINAL_PHASES.has(job.phase) || running.has(job.id)) {
        throw new Error('Wait for this animation generation to finish before discarding it.');
      }
      state.jobs.splice(index, 1);
      try {
        writeState();
      } catch {
        state.jobs.splice(index, 0, job);
        throw new Error('Persona could not discard the animation generation job.');
      }
      removeJobArtifacts(job.id);
      return state.jobs.map(copyJob);
    },
    getJob(jobId: string): PersonaAnimationGenerationJob | null {
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      return job ? copyJob(job) : null;
    },
    getStatus(): PersonaAnimationGeneratorStatus {
      return { ...status, config: { ...status.config }, models: status.models.map((model) => ({ ...model })) };
    },
    listJobs(): PersonaAnimationGenerationJob[] {
      return state.jobs.map(copyJob);
    },
    retry(jobId: string): PersonaAnimationGenerationJob {
      if (!state.config.enabled) {
        throw new Error('Enable the Kimodo animation generator in Settings before retrying.');
      }
      if (running.size > 0 || state.jobs.some((candidate) => !TERMINAL_PHASES.has(candidate.phase))) {
        throw new Error('Persona already has an animation generation in progress.');
      }
      const job = state.jobs.find((candidate) => candidate.id === jobId);
      if (!job) throw new Error('Animation generation job was not found.');
      if (!RECOVERABLE_PHASES.has(job.phase)) {
        throw new Error('Only failed or interrupted animation generations can be retried.');
      }
      if (!dependencies.findGeneratedClip(job.id)) assertGenerationPreflight(job);
      const previous = copyJob(job);
      Object.assign(job, {
        phase: 'queued',
        error: null,
        error_code: null,
        failure_phase: null,
        attempt: job.attempt + 1,
        provider_animation_id:
          job.error_code === 'GENERATOR_QUEUE_REJECTED'
            ? null
            : job.provider_animation_id,
        updated_at: now().toISOString(),
      } satisfies Partial<PersonaAnimationGenerationJob>);
      try {
        writeState();
      } catch {
        Object.assign(job, previous);
        throw generationFailure(
          'GENERATOR_STORAGE_FULL',
          'Persona could not save the animation retry state.',
        );
      }
      dependencies.onJobUpdated(copyJob(job));
      void runJob(job);
      return copyJob(job);
    },
    async setConfig(value: unknown): Promise<PersonaAnimationGeneratorStatus> {
      if (running.size > 0 || state.jobs.some((job) => !TERMINAL_PHASES.has(job.phase))) {
        throw new Error('Wait for the active animation generation before changing Kimodo settings.');
      }
      const previousConfig = state.config;
      const previousJobs = state.jobs.map(copyJob);
      const nextConfig = normalizeConfig(value);
      state.config = nextConfig;
      if (
        nextConfig.server_url !== previousConfig.server_url ||
        nextConfig.model !== previousConfig.model
      ) {
        for (const job of state.jobs) {
          if (RECOVERABLE_PHASES.has(job.phase)) job.provider_animation_id = null;
        }
      }
      try {
        writeState();
      } catch (error) {
        state.config = previousConfig;
        state.jobs = previousJobs;
        throw new Error('Persona could not save the Kimodo settings.', { cause: error });
      }
      return check();
    },
    start(value: unknown, source: 'settings' | 'mcp'): PersonaAnimationGenerationJob {
      if (!state.config.enabled) throw new Error('Enable the Kimodo animation generator in Settings first.');
      if (source === 'mcp' && !state.config.mcp_enabled) {
        throw new Error('Agent animation generation is disabled in Persona Settings.');
      }
      if (running.size > 0 || state.jobs.some((job) => !TERMINAL_PHASES.has(job.phase))) {
        throw new Error('Persona already has an animation generation in progress.');
      }
      const normalized = normalizeRequest(value);
      assertGenerationPreflight();
      const timestamp = now().toISOString();
      const job: PersonaAnimationGenerationJob = {
        id: nodeCrypto.randomUUID(),
        action_id: null,
        action_name: null,
        clip_id: null,
        clip_name: normalized.clipName,
        prompt: normalized.prompt,
        phase: 'queued',
        error: null,
        error_code: null,
        failure_phase: null,
        attempt: 1,
        provider_animation_id: null,
        frames: normalized.frames,
        steps: normalized.steps,
        seed: normalized.seed,
        model: state.config.model,
        model_license: null,
        source_sha256: null,
        vrma_sha256: null,
        converter_version: KIMODO_VRMA_CONVERTER_VERSION,
        created_at: timestamp,
        updated_at: timestamp,
      };
      const previousJobs = [...state.jobs];
      state.jobs.unshift(job);
      const evicted = state.jobs.splice(MAX_JOB_HISTORY);
      try {
        writeState();
      } catch {
        state.jobs = previousJobs;
        throw generationFailure(
          'GENERATOR_STORAGE_FULL',
          'Persona could not save the animation generation job.',
        );
      }
      for (const oldJob of evicted) removeJobArtifacts(oldJob.id);
      dependencies.onJobUpdated(copyJob(job));
      void runJob(job);
      return copyJob(job);
    },
  };
}
