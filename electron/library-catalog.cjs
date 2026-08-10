"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PACKAGED_LIBRARY_SCHEMA_VERSION = 1;
const LIBRARY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ANIMATION_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ANIMATION_TYPES = new Set([
  "IDLE",
  "GREETING",
  "TALK",
  "HAPPY",
  "FINGER_GUN",
  "DANCE",
]);

const EXPRESSION_NAMES = new Set([
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
]);

const SYSTEM_ANIMATIONS = Object.freeze([
  Object.freeze({
    id: "system-idle",
    animation_name: "idle",
    animation_description: "A calm resting motion for the character.",
    animation_trigger_scenario:
      "Used automatically while Persona is waiting and not speaking.",
    animation_type: "IDLE",
    expression_name: null,
    expression_weight: 1,
    asset_paths: Object.freeze([]),
  }),
  Object.freeze({
    id: "system-speaking",
    animation_name: "speaking",
    animation_description:
      "Natural conversational body movement while the character speaks.",
    animation_trigger_scenario:
      "Used automatically while supported voice output is active.",
    animation_type: "TALK",
    expression_name: null,
    expression_weight: 1,
    asset_paths: Object.freeze([]),
  }),
]);
const SYSTEM_ANIMATION_IDS = new Set(
  SYSTEM_ANIMATIONS.map((animation) => animation.id),
);
const ANIMATION_TYPE_BY_RESERVED_NAME = new Map([
  ["idle", "IDLE"],
  ["greeting", "GREETING"],
  ["talk", "TALK"],
  ["speaking", "TALK"],
  ["happy", "HAPPY"],
  ["finger-gun", "FINGER_GUN"],
  ["dance", "DANCE"],
]);

function inferAnimationType(animationName) {
  if (typeof animationName !== "string") return null;
  const baseName = animationName.toLowerCase().replace(/-?\d+$/, "");
  return ANIMATION_TYPE_BY_RESERVED_NAME.get(baseName) ?? null;
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required in the packaged library.`);
  }
  return value.trim();
}

function assetPath(value, extension, field) {
  const normalized = nonEmptyString(value, field).replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    path.posix.extname(normalized).toLowerCase() !== extension
  ) {
    throw new Error(`${field} must be a relative ${extension} asset path.`);
  }
  return normalized;
}

function uniqueBy(records, field, label) {
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record[field])) {
      throw new Error(`Duplicate ${label}: ${record[field]}.`);
    }
    seen.add(record[field]);
  }
}

function validatePackagedLibrary(value) {
  if (
    value?.schema_version !== PACKAGED_LIBRARY_SCHEMA_VERSION ||
    !Array.isArray(value.models) ||
    !Array.isArray(value.animations)
  ) {
    throw new Error("Unsupported packaged library schema.");
  }

  const models = value.models.map((model, index) => {
    const id = nonEmptyString(model?.id, `models[${index}].id`);
    if (!LIBRARY_ID_PATTERN.test(id)) {
      throw new Error(`Invalid packaged model id: ${id}.`);
    }
    return {
      id,
      model_name: nonEmptyString(
        model?.model_name,
        `models[${index}].model_name`,
      ),
      asset_path: assetPath(
        model?.asset_path,
        ".vrm",
        `models[${index}].asset_path`,
      ),
    };
  });

  const configuredAnimations = value.animations.map((animation, index) => {
    const id = nonEmptyString(animation?.id, `animations[${index}].id`);
    if (!LIBRARY_ID_PATTERN.test(id)) {
      throw new Error(`Invalid packaged animation id: ${id}.`);
    }

    const animation_name = nonEmptyString(
      animation?.animation_name,
      `animations[${index}].animation_name`,
    ).toLowerCase();

    if (!ANIMATION_NAME_PATTERN.test(animation_name)) {
      throw new Error(`Invalid packaged animation name: ${animation_name}.`);
    }

    const animation_type = animation?.animation_type ?? null;
    if (animation_type !== null && !ANIMATION_TYPES.has(animation_type)) {
      throw new Error(`Invalid packaged animation type: ${animation_type}.`);
    }

    const expression_name = animation?.expression_name ?? null;
    if (
      expression_name !== null &&
      !EXPRESSION_NAMES.has(expression_name)
    ) {
      throw new Error(
        `Invalid packaged expression name: ${expression_name}.`,
      );
    }

    const expression_weight = animation?.expression_weight ?? 1;
    if (
      typeof expression_weight !== 'number' ||
      !Number.isFinite(expression_weight) ||
      expression_weight < 0 ||
      expression_weight > 1
    ) {
      throw new Error(
        `Invalid packaged expression weight for ${animation_name}.`,
      );
    }

    if (!Array.isArray(animation?.asset_paths)) {
      throw new Error(
        `Packaged animation ${animation_name} must declare asset_paths.`,
      );
    }

    return {
      id,
      animation_name,
      animation_description: nonEmptyString(
        animation.animation_description,
        `animations[${index}].animation_description`,
      ),
      animation_trigger_scenario: nonEmptyString(
        animation.animation_trigger_scenario,
        `animations[${index}].animation_trigger_scenario`,
      ),
      animation_type,
      expression_name,
      expression_weight,
      asset_paths: animation.asset_paths.map((entry, assetIndex) =>
        assetPath(
          entry,
          '.vrma',
          `animations[${index}].asset_paths[${assetIndex}]`,
        ),
      ),
    };
  });

  const animations = SYSTEM_ANIMATIONS.map((systemAnimation) => {
    const configured = configuredAnimations.find(
      (animation) => animation.id === systemAnimation.id,
    );
    if (!configured) {
      return {
        ...systemAnimation,
        asset_paths: [...systemAnimation.asset_paths],
      };
    }
    if (
      configured.animation_name !== systemAnimation.animation_name ||
      configured.animation_type !== systemAnimation.animation_type
    ) {
      throw new Error(
        `${systemAnimation.id} must retain its reserved name and animation type.`,
      );
    }
    return configured;
  });
  animations.push(
    ...configuredAnimations.filter(
      (animation) => !SYSTEM_ANIMATION_IDS.has(animation.id),
    ),
  );

  uniqueBy(models, "id", "packaged model id");
  uniqueBy(configuredAnimations, "id", "packaged animation id");
  uniqueBy(configuredAnimations, "animation_name", "packaged animation name");
  uniqueBy(animations, "id", "packaged animation id");
  uniqueBy(animations, "animation_name", "packaged animation name");
  for (const animation of animations) {
    if (
      !SYSTEM_ANIMATION_IDS.has(animation.id) &&
      (animation.animation_type === "IDLE" ||
        animation.animation_type === "TALK")
    ) {
      throw new Error(
        "Idle and speaking system roles belong to their permanent action slots.",
      );
    }
  }
  const configuredDefaultModelId =
    value.default_model_id == null
      ? null
      : nonEmptyString(value.default_model_id, "default_model_id");
  const default_model_id =
    configuredDefaultModelId ?? models[0]?.id ?? null;
  if (
    configuredDefaultModelId !== null &&
    !models.some((model) => model.id === configuredDefaultModelId)
  ) {
    throw new Error("The packaged default model does not exist.");
  }

  return {
    schema_version: PACKAGED_LIBRARY_SCHEMA_VERSION,
    default_model_id,
    models,
    animations,
  };
}

function readPackagedLibrary(catalogPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read packaged library: ${error.message}`, {
      cause: error,
    });
  }
  return validatePackagedLibrary(parsed);
}

function describeAnimations(animations) {
  if (animations.length === 0) {
    return "- No animation actions currently have playable clips.";
  }
  return animations
    .map(
      (animation) =>
        `- ${animation.animation_name}: ${animation.animation_description} Trigger scenario: ${animation.animation_trigger_scenario}`,
    )
    .join("\n");
}

module.exports = {
  ANIMATION_NAME_PATTERN,
  ANIMATION_TYPES,
  PACKAGED_LIBRARY_SCHEMA_VERSION,
  SYSTEM_ANIMATIONS,
  SYSTEM_ANIMATION_IDS,
  describeAnimations,
  inferAnimationType,
  readPackagedLibrary,
  validatePackagedLibrary,
};
