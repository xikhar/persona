import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ANIMATION_NAME_PATTERN,
  SYSTEM_ANIMATION_IDS,
  inferAnimationType,
  readPackagedLibrary,
  type PackagedAnimation,
  type PackagedLibrary,
} from './library-catalog.cjs';
import { isRecord } from './types.cjs';
import type { VoiceSourceSettings } from './types.cjs';
import type {
  CustomAnimationMetadata,
  PersonaAnimationClipSettings,
  PersonaAnimationLibraryClip,
  PersonaAnimationSettings,
  PersonaAvatarWindowSize,
  PersonaLightingSettings,
  PersonaModelSettings,
  PersonaSettingsSnapshot,
  PersonaSpeakingTransitionSettings,
} from '../shared/persona-api.js';
import {
  DEFAULT_VOICE_SOURCE,
  normalizeVoiceSource,
  sanitizeVoiceSource,
} from './voice-source.cjs';

export type TransitionRange = [number, number];
export type SpeakingTransition = PersonaSpeakingTransitionSettings;
export type AvatarWindowSize = PersonaAvatarWindowSize;
export type ModelLighting = PersonaLightingSettings;
export type AnimationMetadata = CustomAnimationMetadata;

interface StoredModel {
  id: string;
  model_name: string;
  stored_filename: string;
}

interface StoredAnimation extends AnimationMetadata {
  id: string;
}

interface StoredAnimationClip {
  id: string;
  stored_filename: string;
  clip_name: string;
  source: 'imported' | 'kimodo';
  created_at: string;
  prompt: string | null;
  generation_job_id: string | null;
}

interface SettingsState {
  schema_version: number;
  default_model_id: string | null;
  character_size: number;
  avatar_window: AvatarWindowSize;
  click_through_enabled: boolean;
  look_at_cursor: boolean;
  developer_settings_enabled: boolean;
  vroid_hub_allow_plaintext_storage: boolean;
  body_transition_ms: number;
  speaking_debounce_ms: number;
  idle_interim_ms: number;
  speaking_transition: SpeakingTransition;
  model_lighting: Record<string, ModelLighting>;
  models: StoredModel[];
  animations: StoredAnimation[];
  animation_clips: StoredAnimationClip[];
  animation_clip_links: Record<string, string[]>;
  packaged_animation_overrides: Record<string, AnimationMetadata>;
  hidden_packaged_animation_ids: string[];
  voice_source: VoiceSourceSettings;
}

export type AvailableModel = PersonaModelSettings;
export type AvailableAnimationClip = PersonaAnimationClipSettings;
export type AvailableAnimation = PersonaAnimationSettings;
export type SettingsSnapshot = PersonaSettingsSnapshot;

interface HubModel {
  id: string;
  model_name: string;
  buffer: Buffer;
}

export interface SettingsStore {
  assertCanAddAnimationClips(count?: number): void;
  addAnimationClips(animationId: string, filePaths: readonly string[]): SettingsSnapshot;
  importAnimationClips(filePaths: readonly string[]): SettingsSnapshot;
  addGeneratedAnimationClip(
    filePath: string,
    metadata: { clip_name: unknown; prompt: unknown; generation_job_id: unknown },
  ): SettingsSnapshot;
  attachAnimationClip(animationId: string, clipId: string): SettingsSnapshot;
  attachAnimationClips(animationId: string, clipIds: readonly string[]): SettingsSnapshot;
  clearActiveHubModel(): SettingsSnapshot;
  createAnimation(metadata: unknown): SettingsSnapshot;
  createAnimationWithClips(metadata: unknown, clipIds: readonly string[]): SettingsSnapshot;
  deleteAnimation(animationId: string): SettingsSnapshot;
  detachAnimationClip(animationId: string, clipId: string): SettingsSnapshot;
  deleteAnimationLibraryClip(clipId: string): SettingsSnapshot;
  deleteModel(modelId: string): SettingsSnapshot;
  getAnimation(animationName: string): AvailableAnimation | null;
  getSnapshot(): SettingsSnapshot;
  importModel(input: { filePath: string; model_name: unknown }): SettingsSnapshot;
  enableDeveloperSettings(): SettingsSnapshot;
  resetPackagedAnimations(): SettingsSnapshot;
  resetDeveloperSettings(): SettingsSnapshot;
  setVroidHubPlaintextStorageAllowed(value: unknown): SettingsSnapshot;
  resolveAssetRequest(rawUrl: string): string | { buffer: Buffer } | null;
  setActiveHubModel(buffer: Buffer, metadata?: { model_name?: unknown }): SettingsSnapshot;
  setAvatarWindowSize(width: unknown, height: unknown): SettingsSnapshot;
  setClickThroughEnabled(value: unknown): SettingsSnapshot;
  setLookAtCursor(value: unknown): SettingsSnapshot;
  setCharacterSize(value: unknown): SettingsSnapshot;
  setSpeakingTransition(value: unknown): SettingsSnapshot;
  setBodyTransitionMs(value: unknown): SettingsSnapshot;
  setSpeakingDebounceMs(value: unknown): SettingsSnapshot;
  setIdleInterimMs(value: unknown): SettingsSnapshot;
  setVoiceSource(value: unknown): SettingsSnapshot;
  setDefaultModel(modelId: string): SettingsSnapshot;
  setModelLighting(modelId: string, lighting: unknown): SettingsSnapshot;
  resetModelLighting(modelId: string): SettingsSnapshot;
  updateAnimation(animationId: string, metadata: unknown): SettingsSnapshot;
}

export const SETTINGS_SCHEMA_VERSION = 10;
export const DEFAULT_PACKAGED_LIBRARY_PATH = path.join(
  __dirname,
  "..",
  "public",
  "assets",
  "library.json",
);
export const MIN_CHARACTER_SIZE = 0.4;
export const MAX_CHARACTER_SIZE = 1.6;
export const MIN_AVATAR_WINDOW_WIDTH = 320;
export const MAX_AVATAR_WINDOW_WIDTH = 2160;
export const MIN_AVATAR_WINDOW_HEIGHT = 480;
export const MAX_AVATAR_WINDOW_HEIGHT = 3840;
export const DEFAULT_AVATAR_WINDOW_SIZE: Readonly<AvatarWindowSize> = Object.freeze({ width: 430, height: 680 });
const MAX_ASSET_BYTES = 200 * 1024 * 1024;
const MAX_CUSTOM_MODELS = 50;
const MAX_CUSTOM_ANIMATIONS = 100;
const MAX_CUSTOM_ANIMATION_CLIPS = 300;
const LEGACY_SPEAKING_HALF_BASE_MS = 450;
const MIN_SPEAKING_TRANSITION_MS = 45;
const MAX_SPEAKING_TRANSITION_MS = 3600;
const MIN_BODY_TRANSITION_MS = 50;
const MAX_BODY_TRANSITION_MS = 3000;
const DEFAULT_BODY_TRANSITION_MS = 700;
export const DEFAULT_SPEAKING_DEBOUNCE_MS = 350;
export const DEFAULT_IDLE_INTERIM_MS = 350;
const MIN_SCHEDULER_DELAY_MS = 0;
const MAX_SCHEDULER_DELAY_MS = 3000;
const ASSET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const DEFAULT_MODEL_LIGHTING: Readonly<ModelLighting> = Object.freeze({
  tone_mapping: "none",
  exposure: 1,
  environment_enabled: true,
  environment_intensity: 1,
  key_light_intensity: Math.PI,
  ambient_intensity: Math.PI,
});
type LightingNumberField =
  | 'exposure'
  | 'environment_intensity'
  | 'key_light_intensity'
  | 'ambient_intensity';

const MODEL_LIGHTING_RANGES: Readonly<
  Record<LightingNumberField, readonly [number, number]>
> = Object.freeze({
  exposure: [0.1, 3],
  environment_intensity: [0, 2],
  key_light_intensity: [0, 4],
  ambient_intensity: [0, 4],
});
export const DEFAULT_SPEAKING_TRANSITION: Readonly<{
  entry_ms: readonly [number, number];
  exit_ms: readonly [number, number];
}> = Object.freeze({
  entry_ms: Object.freeze([810, 945] as const),
  exit_ms: Object.freeze([630, 855] as const),
});

function defaultSpeakingTransition(): SpeakingTransition {
  return {
    entry_ms: [
      DEFAULT_SPEAKING_TRANSITION.entry_ms[0],
      DEFAULT_SPEAKING_TRANSITION.entry_ms[1],
    ],
    exit_ms: [
      DEFAULT_SPEAKING_TRANSITION.exit_ms[0],
      DEFAULT_SPEAKING_TRANSITION.exit_ms[1],
    ],
  };
}

function sanitizeTransitionRange(
  value: unknown,
  fallback: readonly [number, number],
): TransitionRange {
  const candidate = Array.isArray(value) ? value : [value, value];
  if (candidate.length !== 2) return [fallback[0], fallback[1]];
  const minimum = Number(candidate[0]);
  const maximum = Number(candidate[1]);
  if (
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    minimum < MIN_SPEAKING_TRANSITION_MS ||
    maximum > MAX_SPEAKING_TRANSITION_MS ||
    minimum > maximum
  ) {
    return [fallback[0], fallback[1]];
  }
  return [
    Math.round(minimum),
    Math.round(maximum),
  ];
}

function sanitizeSpeakingTransition(value: unknown): SpeakingTransition {
  const source = isRecord(value) ? value : {};
  return {
    entry_ms: sanitizeTransitionRange(
      source.entry_ms,
      DEFAULT_SPEAKING_TRANSITION.entry_ms,
    ),
    exit_ms: sanitizeTransitionRange(
      source.exit_ms,
      DEFAULT_SPEAKING_TRANSITION.exit_ms,
    ),
  };
}

function sanitizeBodyTransitionMs(value: unknown): number {
  const milliseconds = Number(value);
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < MIN_BODY_TRANSITION_MS ||
    milliseconds > MAX_BODY_TRANSITION_MS
  ) {
    return DEFAULT_BODY_TRANSITION_MS;
  }
  return Math.round(milliseconds);
}

function sanitizeCharacterSize(value: unknown): number {
  const size = Number(value);
  return Number.isFinite(size) &&
    size >= MIN_CHARACTER_SIZE &&
    size <= MAX_CHARACTER_SIZE
    ? size
    : 1;
}

function migrateLegacySpeakingTransition(value: unknown): SpeakingTransition {
  const source = isRecord(value) ? value : {};
  const convert = (
    range: unknown,
    fallback: readonly [number, number],
  ): TransitionRange => {
    const candidate = Array.isArray(range) ? range : [range, range];
    if (candidate.length !== 2) return [fallback[0], fallback[1]];
    return sanitizeTransitionRange(
      candidate.map((factor) => Number(factor) * LEGACY_SPEAKING_HALF_BASE_MS),
      fallback,
    );
  };
  return {
    entry_ms: convert(
      source.entry_factor,
      DEFAULT_SPEAKING_TRANSITION.entry_ms,
    ),
    exit_ms: convert(
      source.exit_factor,
      DEFAULT_SPEAKING_TRANSITION.exit_ms,
    ),
  };
}

function sanitizeSchedulerDelayMs<T extends number | null>(
  value: unknown,
  fallback: T,
): number | T {
  const milliseconds = Number(value);
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < MIN_SCHEDULER_DELAY_MS ||
    milliseconds > MAX_SCHEDULER_DELAY_MS
  ) {
    return fallback;
  }
  return Math.round(milliseconds);
}

function sanitizeAvatarWindowSize(value: unknown): AvatarWindowSize {
  const source = isRecord(value) ? value : {};
  const width = Math.round(Number(source.width));
  const height = Math.round(Number(source.height));
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < MIN_AVATAR_WINDOW_WIDTH ||
    width > MAX_AVATAR_WINDOW_WIDTH ||
    height < MIN_AVATAR_WINDOW_HEIGHT ||
    height > MAX_AVATAR_WINDOW_HEIGHT
  ) {
    return { ...DEFAULT_AVATAR_WINDOW_SIZE };
  }
  return { width, height };
}

function defaultState(packagedLibrary: PackagedLibrary): SettingsState {
  return {
    schema_version: SETTINGS_SCHEMA_VERSION,
    default_model_id: packagedLibrary.default_model_id,
    character_size: 1,
    avatar_window: { ...DEFAULT_AVATAR_WINDOW_SIZE },
    click_through_enabled: false,
    look_at_cursor: true,
    developer_settings_enabled: false,
    vroid_hub_allow_plaintext_storage: false,
    body_transition_ms: DEFAULT_BODY_TRANSITION_MS,
    speaking_debounce_ms: DEFAULT_SPEAKING_DEBOUNCE_MS,
    idle_interim_ms: DEFAULT_IDLE_INTERIM_MS,
    speaking_transition: defaultSpeakingTransition(),
    model_lighting: {},
    models: [],
    animations: [],
    animation_clips: [],
    animation_clip_links: {},
    packaged_animation_overrides: {},
    hidden_packaged_animation_ids: [],
    voice_source: { ...DEFAULT_VOICE_SOURCE },
  };
}

function singleLine(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} is required.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error(`${field} is required.`);
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function optionalExpressionName(value: unknown): string | null {
  if (value == null || value === "") return null;

  if (typeof value !== "string") {
    throw new Error("Expression must be a string.");
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > 120) {
    throw new Error("Expression must be 120 characters or fewer.");
  }

  return trimmed;
}

function expressionWeight(value: unknown): number {
  if (value == null || value === "") return 1;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw new Error("Expression weight must be between 0 and 1.");
  }
  return Math.round(normalized * 100) / 100;
}

export function validateAnimationMetadata(metadata: unknown): AnimationMetadata {
  const source = isRecord(metadata) ? metadata : {};
  const animation_name = singleLine(
    source.animation_name,
    "Animation name",
    48,
  ).toLowerCase();
  if (!ANIMATION_NAME_PATTERN.test(animation_name)) {
    throw new Error(
      "Animation name must use lowercase letters, numbers, and single hyphens.",
    );
  }
  return {
    animation_name,
    animation_description: singleLine(
      source.animation_description,
      "Animation description",
      240,
    ),
    animation_trigger_scenario: singleLine(
      source.animation_trigger_scenario,
      "Animation trigger scenario",
      240,
    ),
    expression_name: optionalExpressionName(source.expression_name),
    expression_weight: expressionWeight(source.expression_weight),
  };
}

export function validateGlbFile(
  filePath: unknown,
  expectedExtension: '.vrm' | '.vrma',
): void {
  if (typeof filePath !== "string") throw new Error("No asset file was selected.");
  if (path.extname(filePath).toLowerCase() !== expectedExtension) {
    throw new Error(`Expected a ${expectedExtension} file.`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 12) {
    throw new Error("Asset file is empty or invalid.");
  }
  if (stat.size > MAX_ASSET_BYTES) {
    throw new Error("Asset file must be 200 MB or smaller.");
  }
  const descriptor = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    fs.readSync(descriptor, header, 0, header.length, 0);
    if (
      header.toString("ascii", 0, 4) !== "glTF" ||
      header.readUInt32LE(4) !== 2
    ) {
      throw new Error("Asset must be a valid VRM/VRMA glTF 2 binary.");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function isValidGlbBuffer(buffer: unknown): buffer is Buffer {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "glTF" &&
    buffer.readUInt32LE(4) === 2
  );
}

function validStoredAsset(
  record: unknown,
  extension: '.vrm' | '.vrma',
): record is Record<string, unknown> & {
  id: string;
  stored_filename: string;
} {
  return (
    isRecord(record) &&
    typeof record.id === 'string' &&
    typeof record.stored_filename === 'string' &&
    ASSET_ID_PATTERN.test(record.id) &&
    record.stored_filename === `${record.id}${extension}`
  );
}

function sanitizeModels(models: unknown): StoredModel[] {
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    if (!validStoredAsset(model, ".vrm")) return [];
    try {
      return [
        {
          id: model.id,
          stored_filename: model.stored_filename,
          model_name: singleLine(model.model_name, "Model name", 80),
        },
      ];
    } catch {
      return [];
    }
  });
}

function roundedLightingNumber(
  value: unknown,
  [minimum, maximum]: readonly [number, number],
  defaultValue: number | null = null,
): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    return null;
  }
  return value === defaultValue
    ? defaultValue
    : Math.round(value * 100) / 100;
}

function completeModelLighting(value: unknown): ModelLighting {
  const source = isRecord(value) ? value : {};
  const lighting: ModelLighting = { ...DEFAULT_MODEL_LIGHTING };
  if (source.tone_mapping === "none" || source.tone_mapping === "aces") {
    lighting.tone_mapping = source.tone_mapping;
  }
  if (typeof source.environment_enabled === "boolean") {
    lighting.environment_enabled = source.environment_enabled;
  }
  for (const field of Object.keys(MODEL_LIGHTING_RANGES) as LightingNumberField[]) {
    const range = MODEL_LIGHTING_RANGES[field];
    const normalized = roundedLightingNumber(
      source[field],
      range,
      DEFAULT_MODEL_LIGHTING[field],
    );
    if (normalized != null) lighting[field] = normalized;
  }
  return lighting;
}

function sanitizeModelLighting(
  modelLighting: unknown,
  knownModelIds: ReadonlySet<string>,
): Record<string, ModelLighting> {
  if (!isRecord(modelLighting)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(modelLighting)
      .filter(([modelId]) => knownModelIds.has(modelId))
      .map(([modelId, lighting]) => [
        modelId,
        completeModelLighting(lighting),
      ]),
  );
}

function sanitizeUserAnimations(animations: unknown): StoredAnimation[] {
  if (!Array.isArray(animations)) return [];
  return animations.flatMap((animation) => {
    if (
      !isRecord(animation) ||
      typeof animation.id !== 'string' ||
      !ASSET_ID_PATTERN.test(animation.id)
    ) {
      return [];
    }
    try {
      return [
        {
          id: animation.id,
          ...validateAnimationMetadata(animation),
        },
      ];
    } catch {
      return [];
    }
  });
}

function sanitizeLegacyAnimationClips(
  animationClips: unknown,
  knownAnimationIds: ReadonlySet<string>,
): Record<string, StoredAnimationClip[]> {
  if (!isRecord(animationClips)) return {};
  const sanitized: Record<string, StoredAnimationClip[]> = {};
  for (const [animationId, clips] of Object.entries(animationClips)) {
    if (!knownAnimationIds.has(animationId) || !Array.isArray(clips)) continue;
    const valid = clips.flatMap((clip) => {
      if (!validStoredAsset(clip, ".vrma")) return [];
      try {
        const clip_name = singleLine(clip.clip_name, "Clip name", 64).toLowerCase();
        if (!ANIMATION_NAME_PATTERN.test(clip_name)) return [];
        return [{
          id: clip.id,
          stored_filename: clip.stored_filename,
          clip_name,
          source: 'imported' as const,
          created_at: new Date(0).toISOString(),
          prompt: null,
          generation_job_id: null,
        }];
      } catch {
        return [];
      }
    });
    if (valid.length > 0) sanitized[animationId] = valid;
  }
  return sanitized;
}

function migrateClipMap(
  clipsByAnimation: Record<string, StoredAnimationClip[]>,
): Pick<SettingsState, 'animation_clips' | 'animation_clip_links'> {
  const clips = new Map<string, StoredAnimationClip>();
  const links: Record<string, string[]> = {};
  for (const [animationId, linkedClips] of Object.entries(clipsByAnimation)) {
    for (const clip of linkedClips) clips.set(clip.id, clip);
    const ids = [...new Set(linkedClips.map((clip) => clip.id))];
    if (ids.length > 0) links[animationId] = ids;
  }
  return { animation_clips: [...clips.values()], animation_clip_links: links };
}

function sanitizeAnimationLibraryClips(value: unknown): StoredAnimationClip[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((clip) => {
    if (!validStoredAsset(clip, '.vrma') || seen.has(clip.id)) return [];
    try {
      const clip_name = singleLine(clip.clip_name, 'Clip name', 64).toLowerCase();
      if (!ANIMATION_NAME_PATTERN.test(clip_name)) return [];
      const created = typeof clip.created_at === 'string' && Number.isFinite(Date.parse(clip.created_at))
        ? new Date(clip.created_at).toISOString()
        : new Date(0).toISOString();
      seen.add(clip.id);
      return [{
        id: clip.id,
        stored_filename: clip.stored_filename,
        clip_name,
        source: clip.source === 'kimodo' ? 'kimodo' as const : 'imported' as const,
        created_at: created,
        prompt: typeof clip.prompt === 'string' && clip.prompt.trim() ? clip.prompt.trim().slice(0, 4096) : null,
        generation_job_id: typeof clip.generation_job_id === 'string' ? clip.generation_job_id : null,
      }];
    } catch {
      return [];
    }
  });
}

function sanitizeAnimationClipLinks(
  value: unknown,
  knownAnimationIds: ReadonlySet<string>,
  knownClipIds: ReadonlySet<string>,
): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const links: Record<string, string[]> = {};
  for (const [animationId, clipIds] of Object.entries(value)) {
    if (!knownAnimationIds.has(animationId) || !Array.isArray(clipIds)) continue;
    const valid = [...new Set(clipIds.filter(
      (clipId): clipId is string => typeof clipId === 'string' && knownClipIds.has(clipId),
    ))];
    if (valid.length > 0) links[animationId] = valid;
  }
  return links;
}

function packagedUserLayers(
  parsed: Record<string, unknown>,
  packagedLibrary: PackagedLibrary,
): {
  hidden: string[];
  overrides: Record<string, AnimationMetadata>;
} {
  const packagedIds = new Set(
    packagedLibrary.animations.map((animation) => animation.id),
  );
  const overrides: Record<string, AnimationMetadata> = {};
  if (isRecord(parsed.packaged_animation_overrides)) {
    for (const [id, metadata] of Object.entries(
      parsed.packaged_animation_overrides,
    )) {
      if (!packagedIds.has(id) || SYSTEM_ANIMATION_IDS.has(id)) continue;
      try {
        overrides[id] = validateAnimationMetadata(metadata);
      } catch {
        // Ignore an invalid user override and retain the packaged metadata.
      }
    }
  }

  const hidden = Array.isArray(parsed.hidden_packaged_animation_ids)
    ? [
        ...new Set(
          parsed.hidden_packaged_animation_ids.filter(
            (id): id is string =>
              typeof id === 'string' &&
              packagedIds.has(id) &&
              !SYSTEM_ANIMATION_IDS.has(id),
          ),
        ),
      ]
    : [];
  return { hidden, overrides };
}

function nextClipName(
  animationName: string,
  existingNames: Set<string>,
): string {
  let index = 1;
  while (existingNames.has(`${animationName}${index}`)) index += 1;
  const clipName = `${animationName}${index}`;
  existingNames.add(clipName);
  return clipName;
}

function migrateLegacyAnimations(
  animations: unknown,
  packagedLibrary: PackagedLibrary,
): {
  animationClips: Record<string, StoredAnimationClip[]>;
  userAnimations: StoredAnimation[];
} {
  const userAnimations: StoredAnimation[] = [];
  const animationClips: Record<string, StoredAnimationClip[]> = {};
  const systemByType = new Map(
    packagedLibrary.animations
      .filter((animation) => SYSTEM_ANIMATION_IDS.has(animation.id))
      .map((animation) => [animation.animation_type, animation]),
  );
  const usedClipNames = new Map<string, Set<string>>();

  for (const animation of Array.isArray(animations) ? animations : []) {
    if (!validStoredAsset(animation, ".vrma")) continue;
    let metadata;
    try {
      metadata = validateAnimationMetadata(animation);
    } catch {
      continue;
    }

    const inferredType = inferAnimationType(metadata.animation_name);
    const systemAnimation =
      inferredType === "IDLE" || inferredType === "TALK"
        ? systemByType.get(inferredType)
        : null;
    const animationId = systemAnimation?.id ?? animation.id;
    const animationName =
      systemAnimation?.animation_name ?? metadata.animation_name;
    if (
      !systemAnimation &&
      !userAnimations.some((candidate) => candidate.id === animationId)
    ) {
      userAnimations.push({ id: animationId, ...metadata });
    }

    const names = usedClipNames.get(animationId) ?? new Set();
    usedClipNames.set(animationId, names);
    const clips = animationClips[animationId] ?? [];
    clips.push({
      id: animation.id,
      stored_filename: animation.stored_filename,
      clip_name: nextClipName(animationName, names),
      source: 'imported',
      created_at: new Date(0).toISOString(),
      prompt: null,
      generation_job_id: null,
    });
    animationClips[animationId] = clips;
  }

  return { animationClips, userAnimations };
}

function safeReadState(
  settingsPath: string,
  packagedLibrary: PackagedLibrary,
): { migrated: boolean; state: SettingsState } {
  const fallback = defaultState(packagedLibrary);
  try {
    const parsedValue: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!isRecord(parsedValue)) return { migrated: false, state: fallback };
    const parsed = parsedValue;
    if (
      typeof parsed.schema_version !== 'number' ||
      ![1, 2, 3, 4, 5, 6, 7, 8, 9, SETTINGS_SCHEMA_VERSION].includes(
        parsed.schema_version,
      )
    ) {
      return { migrated: false, state: fallback };
    }
    const usesLegacySchedulerUnits = parsed.schema_version <= 8;
    const { hidden, overrides } = packagedUserLayers(parsed, packagedLibrary);
    const models = sanitizeModels(parsed.models);
    const knownModelIds = new Set([
      ...packagedLibrary.models.map((model) => model.id),
      ...models.map((model) => model.id),
    ]);
    const voiceSource = normalizeVoiceSource(parsed.voice_source);
    const common = {
      ...fallback,
      default_model_id:
        typeof parsed.default_model_id === "string"
          ? parsed.default_model_id
          : fallback.default_model_id,
      character_size: sanitizeCharacterSize(parsed.character_size),
      avatar_window: sanitizeAvatarWindowSize(parsed.avatar_window),
      click_through_enabled: parsed.click_through_enabled === true,
      // Absent means on, unlike every flag around it. The gaze shipped
      // enabled, so a settings file written before it existed has to read as
      // the default rather than as someone having turned it off.
      look_at_cursor: parsed.look_at_cursor !== false,
      developer_settings_enabled: parsed.developer_settings_enabled === true,
      vroid_hub_allow_plaintext_storage:
        parsed.vroid_hub_allow_plaintext_storage === true,
      body_transition_ms: sanitizeBodyTransitionMs(
        usesLegacySchedulerUnits
          ? Number(parsed.body_transition_seconds) * 1000
          : parsed.body_transition_ms,
      ),
      speaking_debounce_ms: sanitizeSchedulerDelayMs(
        parsed.speaking_debounce_ms,
        DEFAULT_SPEAKING_DEBOUNCE_MS,
      ),
      idle_interim_ms: sanitizeSchedulerDelayMs(
        parsed.idle_interim_ms,
        DEFAULT_IDLE_INTERIM_MS,
      ),
      speaking_transition: usesLegacySchedulerUnits
        ? migrateLegacySpeakingTransition(parsed.speaking_transition)
        : sanitizeSpeakingTransition(parsed.speaking_transition),
      model_lighting: sanitizeModelLighting(
        parsed.model_lighting,
        knownModelIds,
      ),
      models,
      packaged_animation_overrides: overrides,
      hidden_packaged_animation_ids: hidden,
      voice_source: voiceSource,
    };

    if (parsed.schema_version !== SETTINGS_SCHEMA_VERSION) {
      if ([3, 4, 5, 6, 7, 8, 9].includes(parsed.schema_version)) {
        const animations = sanitizeUserAnimations(parsed.animations);
        const knownAnimationIds = new Set([
          ...packagedLibrary.animations.map((animation) => animation.id),
          ...animations.map((animation) => animation.id),
        ]);
        const migratedClips = migrateClipMap(sanitizeLegacyAnimationClips(
          parsed.animation_clips,
          knownAnimationIds,
        ));
        return {
          migrated: true,
          state: {
            ...common,
            animations,
            ...migratedClips,
          },
        };
      }
      const migrated = migrateLegacyAnimations(
        parsed.animations,
        packagedLibrary,
      );
      return {
        migrated: true,
        state: {
          ...common,
          animations: migrated.userAnimations,
          ...migrateClipMap(migrated.animationClips),
        },
      };
    }

    const animations = sanitizeUserAnimations(parsed.animations);
    const knownAnimationIds = new Set([
      ...packagedLibrary.animations.map((animation) => animation.id),
      ...animations.map((animation) => animation.id),
    ]);
    const animationClips = sanitizeAnimationLibraryClips(parsed.animation_clips);
    return {
      migrated: false,
      state: {
        ...common,
        animations,
        animation_clips: animationClips,
        animation_clip_links: sanitizeAnimationClipLinks(
          parsed.animation_clip_links,
          knownAnimationIds,
          new Set(animationClips.map((clip) => clip.id)),
        ),
      },
    };
  } catch {
    return { migrated: false, state: fallback };
  }
}

export function createSettingsStore({
  userDataPath,
  packagedLibraryPath = DEFAULT_PACKAGED_LIBRARY_PATH,
}: {
  userDataPath: string;
  packagedLibraryPath?: string;
}): SettingsStore {
  const packagedLibrary = readPackagedLibrary(packagedLibraryPath);
  const settingsPath = path.join(userDataPath, "settings.json");
  const modelDirectory = path.join(userDataPath, "assets", "models");
  const animationDirectory = path.join(userDataPath, "assets", "animations");
  fs.mkdirSync(modelDirectory, { recursive: true });
  fs.mkdirSync(animationDirectory, { recursive: true });
  const initial = safeReadState(settingsPath, packagedLibrary);
  const state = initial.state;
  let lastPersistedState = structuredClone(state);
  // A model fetched live from a linked account (e.g. VRoid Hub). Deliberately
  // kept out of `state`/settings.json: it never becomes an ordinary,
  // freely-reusable local file and disappears on restart by design.
  let hubModel: HubModel | null = null;
  // Whether the hub model is the active selection, tracked in memory only so
  // the persisted default_model_id always keeps pointing at the user's last
  // real (packaged/local) choice, even while a hub model is selected.
  let hubModelIsActive = false;

  function writeState(): void {
    state.schema_version = SETTINGS_SCHEMA_VERSION;
    fs.mkdirSync(userDataPath, { recursive: true });
    const temporaryPath = `${settingsPath}.tmp`;
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(temporaryPath, 'w', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporaryPath, settingsPath);
      lastPersistedState = structuredClone(state);
    } catch (error) {
      if (descriptor != null) {
        try { fs.closeSync(descriptor); } catch { /* Preserve the original state-write error. */ }
      }
      try { fs.rmSync(temporaryPath, { force: true }); } catch { /* A later state write reuses this exact path. */ }
      Object.assign(state, structuredClone(lastPersistedState));
      throw error;
    }
  }

  if (initial.migrated) writeState();

  function recoverStagedDeletions(
    directory: string,
    extension: '.vrm' | '.vrma',
    retainedFilenames: ReadonlySet<string>,
  ): void {
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.endsWith(`${extension}.delete`)) continue;
      const filename = entry.slice(0, -'.delete'.length);
      if (!/^[0-9a-f-]+\.(?:vrm|vrma)$/iu.test(filename)) continue;
      const stagedPath = path.join(directory, entry);
      const targetPath = path.join(directory, filename);
      try {
        if (retainedFilenames.has(filename) && !fs.existsSync(targetPath)) {
          fs.renameSync(stagedPath, targetPath);
        } else {
          fs.rmSync(stagedPath, { force: true });
        }
      } catch {
        // Leave the recovery file in place. The same exact-target recovery is
        // attempted again at the next startup.
      }
    }
  }

  recoverStagedDeletions(
    modelDirectory,
    '.vrm',
    new Set(state.models.map((model) => model.stored_filename)),
  );
  recoverStagedDeletions(
    animationDirectory,
    '.vrma',
    new Set(state.animation_clips.map((clip) => clip.stored_filename)),
  );

  function userAssetUrl(
    kind: 'animation' | 'model',
    record: { id: string },
  ): string {
    const extension = kind === "model" ? ".vrm" : ".vrma";
    return `persona-asset://${kind}/${record.id}${extension}`;
  }

  function packagedAssetUrl(relativePath: string): string {
    return `./assets/${relativePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;
  }

  function availableModels(): AvailableModel[] {
    const packagedModels: AvailableModel[] = packagedLibrary.models.map((model) => ({
      id: model.id,
      model_name: model.model_name,
      origin: "packaged",
      removable: false,
      asset_url: packagedAssetUrl(model.asset_path),
    }));
    const userModels: AvailableModel[] = state.models
      .filter((model) =>
        fs.existsSync(path.join(modelDirectory, model.stored_filename)),
      )
      .map((model) => ({
        id: model.id,
        model_name: model.model_name,
        origin: "user",
        removable: true,
        asset_url: userAssetUrl("model", model),
      }));
    const hubModels: AvailableModel[] = hubModel
      ? [
          {
            id: hubModel.id,
            model_name: hubModel.model_name,
            origin: "hub",
            removable: false,
            asset_url: `persona-asset://hub/${hubModel.id}.vrm`,
          },
        ]
      : [];
    return [...packagedModels, ...userModels, ...hubModels];
  }

  function packagedAnimationMetadata(
    animation: PackagedAnimation,
  ): AnimationMetadata | PackagedAnimation {
    return state.packaged_animation_overrides[animation.id] ?? animation;
  }

  function userClips(animationId: string): StoredAnimationClip[] {
    const linked = new Set(state.animation_clip_links[animationId] ?? []);
    return state.animation_clips.filter(
      (clip) => linked.has(clip.id) &&
        fs.existsSync(path.join(animationDirectory, clip.stored_filename)),
    );
  }

  function animationClips(
    animation: {
      id: string;
      animation_name: string;
      asset_paths: readonly string[];
    },
    animationName = animation.animation_name,
  ): AvailableAnimationClip[] {
    const packagedClips: AvailableAnimationClip[] = animation.asset_paths.map(
      (assetPath, index) => ({
        id: `${animation.id}:packaged:${index + 1}`,
        animation_name: `${animationName}${index + 1}`,
        origin: "packaged",
        source: "packaged",
        removable: false,
        asset_url: packagedAssetUrl(assetPath),
      }),
    );
    const uploadedClips: AvailableAnimationClip[] = userClips(animation.id).map((clip) => ({
      id: clip.id,
      animation_name: clip.clip_name,
      origin: "user",
      source: clip.source,
      removable: true,
      asset_url: userAssetUrl("animation", clip),
    }));
    return [...packagedClips, ...uploadedClips];
  }

  function availableAnimationLibraryClips(): PersonaAnimationLibraryClip[] {
    return state.animation_clips
      .filter((clip) => fs.existsSync(path.join(animationDirectory, clip.stored_filename)))
      .map((clip) => ({
        id: clip.id,
        clip_name: clip.clip_name,
        source: clip.source,
        asset_url: userAssetUrl('animation', clip),
        created_at: clip.created_at,
        prompt: clip.prompt,
        generation_job_id: clip.generation_job_id,
        linked_action_ids: Object.entries(state.animation_clip_links)
          .filter(([, clipIds]) => clipIds.includes(clip.id))
          .map(([animationId]) => animationId),
      }));
  }

  function availableAnimations(): AvailableAnimation[] {
    const hidden = new Set(state.hidden_packaged_animation_ids);
    const packagedAnimations: AvailableAnimation[] = packagedLibrary.animations
      .filter((animation) => !hidden.has(animation.id))
      .map((animation) => {
        const metadata = packagedAnimationMetadata(animation);
        const clips = animationClips(animation, metadata.animation_name);
        const system = SYSTEM_ANIMATION_IDS.has(animation.id);
        return {
          id: animation.id,
          animation_name: metadata.animation_name,
          animation_description: metadata.animation_description,
          animation_trigger_scenario: metadata.animation_trigger_scenario,
          expression_name: metadata.expression_name ?? null,
          expression_weight: metadata.expression_weight ?? 1,
          animation_type: animation.animation_type,
          origin: "packaged",
          system,
          editable: !system,
          modified: state.packaged_animation_overrides[animation.id] != null,
          removable: !system,
          clips,
          asset_urls: clips.map((clip) => clip.asset_url),
        };
      });
    const userAnimations: AvailableAnimation[] = state.animations.map((animation) => {
      const clips = animationClips({ ...animation, asset_paths: [] });
      return {
        id: animation.id,
        animation_name: animation.animation_name,
        animation_description: animation.animation_description,
        animation_trigger_scenario: animation.animation_trigger_scenario,
        expression_name: animation.expression_name ?? null,
        expression_weight: animation.expression_weight ?? 1,
        animation_type: null,
        origin: "user",
        system: false,
        editable: true,
        modified: false,
        removable: true,
        clips,
        asset_urls: clips.map((clip) => clip.asset_url),
      };
    });
    return [...packagedAnimations, ...userAnimations];
  }

  function getSnapshot(): SettingsSnapshot {
    const models = availableModels();
    const modelIds = new Set(models.map((model) => model.id));
    const defaultModel =
      hubModel && hubModelIsActive
        ? hubModel.id
        : models.some((model) => model.id === state.default_model_id)
          ? state.default_model_id
          : packagedLibrary.default_model_id;
    const changedPackagedIds = new Set([
      ...Object.keys(state.packaged_animation_overrides),
      ...state.hidden_packaged_animation_ids,
    ]);
    return {
      schema_version: SETTINGS_SCHEMA_VERSION,
      default_model_id: defaultModel,
      character_size: state.character_size,
      avatar_window: sanitizeAvatarWindowSize(state.avatar_window),
      click_through_enabled: state.click_through_enabled === true,
      look_at_cursor: state.look_at_cursor !== false,
      developer_settings_enabled: state.developer_settings_enabled === true,
      vroid_hub_allow_plaintext_storage:
        state.vroid_hub_allow_plaintext_storage === true,
      body_transition_ms: sanitizeBodyTransitionMs(
        state.body_transition_ms,
      ),
      speaking_debounce_ms: sanitizeSchedulerDelayMs(
        state.speaking_debounce_ms,
        DEFAULT_SPEAKING_DEBOUNCE_MS,
      ),
      idle_interim_ms: sanitizeSchedulerDelayMs(
        state.idle_interim_ms,
        DEFAULT_IDLE_INTERIM_MS,
      ),
      speaking_transition: sanitizeSpeakingTransition(
        state.speaking_transition,
      ),
      packaged_animation_change_count: changedPackagedIds.size,
      models,
      animations: availableAnimations(),
      animation_clips: availableAnimationLibraryClips(),
      model_lighting: sanitizeModelLighting(
        state.model_lighting,
        modelIds,
      ),
      voice_source: normalizeVoiceSource(state.voice_source),
    };
  }

  function animationNameTaken(
    animationName: string,
    excludingId: string | null = null,
  ): boolean {
    return availableAnimations().some(
      (animation) =>
        animation.id !== excludingId &&
        animation.animation_name === animationName,
    );
  }

  function importModel({
    filePath,
    model_name,
  }: {
    filePath: string;
    model_name: unknown;
  }): SettingsSnapshot {
    if (state.models.length >= MAX_CUSTOM_MODELS) {
      throw new Error("Persona supports up to 50 custom models.");
    }
    const normalizedName = singleLine(model_name, "Model name", 80);
    if (
      availableModels().some(
        (model) =>
          model.model_name.toLowerCase() === normalizedName.toLowerCase(),
      )
    ) {
      throw new Error("A model with this name already exists.");
    }
    validateGlbFile(filePath, ".vrm");
    const id = nodeCrypto.randomUUID();
    const stored_filename = `${id}.vrm`;
    fs.copyFileSync(filePath, path.join(modelDirectory, stored_filename));
    state.models.push({ id, model_name: normalizedName, stored_filename });
    if (
      !availableModels().some(
        (model) => model.id === state.default_model_id,
      )
    ) {
      state.default_model_id = id;
    }
    try {
      writeState();
    } catch (error) {
      removeStoredFile(modelDirectory, stored_filename);
      throw error;
    }
    return getSnapshot();
  }

  function createAnimation(metadata: unknown): SettingsSnapshot {
    return createAnimationWithClips(metadata, []);
  }

  function assertCanAddAnimationClips(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error('Animation clip count must be a positive integer.');
    }
    if (state.animation_clips.length + count > MAX_CUSTOM_ANIMATION_CLIPS) {
      throw new Error(`Persona supports up to ${MAX_CUSTOM_ANIMATION_CLIPS} animation clips.`);
    }
  }

  function createAnimationWithClips(
    metadata: unknown,
    clipIds: readonly string[],
  ): SettingsSnapshot {
    if (state.animations.length >= MAX_CUSTOM_ANIMATIONS) {
      throw new Error("Persona supports up to 100 custom animation actions.");
    }
    const normalized = validateAnimationMetadata(metadata);
    if (animationNameTaken(normalized.animation_name)) {
      throw new Error("An animation action with this name already exists.");
    }
    if (!Array.isArray(clipIds) || clipIds.some((clipId) => typeof clipId !== 'string')) {
      throw new Error('Animation clip ids must be an array of strings.');
    }
    const linkedClipIds = [...new Set(clipIds)];
    if (linkedClipIds.some((clipId) => !state.animation_clips.some((clip) => clip.id === clipId))) {
      throw new Error('One or more animation clips are not in the reusable library.');
    }
    const id = nodeCrypto.randomUUID();
    state.animations.push({ id, ...normalized });
    if (linkedClipIds.length > 0) state.animation_clip_links[id] = linkedClipIds;
    writeState();
    return getSnapshot();
  }

  function addAnimationClips(
    animationId: string,
    filePaths: readonly string[],
  ): SettingsSnapshot {
    const animation = availableAnimations().find(
      (candidate) => candidate.id === animationId,
    );
    if (!animation) throw new Error("Animation action is not installed.");
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error("No VRMA files were selected.");
    }
    assertCanAddAnimationClips(filePaths.length);
    for (const filePath of filePaths) validateGlbFile(filePath, ".vrma");

    const existingNames = new Set(
      state.animation_clips.map((clip) => clip.clip_name),
    );
    const added: StoredAnimationClip[] = [];
    try {
      for (const filePath of filePaths) {
        const id = nodeCrypto.randomUUID();
        const stored_filename = `${id}.vrma`;
        fs.copyFileSync(filePath, path.join(animationDirectory, stored_filename));
        added.push({
          id,
          stored_filename,
          clip_name: nextClipName(animation.animation_name, existingNames),
          source: 'imported',
          created_at: new Date().toISOString(),
          prompt: null,
          generation_job_id: null,
        });
      }
      state.animation_clips.push(...added);
      state.animation_clip_links[animationId] = [
        ...(state.animation_clip_links[animationId] ?? []),
        ...added.map((clip) => clip.id),
      ];
      writeState();
    } catch (error) {
      for (const clip of added) {
        removeStoredFile(animationDirectory, clip.stored_filename);
      }
      throw error;
    }
    return getSnapshot();
  }

  function importAnimationClips(filePaths: readonly string[]): SettingsSnapshot {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error('No VRMA files were selected.');
    }
    assertCanAddAnimationClips(filePaths.length);
    for (const filePath of filePaths) validateGlbFile(filePath, '.vrma');
    const existingNames = new Set(state.animation_clips.map((clip) => clip.clip_name));
    const added: StoredAnimationClip[] = [];
    try {
      for (const filePath of filePaths) {
        const id = nodeCrypto.randomUUID();
        const stored_filename = `${id}.vrma`;
        fs.copyFileSync(filePath, path.join(animationDirectory, stored_filename));
        const basename = path.basename(filePath, path.extname(filePath))
          .toLowerCase()
          .normalize('NFKD')
          .replace(/[^a-z0-9]+/gu, '-')
          .replace(/^-|-$/gu, '')
          .slice(0, 58)
          .replace(/-$/u, '') || 'imported-clip';
        let clip_name = basename;
        for (let index = 2; existingNames.has(clip_name); index += 1) {
          const suffix = `-${index}`;
          clip_name = `${basename.slice(0, 64 - suffix.length).replace(/-$/u, '')}${suffix}`;
        }
        existingNames.add(clip_name);
        added.push({
          id,
          stored_filename,
          clip_name,
          source: 'imported',
          created_at: new Date().toISOString(),
          prompt: null,
          generation_job_id: null,
        });
      }
      state.animation_clips.push(...added);
      writeState();
    } catch (error) {
      for (const clip of added) removeStoredFile(animationDirectory, clip.stored_filename);
      throw error;
    }
    return getSnapshot();
  }

  function addGeneratedAnimationClip(
    filePath: string,
    metadata: { clip_name: unknown; prompt: unknown; generation_job_id: unknown },
  ): SettingsSnapshot {
    assertCanAddAnimationClips();
    validateGlbFile(filePath, '.vrma');
    const requestedName = singleLine(metadata.clip_name, 'Clip name', 64).toLowerCase();
    if (!ANIMATION_NAME_PATTERN.test(requestedName)) {
      throw new Error('Clip name must use lowercase letters, numbers, and single hyphens.');
    }
    const existingNames = new Set(state.animation_clips.map((clip) => clip.clip_name));
    let clipName = requestedName;
    for (let index = 2; existingNames.has(clipName); index += 1) {
      const suffix = `-${index}`;
      clipName = `${requestedName.slice(0, 64 - suffix.length).replace(/-$/u, '')}${suffix}`;
    }
    const prompt = typeof metadata.prompt === 'string' ? metadata.prompt.trim() : '';
    if (!prompt || Buffer.byteLength(prompt, 'utf8') > 4096) {
      throw new Error('Generation prompt must be between 1 and 4096 UTF-8 bytes.');
    }
    const generationJobId = singleLine(metadata.generation_job_id, 'Generation job id', 128);
    const id = nodeCrypto.randomUUID();
    const stored_filename = `${id}.vrma`;
    fs.copyFileSync(filePath, path.join(animationDirectory, stored_filename));
    state.animation_clips.push({
      id,
      stored_filename,
      clip_name: clipName,
      source: 'kimodo',
      created_at: new Date().toISOString(),
      prompt,
      generation_job_id: generationJobId,
    });
    try {
      writeState();
    } catch (error) {
      removeStoredFile(animationDirectory, stored_filename);
      throw error;
    }
    return getSnapshot();
  }

  function attachAnimationClips(
    animationId: string,
    clipIds: readonly string[],
  ): SettingsSnapshot {
    if (!availableAnimations().some((animation) => animation.id === animationId)) {
      throw new Error('Animation action is not installed.');
    }
    const uniqueClipIds = [...new Set(clipIds)];
    if (uniqueClipIds.length === 0) {
      throw new Error('Choose at least one animation clip.');
    }
    const libraryIds = new Set(state.animation_clips.map((clip) => clip.id));
    if (uniqueClipIds.some((clipId) => !libraryIds.has(clipId))) {
      throw new Error('Animation clip is not in the reusable library.');
    }
    const previousLinks = state.animation_clip_links[animationId];
    const links = previousLinks ?? [];
    const nextLinks = [...links];
    for (const clipId of uniqueClipIds) {
      if (!nextLinks.includes(clipId)) nextLinks.push(clipId);
    }
    if (nextLinks.length === links.length) return getSnapshot();
    state.animation_clip_links[animationId] = nextLinks;
    try {
      writeState();
    } catch (error) {
      if (previousLinks) state.animation_clip_links[animationId] = previousLinks;
      else delete state.animation_clip_links[animationId];
      throw error;
    }
    return getSnapshot();
  }

  function attachAnimationClip(animationId: string, clipId: string): SettingsSnapshot {
    return attachAnimationClips(animationId, [clipId]);
  }

  function updateAnimation(
    animationId: string,
    metadata: unknown,
  ): SettingsSnapshot {
    const normalized = validateAnimationMetadata(metadata);
    if (animationNameTaken(normalized.animation_name, animationId)) {
      throw new Error("An animation action with this name already exists.");
    }

    const packaged = packagedLibrary.animations.find(
      (animation) => animation.id === animationId,
    );
    if (packaged) {
      if (SYSTEM_ANIMATION_IDS.has(animationId)) {
        throw new Error("Idle and Speaking are permanent system actions.");
      }
      if (state.hidden_packaged_animation_ids.includes(animationId)) {
        throw new Error("This packaged animation action is currently removed.");
      }
      const unchanged =
        normalized.animation_name === packaged.animation_name &&
        normalized.animation_description ===
          packaged.animation_description &&
        normalized.animation_trigger_scenario ===
          packaged.animation_trigger_scenario &&
        normalized.expression_name === (packaged.expression_name ?? null) &&
        normalized.expression_weight === (packaged.expression_weight ?? 1);
      if (unchanged) {
        delete state.packaged_animation_overrides[animationId];
      } else {
        state.packaged_animation_overrides[animationId] = normalized;
      }
      writeState();
      return getSnapshot();
    }

    const userAnimation = state.animations.find(
      (animation) => animation.id === animationId,
    );
    if (!userAnimation) throw new Error("Animation action is not installed.");
    Object.assign(userAnimation, normalized);
    writeState();
    return getSnapshot();
  }

  function removeStoredFile(directory: string, filename: string): void {
    const target = path.join(directory, filename);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }

  function stageStoredFileDeletion(
    directory: string,
    filename: string,
  ): { stagedPath: string; targetPath: string } | null {
    const targetPath = path.join(directory, filename);
    if (!fs.existsSync(targetPath)) return null;
    const stagedPath = `${targetPath}.delete`;
    if (fs.existsSync(stagedPath)) {
      throw new Error('A previous asset deletion is still awaiting recovery. Restart Persona and try again.');
    }
    fs.renameSync(targetPath, stagedPath);
    return { stagedPath, targetPath };
  }

  function restoreStagedFile(
    staged: { stagedPath: string; targetPath: string } | null,
  ): void {
    if (staged && fs.existsSync(staged.stagedPath) && !fs.existsSync(staged.targetPath)) {
      try {
        fs.renameSync(staged.stagedPath, staged.targetPath);
      } catch {
        // The file remains in its deterministic .delete recovery location and
        // is restored from the persisted state on the next startup.
      }
    }
  }

  function finishStagedDeletion(
    staged: { stagedPath: string; targetPath: string } | null,
  ): void {
    if (!staged) return;
    try {
      fs.rmSync(staged.stagedPath, { force: true });
    } catch {
      // The state no longer references this file. Startup cleanup retries the
      // exact staged path without risking a user-owned asset.
    }
  }

  function detachAnimationClip(
    animationId: string,
    clipId: string,
  ): SettingsSnapshot {
    const links = state.animation_clip_links[animationId] ?? [];
    if (!links.includes(clipId)) throw new Error('Animation clip is not linked to this action.');
    const remaining = links.filter((id) => id !== clipId);
    if (remaining.length > 0) state.animation_clip_links[animationId] = remaining;
    else delete state.animation_clip_links[animationId];
    writeState();
    return getSnapshot();
  }

  function deleteAnimationLibraryClip(clipId: string): SettingsSnapshot {
    const index = state.animation_clips.findIndex((clip) => clip.id === clipId);
    if (index === -1) throw new Error('Animation clip was not found.');
    const removed = state.animation_clips[index];
    if (!removed) throw new Error('Animation clip was not found.');
    const staged = stageStoredFileDeletion(animationDirectory, removed.stored_filename);
    state.animation_clips.splice(index, 1);
    for (const [animationId, links] of Object.entries(state.animation_clip_links)) {
      const remaining = links.filter((id) => id !== clipId);
      if (remaining.length > 0) state.animation_clip_links[animationId] = remaining;
      else delete state.animation_clip_links[animationId];
    }
    try {
      writeState();
    } catch (error) {
      restoreStagedFile(staged);
      throw error;
    }
    finishStagedDeletion(staged);
    return getSnapshot();
  }

  function deleteAnimation(animationId: string): SettingsSnapshot {
    if (SYSTEM_ANIMATION_IDS.has(animationId)) {
      throw new Error("Idle and Speaking cannot be removed.");
    }
    const packaged = packagedLibrary.animations.find(
      (animation) => animation.id === animationId,
    );
    if (packaged) {
      if (!state.hidden_packaged_animation_ids.includes(animationId)) {
        state.hidden_packaged_animation_ids.push(animationId);
      }
      delete state.packaged_animation_overrides[animationId];
      delete state.animation_clip_links[animationId];
      writeState();
      return getSnapshot();
    }

    const index = state.animations.findIndex(
      (animation) => animation.id === animationId,
    );
    if (index === -1) throw new Error("Animation action is not installed.");
    state.animations.splice(index, 1);
    delete state.animation_clip_links[animationId];
    writeState();
    return getSnapshot();
  }

  function resetPackagedAnimations(): SettingsSnapshot {
    state.packaged_animation_overrides = {};
    state.hidden_packaged_animation_ids = [];
    writeState();
    return getSnapshot();
  }

  function deleteModel(modelId: string): SettingsSnapshot {
    const index = state.models.findIndex((model) => model.id === modelId);
    if (index === -1) {
      throw new Error("Packaged models cannot be deleted.");
    }
    const removed = state.models[index];
    if (!removed) throw new Error('Custom model was not found.');
    const staged = stageStoredFileDeletion(modelDirectory, removed.stored_filename);
    state.models.splice(index, 1);
    if (state.default_model_id === modelId) {
      state.default_model_id =
        packagedLibrary.default_model_id ?? state.models[0]?.id ?? null;
    }
    delete state.model_lighting[modelId];
    try {
      writeState();
    } catch (error) {
      restoreStagedFile(staged);
      throw error;
    }
    finishStagedDeletion(staged);
    return getSnapshot();
  }

  function setDefaultModel(modelId: string): SettingsSnapshot {
    if (!availableModels().some((model) => model.id === modelId)) {
      throw new Error("Selected model is not installed.");
    }
    if (hubModel && modelId === hubModel.id) {
      hubModelIsActive = true;
      return getSnapshot();
    }
    hubModelIsActive = false;
    state.default_model_id = modelId;
    writeState();
    return getSnapshot();
  }

  function setActiveHubModel(
    buffer: Buffer,
    { model_name }: { model_name?: unknown } = {},
  ): SettingsSnapshot {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
      throw new Error("Downloaded model is empty or invalid.");
    }
    if (buffer.length > MAX_ASSET_BYTES) {
      throw new Error("Downloaded model must be 200 MB or smaller.");
    }
    if (!isValidGlbBuffer(buffer)) {
      throw new Error("Downloaded model must be a valid VRM glTF 2 binary.");
    }
    const normalizedName = singleLine(model_name, "Model name", 80);
    const id = nodeCrypto.randomUUID();
    hubModel = { id, model_name: normalizedName, buffer };
    hubModelIsActive = true;
    return getSnapshot();
  }

  function clearActiveHubModel(): SettingsSnapshot {
    hubModel = null;
    hubModelIsActive = false;
    return getSnapshot();
  }

  function setCharacterSize(value: unknown): SettingsSnapshot {
    const size = Number(value);
    if (
      !Number.isFinite(size) ||
      size < MIN_CHARACTER_SIZE ||
      size > MAX_CHARACTER_SIZE
    ) {
      throw new Error(
        `Character size must be between ${MIN_CHARACTER_SIZE} and ${MAX_CHARACTER_SIZE}.`,
      );
    }
    state.character_size = Math.round(size * 100) / 100;
    writeState();
    return getSnapshot();
  }

  function setAvatarWindowSize(
    width: unknown,
    height: unknown,
  ): SettingsSnapshot {
    const nextWidth = Math.round(Number(width));
    if (
      !Number.isFinite(nextWidth) ||
      nextWidth < MIN_AVATAR_WINDOW_WIDTH ||
      nextWidth > MAX_AVATAR_WINDOW_WIDTH
    ) {
      throw new Error(
        `Avatar window width must be between ${MIN_AVATAR_WINDOW_WIDTH} and ${MAX_AVATAR_WINDOW_WIDTH}.`,
      );
    }
    const nextHeight = Math.round(Number(height));
    if (
      !Number.isFinite(nextHeight) ||
      nextHeight < MIN_AVATAR_WINDOW_HEIGHT ||
      nextHeight > MAX_AVATAR_WINDOW_HEIGHT
    ) {
      throw new Error(
        `Avatar window height must be between ${MIN_AVATAR_WINDOW_HEIGHT} and ${MAX_AVATAR_WINDOW_HEIGHT}.`,
      );
    }
    state.avatar_window = { width: nextWidth, height: nextHeight };
    writeState();
    return getSnapshot();
  }

  function setSpeakingTransition(value: unknown): SettingsSnapshot {
    if (!isRecord(value)) {
      throw new Error("Speaking transition settings must be an object.");
    }
    for (const field of ['entry_ms', 'exit_ms'] as const) {
      const range = value[field];
      if (
        !Array.isArray(range) ||
        range.length !== 2 ||
        range.some(
          (milliseconds) =>
            !Number.isFinite(Number(milliseconds)) ||
            Number(milliseconds) < MIN_SPEAKING_TRANSITION_MS ||
            Number(milliseconds) > MAX_SPEAKING_TRANSITION_MS,
        ) ||
        Number(range[0]) > Number(range[1])
      ) {
        throw new Error(
          `Speaking transition ranges must contain two ordered millisecond values between ${MIN_SPEAKING_TRANSITION_MS} and ${MAX_SPEAKING_TRANSITION_MS}.`,
        );
      }
    }
    state.speaking_transition = sanitizeSpeakingTransition(value);
    writeState();
    return getSnapshot();
  }

  function setBodyTransitionMs(value: unknown): SettingsSnapshot {
    const milliseconds = Number(value);
    if (
      !Number.isFinite(milliseconds) ||
      milliseconds < MIN_BODY_TRANSITION_MS ||
      milliseconds > MAX_BODY_TRANSITION_MS
    ) {
      throw new Error(
        `Body transition duration must be between ${MIN_BODY_TRANSITION_MS} and ${MAX_BODY_TRANSITION_MS} milliseconds.`,
      );
    }
    state.body_transition_ms = sanitizeBodyTransitionMs(milliseconds);
    writeState();
    return getSnapshot();
  }

  function setSpeakingDebounceMs(value: unknown): SettingsSnapshot {
    const sanitized = sanitizeSchedulerDelayMs(value, null);
    if (sanitized == null) {
      throw new Error(
        `Speaking debounce must be between ${MIN_SCHEDULER_DELAY_MS} and ${MAX_SCHEDULER_DELAY_MS} milliseconds.`,
      );
    }
    state.speaking_debounce_ms = sanitized;
    writeState();
    return getSnapshot();
  }

  function setIdleInterimMs(value: unknown): SettingsSnapshot {
    const sanitized = sanitizeSchedulerDelayMs(value, null);
    if (sanitized == null) {
      throw new Error(
        `Idle interim must be between ${MIN_SCHEDULER_DELAY_MS} and ${MAX_SCHEDULER_DELAY_MS} milliseconds.`,
      );
    }
    state.idle_interim_ms = sanitized;
    writeState();
    return getSnapshot();
  }

  function enableDeveloperSettings(): SettingsSnapshot {
    state.developer_settings_enabled = true;
    writeState();
    return getSnapshot();
  }

  function resetDeveloperSettings(): SettingsSnapshot {
    state.body_transition_ms = DEFAULT_BODY_TRANSITION_MS;
    state.speaking_debounce_ms = DEFAULT_SPEAKING_DEBOUNCE_MS;
    state.idle_interim_ms = DEFAULT_IDLE_INTERIM_MS;
    state.speaking_transition = defaultSpeakingTransition();
    state.vroid_hub_allow_plaintext_storage = false;
    writeState();
    return getSnapshot();
  }

  function setClickThroughEnabled(value: unknown): SettingsSnapshot {
    state.click_through_enabled = value === true;
    writeState();
    return getSnapshot();
  }

  function setLookAtCursor(value: unknown): SettingsSnapshot {
    state.look_at_cursor = value === true;
    writeState();
    return getSnapshot();
  }

  function setVroidHubPlaintextStorageAllowed(value: unknown): SettingsSnapshot {
    state.vroid_hub_allow_plaintext_storage = value === true;
    writeState();
    return getSnapshot();
  }

  function setVoiceSource(value: unknown): SettingsSnapshot {
    state.voice_source = sanitizeVoiceSource(value);
    writeState();
    return getSnapshot();
  }

  function setModelLighting(
    modelId: string,
    lighting: unknown,
  ): SettingsSnapshot {
    if (!availableModels().some((model) => model.id === modelId)) {
      throw new Error("Selected model is not installed.");
    }
    if (!isRecord(lighting)) {
      throw new Error("lighting must be an object.");
    }
    const merged = completeModelLighting(state.model_lighting[modelId]);
    if (lighting.tone_mapping !== undefined) {
      if (lighting.tone_mapping !== "none" && lighting.tone_mapping !== "aces") {
        throw new Error("tone_mapping must be 'none' or 'aces'.");
      }
      merged.tone_mapping = lighting.tone_mapping;
    }
    if (lighting.exposure !== undefined) {
      const value = roundedLightingNumber(
        lighting.exposure,
        MODEL_LIGHTING_RANGES.exposure,
        DEFAULT_MODEL_LIGHTING.exposure,
      );
      if (value == null) {
        throw new Error("exposure must be between 0.1 and 3.");
      }
      merged.exposure = value;
    }
    if (lighting.environment_enabled !== undefined) {
      if (typeof lighting.environment_enabled !== "boolean") {
        throw new Error("environment_enabled must be a boolean.");
      }
      merged.environment_enabled = lighting.environment_enabled;
    }
    if (lighting.environment_intensity !== undefined) {
      const value = roundedLightingNumber(
        lighting.environment_intensity,
        MODEL_LIGHTING_RANGES.environment_intensity,
        DEFAULT_MODEL_LIGHTING.environment_intensity,
      );
      if (value == null) {
        throw new Error("environment_intensity must be between 0 and 2.");
      }
      merged.environment_intensity = value;
    }
    if (lighting.key_light_intensity !== undefined) {
      const value = roundedLightingNumber(
        lighting.key_light_intensity,
        MODEL_LIGHTING_RANGES.key_light_intensity,
        DEFAULT_MODEL_LIGHTING.key_light_intensity,
      );
      if (value == null) {
        throw new Error("key_light_intensity must be between 0 and 4.");
      }
      merged.key_light_intensity = value;
    }
    if (lighting.ambient_intensity !== undefined) {
      const value = roundedLightingNumber(
        lighting.ambient_intensity,
        MODEL_LIGHTING_RANGES.ambient_intensity,
        DEFAULT_MODEL_LIGHTING.ambient_intensity,
      );
      if (value == null) {
        throw new Error("ambient_intensity must be between 0 and 4.");
      }
      merged.ambient_intensity = value;
    }
    state.model_lighting[modelId] = merged;
    writeState();
    return getSnapshot();
  }

  function resetModelLighting(modelId: string): SettingsSnapshot {
    if (!availableModels().some((model) => model.id === modelId)) {
      throw new Error("Selected model is not installed.");
    }
    delete state.model_lighting[modelId];
    writeState();
    return getSnapshot();
  }

  function getAnimation(animationName: string): AvailableAnimation | null {
    return (
      availableAnimations().find(
        (animation) => animation.animation_name === animationName,
      ) ?? null
    );
  }

  function resolveAssetRequest(
    rawUrl: string,
  ): string | { buffer: Buffer } | null {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    if (url.protocol !== "persona-asset:" || url.search || url.hash) return null;
    const kind = url.hostname;
    const requestedFilename = url.pathname.replace(/^\/+/, "");
    if (kind === "model") {
      const record = state.models.find(
        (model) => `${model.id}.vrm` === requestedFilename,
      );
      if (!record) return null;
      const resolved = path.join(modelDirectory, record.stored_filename);
      return fs.existsSync(resolved) ? resolved : null;
    }
    if (kind === "animation") {
      const record = state.animation_clips.find(
        (clip) => `${clip.id}.vrma` === requestedFilename,
      );
      if (!record) return null;
      const resolved = path.join(animationDirectory, record.stored_filename);
      return fs.existsSync(resolved) ? resolved : null;
    }
    if (kind === "hub") {
      if (!hubModel || `${hubModel.id}.vrm` !== requestedFilename) return null;
      return { buffer: hubModel.buffer };
    }
    return null;
  }

  return {
    assertCanAddAnimationClips,
    addAnimationClips,
    importAnimationClips,
    addGeneratedAnimationClip,
    attachAnimationClip,
    attachAnimationClips,
    clearActiveHubModel,
    createAnimation,
    createAnimationWithClips,
    deleteAnimation,
    detachAnimationClip,
    deleteAnimationLibraryClip,
    deleteModel,
    getAnimation,
    getSnapshot,
    importModel,
    enableDeveloperSettings,
    resetPackagedAnimations,
    resetDeveloperSettings,
    setVroidHubPlaintextStorageAllowed,
    resolveAssetRequest,
    setActiveHubModel,
    setAvatarWindowSize,
    setCharacterSize,
    setClickThroughEnabled,
    setLookAtCursor,
    setSpeakingTransition,
    setBodyTransitionMs,
    setSpeakingDebounceMs,
    setIdleInterimMs,
    setVoiceSource,
    setDefaultModel,
    setModelLighting,
    resetModelLighting,
    updateAnimation,
  };
}

export { ANIMATION_NAME_PATTERN };
