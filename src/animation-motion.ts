import * as THREE from 'three';

const DEFAULT_VELOCITY_WINDOW_SECONDS = 0.12;
const VARIETY_TEMPERATURE = 0.1;

type MotionTrackKind = 'quaternion' | 'vector';

interface MotionTrackProfile {
  interpolant: THREE.Interpolant;
  kind: MotionTrackKind;
  name: string;
  valueSize: number;
  weight: number;
}

interface MotionClipProfile {
  clip: THREE.AnimationClip;
  tracks: Map<string, MotionTrackProfile>;
}

type InterpolatableTrack = THREE.KeyframeTrack & {
  createInterpolant: (result: Float32Array) => THREE.Interpolant;
};

export interface MotionClipCandidate {
  clip: THREE.AnimationClip;
  url: string;
}

export interface MotionClipSource extends MotionClipCandidate {
  time: number;
  weight: number;
}

export interface MotionTransitionRanking extends MotionClipCandidate {
  poseDistance: number;
  score: number;
  startTime: number;
  velocityDistance: number;
}

interface RankMotionTransitionsOptions {
  entrySampleSeconds?: number;
  loopTarget?: boolean;
  loopSampleSeconds?: number;
  velocityWindowSeconds?: number;
}

const profileCache = new WeakMap<THREE.AnimationClip, MotionClipProfile>();

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function trackKind(track: THREE.KeyframeTrack): MotionTrackKind | null {
  if (
    track instanceof THREE.QuaternionKeyframeTrack ||
    track.name.endsWith('.quaternion')
  ) {
    return 'quaternion';
  }
  if (
    track instanceof THREE.VectorKeyframeTrack ||
    track.name.endsWith('.position') ||
    track.name.endsWith('.scale')
  ) {
    return 'vector';
  }
  return null;
}

function motionTrackWeight(name: string): number {
  const normalized = name.toLowerCase();
  if (normalized.endsWith('.position')) {
    return normalized.includes('hips') ? 0.35 : 0.15;
  }
  if (/upperarm|lowerarm|hand\.quaternion/.test(normalized)) return 1;
  if (normalized.includes('shoulder')) return 0.7;
  if (/thumb|index|middle|ring|little/.test(normalized)) return 0.22;
  if (/head|neck|chest|spine/.test(normalized)) return 0.5;
  if (normalized.includes('hips')) return 0.3;
  return 0.08;
}

function profileFor(clip: THREE.AnimationClip): MotionClipProfile {
  const cached = profileCache.get(clip);
  if (cached) return cached;
  const tracks = new Map<string, MotionTrackProfile>();
  for (const track of clip.tracks) {
    const kind = trackKind(track);
    if (!kind) continue;
    const valueSize = track.getValueSize();
    tracks.set(track.name, {
      interpolant: (track as InterpolatableTrack).createInterpolant(
        new Float32Array(valueSize),
      ),
      kind,
      name: track.name,
      valueSize,
      weight: motionTrackWeight(track.name),
    });
  }
  const profile = { clip, tracks } satisfies MotionClipProfile;
  profileCache.set(clip, profile);
  return profile;
}

function sampleTrack(
  profile: MotionTrackProfile,
  clipDuration: number,
  time: number,
): number[] {
  return Array.from(
    profile.interpolant.evaluate(clamp(time, 0, clipDuration)),
  );
}

function normalizedQuaternion(values: readonly number[]): number[] {
  const length = Math.hypot(...values);
  if (length <= Number.EPSILON) return [0, 0, 0, 1];
  return values.map((value) => value / length);
}

function quaternionAngle(
  leftValues: readonly number[],
  rightValues: readonly number[],
): number {
  const left = normalizedQuaternion(leftValues);
  const right = normalizedQuaternion(rightValues);
  const dot = Math.abs(
    left.reduce((total, value, index) => total + value * right[index], 0),
  );
  return 2 * Math.acos(clamp(dot, -1, 1));
}

function vectorDistance(
  left: readonly number[],
  right: readonly number[],
): number {
  return Math.hypot(
    ...left.map((value, index) => value - (right[index] ?? 0)),
  );
}

function quaternionVelocity(
  fromValues: readonly number[],
  toValues: readonly number[],
  elapsed: number,
): number[] {
  const from = new THREE.Quaternion(...normalizedQuaternion(fromValues));
  const to = new THREE.Quaternion(...normalizedQuaternion(toValues));
  if (from.dot(to) < 0) {
    to.set(-to.x, -to.y, -to.z, -to.w);
  }
  const delta = from.clone().invert().multiply(to).normalize();
  if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
  const angle = 2 * Math.acos(clamp(delta.w, -1, 1));
  const sine = Math.sqrt(Math.max(0, 1 - delta.w * delta.w));
  if (sine <= 0.00001 || elapsed <= Number.EPSILON) return [0, 0, 0];
  const scale = angle / sine / elapsed;
  return [delta.x * scale, delta.y * scale, delta.z * scale];
}

function vectorVelocity(
  from: readonly number[],
  to: readonly number[],
  elapsed: number,
): number[] {
  if (elapsed <= Number.EPSILON) return from.map(() => 0);
  return from.map((value, index) => ((to[index] ?? 0) - value) / elapsed);
}

function samplingInterval(
  duration: number,
  time: number,
  windowSeconds: number,
): [number, number] {
  const center = clamp(time, 0, duration);
  let start = center;
  const end = Math.min(duration, center + windowSeconds);
  if (end - start < windowSeconds * 0.5) {
    start = Math.max(0, end - windowSeconds);
  }
  return [start, end];
}

export function motionTransitionDistance(
  sourceClip: THREE.AnimationClip,
  sourceTime: number,
  targetClip: THREE.AnimationClip,
  targetTime: number,
  velocityWindowSeconds = DEFAULT_VELOCITY_WINDOW_SECONDS,
): Pick<MotionTransitionRanking, 'poseDistance' | 'score' | 'velocityDistance'> {
  const source = profileFor(sourceClip);
  const target = profileFor(targetClip);
  const [sourceVelocityStart, sourceVelocityEnd] = samplingInterval(
    sourceClip.duration,
    sourceTime,
    velocityWindowSeconds,
  );
  const [targetVelocityStart, targetVelocityEnd] = samplingInterval(
    targetClip.duration,
    targetTime,
    velocityWindowSeconds,
  );
  let poseSquareTotal = 0;
  let velocitySquareTotal = 0;
  let totalWeight = 0;

  for (const [name, sourceTrack] of source.tracks) {
    const targetTrack = target.tracks.get(name);
    if (!targetTrack || targetTrack.kind !== sourceTrack.kind) continue;
    const weight = Math.min(sourceTrack.weight, targetTrack.weight);
    const sourcePose = sampleTrack(
      sourceTrack,
      sourceClip.duration,
      sourceTime,
    );
    const targetPose = sampleTrack(
      targetTrack,
      targetClip.duration,
      targetTime,
    );
    const poseDistance =
      sourceTrack.kind === 'quaternion'
        ? quaternionAngle(sourcePose, targetPose)
        : vectorDistance(sourcePose, targetPose);
    const sourceFrom = sampleTrack(
      sourceTrack,
      sourceClip.duration,
      sourceVelocityStart,
    );
    const sourceTo = sampleTrack(
      sourceTrack,
      sourceClip.duration,
      sourceVelocityEnd,
    );
    const targetFrom = sampleTrack(
      targetTrack,
      targetClip.duration,
      targetVelocityStart,
    );
    const targetTo = sampleTrack(
      targetTrack,
      targetClip.duration,
      targetVelocityEnd,
    );
    const sourceVelocity =
      sourceTrack.kind === 'quaternion'
        ? quaternionVelocity(
            sourceFrom,
            sourceTo,
            sourceVelocityEnd - sourceVelocityStart,
          )
        : vectorVelocity(
            sourceFrom,
            sourceTo,
            sourceVelocityEnd - sourceVelocityStart,
          );
    const targetVelocity =
      targetTrack.kind === 'quaternion'
        ? quaternionVelocity(
            targetFrom,
            targetTo,
            targetVelocityEnd - targetVelocityStart,
          )
        : vectorVelocity(
            targetFrom,
            targetTo,
            targetVelocityEnd - targetVelocityStart,
          );
    const velocityDistance = vectorDistance(sourceVelocity, targetVelocity);
    poseSquareTotal += weight * poseDistance * poseDistance;
    velocitySquareTotal += weight * velocityDistance * velocityDistance;
    totalWeight += weight;
  }

  if (totalWeight <= Number.EPSILON) {
    return {
      poseDistance: Number.POSITIVE_INFINITY,
      score: Number.POSITIVE_INFINITY,
      velocityDistance: Number.POSITIVE_INFINITY,
    };
  }
  const poseDistance = Math.sqrt(poseSquareTotal / totalWeight);
  const velocityDistance = Math.sqrt(velocitySquareTotal / totalWeight);
  return {
    poseDistance,
    score: poseDistance + 0.12 * Math.min(1.5, velocityDistance),
    velocityDistance,
  };
}

function loopStartTimes(duration: number, sampleSeconds: number): number[] {
  if (duration <= Number.EPSILON) return [0];
  const sampleCount = clamp(Math.ceil(duration / sampleSeconds), 8, 32);
  return Array.from(
    { length: sampleCount },
    (_, index) => (duration * index) / sampleCount,
  );
}

function entryStartTimes(duration: number, windowSeconds: number): number[] {
  const window = Math.min(
    Math.max(0, windowSeconds),
    Math.max(0, duration * 0.2),
  );
  if (window <= Number.EPSILON) return [0];
  const sampleCount = Math.max(2, Math.ceil(window / 0.075) + 1);
  return Array.from(
    { length: sampleCount },
    (_, index) => (window * index) / (sampleCount - 1),
  );
}

export function rankMotionTransitions(
  source: MotionClipCandidate,
  sourceTime: number,
  candidates: readonly MotionClipCandidate[],
  options: RankMotionTransitionsOptions = {},
): MotionTransitionRanking[] {
  return rankBlendedMotionTransitions(
    [{ ...source, time: sourceTime, weight: 1 }],
    candidates,
    options,
  );
}

export function rankBlendedMotionTransitions(
  sources: readonly MotionClipSource[],
  candidates: readonly MotionClipCandidate[],
  options: RankMotionTransitionsOptions = {},
): MotionTransitionRanking[] {
  const velocityWindow =
    options.velocityWindowSeconds ?? DEFAULT_VELOCITY_WINDOW_SECONDS;
  const usableSources = sources.filter(
    ({ weight }) => Number.isFinite(weight) && weight > Number.EPSILON,
  );
  const sourceWeight = usableSources.reduce(
    (total, source) => total + source.weight,
    0,
  );
  return candidates
    .map((candidate) => {
      const targetTimes = options.loopTarget
        ? loopStartTimes(
            candidate.clip.duration,
            options.loopSampleSeconds ?? 0.35,
          )
        : entryStartTimes(
            candidate.clip.duration,
            options.entrySampleSeconds ?? 0,
          );
      return targetTimes
        .map((startTime) => {
          let poseSquareTotal = 0;
          let velocitySquareTotal = 0;
          let finiteWeight = 0;
          for (const source of usableSources) {
            let distance: ReturnType<typeof motionTransitionDistance>;
            try {
              distance = motionTransitionDistance(
                source.clip,
                source.time,
                candidate.clip,
                startTime,
                velocityWindow,
              );
            } catch {
              continue;
            }
            if (!Number.isFinite(distance.score)) continue;
            const weight = source.weight / sourceWeight;
            poseSquareTotal +=
              weight * distance.poseDistance * distance.poseDistance;
            velocitySquareTotal +=
              weight * distance.velocityDistance * distance.velocityDistance;
            finiteWeight += weight;
          }
          if (finiteWeight <= Number.EPSILON) {
            return {
              ...candidate,
              poseDistance: Number.POSITIVE_INFINITY,
              score: Number.POSITIVE_INFINITY,
              startTime,
              velocityDistance: Number.POSITIVE_INFINITY,
            };
          }
          const poseDistance = Math.sqrt(poseSquareTotal / finiteWeight);
          const velocityDistance = Math.sqrt(
            velocitySquareTotal / finiteWeight,
          );
          return {
            ...candidate,
            poseDistance,
            score: poseDistance + 0.12 * Math.min(1.5, velocityDistance),
            startTime,
            velocityDistance,
          };
        })
        .sort((left, right) => left.score - right.score)[0];
    })
    .sort((left, right) => left.score - right.score);
}

export function selectMotionTransition(
  rankings: readonly MotionTransitionRanking[],
  recentUrls: readonly string[],
  random: () => number = Math.random,
): MotionTransitionRanking | null {
  const finiteRankings = rankings.filter(({ score }) => Number.isFinite(score));
  if (finiteRankings.length === 0) return null;
  const recency = recentUrls.slice(-6);
  const rawBestScore = finiteRankings[0].score;
  const compatibilityTolerance = Math.max(0.1, rawBestScore * 0.35);
  const candidates = finiteRankings
    .filter(
      ({ score }) => score <= rawBestScore + compatibilityTolerance,
    )
    .map((ranking) => {
      const recentIndex = recency.lastIndexOf(ranking.url);
      const recencyPenalty =
        recentIndex < 0 ? 0 : 0.04 * (recentIndex + 1);
      return {
        effectiveScore: ranking.score + recencyPenalty,
        ranking,
      };
    })
    .sort((left, right) => left.effectiveScore - right.effectiveScore);
  const bestScore = candidates[0].effectiveScore;
  const shortlist = candidates.slice(0, 4);
  const weights = shortlist.map(({ effectiveScore }) =>
    Number.isFinite(effectiveScore)
      ? Math.exp(-(effectiveScore - bestScore) / VARIETY_TEMPERATURE)
      : 0,
  );
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  if (totalWeight <= Number.EPSILON) return shortlist[0]?.ranking ?? null;
  let choice = clamp(random(), 0, 1) * totalWeight;
  for (let index = 0; index < shortlist.length; index += 1) {
    choice -= weights[index];
    if (choice <= 0) return shortlist[index].ranking;
  }
  return shortlist.at(-1)?.ranking ?? null;
}

export function selectVariedMotionTransition(
  rankings: readonly MotionTransitionRanking[],
  recentUrls: readonly string[],
  random: () => number = Math.random,
): MotionTransitionRanking | null {
  const finiteRankings = rankings.filter(({ score }) => Number.isFinite(score));
  if (finiteRankings.length === 0) return null;
  const recent = new Set(recentUrls.slice(-6));
  const fresh = finiteRankings.filter(({ url }) => !recent.has(url));
  const candidates = fresh.length > 0 ? fresh : finiteRankings;
  const index = Math.min(
    candidates.length - 1,
    Math.floor(clamp(random(), 0, 1) * candidates.length),
  );
  return candidates[index] ?? null;
}
