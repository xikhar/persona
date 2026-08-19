import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  motionTransitionDistance,
  rankBlendedMotionTransitions,
  rankMotionTransitions,
  selectMotionTransition,
  selectVariedMotionTransition,
} from './animation-motion';
import { assertDefined, definedAt } from './test-support';

function positionClip(
  name: string,
  times: readonly number[],
  xValues: readonly number[],
): THREE.AnimationClip {
  return new THREE.AnimationClip(name, times.at(-1) ?? 0, [
    new THREE.VectorKeyframeTrack(
      'Normalized_Hips.position',
      times,
      xValues.flatMap((value) => [value, 0, 0]),
    ),
  ]);
}

describe('animation motion compatibility', () => {
  it('ranks matching pose and motion direction ahead of an opposing motion', () => {
    const source = positionClip('source', [0, 1], [0, 1]);
    const continuing = positionClip('continuing', [0, 1], [0.5, 1.5]);
    const reversing = positionClip('reversing', [0, 1], [0.5, -0.5]);

    const rankings = rankMotionTransitions(
      { clip: source, url: 'source' },
      0.5,
      [
        { clip: reversing, url: 'reversing' },
        { clip: continuing, url: 'continuing' },
      ],
    );

    expect(rankings.map(({ url }) => url)).toEqual([
      'continuing',
      'reversing',
    ]);
    expect(definedAt(rankings, 0).poseDistance).toBeCloseTo(0, 8);
    expect(definedAt(rankings, 0).velocityDistance).toBeCloseTo(0, 8);
    expect(definedAt(rankings, 1).velocityDistance).toBeGreaterThan(1);
  });

  it('treats opposite quaternion signs as the same pose', () => {
    const source = new THREE.AnimationClip('source', 1, [
      new THREE.QuaternionKeyframeTrack(
        'Normalized_Head.quaternion',
        [0, 1],
        [0, 0, 0, 1, 0, 0, 0, 1],
      ),
    ]);
    const target = new THREE.AnimationClip('target', 1, [
      new THREE.QuaternionKeyframeTrack(
        'Normalized_Head.quaternion',
        [0, 1],
        [0, 0, 0, -1, 0, 0, 0, -1],
      ),
    ]);

    expect(
      motionTransitionDistance(source, 0.5, target, 0).poseDistance,
    ).toBeCloseTo(0, 8);
  });

  it('phase-matches a looping target to the outgoing pose', () => {
    const source = positionClip('source', [0, 1], [2, 2]);
    const idle = positionClip('idle', [0, 1, 2], [0, 2, 0]);

    const [ranking] = rankMotionTransitions(
      { clip: source, url: 'source' },
      0.5,
      [{ clip: idle, url: 'idle' }],
      { loopSampleSeconds: 0.25, loopTarget: true },
    );

    assertDefined(ranking, 'loop ranking');
    expect(ranking.startTime).toBeCloseTo(1, 8);
    expect(ranking.poseDistance).toBeCloseTo(0, 8);
  });

  it('phase-matches within the beginning of a speaking chunk', () => {
    const source = positionClip('source', [0, 1], [1, 1]);
    const target = positionClip('target', [0, 0.1, 0.2, 1], [0, 1, 1, 1]);

    const [fromStart] = rankMotionTransitions(
      { clip: source, url: 'source' },
      0.5,
      [{ clip: target, url: 'target' }],
    );
    const [phaseMatched] = rankMotionTransitions(
      { clip: source, url: 'source' },
      0.5,
      [{ clip: target, url: 'target' }],
      { entrySampleSeconds: 0.3 },
    );

    assertDefined(fromStart, 'unphased ranking');
    assertDefined(phaseMatched, 'phase-matched ranking');
    expect(phaseMatched.startTime).toBeGreaterThan(0);
    expect(phaseMatched.poseDistance).toBeLessThan(fromStart.poseDistance);
  });

  it('ranks against the weighted pose that is visible during a retarget', () => {
    const left = positionClip('left', [0, 1], [0, 0]);
    const right = positionClip('right', [0, 1], [2, 2]);
    const middle = positionClip('middle', [0, 1], [1, 1]);
    const edge = positionClip('edge', [0, 1], [0, 0]);

    const rankings = rankBlendedMotionTransitions(
      [
        { clip: left, time: 0.5, url: 'left', weight: 0.5 },
        { clip: right, time: 0.5, url: 'right', weight: 0.5 },
      ],
      [
        { clip: edge, url: 'edge' },
        { clip: middle, url: 'middle' },
      ],
    );

    expect(rankings.map(({ url }) => url)).toEqual(['middle', 'edge']);
  });

  it('keeps compatible variety while avoiding the most recent motions', () => {
    const rankings = ['best', 'recent', 'fresh', 'fourth'].map(
      (url, index) => ({
        clip: positionClip(url, [0, 1], [0, 0]),
        poseDistance: 0.1 + index * 0.01,
        score: 0.1 + index * 0.01,
        startTime: 0,
        url,
        velocityDistance: 0,
      }),
    );

    expect(selectMotionTransition(rankings, ['best', 'recent'], () => 0)?.url)
      .toBe('fresh');
    expect(selectMotionTransition(rankings, [], () => 0)?.url).toBe('best');
  });

  it('never spends variety on an incompatible boundary', () => {
    const rankings = [
      ['best', 0.1],
      ['compatible', 0.18],
      ['distant', 0.3],
    ].map(([url, score]) => ({
      clip: positionClip(String(url), [0, 1], [0, 0]),
      poseDistance: Number(score),
      score: Number(score),
      startTime: 0,
      url: String(url),
      velocityDistance: 0,
    }));

    expect(selectMotionTransition(rankings, [], () => 1)?.url).toBe(
      'compatible',
    );
    expect(
      selectMotionTransition(
        rankings,
        ['best', 'best', 'best', 'best', 'best', 'best'],
        () => 1,
      )?.url,
    ).not.toBe('distant');
  });

  it('selects speaking chunks uniformly while excluding recent motions', () => {
    const rankings = ['closest', 'recent', 'fresh-a', 'fresh-b'].map(
      (url, index) => ({
        clip: positionClip(url, [0, 1], [0, 0]),
        poseDistance: index,
        score: index,
        startTime: index / 10,
        url,
        velocityDistance: 0,
      }),
    );

    expect(
      selectVariedMotionTransition(
        rankings,
        ['closest', 'recent'],
        () => 0,
      )?.url,
    ).toBe('fresh-a');
    expect(
      selectVariedMotionTransition(
        rankings,
        ['closest', 'recent'],
        () => 0.99,
      )?.url,
    ).toBe('fresh-b');
  });

  it('ignores a malformed candidate instead of wedging selection', () => {
    const source = positionClip('source', [0, 1], [0, 1]);
    const valid = positionClip('valid', [0, 1], [1, 2]);
    const malformed = positionClip('malformed', [0, 1], [1, 2]);
    Object.assign(definedAt(malformed.tracks, 0, 'track'), {
      createInterpolant: () => {
        throw new Error('broken interpolant');
      },
    });

    const rankings = rankMotionTransitions(
      { clip: source, url: 'source' },
      1,
      [
        { clip: malformed, url: 'malformed' },
        { clip: valid, url: 'valid' },
      ],
    );

    expect(rankings.at(-1)).toMatchObject({
      score: Number.POSITIVE_INFINITY,
      url: 'malformed',
    });
    expect(selectMotionTransition(rankings, [], () => 1)?.url).toBe('valid');
  });
});
