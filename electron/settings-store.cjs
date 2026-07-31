"use strict";

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  ANIMATION_NAME_PATTERN,
  SYSTEM_ANIMATION_IDS,
  inferAnimationType,
  readPackagedLibrary,
} = require("./library-catalog.cjs");
const {
  DEFAULT_VOICE_SOURCE,
  normalizeVoiceSource,
  sanitizeVoiceSourcePattern,
} = require("./voice-source.cjs");

const SETTINGS_SCHEMA_VERSION = 4;
const DEFAULT_PACKAGED_LIBRARY_PATH = path.join(
  __dirname,
  "..",
  "public",
  "assets",
  "library.json",
);
const MIN_CHARACTER_SIZE = 0.7;
const MAX_CHARACTER_SIZE = 1.6;
const MAX_ASSET_BYTES = 200 * 1024 * 1024;
const MAX_CUSTOM_MODELS = 50;
const MAX_CUSTOM_ANIMATIONS = 100;
const MAX_CUSTOM_ANIMATION_CLIPS = 300;
const ASSET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MODEL_LIGHTING = Object.freeze({
  tone_mapping: "none",
  exposure: 1,
  environment_enabled: true,
  environment_intensity: 1,
  key_light_intensity: Math.PI,
  ambient_intensity: Math.PI,
});
const MODEL_LIGHTING_RANGES = Object.freeze({
  exposure: [0.1, 3],
  environment_intensity: [0, 2],
  key_light_intensity: [0, 4],
  ambient_intensity: [0, 4],
});

function defaultState(packagedLibrary) {
  return {
    schema_version: SETTINGS_SCHEMA_VERSION,
    default_model_id: packagedLibrary.default_model_id,
    character_size: 1,
    model_lighting: {},
    models: [],
    animations: [],
    animation_clips: {},
    packaged_animation_overrides: {},
    hidden_packaged_animation_ids: [],
    voice_source: { ...DEFAULT_VOICE_SOURCE },
  };
}

function singleLine(value, field, maxLength) {
  if (typeof value !== "string") throw new Error(`${field} is required.`);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error(`${field} is required.`);
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function validateAnimationMetadata(metadata) {
  const animation_name = singleLine(
    metadata?.animation_name,
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
      metadata?.animation_description,
      "Animation description",
      240,
    ),
    animation_trigger_scenario: singleLine(
      metadata?.animation_trigger_scenario,
      "Animation trigger scenario",
      240,
    ),
  };
}

function validateGlbFile(filePath, expectedExtension) {
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

function validStoredAsset(record, extension) {
  return (
    ASSET_ID_PATTERN.test(record?.id) &&
    record.stored_filename === `${record.id}${extension}`
  );
}

function sanitizeModels(models) {
  if (!Array.isArray(models)) return [];
  return models.flatMap((model) => {
    if (!validStoredAsset(model, ".vrm")) return [];
    try {
      return [
        {
          ...model,
          model_name: singleLine(model.model_name, "Model name", 80),
        },
      ];
    } catch {
      return [];
    }
  });
}

function roundedLightingNumber(
  value,
  [minimum, maximum],
  defaultValue = null,
) {
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

function completeModelLighting(value) {
  const source =
    value != null && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  const lighting = { ...DEFAULT_MODEL_LIGHTING };
  if (source.tone_mapping === "none" || source.tone_mapping === "aces") {
    lighting.tone_mapping = source.tone_mapping;
  }
  if (typeof source.environment_enabled === "boolean") {
    lighting.environment_enabled = source.environment_enabled;
  }
  for (const [field, range] of Object.entries(MODEL_LIGHTING_RANGES)) {
    const normalized = roundedLightingNumber(
      source[field],
      range,
      DEFAULT_MODEL_LIGHTING[field],
    );
    if (normalized != null) lighting[field] = normalized;
  }
  return lighting;
}

function sanitizeModelLighting(modelLighting, knownModelIds) {
  if (
    modelLighting == null ||
    typeof modelLighting !== "object" ||
    Array.isArray(modelLighting)
  ) {
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

function sanitizeUserAnimations(animations) {
  if (!Array.isArray(animations)) return [];
  return animations.flatMap((animation) => {
    if (!ASSET_ID_PATTERN.test(animation?.id)) return [];
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

function sanitizeAnimationClips(animationClips, knownAnimationIds) {
  if (animationClips == null || typeof animationClips !== "object") return {};
  const sanitized = {};
  for (const [animationId, clips] of Object.entries(animationClips)) {
    if (!knownAnimationIds.has(animationId) || !Array.isArray(clips)) continue;
    const valid = clips.flatMap((clip) => {
      if (!validStoredAsset(clip, ".vrma")) return [];
      try {
        const clip_name = singleLine(clip.clip_name, "Clip name", 64).toLowerCase();
        if (!ANIMATION_NAME_PATTERN.test(clip_name)) return [];
        return [{ id: clip.id, stored_filename: clip.stored_filename, clip_name }];
      } catch {
        return [];
      }
    });
    if (valid.length > 0) sanitized[animationId] = valid;
  }
  return sanitized;
}

function packagedUserLayers(parsed, packagedLibrary) {
  const packagedIds = new Set(
    packagedLibrary.animations.map((animation) => animation.id),
  );
  const overrides = {};
  if (
    parsed.packaged_animation_overrides != null &&
    typeof parsed.packaged_animation_overrides === "object"
  ) {
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
            (id) => packagedIds.has(id) && !SYSTEM_ANIMATION_IDS.has(id),
          ),
        ),
      ]
    : [];
  return { hidden, overrides };
}

function nextClipName(animationName, existingNames) {
  let index = 1;
  while (existingNames.has(`${animationName}${index}`)) index += 1;
  const clipName = `${animationName}${index}`;
  existingNames.add(clipName);
  return clipName;
}

function migrateLegacyAnimations(animations, packagedLibrary) {
  const userAnimations = [];
  const animationClips = {};
  const systemByType = new Map(
    packagedLibrary.animations
      .filter((animation) => SYSTEM_ANIMATION_IDS.has(animation.id))
      .map((animation) => [animation.animation_type, animation]),
  );
  const usedClipNames = new Map();

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
    });
    animationClips[animationId] = clips;
  }

  return { animationClips, userAnimations };
}

function safeReadState(settingsPath, packagedLibrary) {
  const fallback = defaultState(packagedLibrary);
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (![1, 2, 3, SETTINGS_SCHEMA_VERSION].includes(parsed?.schema_version)) {
      return { migrated: false, state: fallback };
    }
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
      character_size: parsed.character_size,
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
      if (parsed.schema_version === 3) {
        const animations = sanitizeUserAnimations(parsed.animations);
        const knownAnimationIds = new Set([
          ...packagedLibrary.animations.map((animation) => animation.id),
          ...animations.map((animation) => animation.id),
        ]);
        return {
          migrated: true,
          state: {
            ...common,
            animations,
            animation_clips: sanitizeAnimationClips(
              parsed.animation_clips,
              knownAnimationIds,
            ),
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
          animation_clips: migrated.animationClips,
        },
      };
    }

    const animations = sanitizeUserAnimations(parsed.animations);
    const knownAnimationIds = new Set([
      ...packagedLibrary.animations.map((animation) => animation.id),
      ...animations.map((animation) => animation.id),
    ]);
    return {
      migrated: false,
      state: {
        ...common,
        animations,
        animation_clips: sanitizeAnimationClips(
          parsed.animation_clips,
          knownAnimationIds,
        ),
      },
    };
  } catch {
    return { migrated: false, state: fallback };
  }
}

function createSettingsStore({
  userDataPath,
  packagedLibraryPath = DEFAULT_PACKAGED_LIBRARY_PATH,
}) {
  const packagedLibrary = readPackagedLibrary(packagedLibraryPath);
  const settingsPath = path.join(userDataPath, "settings.json");
  const modelDirectory = path.join(userDataPath, "assets", "models");
  const animationDirectory = path.join(userDataPath, "assets", "animations");
  fs.mkdirSync(modelDirectory, { recursive: true });
  fs.mkdirSync(animationDirectory, { recursive: true });
  const initial = safeReadState(settingsPath, packagedLibrary);
  let state = initial.state;

  function writeState() {
    state.schema_version = SETTINGS_SCHEMA_VERSION;
    fs.mkdirSync(userDataPath, { recursive: true });
    const temporaryPath = `${settingsPath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, settingsPath);
  }

  if (initial.migrated) writeState();

  function userAssetUrl(kind, record) {
    const extension = kind === "model" ? ".vrm" : ".vrma";
    return `persona-asset://${kind}/${record.id}${extension}`;
  }

  function packagedAssetUrl(relativePath) {
    return `./assets/${relativePath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;
  }

  function availableModels() {
    const packagedModels = packagedLibrary.models.map((model) => ({
      id: model.id,
      model_name: model.model_name,
      origin: "packaged",
      removable: false,
      asset_url: packagedAssetUrl(model.asset_path),
    }));
    const userModels = state.models
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
    return [...packagedModels, ...userModels];
  }

  function packagedAnimationMetadata(animation) {
    return state.packaged_animation_overrides[animation.id] ?? animation;
  }

  function userClips(animationId) {
    return (state.animation_clips[animationId] ?? []).filter((clip) =>
      fs.existsSync(path.join(animationDirectory, clip.stored_filename)),
    );
  }

  function animationClips(animation, animationName = animation.animation_name) {
    const packagedClips = (animation.asset_paths ?? []).map(
      (assetPath, index) => ({
        id: `${animation.id}:packaged:${index + 1}`,
        animation_name: `${animationName}${index + 1}`,
        origin: "packaged",
        removable: false,
        asset_url: packagedAssetUrl(assetPath),
      }),
    );
    const uploadedClips = userClips(animation.id).map((clip) => ({
      id: clip.id,
      animation_name: clip.clip_name,
      origin: "user",
      removable: true,
      asset_url: userAssetUrl("animation", clip),
    }));
    return [...packagedClips, ...uploadedClips];
  }

  function availableAnimations() {
    const hidden = new Set(state.hidden_packaged_animation_ids);
    const packagedAnimations = packagedLibrary.animations
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
    const userAnimations = state.animations.map((animation) => {
      const clips = animationClips({ ...animation, asset_paths: [] });
      return {
        id: animation.id,
        animation_name: animation.animation_name,
        animation_description: animation.animation_description,
        animation_trigger_scenario: animation.animation_trigger_scenario,
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

  function getSnapshot() {
    const models = availableModels();
    const modelIds = new Set(models.map((model) => model.id));
    const defaultModel = models.some(
      (model) => model.id === state.default_model_id,
    )
      ? state.default_model_id
      : packagedLibrary.default_model_id;
    const characterSize = Number(state.character_size);
    const changedPackagedIds = new Set([
      ...Object.keys(state.packaged_animation_overrides),
      ...state.hidden_packaged_animation_ids,
    ]);
    return {
      schema_version: SETTINGS_SCHEMA_VERSION,
      default_model_id: defaultModel,
      character_size:
        Number.isFinite(characterSize) &&
        characterSize >= MIN_CHARACTER_SIZE &&
        characterSize <= MAX_CHARACTER_SIZE
          ? characterSize
          : 1,
      packaged_animation_change_count: changedPackagedIds.size,
      models,
      animations: availableAnimations(),
      model_lighting: sanitizeModelLighting(
        state.model_lighting,
        modelIds,
      ),
      voice_source: normalizeVoiceSource(state.voice_source),
    };
  }

  function animationNameTaken(animationName, excludingId = null) {
    return availableAnimations().some(
      (animation) =>
        animation.id !== excludingId &&
        animation.animation_name === animationName,
    );
  }

  function importModel({ filePath, model_name }) {
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
    writeState();
    return getSnapshot();
  }

  function createAnimation(metadata) {
    if (state.animations.length >= MAX_CUSTOM_ANIMATIONS) {
      throw new Error("Persona supports up to 100 custom animation actions.");
    }
    const normalized = validateAnimationMetadata(metadata);
    if (animationNameTaken(normalized.animation_name)) {
      throw new Error("An animation action with this name already exists.");
    }
    state.animations.push({ id: nodeCrypto.randomUUID(), ...normalized });
    writeState();
    return getSnapshot();
  }

  function addAnimationClips(animationId, filePaths) {
    const animation = availableAnimations().find(
      (candidate) => candidate.id === animationId,
    );
    if (!animation) throw new Error("Animation action is not installed.");
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error("No VRMA files were selected.");
    }
    const clipCount = Object.values(state.animation_clips).reduce(
      (count, clips) => count + clips.length,
      0,
    );
    if (clipCount + filePaths.length > MAX_CUSTOM_ANIMATION_CLIPS) {
      throw new Error(
        `Persona supports up to ${MAX_CUSTOM_ANIMATION_CLIPS} uploaded animation clips.`,
      );
    }
    for (const filePath of filePaths) validateGlbFile(filePath, ".vrma");

    const existingNames = new Set(
      animation.clips.map((clip) => clip.animation_name),
    );
    const added = [];
    try {
      for (const filePath of filePaths) {
        const id = nodeCrypto.randomUUID();
        const stored_filename = `${id}.vrma`;
        fs.copyFileSync(filePath, path.join(animationDirectory, stored_filename));
        added.push({
          id,
          stored_filename,
          clip_name: nextClipName(animation.animation_name, existingNames),
        });
      }
    } catch (error) {
      for (const clip of added) {
        removeStoredFile(animationDirectory, clip.stored_filename);
      }
      throw error;
    }
    state.animation_clips[animationId] = [
      ...(state.animation_clips[animationId] ?? []),
      ...added,
    ];
    writeState();
    return getSnapshot();
  }

  function updateAnimation(animationId, metadata) {
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
          packaged.animation_trigger_scenario;
      if (unchanged) {
        delete state.packaged_animation_overrides[animationId];
      } else {
        state.packaged_animation_overrides[animationId] = normalized;
      }
      (state.animation_clips[animationId] ?? []).forEach((clip, index) => {
        clip.clip_name = `${normalized.animation_name}${
          packaged.asset_paths.length + index + 1
        }`;
      });
      writeState();
      return getSnapshot();
    }

    const userAnimation = state.animations.find(
      (animation) => animation.id === animationId,
    );
    if (!userAnimation) throw new Error("Animation action is not installed.");
    Object.assign(userAnimation, normalized);
    (state.animation_clips[animationId] ?? []).forEach((clip, index) => {
      clip.clip_name = `${normalized.animation_name}${index + 1}`;
    });
    writeState();
    return getSnapshot();
  }

  function removeStoredFile(directory, filename) {
    const target = path.join(directory, filename);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }

  function deleteAnimationClip(animationId, clipId) {
    const clips = state.animation_clips[animationId] ?? [];
    const index = clips.findIndex((clip) => clip.id === clipId);
    if (index === -1) throw new Error("Uploaded animation clip was not found.");
    const [removed] = clips.splice(index, 1);
    removeStoredFile(animationDirectory, removed.stored_filename);
    if (clips.length === 0) delete state.animation_clips[animationId];
    writeState();
    return getSnapshot();
  }

  function deleteAnimation(animationId) {
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
      writeState();
      return getSnapshot();
    }

    const index = state.animations.findIndex(
      (animation) => animation.id === animationId,
    );
    if (index === -1) throw new Error("Animation action is not installed.");
    state.animations.splice(index, 1);
    for (const clip of state.animation_clips[animationId] ?? []) {
      removeStoredFile(animationDirectory, clip.stored_filename);
    }
    delete state.animation_clips[animationId];
    writeState();
    return getSnapshot();
  }

  function resetPackagedAnimations() {
    state.packaged_animation_overrides = {};
    state.hidden_packaged_animation_ids = [];
    for (const animation of packagedLibrary.animations) {
      (state.animation_clips[animation.id] ?? []).forEach((clip, index) => {
        clip.clip_name = `${animation.animation_name}${
          animation.asset_paths.length + index + 1
        }`;
      });
    }
    writeState();
    return getSnapshot();
  }

  function deleteModel(modelId) {
    const index = state.models.findIndex((model) => model.id === modelId);
    if (index === -1) {
      throw new Error("Packaged models cannot be deleted.");
    }
    const [removed] = state.models.splice(index, 1);
    removeStoredFile(modelDirectory, removed.stored_filename);
    if (state.default_model_id === modelId) {
      state.default_model_id =
        packagedLibrary.default_model_id ?? state.models[0]?.id ?? null;
    }
    delete state.model_lighting[modelId];
    writeState();
    return getSnapshot();
  }

  function setDefaultModel(modelId) {
    if (!availableModels().some((model) => model.id === modelId)) {
      throw new Error("Selected model is not installed.");
    }
    state.default_model_id = modelId;
    writeState();
    return getSnapshot();
  }

  function setCharacterSize(value) {
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

  function setVoiceSource(value) {
    const mode = value?.mode === "custom" ? "custom" : "default";
    if (mode === "default") {
      state.voice_source = { ...DEFAULT_VOICE_SOURCE };
      writeState();
      return getSnapshot();
    }
    state.voice_source = {
      mode: "custom",
      process_pattern: sanitizeVoiceSourcePattern(value?.process_pattern),
    };
    writeState();
    return getSnapshot();
  }

  function setModelLighting(modelId, lighting) {
    if (!availableModels().some((model) => model.id === modelId)) {
      throw new Error("Selected model is not installed.");
    }
    if (
      !lighting ||
      typeof lighting !== "object" ||
      Array.isArray(lighting)
    ) {
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

  function resetModelLighting(modelId) {
    if (!availableModels().some((model) => model.id === modelId)) {
      throw new Error("Selected model is not installed.");
    }
    delete state.model_lighting[modelId];
    writeState();
    return getSnapshot();
  }

  function getAnimation(animationName) {
    return (
      availableAnimations().find(
        (animation) => animation.animation_name === animationName,
      ) ?? null
    );
  }

  function resolveAssetRequest(rawUrl) {
    let url;
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
      const record = Object.values(state.animation_clips)
        .flat()
        .find((clip) => `${clip.id}.vrma` === requestedFilename);
      if (!record) return null;
      const resolved = path.join(animationDirectory, record.stored_filename);
      return fs.existsSync(resolved) ? resolved : null;
    }
    return null;
  }

  return {
    addAnimationClips,
    createAnimation,
    deleteAnimation,
    deleteAnimationClip,
    deleteModel,
    getAnimation,
    getSnapshot,
    importModel,
    resetPackagedAnimations,
    resolveAssetRequest,
    setCharacterSize,
    setVoiceSource,
    setDefaultModel,
    setModelLighting,
    resetModelLighting,
    updateAnimation,
  };
}

module.exports = {
  ANIMATION_NAME_PATTERN,
  DEFAULT_MODEL_LIGHTING,
  DEFAULT_PACKAGED_LIBRARY_PATH,
  MAX_CHARACTER_SIZE,
  MIN_CHARACTER_SIZE,
  SETTINGS_SCHEMA_VERSION,
  createSettingsStore,
  validateAnimationMetadata,
  validateGlbFile,
};
