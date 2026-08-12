import fs from 'node:fs';
import path from 'node:path';
import { errorMessage, isRecord } from './types.cjs';

export const PACKAGED_LIBRARY_SCHEMA_VERSION = 1;
export const LIBRARY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const ANIMATION_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export type AnimationType =
  | 'IDLE'
  | 'GREETING'
  | 'TALK'
  | 'HAPPY'
  | 'FINGER_GUN'
  | 'DANCE';

export interface PackagedModel {
  id: string;
  model_name: string;
  asset_path: string;
}

export interface PackagedAnimation {
  id: string;
  animation_name: string;
  animation_description: string;
  animation_trigger_scenario: string;
  animation_type: AnimationType | null;
  expression_name: string | null;
  expression_weight: number;
  asset_paths: readonly string[];
}

export interface PackagedLibrary {
  schema_version: typeof PACKAGED_LIBRARY_SCHEMA_VERSION;
  default_model_id: string | null;
  models: PackagedModel[];
  animations: PackagedAnimation[];
}

export const ANIMATION_TYPES: ReadonlySet<AnimationType> = new Set([
  'IDLE',
  'GREETING',
  'TALK',
  'HAPPY',
  'FINGER_GUN',
  'DANCE',
]);

export const SYSTEM_ANIMATIONS: readonly Readonly<PackagedAnimation>[] =
  Object.freeze([
    Object.freeze({
      id: 'system-idle',
      animation_name: 'idle',
      animation_description: 'A calm resting motion for the character.',
      animation_trigger_scenario:
        'Used automatically while Persona is waiting and not speaking.',
      animation_type: 'IDLE',
      expression_name: null,
      expression_weight: 1,
      asset_paths: Object.freeze([]),
    }),
    Object.freeze({
      id: 'system-speaking',
      animation_name: 'speaking',
      animation_description:
        'Natural conversational body movement while the character speaks.',
      animation_trigger_scenario:
        'Used automatically while supported voice output is active.',
      animation_type: 'TALK',
      expression_name: null,
      expression_weight: 1,
      asset_paths: Object.freeze([]),
    }),
  ]);

export const SYSTEM_ANIMATION_IDS: ReadonlySet<string> = new Set(
  SYSTEM_ANIMATIONS.map((animation) => animation.id),
);

const ANIMATION_TYPE_BY_RESERVED_NAME: ReadonlyMap<string, AnimationType> =
  new Map([
    ['idle', 'IDLE'],
    ['greeting', 'GREETING'],
    ['talk', 'TALK'],
    ['speaking', 'TALK'],
    ['happy', 'HAPPY'],
    ['finger-gun', 'FINGER_GUN'],
    ['dance', 'DANCE'],
  ]);

export function inferAnimationType(animationName: unknown): AnimationType | null {
  if (typeof animationName !== 'string') return null;
  const baseName = animationName.toLowerCase().replace(/-?\d+$/, '');
  return ANIMATION_TYPE_BY_RESERVED_NAME.get(baseName) ?? null;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required in the packaged library.`);
  }
  return value.trim();
}

function assetPath(value: unknown, extension: string, field: string): string {
  const normalized = nonEmptyString(value, field).replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    normalized.split('/').includes('..') ||
    path.posix.extname(normalized).toLowerCase() !== extension
  ) {
    throw new Error(`${field} must be a relative ${extension} asset path.`);
  }
  return normalized;
}

function uniqueBy<T, K extends keyof T>(
  records: readonly T[],
  field: K,
  label: string,
): void {
  const seen = new Set<T[K]>();
  for (const record of records) {
    if (seen.has(record[field])) {
      throw new Error(`Duplicate ${label}: ${String(record[field])}.`);
    }
    seen.add(record[field]);
  }
}

function animationType(value: unknown): AnimationType | null {
  if (value == null) return null;
  const matched =
    typeof value === 'string'
      ? [...ANIMATION_TYPES].find((candidate) => candidate === value)
      : undefined;
  if (matched === undefined) {
    throw new Error(`Invalid packaged animation type: ${String(value)}.`);
  }
  return matched;
}

function expressionName(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 120) {
    throw new Error(`Invalid packaged expression name: ${String(value)}.`);
  }
  return value;
}

function expressionWeight(value: unknown, animationName: string): number {
  const weight = value ?? 1;
  if (
    typeof weight !== 'number' ||
    !Number.isFinite(weight) ||
    weight < 0 ||
    weight > 1
  ) {
    throw new Error(
      `Invalid packaged expression weight for ${animationName}.`,
    );
  }
  return weight;
}

export function validatePackagedLibrary(value: unknown): PackagedLibrary {
  if (
    !isRecord(value) ||
    value.schema_version !== PACKAGED_LIBRARY_SCHEMA_VERSION ||
    !Array.isArray(value.models) ||
    !Array.isArray(value.animations)
  ) {
    throw new Error('Unsupported packaged library schema.');
  }

  const models = value.models.map((modelValue, index): PackagedModel => {
    if (!isRecord(modelValue)) {
      throw new Error(`models[${index}] must be an object.`);
    }
    const id = nonEmptyString(modelValue.id, `models[${index}].id`);
    if (!LIBRARY_ID_PATTERN.test(id)) {
      throw new Error(`Invalid packaged model id: ${id}.`);
    }
    return {
      id,
      model_name: nonEmptyString(
        modelValue.model_name,
        `models[${index}].model_name`,
      ),
      asset_path: assetPath(
        modelValue.asset_path,
        '.vrm',
        `models[${index}].asset_path`,
      ),
    };
  });

  const configuredAnimations = value.animations.map(
    (animationValue, index): PackagedAnimation => {
      if (!isRecord(animationValue)) {
        throw new Error(`animations[${index}] must be an object.`);
      }
      const id = nonEmptyString(
        animationValue.id,
        `animations[${index}].id`,
      );
      if (!LIBRARY_ID_PATTERN.test(id)) {
        throw new Error(`Invalid packaged animation id: ${id}.`);
      }

      const animation_name = nonEmptyString(
        animationValue.animation_name,
        `animations[${index}].animation_name`,
      ).toLowerCase();
      if (!ANIMATION_NAME_PATTERN.test(animation_name)) {
        throw new Error(`Invalid packaged animation name: ${animation_name}.`);
      }
      if (!Array.isArray(animationValue.asset_paths)) {
        throw new Error(
          `Packaged animation ${animation_name} must declare asset_paths.`,
        );
      }

      return {
        id,
        animation_name,
        animation_description: nonEmptyString(
          animationValue.animation_description,
          `animations[${index}].animation_description`,
        ),
        animation_trigger_scenario: nonEmptyString(
          animationValue.animation_trigger_scenario,
          `animations[${index}].animation_trigger_scenario`,
        ),
        animation_type: animationType(animationValue.animation_type),
        expression_name: expressionName(animationValue.expression_name),
        expression_weight: expressionWeight(
          animationValue.expression_weight,
          animation_name,
        ),
        asset_paths: animationValue.asset_paths.map((entry, assetIndex) =>
          assetPath(
            entry,
            '.vrma',
            `animations[${index}].asset_paths[${assetIndex}]`,
          ),
        ),
      };
    },
  );

  const animations: PackagedAnimation[] = SYSTEM_ANIMATIONS.map(
    (systemAnimation) => {
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
    },
  );
  animations.push(
    ...configuredAnimations.filter(
      (animation) => !SYSTEM_ANIMATION_IDS.has(animation.id),
    ),
  );

  uniqueBy(models, 'id', 'packaged model id');
  uniqueBy(configuredAnimations, 'id', 'packaged animation id');
  uniqueBy(configuredAnimations, 'animation_name', 'packaged animation name');
  uniqueBy(animations, 'id', 'packaged animation id');
  uniqueBy(animations, 'animation_name', 'packaged animation name');
  for (const animation of animations) {
    if (
      !SYSTEM_ANIMATION_IDS.has(animation.id) &&
      (animation.animation_type === 'IDLE' || animation.animation_type === 'TALK')
    ) {
      throw new Error(
        'Idle and speaking system roles belong to their permanent action slots.',
      );
    }
  }

  const configuredDefaultModelId =
    value.default_model_id == null
      ? null
      : nonEmptyString(value.default_model_id, 'default_model_id');
  const default_model_id = configuredDefaultModelId ?? models[0]?.id ?? null;
  if (
    configuredDefaultModelId !== null &&
    !models.some((model) => model.id === configuredDefaultModelId)
  ) {
    throw new Error('The packaged default model does not exist.');
  }

  return {
    schema_version: PACKAGED_LIBRARY_SCHEMA_VERSION,
    default_model_id,
    models,
    animations,
  };
}

export function readPackagedLibrary(catalogPath: string): PackagedLibrary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read packaged library: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return validatePackagedLibrary(parsed);
}

export function describeAnimations(
  animations: readonly Pick<
    PackagedAnimation,
    | 'animation_name'
    | 'animation_description'
    | 'animation_trigger_scenario'
  >[],
): string {
  if (animations.length === 0) {
    return '- No animation actions currently have playable clips.';
  }
  return animations
    .map(
      (animation) =>
        `- ${animation.animation_name}: ${animation.animation_description} Trigger scenario: ${animation.animation_trigger_scenario}`,
    )
    .join('\n');
}
