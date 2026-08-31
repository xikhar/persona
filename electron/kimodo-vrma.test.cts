import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { validateCoreGlb } from './gltf-validation.cjs';
import { convertKimodoGlbToVrma, validatePersonaVrma } from './kimodo-vrma.cjs';

const NAMES = [
  'Hips', 'Spine1', 'Spine2', 'Chest', 'Neck1', 'Neck2', 'Head', 'Jaw',
  'LeftEye', 'RightEye', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'LeftHandThumbEnd', 'LeftHandMiddleEnd', 'RightShoulder', 'RightArm',
  'RightForeArm', 'RightHand', 'RightHandThumbEnd', 'RightHandMiddleEnd',
  'LeftLeg', 'LeftShin', 'LeftFoot', 'LeftToeBase', 'RightLeg', 'RightShin',
  'RightFoot', 'RightToeBase',
];
const PARENTS = [-1, 0, 1, 2, 3, 4, 5, 6, 6, 6, 3, 10, 11, 12, 13, 13, 3, 16, 17, 18, 19, 19, 0, 22, 23, 24, 0, 26, 27, 28];
const OFFSETS = [
  [0, 0, 0], [-0.00013727, 0.0500376256, -0.00053726669], [-1.86574103e-9, 0.0712530139, -0.000298248546],
  [-5.75188398e-9, 0.0755006305, -0.00815970992], [-0.00181676517, 0.263112953, -0.00553348292],
  [-2.85102231e-8, 0.0770939664, 0.0230258546], [-4.5975437e-8, 0.0612891595, 0.0195370861],
  [2.63687901e-5, 0.0047559225, 0.0309494062], [0.0320638079, 0.0538020513, 0.0758688308],
  [-0.0322244017, 0.05361869, 0.0755823359], [0.0162165175, 0.232371641, 0.0511341324],
  [0.149198457, 2.19397873e-8, -0.0550232576], [0.287393078, 2.50268389e-9, -2.58787737e-5],
  [0.270939812, -7.06625108e-9, 2.60897248e-5], [0.122686267, -0.0322017573, 0.0483306876],
  [0.190119595, -0.00312878387, -0.000339570373], [-0.0138011824, 0.231803086, 0.0521415786],
  [-0.150371962, 1.17387901e-7, -0.0554560437], [-0.287366393, 1.87628082e-8, -2.59709359e-5],
  [-0.271336198, -1.16767401e-9, 2.61269368e-5], [-0.122642483, -0.0321145448, 0.0480403904],
  [-0.190005945, -0.00306615542, -0.0003157343], [0.10043214, -0.0843452671, 0.0259565473],
  [-1e-8, -0.432217537, -0.00802912805], [1e-8, -0.421550959, -0.0348152298],
  [0, -0.0505947206, 0.132315294], [-0.10047278, -0.0829525995, 0.0262031695],
  [1e-8, -0.433622059, -0.00805555828], [2e-8, -0.421173943, -0.0347839785],
  [-3.42907669e-9, -0.0507960932, 0.132841956],
];

function encodeGlb(document: Record<string, unknown>, binary: Buffer): Buffer {
  const encoded = Buffer.from(JSON.stringify(document));
  const jsonLength = Math.ceil(encoded.length / 4) * 4;
  const binLength = Math.ceil(binary.length / 4) * 4;
  const output = Buffer.alloc(12 + 8 + jsonLength + 8 + binLength);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonLength, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  encoded.copy(output, 20);
  output.fill(0x20, 20 + encoded.length, 20 + jsonLength);
  output.writeUInt32LE(binLength, 20 + jsonLength);
  output.writeUInt32LE(0x004e4942, 24 + jsonLength);
  binary.copy(output, 28 + jsonLength);
  return output;
}

type Quaternion = [number, number, number, number];

function createKimodoFixture(
  frames = 60,
  rotationAt: (joint: number, frame: number) => Quaternion = () => [0, 0, 0, 1],
): Buffer {
  const chunks: Buffer[] = [];
  const bufferViews: Array<Record<string, number>> = [];
  const append = (values: number[]): number => {
    const chunk = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => chunk.writeFloatLE(value, index * 4));
    const byteOffset = chunks.reduce((total, candidate) => total + candidate.length, 0);
    chunks.push(chunk);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: chunk.length });
    return bufferViews.length - 1;
  };
  const times = Array.from({ length: frames }, (_unused, index) => index / 30);
  const roots = Array.from({ length: frames }, (_unused, index) => [index / 300, 0.99, 0]).flat();
  const accessors: Array<Record<string, unknown>> = [
    { bufferView: append(times), componentType: 5126, count: frames, type: 'SCALAR' },
    { bufferView: append(roots), componentType: 5126, count: frames, type: 'VEC3' },
  ];
  for (let joint = 0; joint < NAMES.length; joint += 1) {
    const rotations = Array.from({ length: frames }, (_unused, frame) => rotationAt(joint, frame)).flat();
    accessors.push({ bufferView: append(rotations), componentType: 5126, count: frames, type: 'VEC4' });
  }
  const nodes = NAMES.map((name, index) => {
    const children = PARENTS.flatMap((parent, child) => parent === index ? [child] : []);
    return {
      name,
      ...(index === 0 ? {} : { translation: OFFSETS[index] }),
      ...(children.length > 0 ? { children } : {}),
    };
  });
  const samplers = accessors.slice(1).map((_accessor, index) => ({ input: 0, output: index + 1, interpolation: 'LINEAR' }));
  const channels = [
    { sampler: 0, target: { node: 0, path: 'translation' } },
    ...NAMES.map((_name, index) => ({ sampler: index + 1, target: { node: index, path: 'rotation' } })),
  ];
  const binary = Buffer.concat(chunks);
  return encodeGlb({
    asset: { version: '2.0', generator: 'kimodo.cpp skeleton exporter' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    buffers: [{ byteLength: binary.length }],
    bufferViews,
    accessors,
    animations: [{ name: 'KimodoMotion', samplers, channels }],
    extras: { skeleton: 'soma30', fps: 30, rotation_order: 'xyzw' },
  }, binary);
}

function readJson(buffer: Buffer): Record<string, unknown> {
  const length = buffer.readUInt32LE(12);
  return JSON.parse(buffer.subarray(20, 20 + length).toString('utf8').trim()) as Record<string, unknown>;
}

function readDocument(buffer: Buffer): { binary: Buffer; json: Record<string, unknown> } {
  const json = readJson(buffer);
  const jsonLength = buffer.readUInt32LE(12);
  const binaryHeader = 20 + jsonLength;
  const binaryLength = buffer.readUInt32LE(binaryHeader);
  return { binary: buffer.subarray(binaryHeader + 8, binaryHeader + 8 + binaryLength), json };
}

function trackValues(buffer: Buffer, node: number, path: 'rotation' | 'translation'): number[] {
  const { binary, json } = readDocument(buffer);
  const animations = json.animations as Array<Record<string, unknown>>;
  const animation = animations[0] as {
    channels: Array<{ sampler: number; target: { node: number; path: string } }>;
    samplers: Array<{ output: number }>;
  };
  const channel = animation.channels.find((candidate) => candidate.target.node === node && candidate.target.path === path);
  assert.ok(channel);
  const accessorIndex = animation.samplers[channel.sampler]?.output;
  assert.ok(accessorIndex != null);
  const accessors = json.accessors as Array<{ bufferView: number; byteOffset?: number; count: number; type: string }>;
  const accessor = accessors[accessorIndex];
  assert.ok(accessor);
  const views = json.bufferViews as Array<{ byteOffset?: number }>;
  const view = views[accessor.bufferView];
  assert.ok(view);
  const components = accessor.type === 'VEC4' ? 4 : 3;
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from(
    { length: accessor.count * components },
    (_unused, index) => binary.readFloatLE(offset + index * 4),
  );
}

function timelineValues(buffer: Buffer): number[] {
  const { binary, json } = readDocument(buffer);
  const animation = (json.animations as Array<{
    samplers: Array<{ input: number }>;
  }>)[0];
  assert.ok(animation);
  const accessorIndex = animation.samplers[0]?.input;
  assert.ok(accessorIndex != null);
  const accessor = (json.accessors as Array<{
    bufferView: number;
    byteOffset?: number;
    count: number;
  }>)[accessorIndex];
  assert.ok(accessor);
  const view = (json.bufferViews as Array<{ byteOffset?: number }>)[accessor.bufferView];
  assert.ok(view);
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from(
    { length: accessor.count },
    (_unused, index) => binary.readFloatLE(offset + index * 4),
  );
}

function axisAngle(axis: 'x' | 'y' | 'z', radians: number): Quaternion {
  const half = radians / 2;
  const sine = Math.sin(half);
  return [axis === 'x' ? sine : 0, axis === 'y' ? sine : 0, axis === 'z' ? sine : 0, Math.cos(half)];
}

function multiply(left: Quaternion, right: Quaternion): Quaternion {
  const [lx, ly, lz, lw] = left;
  const [rx, ry, rz, rw] = right;
  return [
    lw * rx + lx * rw + ly * rz - lz * ry,
    lw * ry - lx * rz + ly * rw + lz * rx,
    lw * rz + lx * ry - ly * rx + lz * rw,
    lw * rw - lx * rx - ly * ry - lz * rz,
  ];
}

function normalized(value: Quaternion): Quaternion {
  const norm = Math.hypot(...value);
  return value.map((component) => component / norm) as Quaternion;
}

function quaternionFrames(values: number[]): Quaternion[] {
  const frames: Quaternion[] = [];
  for (let index = 0; index < values.length; index += 4) {
    frames.push([values[index] ?? 0, values[index + 1] ?? 0, values[index + 2] ?? 0, values[index + 3] ?? 0]);
  }
  return frames;
}

function orientationDot(left: Quaternion, right: Quaternion): number {
  return Math.abs(left.reduce((sum, component, index) => sum + component * (right[index] ?? 0), 0));
}

test('converts exact Kimodo soma30 GLB into a semantically valid grounded VRMA', async () => {
  const source = createKimodoFixture();
  const original = Buffer.from(source);
  const converted = convertKimodoGlbToVrma(source);
  assert.deepEqual(source, original, 'conversion must not mutate the downloaded provider artifact');
  validatePersonaVrma(converted);
  await validateCoreGlb(converted);
  const document = readJson(converted);
  assert.deepEqual(document.extensionsUsed, ['VRMC_vrm_animation']);
  const extension = (document.extensions as Record<string, unknown>).VRMC_vrm_animation as {
    humanoid: { humanBones: Record<string, { node: number }> };
  };
  assert.deepEqual(extension.humanoid.humanBones.jaw, { node: 7 });
  const nodes = document.nodes as Array<Record<string, unknown>>;
  const hips = nodes[0];
  assert.ok(Array.isArray(hips?.translation));
  assert.ok(Number((hips?.translation as number[])[1]) > 0.8);
  const accessors = document.accessors as Array<Record<string, unknown>>;
  assert.deepEqual(accessors[0]?.min, [0]);
  assert.ok(Number((accessors[0]?.max as number[])[0]) > 1.9);
});

test('collapses the omitted SOMA Neck1 rotation into VRM neck and canonicalizes quaternions', () => {
  const source = createKimodoFixture(60, (joint, frame) => {
    const base = joint === 4
      ? axisAngle('x', 0.25 + frame * 0.01)
      : joint === 5
        ? axisAngle('y', -0.2 + frame * 0.005)
        : axisAngle('z', joint === 6 ? frame * 0.002 : 0);
    const signedScale = frame % 2 === 0 ? 1.001 : -1.001;
    return base.map((component) => component * signedScale) as Quaternion;
  });
  const converted = convertKimodoGlbToVrma(source);
  validatePersonaVrma(converted);

  const sourceNeck1 = quaternionFrames(trackValues(source, 4, 'rotation'));
  const sourceNeck2 = quaternionFrames(trackValues(source, 5, 'rotation'));
  const collapsed = quaternionFrames(trackValues(converted, 4, 'rotation'));
  const neck = quaternionFrames(trackValues(converted, 5, 'rotation'));
  collapsed.forEach((value) => assert.deepEqual(value, [0, 0, 0, 1]));
  neck.forEach((value, frame) => {
    const expected = normalized(multiply(normalized(sourceNeck1[frame]!), normalized(sourceNeck2[frame]!)));
    assert.ok(orientationDot(expected, value) > 1 - 1e-6);
    assert.ok(Math.abs(Math.hypot(...value) - 1) < 1e-6);
    if (frame > 0) {
      const previous = neck[frame - 1]!;
      assert.ok(previous.reduce((sum, component, index) => sum + component * (value[index] ?? 0), 0) >= 0);
    }
  });
});

test('preserves every authored Kimodo frame on all directly mapped tracks', () => {
  const source = createKimodoFixture(150, (joint, frame) => {
    const axis = joint % 3 === 0 ? 'x' : joint % 3 === 1 ? 'y' : 'z';
    const value = axisAngle(axis, 0.002 * joint + 0.003 * frame);
    return (frame + joint) % 7 === 0
      ? value.map((component) => -component) as Quaternion
      : value;
  });
  const converted = convertKimodoGlbToVrma(source);

  assert.deepEqual(timelineValues(converted), timelineValues(source));
  assert.deepEqual(
    trackValues(converted, 0, 'translation'),
    trackValues(source, 0, 'translation'),
  );
  for (let joint = 0; joint < NAMES.length; joint += 1) {
    if (joint === 4 || joint === 5) continue;
    const before = quaternionFrames(trackValues(source, joint, 'rotation'));
    const after = quaternionFrames(trackValues(converted, joint, 'rotation'));
    assert.equal(after.length, before.length);
    after.forEach((value, frame) => {
      assert.ok(orientationDot(normalized(before[frame]!), value) > 1 - 1e-6);
    });
  }
});

test('converted VRMA loads through the production VRM animation plugin', async () => {
  const progressEventHost = globalThis as unknown as { ProgressEvent?: new (type: string, init?: object) => object };
  progressEventHost.ProgressEvent ??= class ProgressEvent {
    constructor(public type: string, public init: object = {}) {}
  };
  const [{ GLTFLoader }, { VRMAnimationLoaderPlugin }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('@pixiv/three-vrm-animation'),
  ]);
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const converted = convertKimodoGlbToVrma(createKimodoFixture());
  const arrayBuffer = Uint8Array.from(converted).buffer;
  const gltf = await loader.parseAsync(arrayBuffer, '');
  assert.equal(gltf.userData.vrmAnimations.length, 1);
  const animation = gltf.userData.vrmAnimations[0];
  assert.ok(Math.abs(animation.duration - 59 / 30) < 1e-6);
  assert.equal(animation.humanoidTracks.translation.get('hips')?.times.length, 60);
  assert.ok(animation.humanoidTracks.rotation.get('head') != null);
  assert.ok(animation.humanoidTracks.rotation.get('jaw') != null);
});

test('rejects a non-soma Kimodo source instead of relabeling it', () => {
  const source = createKimodoFixture();
  const document = readJson(source);
  document.extras = { skeleton: 'smplx22', fps: 30, rotation_order: 'xyzw' };
  const jsonLength = source.readUInt32LE(12);
  const binHeader = 20 + jsonLength;
  const binaryLength = source.readUInt32LE(binHeader);
  const binary = source.subarray(binHeader + 8, binHeader + 8 + binaryLength);
  assert.throws(
    () => convertKimodoGlbToVrma(encodeGlb(document, binary)),
    /only converts Kimodo soma30/,
  );
});

test('rejects rest transforms and a tampered humanoid mapping', () => {
  const source = createKimodoFixture();
  const { binary, json } = readDocument(source);
  const nodes = json.nodes as Array<Record<string, unknown>>;
  nodes[5] = { ...nodes[5], rotation: [0, 0, 0, 1] };
  assert.throws(
    () => convertKimodoGlbToVrma(encodeGlb(json, binary)),
    /must not define rotation/,
  );

  const converted = convertKimodoGlbToVrma(createKimodoFixture());
  const output = readDocument(converted);
  const extension = (output.json.extensions as Record<string, unknown>).VRMC_vrm_animation as {
    humanoid: { humanBones: Record<string, { node: number }> };
  };
  extension.humanoid.humanBones.neck = { node: 4 };
  assert.throws(
    () => validatePersonaVrma(encodeGlb(output.json, output.binary)),
    /neck maps to an unexpected soma30 node/,
  );

  const invalidBounds = readDocument(convertKimodoGlbToVrma(createKimodoFixture()));
  const accessors = invalidBounds.json.accessors as Array<Record<string, unknown>>;
  accessors[0] = { ...accessors[0], min: ['0'] };
  assert.throws(
    () => validatePersonaVrma(encodeGlb(invalidBounds.json, invalidBounds.binary)),
    /timeline bounds are invalid/,
  );
});

const realFixturePath = process.env.PERSONA_KIMODO_REAL_FIXTURE;
test(
  'converts an opt-in real Kimodo motion through semantic and Khronos validation',
  { skip: !realFixturePath },
  async () => {
    assert.ok(realFixturePath);
    const source = fs.readFileSync(realFixturePath);
    const converted = convertKimodoGlbToVrma(source);
    validatePersonaVrma(converted);
    await validateCoreGlb(converted);
    const progressEventHost = globalThis as unknown as { ProgressEvent?: new (type: string, init?: object) => object };
    progressEventHost.ProgressEvent ??= class ProgressEvent {
      constructor(public type: string, public init: object = {}) {}
    };
    const [{ GLTFLoader }, { VRMAnimationLoaderPlugin }] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('@pixiv/three-vrm-animation'),
    ]);
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const gltf = await loader.parseAsync(Uint8Array.from(converted).buffer, '');
    assert.equal(gltf.userData.vrmAnimations.length, 1);
    const sourceNeck1 = quaternionFrames(trackValues(source, 4, 'rotation'));
    const sourceNeck2 = quaternionFrames(trackValues(source, 5, 'rotation'));
    const neck = quaternionFrames(trackValues(converted, 5, 'rotation'));
    assert.equal(neck.length, sourceNeck1.length);
    neck.forEach((value, frame) => {
      const expected = normalized(multiply(normalized(sourceNeck1[frame]!), normalized(sourceNeck2[frame]!)));
      assert.ok(orientationDot(expected, value) > 1 - 1e-5);
    });
  },
);

const targetVrmPaths = (process.env.PERSONA_VRM_TARGETS ?? '')
  .split(path.delimiter)
  .filter((candidate) => candidate.length > 0);
test(
  'creates finite production animation clips for opt-in VRM 0.x and 1.0 targets',
  { skip: targetVrmPaths.length === 0 },
  async () => {
    const progressEventHost = globalThis as unknown as { ProgressEvent?: new (type: string, init?: object) => object };
    progressEventHost.ProgressEvent ??= class ProgressEvent {
      constructor(public type: string, public init: object = {}) {}
    };
    const [{ GLTFLoader }, animationModule, vrmModule, threeModule] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('@pixiv/three-vrm-animation'),
      import('@pixiv/three-vrm'),
      import('three'),
    ]);
    const source = realFixturePath ? fs.readFileSync(realFixturePath) : createKimodoFixture();
    const converted = convertKimodoGlbToVrma(source);
    const animationLoader = new GLTFLoader();
    animationLoader.register((parser) => new animationModule.VRMAnimationLoaderPlugin(parser));
    const loadedAnimation = await animationLoader.parseAsync(Uint8Array.from(converted).buffer, '');
    const animation = loadedAnimation.userData.vrmAnimations[0];
    assert.ok(animation);

    for (const targetPath of targetVrmPaths) {
      const vrmLoader = new GLTFLoader();
      vrmLoader.register((parser) => {
        const mutableParser = parser as unknown as {
          loadTexture(index: number): Promise<unknown>;
        };
        mutableParser.loadTexture = async () => new threeModule.Texture();
        return { name: 'PersonaNodeTextureStub' };
      });
      vrmLoader.register((parser) => new vrmModule.VRMLoaderPlugin(parser));
      const loadedVrm = await vrmLoader.parseAsync(
        Uint8Array.from(fs.readFileSync(targetPath)).buffer,
        '',
      );
      const vrm = loadedVrm.userData.vrm;
      assert.ok(vrm, `VRM loader did not produce a humanoid for ${targetPath}`);
      const clip = animationModule.createVRMAnimationClip(animation, vrm);
      assert.ok(clip.tracks.length >= 20, `too few retargeted tracks for ${targetPath}`);
      assert.ok(
        clip.tracks.every((track: { values: ArrayLike<number> }) =>
          Array.from(track.values).every(Number.isFinite),
        ),
        `retargeted track contains a non-finite value for ${targetPath}`,
      );
    }
  },
);
