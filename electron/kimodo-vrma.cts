import { isRecord } from './types.cjs';
import type { VRMCVRMAnimation } from '@pixiv/types-vrmc-vrm-animation-1.0';

// Format choices are grounded in VRMC_vrm_animation 1.0 and cross-checked
// against the official UniVRM exporter plus the MIT fbx2vrma-converter. This
// stays an exact Kimodo SOMA30 adapter: a generic GLB cannot be made into a
// trustworthy humanoid animation by changing its extension.

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const FLOAT_COMPONENT_TYPE = 5126;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MIN_FRAMES = 60;
const MAX_FRAMES = 150;
const SOURCE_QUATERNION_NORM_TOLERANCE = 0.01;
const OUTPUT_QUATERNION_NORM_TOLERANCE = 1e-5;
const SOMA_RP_LICENSE = 'NVIDIA Open Model License';
const SOMA_RP_LICENSE_URL =
  'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/';

const SOMA30_NAMES = Object.freeze([
  'Hips',
  'Spine1',
  'Spine2',
  'Chest',
  'Neck1',
  'Neck2',
  'Head',
  'Jaw',
  'LeftEye',
  'RightEye',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'LeftHandThumbEnd',
  'LeftHandMiddleEnd',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand',
  'RightHandThumbEnd',
  'RightHandMiddleEnd',
  'LeftLeg',
  'LeftShin',
  'LeftFoot',
  'LeftToeBase',
  'RightLeg',
  'RightShin',
  'RightFoot',
  'RightToeBase',
] as const);

export const SOMA30_PARENTS = Object.freeze([
  -1, 0, 1, 2, 3, 4, 5, 6, 6, 6, 3, 10, 11, 12, 13, 13, 3, 16, 17,
  18, 19, 19, 0, 22, 23, 24, 0, 26, 27, 28,
] as const);

export const SOMA30_OFFSETS: readonly (readonly [number, number, number])[] = Object.freeze([
  [0, 0, 0],
  [-0.00013727, 0.0500376256, -0.00053726669],
  [-1.86574103e-9, 0.0712530139, -0.000298248546],
  [-5.75188398e-9, 0.0755006305, -0.00815970992],
  [-0.00181676517, 0.263112953, -0.00553348292],
  [-2.85102231e-8, 0.0770939664, 0.0230258546],
  [-4.5975437e-8, 0.0612891595, 0.0195370861],
  [2.63687901e-5, 0.0047559225, 0.0309494062],
  [0.0320638079, 0.0538020513, 0.0758688308],
  [-0.0322244017, 0.05361869, 0.0755823359],
  [0.0162165175, 0.232371641, 0.0511341324],
  [0.149198457, 2.19397873e-8, -0.0550232576],
  [0.287393078, 2.50268389e-9, -2.58787737e-5],
  [0.270939812, -7.06625108e-9, 2.60897248e-5],
  [0.122686267, -0.0322017573, 0.0483306876],
  [0.190119595, -0.00312878387, -0.000339570373],
  [-0.0138011824, 0.231803086, 0.0521415786],
  [-0.150371962, 1.17387901e-7, -0.0554560437],
  [-0.287366393, 1.87628082e-8, -2.59709359e-5],
  [-0.271336198, -1.16767401e-9, 2.61269368e-5],
  [-0.122642483, -0.0321145448, 0.0480403904],
  [-0.190005945, -0.00306615542, -0.0003157343],
  [0.10043214, -0.0843452671, 0.0259565473],
  [-1e-8, -0.432217537, -0.00802912805],
  [1e-8, -0.421550959, -0.0348152298],
  [0, -0.0505947206, 0.132315294],
  [-0.10047278, -0.0829525995, 0.0262031695],
  [1e-8, -0.433622059, -0.00805555828],
  [2e-8, -0.421173943, -0.0347839785],
  [-3.42907669e-9, -0.0507960932, 0.132841956],
]);

export const KIMODO_VRMA_CONVERTER_VERSION = 'persona-soma30-v2';

const VRM_HUMANOID_BONES = Object.freeze({
  hips: 0,
  spine: 1,
  chest: 2,
  upperChest: 3,
  neck: 5,
  head: 6,
  jaw: 7,
  leftShoulder: 10,
  leftUpperArm: 11,
  leftLowerArm: 12,
  leftHand: 13,
  rightShoulder: 16,
  rightUpperArm: 17,
  rightLowerArm: 18,
  rightHand: 19,
  leftUpperLeg: 22,
  leftLowerLeg: 23,
  leftFoot: 24,
  leftToes: 25,
  rightUpperLeg: 26,
  rightLowerLeg: 27,
  rightFoot: 28,
  rightToes: 29,
} as const);

interface GlbDocument {
  json: Record<string, unknown>;
  binary: Buffer;
}

interface NumericAccessor {
  byteLength: number;
  byteOffset: number;
  components: number;
  count: number;
  values: number[];
  viewIndex: number;
}

type Quaternion = [number, number, number, number];

interface AnimationValidation {
  duration: number;
  rotationAccessors: Map<number, NumericAccessor>;
  timeAccessor: Record<string, unknown>;
}

export function validateKimodoSomaModelDescriptor(value: unknown): void {
  const model = requiredRecord(value, 'soma-rp-v1.1 model descriptor');
  if (model.id !== 'soma-rp-v1.1' || model.skeleton_key !== 'soma30') {
    throw new Error('Kimodo did not advertise the supported soma-rp-v1.1 soma30 model.');
  }
  if (
    model.license !== SOMA_RP_LICENSE ||
    model.license_url !== SOMA_RP_LICENSE_URL ||
    model.commercial !== true
  ) {
    throw new Error('Kimodo soma-rp-v1.1 license metadata is incompatible.');
  }
  const parents = requiredArray(model.parents, 'soma-rp-v1.1 parents');
  if (
    parents.length !== SOMA30_PARENTS.length ||
    parents.some((parent, index) => parent !== SOMA30_PARENTS[index])
  ) {
    throw new Error('Kimodo soma-rp-v1.1 parent hierarchy is incompatible.');
  }
  const offsets = requiredArray(model.offsets, 'soma-rp-v1.1 offsets');
  if (offsets.length !== SOMA30_OFFSETS.length) {
    throw new Error('Kimodo soma-rp-v1.1 rest offsets are incompatible.');
  }
  offsets.forEach((offset, index) => {
    const values = requiredArray(offset, `soma-rp-v1.1 offset ${index}`);
    const expected = SOMA30_OFFSETS[index];
    if (
      !expected ||
      values.length !== 3 ||
      values.some(
        (component, axis) =>
          typeof component !== 'number' ||
          !Number.isFinite(component) ||
          Math.abs(component - (expected[axis] ?? 0)) > 1e-4,
      )
    ) {
      throw new Error(`Kimodo soma-rp-v1.1 rest offset ${index} is incompatible.`);
    }
  });
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Kimodo GLB ${field} is missing.`);
  return value;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Kimodo GLB ${field} is invalid.`);
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`Kimodo GLB ${field} is invalid.`);
  }
  return Number(value);
}

function parseGlb(buffer: Buffer): GlbDocument {
  if (buffer.length < 28 || buffer.length > MAX_SOURCE_BYTES) {
    throw new Error('Kimodo GLB must be between 28 bytes and 64 MB.');
  }
  if (
    buffer.readUInt32LE(0) !== GLB_MAGIC ||
    buffer.readUInt32LE(4) !== GLB_VERSION ||
    buffer.readUInt32LE(8) !== buffer.length
  ) {
    throw new Error('Kimodo output is not a complete glTF 2 binary.');
  }

  let offset = 12;
  let json: Record<string, unknown> | null = null;
  let binary: Buffer | null = null;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error('Kimodo GLB has a truncated chunk header.');
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 !== 0 || offset + length > buffer.length) {
      throw new Error('Kimodo GLB has an invalid chunk length.');
    }
    const chunk = buffer.subarray(offset, offset + length);
    offset += length;
    if (type === JSON_CHUNK) {
      if (json) throw new Error('Kimodo GLB contains more than one JSON chunk.');
      try {
        let jsonText = chunk.toString('utf8');
        while (jsonText.endsWith('\u0000') || jsonText.endsWith(' ')) {
          jsonText = jsonText.slice(0, -1);
        }
        const parsed: unknown = JSON.parse(jsonText);
        json = requiredRecord(parsed, 'JSON document');
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error('Kimodo GLB JSON is invalid.', { cause: error });
        }
        throw error;
      }
    } else if (type === BIN_CHUNK) {
      if (binary) throw new Error('Kimodo GLB contains more than one binary chunk.');
      if (!json) throw new Error('Kimodo GLB JSON chunk must precede its binary chunk.');
      binary = chunk;
    } else {
      throw new Error('Kimodo GLB contains an unsupported chunk type.');
    }
  }
  if (!json || !binary) throw new Error('Kimodo GLB must contain JSON and binary chunks.');
  return { json, binary };
}

function nodeTranslation(node: Record<string, unknown>, index: number): [number, number, number] {
  if (index === 0 && node.translation == null) return [0, 0, 0];
  const translation = requiredArray(node.translation, `node ${index} translation`);
  if (
    translation.length !== 3 ||
    !translation.every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    throw new Error(`Kimodo GLB node ${index} translation is invalid.`);
  }
  return [Number(translation[0]), Number(translation[1]), Number(translation[2])];
}

function validateNodeOnlyScene(document: Record<string, unknown>): void {
  if (document.scene !== 0) throw new Error('Kimodo GLB must select scene 0.');
  const scenes = requiredArray(document.scenes, 'scenes');
  if (scenes.length !== 1) throw new Error('Kimodo GLB must contain exactly one scene.');
  const scene = requiredRecord(scenes[0], 'scene 0');
  const roots = requiredArray(scene.nodes, 'scene 0 nodes');
  if (roots.length !== 1 || roots[0] !== 0) {
    throw new Error('Kimodo GLB scene must contain only the soma30 Hips root.');
  }
  for (const field of [
    'meshes',
    'skins',
    'cameras',
    'images',
    'textures',
    'materials',
    'samplers',
  ] as const) {
    if (document[field] != null && requiredArray(document[field], field).length !== 0) {
      throw new Error(`Kimodo GLB must not contain ${field}.`);
    }
  }
}

function validateSkeleton(document: Record<string, unknown>, allowGroundedRoot = false): {
  nodes: Record<string, unknown>[];
  hipsHeight: number;
} {
  const extras = requiredRecord(document.extras, 'extras');
  if (
    extras.skeleton !== 'soma30' ||
    extras.fps !== 30 ||
    extras.rotation_order !== 'xyzw'
  ) {
    throw new Error('Persona only converts Kimodo soma30 motion at 30 FPS in XYZW order.');
  }
  if (
    !allowGroundedRoot &&
    (document.extensions != null || document.extensionsUsed != null || document.extensionsRequired != null)
  ) {
    throw new Error('Kimodo source GLB must not contain pre-existing extensions.');
  }
  validateNodeOnlyScene(document);
  const rawNodes = requiredArray(document.nodes, 'nodes');
  if (rawNodes.length !== SOMA30_NAMES.length) {
    throw new Error('Kimodo soma30 output must contain exactly 30 skeleton nodes.');
  }
  const nodes = rawNodes.map((node, index) => {
    const record = requiredRecord(node, `node ${index}`);
    if (record.name !== SOMA30_NAMES[index]) {
      throw new Error(`Kimodo soma30 node ${index} must be ${SOMA30_NAMES[index]}.`);
    }
    for (const field of ['matrix', 'rotation', 'scale', 'mesh', 'skin', 'camera', 'weights'] as const) {
      if (record[field] != null) {
        throw new Error(`Kimodo soma30 node ${index} must not define ${field}.`);
      }
    }
    const translation = nodeTranslation(record, index);
    const expected = SOMA30_OFFSETS[index];
    if (!expected || translation.some((value, axis) => Math.abs(value - (expected[axis] ?? 0)) > 1e-4)) {
      // A converted clip deliberately grounds Hips while preserving every
      // other rest offset. The grounded root is accepted by the validator,
      // while a source converter call still starts from Kimodo's zero root.
      if (!allowGroundedRoot || index !== 0 || translation[0] !== 0 || translation[2] !== 0 || translation[1] < 0.25 || translation[1] > 3) {
        throw new Error(`Kimodo soma30 node ${index} rest offset is incompatible.`);
      }
    }
    return record;
  });

  const discoveredParents = Array<number>(nodes.length).fill(-1);
  nodes.forEach((node, parent) => {
    if (node.children == null) return;
    for (const childValue of requiredArray(node.children, `node ${parent} children`)) {
      const child = requiredInteger(childValue, `node ${parent} child`);
      if (child >= nodes.length || discoveredParents[child] !== -1) {
        throw new Error('Kimodo soma30 hierarchy is invalid.');
      }
      discoveredParents[child] = parent;
    }
  });
  if (discoveredParents.some((parent, index) => parent !== SOMA30_PARENTS[index])) {
    throw new Error('Kimodo soma30 hierarchy does not match the supported skeleton.');
  }

  const worldY = Array<number>(nodes.length).fill(0);
  let minimumY = 0;
  nodes.forEach((node, index) => {
    const [, localY] = nodeTranslation(node, index);
    const parent = SOMA30_PARENTS[index] ?? -1;
    worldY[index] = localY + (parent < 0 ? 0 : (worldY[parent] ?? 0));
    minimumY = Math.min(minimumY, worldY[index] ?? 0);
  });
  const hipsHeight = (worldY[0] ?? 0) - minimumY;
  if (!Number.isFinite(hipsHeight) || hipsHeight < 0.25 || hipsHeight > 3) {
    throw new Error('Kimodo soma30 rest pose has an invalid hips height.');
  }
  return { nodes, hipsHeight };
}

function accessorValues(
  document: Record<string, unknown>,
  binary: Buffer,
  accessorIndex: number,
  expectedType: 'SCALAR' | 'VEC3' | 'VEC4',
): NumericAccessor {
  const accessors = requiredArray(document.accessors, 'accessors');
  const accessor = requiredRecord(accessors[accessorIndex], `accessor ${accessorIndex}`);
  if (accessor.componentType !== FLOAT_COMPONENT_TYPE || accessor.type !== expectedType) {
    throw new Error(`Kimodo GLB accessor ${accessorIndex} must contain ${expectedType} float data.`);
  }
  if (accessor.sparse != null || accessor.normalized === true) {
    throw new Error('Sparse or normalized Kimodo accessors are not supported.');
  }
  const count = requiredInteger(accessor.count, `accessor ${accessorIndex} count`);
  if (count < MIN_FRAMES || count > MAX_FRAMES) throw new Error('Kimodo GLB frame count is invalid.');
  const viewIndex = requiredInteger(accessor.bufferView, `accessor ${accessorIndex} bufferView`);
  const views = requiredArray(document.bufferViews, 'bufferViews');
  const view = requiredRecord(views[viewIndex], `bufferView ${viewIndex}`);
  if (view.buffer !== 0 || view.byteStride != null) {
    throw new Error('Interleaved or external Kimodo buffers are not supported.');
  }
  const components = expectedType === 'SCALAR' ? 1 : expectedType === 'VEC3' ? 3 : 4;
  const byteLength = count * components * 4;
  const viewOffset = requiredInteger(view.byteOffset ?? 0, `bufferView ${viewIndex} byteOffset`);
  const accessorOffset = requiredInteger(accessor.byteOffset ?? 0, `accessor ${accessorIndex} byteOffset`);
  const byteOffset = viewOffset + accessorOffset;
  const viewLength = requiredInteger(view.byteLength, `bufferView ${viewIndex} byteLength`);
  if (
    accessorOffset !== 0 ||
    viewLength !== byteLength ||
    byteOffset + byteLength > binary.length
  ) {
    throw new Error(`Kimodo GLB accessor ${accessorIndex} exceeds its buffer.`);
  }
  const values: number[] = [];
  for (let offset = byteOffset; offset < byteOffset + byteLength; offset += 4) {
    const value = binary.readFloatLE(offset);
    if (!Number.isFinite(value)) throw new Error('Kimodo motion contains a non-finite value.');
    values.push(value);
  }
  return { byteLength, byteOffset, components, count, values, viewIndex };
}

function quaternionDot(left: Quaternion, right: Quaternion): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2] + left[3] * right[3];
}

function negateQuaternion(value: Quaternion): Quaternion {
  return [-value[0], -value[1], -value[2], -value[3]];
}

function normalizedQuaternion(value: Quaternion, previous: Quaternion | null): Quaternion {
  const norm = Math.hypot(...value);
  let result: Quaternion = [
    value[0] / norm,
    value[1] / norm,
    value[2] / norm,
    value[3] / norm,
  ];
  if (previous) {
    if (quaternionDot(previous, result) < 0) result = negateQuaternion(result);
  } else {
    // q and -q encode the same orientation. Pick one representation so the
    // generated bytes are deterministic even if the source starts negated.
    const firstNonZero = [result[3], result[0], result[1], result[2]].find(
      (component) => component !== 0,
    );
    if (firstNonZero != null && firstNonZero < 0) result = negateQuaternion(result);
  }
  return result;
}

function multiplyQuaternions(left: Quaternion, right: Quaternion): Quaternion {
  const [lx, ly, lz, lw] = left;
  const [rx, ry, rz, rw] = right;
  return [
    lw * rx + lx * rw + ly * rz - lz * ry,
    lw * ry - lx * rz + ly * rw + lz * rx,
    lw * rz + lx * ry - ly * rx + lz * rw,
    lw * rw - lx * rx - ly * ry - lz * rz,
  ];
}

function quaternionAt(accessor: NumericAccessor, frame: number): Quaternion {
  const offset = frame * accessor.components;
  return [
    accessor.values[offset] ?? 0,
    accessor.values[offset + 1] ?? 0,
    accessor.values[offset + 2] ?? 0,
    accessor.values[offset + 3] ?? 0,
  ];
}

function writeQuaternion(
  binary: Buffer,
  accessor: NumericAccessor,
  frame: number,
  value: Quaternion,
): void {
  const byteOffset = accessor.byteOffset + frame * accessor.components * 4;
  value.forEach((component, index) => binary.writeFloatLE(component, byteOffset + index * 4));
  const valueOffset = frame * accessor.components;
  value.forEach((component, index) => {
    accessor.values[valueOffset + index] = component;
  });
}

function canonicalizeRotationTracks(
  binary: Buffer,
  rotationAccessors: Map<number, NumericAccessor>,
): void {
  for (const accessor of rotationAccessors.values()) {
    let previous: Quaternion | null = null;
    for (let frame = 0; frame < accessor.count; frame += 1) {
      const quaternion = normalizedQuaternion(quaternionAt(accessor, frame), previous);
      writeQuaternion(binary, accessor, frame, quaternion);
      previous = quaternion;
    }
  }
}

function collapseNeckChain(
  binary: Buffer,
  rotationAccessors: Map<number, NumericAccessor>,
): void {
  const neck1 = rotationAccessors.get(4);
  const neck2 = rotationAccessors.get(5);
  if (!neck1 || !neck2 || neck1.count !== neck2.count) {
    throw new Error('Kimodo soma30 neck rotation tracks are incompatible.');
  }
  let previous: Quaternion | null = null;
  for (let frame = 0; frame < neck1.count; frame += 1) {
    // SOMA30 has two identity-rest neck joints while VRM has one. The VRMA
    // specification requires an omitted optional source bone to be composed
    // into the affected child. Parent-to-child local rotations compose q1*q2.
    const composed = normalizedQuaternion(
      multiplyQuaternions(quaternionAt(neck1, frame), quaternionAt(neck2, frame)),
      previous,
    );
    writeQuaternion(binary, neck1, frame, [0, 0, 0, 1]);
    writeQuaternion(binary, neck2, frame, composed);
    previous = composed;
  }
}

function validateAnimation(
  document: Record<string, unknown>,
  binary: Buffer,
  outputContract = false,
): AnimationValidation {
  const buffers = requiredArray(document.buffers, 'buffers');
  if (buffers.length !== 1) throw new Error('Kimodo GLB must contain one embedded buffer.');
  const declaredBuffer = requiredRecord(buffers[0], 'buffer 0');
  const declaredLength = requiredInteger(declaredBuffer.byteLength, 'buffer 0 byteLength');
  if (declaredBuffer.uri != null || declaredLength > binary.length || binary.length - declaredLength > 3) {
    throw new Error('Kimodo GLB binary buffer is invalid.');
  }
  const animations = requiredArray(document.animations, 'animations');
  if (animations.length !== 1) throw new Error('Kimodo GLB must contain one animation.');
  const animation = requiredRecord(animations[0], 'animation');
  const samplers = requiredArray(animation.samplers, 'animation samplers');
  const channels = requiredArray(animation.channels, 'animation channels');
  if (samplers.length !== 31 || channels.length !== 31) {
    throw new Error('Kimodo soma30 motion must contain one hips translation and 30 rotation tracks.');
  }
  const accessors = requiredArray(document.accessors, 'accessors');
  const bufferViews = requiredArray(document.bufferViews, 'bufferViews');
  if (accessors.length !== 32 || bufferViews.length !== 32) {
    throw new Error('Kimodo soma30 motion must contain exactly 32 accessors and buffer views.');
  }
  const seen = new Set<string>();
  const seenOutputs = new Set<number>();
  const seenSamplers = new Set<number>();
  const usedViews = new Set<number>();
  const byteRanges: Array<{ end: number; start: number }> = [];
  const rotationAccessors = new Map<number, NumericAccessor>();
  let timeAccessorIndex: number | null = null;
  let frameCount: number | null = null;
  for (const [channelIndex, channelValue] of channels.entries()) {
    const channel = requiredRecord(channelValue, `animation channel ${channelIndex}`);
    const samplerIndex = requiredInteger(channel.sampler, `animation channel ${channelIndex} sampler`);
    if (samplerIndex >= samplers.length || seenSamplers.has(samplerIndex)) {
      throw new Error('Kimodo animation sampler references must be unique and in range.');
    }
    seenSamplers.add(samplerIndex);
    const sampler = requiredRecord(samplers[samplerIndex], `animation sampler ${samplerIndex}`);
    if (sampler.interpolation !== 'LINEAR') throw new Error('Kimodo tracks must use linear interpolation.');
    const input = requiredInteger(sampler.input, `animation sampler ${samplerIndex} input`);
    const output = requiredInteger(sampler.output, `animation sampler ${samplerIndex} output`);
    if (input >= accessors.length || output >= accessors.length) throw new Error('Kimodo animation accessor is missing.');
    if (seenOutputs.has(output)) throw new Error('Kimodo animation output accessors must not be shared.');
    seenOutputs.add(output);
    if (timeAccessorIndex == null) timeAccessorIndex = input;
    if (input !== timeAccessorIndex) throw new Error('Kimodo animation tracks must share one timeline.');
    const target = requiredRecord(channel.target, `animation channel ${channelIndex} target`);
    const node = requiredInteger(target.node, `animation channel ${channelIndex} node`);
    const trackPath = target.path;
    if (node >= SOMA30_NAMES.length || (trackPath !== 'translation' && trackPath !== 'rotation')) {
      throw new Error('Kimodo animation channel target is invalid.');
    }
    const key = `${node}:${trackPath}`;
    if (seen.has(key)) throw new Error('Kimodo animation contains a duplicate track.');
    seen.add(key);
    if (trackPath === 'translation' && node !== 0) {
      throw new Error('Only Kimodo hips translation can be converted.');
    }
    const values = accessorValues(document, binary, output, trackPath === 'translation' ? 'VEC3' : 'VEC4');
    if (usedViews.has(values.viewIndex)) {
      throw new Error('Kimodo animation buffer views must not be shared.');
    }
    usedViews.add(values.viewIndex);
    byteRanges.push({ start: values.byteOffset, end: values.byteOffset + values.byteLength });
    if (frameCount == null) frameCount = values.count;
    if (values.count !== frameCount) throw new Error('Kimodo animation track lengths do not match.');
    if (trackPath === 'rotation') {
      rotationAccessors.set(node, values);
      let previous: Quaternion | null = null;
      for (let index = 0; index < values.values.length; index += 4) {
        const quaternion: Quaternion = [
          values.values[index] ?? 0,
          values.values[index + 1] ?? 0,
          values.values[index + 2] ?? 0,
          values.values[index + 3] ?? 0,
        ];
        const norm = Math.hypot(...quaternion);
        const tolerance = outputContract
          ? OUTPUT_QUATERNION_NORM_TOLERANCE
          : SOURCE_QUATERNION_NORM_TOLERANCE;
        if (Math.abs(norm - 1) > tolerance) {
          throw new Error('Kimodo motion contains an invalid quaternion.');
        }
        if (outputContract && previous && quaternionDot(previous, quaternion) < -1e-6) {
          throw new Error('Persona VRMA quaternion signs are discontinuous.');
        }
        previous = quaternion;
      }
    } else if (values.values.some((value) => Math.abs(value) > 100)) {
      throw new Error('Kimodo hips translation exceeds Persona limits.');
    }
  }
  if (!seen.has('0:translation') || SOMA30_NAMES.some((_name, index) => !seen.has(`${index}:rotation`))) {
    throw new Error('Kimodo motion is missing required skeleton tracks.');
  }
  if (timeAccessorIndex == null || frameCount == null) throw new Error('Kimodo animation timeline is missing.');
  const timeline = accessorValues(document, binary, timeAccessorIndex, 'SCALAR');
  if (usedViews.has(timeline.viewIndex)) {
    throw new Error('Kimodo animation timeline must use its own buffer view.');
  }
  usedViews.add(timeline.viewIndex);
  byteRanges.push({ start: timeline.byteOffset, end: timeline.byteOffset + timeline.byteLength });
  byteRanges.sort((left, right) => left.start - right.start);
  if (
    usedViews.size !== bufferViews.length ||
    byteRanges[0]?.start !== 0 ||
    byteRanges.some((range, index) => index > 0 && range.start !== (byteRanges[index - 1]?.end ?? -1)) ||
    byteRanges.at(-1)?.end !== declaredLength
  ) {
    throw new Error('Kimodo animation buffers overlap, contain gaps, or contain unused views.');
  }
  if (timeline.count !== frameCount || Math.abs((timeline.values[0] ?? 1)) > 1e-5) {
    throw new Error('Kimodo animation timeline is invalid.');
  }
  for (let index = 1; index < timeline.values.length; index += 1) {
    const delta = (timeline.values[index] ?? 0) - (timeline.values[index - 1] ?? 0);
    if (Math.abs(delta - 1 / 30) > 1e-4) {
      throw new Error('Kimodo animation timeline must be strictly 30 FPS.');
    }
  }
  const duration = timeline.values.at(-1) ?? 0;
  if (outputContract) {
    const minimum = requiredArray(
      requiredRecord(accessors[timeAccessorIndex], `accessor ${timeAccessorIndex}`).min,
      `accessor ${timeAccessorIndex} min`,
    );
    const maximum = requiredArray(
      requiredRecord(accessors[timeAccessorIndex], `accessor ${timeAccessorIndex}`).max,
      `accessor ${timeAccessorIndex} max`,
    );
    if (
      minimum.length !== 1 ||
      maximum.length !== 1 ||
      typeof minimum[0] !== 'number' ||
      !Number.isFinite(minimum[0]) ||
      typeof maximum[0] !== 'number' ||
      !Number.isFinite(maximum[0]) ||
      Math.abs(minimum[0]) > 1e-6 ||
      Math.abs(maximum[0] - duration) > 1e-6
    ) {
      throw new Error('Persona VRMA timeline bounds are invalid.');
    }
  }
  return {
    duration,
    rotationAccessors,
    timeAccessor: requiredRecord(accessors[timeAccessorIndex], `accessor ${timeAccessorIndex}`),
  };
}

function encodeGlb(json: Record<string, unknown>, binary: Buffer): Buffer {
  const encodedJson = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadding = (4 - (encodedJson.length % 4)) % 4;
  const binaryPadding = (4 - (binary.length % 4)) % 4;
  const totalLength = 12 + 8 + encodedJson.length + jsonPadding + 8 + binary.length + binaryPadding;
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(GLB_MAGIC, 0);
  output.writeUInt32LE(GLB_VERSION, 4);
  output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(encodedJson.length + jsonPadding, 12);
  output.writeUInt32LE(JSON_CHUNK, 16);
  encodedJson.copy(output, 20);
  output.fill(0x20, 20 + encodedJson.length, 20 + encodedJson.length + jsonPadding);
  const binHeader = 20 + encodedJson.length + jsonPadding;
  output.writeUInt32LE(binary.length + binaryPadding, binHeader);
  output.writeUInt32LE(BIN_CHUNK, binHeader + 4);
  binary.copy(output, binHeader + 8);
  return output;
}

export function convertKimodoGlbToVrma(source: Buffer): Buffer {
  const parsed = parseGlb(source);
  const { json } = parsed;
  // parseGlb returns a view into source. Always mutate a private copy so a
  // caller can safely retain or hash the exact downloaded provider artifact.
  const binary = Buffer.from(parsed.binary);
  const asset = requiredRecord(json.asset, 'asset');
  if (asset.version !== '2.0' || asset.generator !== 'kimodo.cpp skeleton exporter') {
    throw new Error('Kimodo output does not match the pinned glTF 2.0 skeleton exporter.');
  }
  const { nodes, hipsHeight } = validateSkeleton(json);
  const { duration, rotationAccessors, timeAccessor } = validateAnimation(json, binary);

  canonicalizeRotationTracks(binary, rotationAccessors);
  collapseNeckChain(binary, rotationAccessors);

  nodes[0] = { ...nodes[0], translation: [0, hipsHeight, 0] };
  json.nodes = nodes;
  timeAccessor.min = [0];
  timeAccessor.max = [duration];
  json.extensionsUsed = [
    ...new Set([
      ...requiredArray(json.extensionsUsed ?? [], 'extensionsUsed').filter(
        (value): value is string => typeof value === 'string',
      ),
      'VRMC_vrm_animation',
    ]),
  ];
  const vrmaExtension = {
    specVersion: '1.0',
    humanoid: {
      humanBones: Object.fromEntries(
        Object.entries(VRM_HUMANOID_BONES).map(([bone, node]) => [bone, { node }]),
      ),
    },
  } satisfies VRMCVRMAnimation;
  json.extensions = {
    ...(isRecord(json.extensions) ? json.extensions : {}),
    VRMC_vrm_animation: vrmaExtension,
  };
  json.asset = {
    ...asset,
    generator: 'Persona Kimodo soma30 VRMA converter',
  };
  json.extras = {
    ...requiredRecord(json.extras, 'extras'),
    persona_conversion: {
      source: 'kimodo.cpp',
      skeleton: 'soma30',
      source_fps: 30,
      converter: KIMODO_VRMA_CONVERTER_VERSION,
      collapsed_source_bones: ['Neck1'],
    },
  };
  return encodeGlb(json, binary);
}

function validateHumanoidMapping(value: unknown): void {
  const bones = requiredRecord(value, 'VRMA humanBones');
  const actualNames = Object.keys(bones).sort();
  const expectedNames = Object.keys(VRM_HUMANOID_BONES).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error('Persona VRMA humanoid mapping does not match the supported soma30 adapter.');
  }
  for (const [name, expectedNode] of Object.entries(VRM_HUMANOID_BONES)) {
    const bone = requiredRecord(bones[name], `VRMA ${name} bone`);
    if (requiredInteger(bone.node, `VRMA ${name} node`) !== expectedNode) {
      throw new Error(`Persona VRMA ${name} maps to an unexpected soma30 node.`);
    }
    if (Object.keys(bone).some((key) => key !== 'node')) {
      throw new Error(`Persona VRMA ${name} bone contains unsupported metadata.`);
    }
  }
}

export function validatePersonaVrma(buffer: Buffer): void {
  const { json, binary } = parseGlb(buffer);
  const asset = requiredRecord(json.asset, 'asset');
  if (asset.version !== '2.0' || asset.generator !== 'Persona Kimodo soma30 VRMA converter') {
    throw new Error('Persona VRMA asset metadata is invalid.');
  }
  const extensionsUsed = requiredArray(json.extensionsUsed, 'extensionsUsed');
  if (extensionsUsed.length !== 1 || extensionsUsed[0] !== 'VRMC_vrm_animation') {
    throw new Error('Persona VRMA must declare only VRMC_vrm_animation.');
  }
  if (json.extensionsRequired != null) {
    throw new Error('Persona VRMA must not require unknown glTF extensions.');
  }
  const extensions = requiredRecord(json.extensions, 'extensions');
  if (Object.keys(extensions).length !== 1) {
    throw new Error('Persona VRMA contains unsupported glTF extensions.');
  }
  const extension = requiredRecord(
    extensions.VRMC_vrm_animation,
    'VRMC_vrm_animation extension',
  );
  if (extension.specVersion !== '1.0') throw new Error('VRMA specVersion must be 1.0.');
  if (Object.keys(extension).some((key) => key !== 'specVersion' && key !== 'humanoid')) {
    throw new Error('Persona VRMA extension contains unsupported fields.');
  }
  const humanoid = requiredRecord(extension.humanoid, 'VRMA humanoid');
  if (Object.keys(humanoid).some((key) => key !== 'humanBones')) {
    throw new Error('Persona VRMA humanoid contains unsupported fields.');
  }
  validateHumanoidMapping(humanoid.humanBones);
  const conversion = requiredRecord(
    requiredRecord(json.extras, 'extras').persona_conversion,
    'persona_conversion provenance',
  );
  if (
    conversion.source !== 'kimodo.cpp' ||
    conversion.skeleton !== 'soma30' ||
    conversion.source_fps !== 30 ||
    conversion.converter !== KIMODO_VRMA_CONVERTER_VERSION ||
    !Array.isArray(conversion.collapsed_source_bones) ||
    conversion.collapsed_source_bones.length !== 1 ||
    conversion.collapsed_source_bones[0] !== 'Neck1'
  ) {
    throw new Error('Persona VRMA conversion provenance is invalid.');
  }
  validateSkeleton(json, true);
  const { rotationAccessors } = validateAnimation(json, binary, true);
  const neck1 = rotationAccessors.get(4);
  if (
    !neck1 ||
    Array.from({ length: neck1.count }, (_unused, frame) => quaternionAt(neck1, frame)).some(
      (quaternion) => quaternion.some((value, index) => Math.abs(value - (index === 3 ? 1 : 0)) > 1e-6),
    )
  ) {
    throw new Error('Persona VRMA did not collapse the SOMA30 Neck1 track.');
  }
}
