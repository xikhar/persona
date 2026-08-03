import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  AnimationScheduler,
  bodyTransitionTiming,
  fitTransitionTiming,
  nextSequenceTransitionTime,
  speakingTransitionTiming,
  transitionProgress,
  type AnimationSchedulerDebugEvent,
  type AnimationSchedulerTiming,
} from './animation-scheduler';

const TIMING: AnimationSchedulerTiming = {
  bodyTransitionMs: 1000,
  speakingDebounceMs: 500,
  idleInterimMs: 300,
  speakingTransition: {
    entry_ms: [450, 450],
    exit_ms: [450, 450],
  },
};

function motionClip(name: string, duration = 2): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, [
    new THREE.VectorKeyframeTrack(
      '.position',
      [0, duration],
      [0, 0, 0, 1, 0, 0],
    ),
  ]);
}

function directedMotionClip(
  name: string,
  start: number,
  end: number,
  duration = 2,
): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, [
    new THREE.VectorKeyframeTrack(
      '.position',
      [0, duration],
      [start, 0, 0, end, 0, 0],
    ),
  ]);
}

function createHarness(
  clips: Record<string, THREE.AnimationClip>,
  timing = TIMING,
) {
  const mixer = new THREE.AnimationMixer(new THREE.Object3D());
  const events: AnimationSchedulerDebugEvent[] = [];
  const scheduler = new AnimationScheduler(mixer, {
    debug: (event) => events.push(event),
    loadClip: async (url) => {
      const clip = clips[url];
      if (!clip) throw new Error(`missing ${url}`);
      return clip;
    },
    random: () => 0,
    timing,
  });
  return {
    running(url: string) {
      return scheduler
        .getDebugSnapshot()
        .weights.some((entry) => entry.url === url && entry.running);
    },
    weight(url: string) {
      return scheduler
        .getDebugSnapshot()
        .weights.filter((entry) => entry.url === url)
        .reduce((total, entry) => total + entry.weight, 0);
    },
    events,
    mixer,
    scheduler,
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

describe('animation scheduler timing', () => {
  it('derives every transition from the global body and speaking settings', () => {
    expect(bodyTransitionTiming(2000)).toEqual({
      entry: 1,
      exit: 1,
      total: 2,
    });
    expect(
      speakingTransitionTiming(
        { entry_ms: [900, 900], exit_ms: [1350, 1350] },
        () => 0,
      ),
    ).toEqual({ entry: 0.9, exit: 1.35, total: 2.25 });
    expect(transitionProgress(0.45, { entry: 0.9, exit: 1.35, total: 2.25 }))
      .toBeCloseTo(0.25, 8);
    expect(transitionProgress(1.575, { entry: 0.9, exit: 1.35, total: 2.25 }))
      .toBeCloseTo(0.75, 8);
    expect(transitionProgress(0.09, { entry: 0.9, exit: 1.35, total: 2.25 }))
      .toBeLessThan(0.05);
    expect(transitionProgress(2.16, { entry: 0.9, exit: 1.35, total: 2.25 }))
      .toBeGreaterThan(0.95);
  });

  it('uses clip duration to choose a safe scheduling boundary', () => {
    expect(nextSequenceTransitionTime(3, 1)).toBe(2);
    expect(nextSequenceTransitionTime(1, 4)).toBe(0.2);
  });

  it('fits long requested blends into a clip without changing their profile', () => {
    expect(
      fitTransitionTiming({ entry: 1, exit: 2, total: 3 }, 0.9),
    ).toEqual({ entry: 0.3, exit: 0.6, total: 0.9 });
  });

  it('keeps the eased transition monotonic and weight-preserving', () => {
    const timing = { entry: 0.7, exit: 0.8, total: 1.5 };
    const samples = Array.from(
      { length: 61 },
      (_, index) => transitionProgress((timing.total * index) / 60, timing),
    );
    expect(samples[0]).toBe(0);
    expect(samples.at(-1)).toBe(1);
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]).toBeGreaterThanOrEqual(samples[index - 1]);
      expect(samples[index] + (1 - samples[index])).toBeCloseTo(1, 12);
    }
  });
});

describe('animation scheduler transitions', () => {
  it('retargets an in-progress blend without changing its current pose weights', async () => {
    const clips = {
      idle: motionClip('idle'),
      talk: motionClip('talk'),
      wave: motionClip('wave'),
    };
    const { scheduler, weight } = createHarness(clips);
    scheduler.setSpeakingActive(true);

    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['idle'],
      playback: 'loop',
      type: 'IDLE',
    });
    scheduler.update(1);
    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['talk'],
      playback: 'loop',
      type: 'TALK',
    });
    scheduler.update(0.4);

    const before = {
      idle: weight('idle'),
      talk: weight('talk'),
    };
    expect(before.idle + before.talk).toBeCloseTo(1, 8);

    await scheduler.request({
      animationRequest: 7,
      animationUrls: ['wave'],
      playback: 'once',
      type: 'CUSTOM',
    });
    expect(weight('idle')).toBeCloseTo(before.idle, 8);
    expect(weight('talk')).toBeCloseTo(before.talk, 8);
    expect(weight('wave')).toBe(0);

    scheduler.update(0.5);
    const customProgress = transitionProgress(
      0.5,
      speakingTransitionTiming(TIMING.speakingTransition, () => 0),
    );
    expect(weight('idle')).toBeCloseTo(
      before.idle * (1 - customProgress),
      8,
    );
    expect(weight('talk')).toBeCloseTo(
      before.talk * (1 - customProgress),
      8,
    );
    expect(weight('wave')).toBeCloseTo(customProgress, 8);
    expect(
      weight('idle') + weight('talk') + weight('wave'),
    ).toBeCloseTo(1, 8);
  });

  it('commits the latest speech state when activity changes during loading', async () => {
    let resolveIdle: ((clip: THREE.AnimationClip) => void) | undefined;
    const idlePending = new Promise<THREE.AnimationClip>((resolve) => {
      resolveIdle = resolve;
    });
    const clips = {
      idle: motionClip('idle'),
      talk: motionClip('talk'),
    };
    const mixer = new THREE.AnimationMixer(new THREE.Object3D());
    const events: AnimationSchedulerDebugEvent[] = [];
    const scheduler = new AnimationScheduler(mixer, {
      debug: (event) => events.push(event),
      loadClip: (url) =>
        url === 'idle' ? idlePending : Promise.resolve(clips.talk),
      timing: TIMING,
    });

    const request = scheduler.request({
      animationRequest: 0,
      animationUrls: ['talk'],
      fallbackAnimationUrls: ['idle'],
      playback: 'loop',
      type: 'TALK',
    });
    scheduler.setSpeakingActive(true);
    resolveIdle?.(clips.idle);
    await request;

    expect(scheduler.getDebugSnapshot().active?.url).toBe('talk');
    expect(
      events.some((event) => event.event === 'target-selection-retried'),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.event === 'transition-started' &&
          event.reason === 'fallback-request',
      ),
    ).toBe(false);
  });

  it('parks an inactive speaking request on the existing Idle action', async () => {
    const clips = {
      idle: motionClip('idle'),
      talk: motionClip('talk'),
    };
    const { events, scheduler } = createHarness(clips);
    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['idle'],
      playback: 'loop',
      type: 'IDLE',
    });
    scheduler.update(1);
    const idleId = scheduler.getDebugSnapshot().active?.id;

    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['talk'],
      fallbackAnimationUrls: ['idle'],
      playback: 'loop',
      type: 'TALK',
    });

    expect(scheduler.getDebugSnapshot().active).toMatchObject({
      id: idleId,
      type: 'IDLE',
      url: 'idle',
    });
    expect(
      events.some((event) => event.event === 'request-parked-on-idle'),
    ).toBe(true);
  });

  it('starts speaking from a warmed clip without waiting for slower clips', async () => {
    let resolveSlow: ((clip: THREE.AnimationClip) => void) | undefined;
    const slow = new Promise<THREE.AnimationClip>((resolve) => {
      resolveSlow = resolve;
    });
    const clips = {
      idle: motionClip('idle'),
      ready: motionClip('ready'),
      slow: motionClip('slow'),
    };
    const mixer = new THREE.AnimationMixer(new THREE.Object3D());
    const scheduler = new AnimationScheduler(mixer, {
      loadClip: (url) =>
        url === 'slow' ? slow : Promise.resolve(clips[url as 'idle' | 'ready']),
      random: () => 0,
      timing: TIMING,
    });

    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['idle'],
      playback: 'loop',
      type: 'IDLE',
    });
    scheduler.update(1);
    scheduler.prepare(['ready', 'slow']);
    await settle();
    scheduler.setSpeakingActive(true);

    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['ready', 'slow'],
      fallbackAnimationUrls: ['idle'],
      playback: 'loop',
      type: 'TALK',
    });

    expect(scheduler.getDebugSnapshot().active?.url).toBe('ready');
    resolveSlow?.(clips.slow);
  });

  it('starts the speaking action immediately and uses the body transition on voice onset', async () => {
    const clips = {
      idle: directedMotionClip('idle', 0, 0),
      talk: directedMotionClip('talk', 1, 2),
    };
    const { events, running, scheduler, weight } = createHarness(clips, {
      ...TIMING,
      bodyTransitionMs: 2000,
    });
    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['idle'],
      playback: 'loop',
      type: 'IDLE',
    });
    scheduler.update(2);
    scheduler.setSpeakingActive(true);

    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['talk'],
      fallbackAnimationUrls: ['idle'],
      playback: 'loop',
      type: 'TALK',
    });

    expect(running('talk')).toBe(true);
    expect(
      [...events].reverse().find(
        (event) =>
          event.event === 'transition-started' && event.reason === 'request',
      )?.duration,
    ).toBe(0.9);
    scheduler.update(0.016);
    expect(weight('talk')).toBeGreaterThan(0);
  });

  it('updates a live Speaking library without restarting its current action', async () => {
    const clips = {
      talk1: motionClip('talk1'),
      talk2: motionClip('talk2'),
      talk3: motionClip('talk3'),
    };
    const { events, scheduler } = createHarness(clips);
    scheduler.setSpeakingActive(true);
    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['talk1', 'talk2'],
      playback: 'loop',
      type: 'TALK',
    });
    const active = scheduler.getDebugSnapshot().active;

    await scheduler.request({
      animationRequest: 0,
      animationUrls: [active?.url ?? 'talk1', 'talk3'],
      playback: 'loop',
      type: 'TALK',
    });

    expect(scheduler.getDebugSnapshot().active?.id).toBe(active?.id);
    expect(
      events.some((event) => event.event === 'request-retained-action'),
    ).toBe(true);
    expect(
      [...events].reverse().find(
        (event) => event.event === 'sequence-scheduled',
      )?.candidateCount,
    ).toBe(1);
  });

  it('creates a fresh action when the same clip is requested before its old action fades out', async () => {
    const clips = { wave: motionClip('wave') };
    const { scheduler } = createHarness(clips);
    await scheduler.request({
      animationRequest: 1,
      animationUrls: ['wave'],
      playback: 'once',
      type: 'CUSTOM',
    });
    scheduler.update(0.4);
    const first = scheduler.getDebugSnapshot().weights[0];

    await scheduler.request({
      animationRequest: 2,
      animationUrls: ['wave'],
      playback: 'once',
      type: 'CUSTOM',
    });
    const retargeted = scheduler.getDebugSnapshot().weights;

    expect(retargeted).toHaveLength(2);
    expect(new Set(retargeted.map((entry) => entry.id)).size).toBe(2);
    expect(
      retargeted.find((entry) => entry.id === first.id)?.actionTime,
    ).toBeCloseTo(first.actionTime, 8);
    expect(
      retargeted.find((entry) => entry.id !== first.id)?.actionTime,
    ).toBe(0);
    expect(
      retargeted.reduce((total, entry) => total + entry.weight, 0),
    ).toBeCloseTo(first.weight, 8);
  });

  it('keeps speaking active and preserves its chunk plan across a short gap', async () => {
    const clips = {
      idle: motionClip('idle'),
      talk1: motionClip('talk1'),
      talk2: motionClip('talk2'),
    };
    const { events, running, scheduler } = createHarness(clips, {
      ...TIMING,
      bodyTransitionMs: 400,
    });
    scheduler.setSpeakingActive(true);
    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['talk1', 'talk2'],
      fallbackAnimationUrls: ['idle'],
      playback: 'loop',
      type: 'TALK',
    });
    scheduler.update(0.4);
    scheduler.update(0.3);
    const originalTalkPlan = [...events].reverse().find(
      (event) =>
        event.event === 'sequence-scheduled' && event.nextType === 'TALK',
    );

    scheduler.setSpeakingActive(false);
    scheduler.update(0.3);
    expect(scheduler.getDebugSnapshot().speakingActive).toBe(true);
    scheduler.setSpeakingActive(true);
    const latestTalkPlan = [...events].reverse().find(
      (event) =>
        event.event === 'sequence-scheduled' && event.nextType === 'TALK',
    );
    expect(latestTalkPlan?.startAtMixerTime).toBe(
      originalTalkPlan?.startAtMixerTime,
    );
    scheduler.update(0.2);
    await settle();

    expect(
      events.some(
        (event) =>
          event.event === 'transition-started' &&
          event.reason === 'speaking-gap',
      ),
    ).toBe(false);
    expect(running('idle')).toBe(false);
    expect(
      events.some(
        (event) =>
          event.event === 'motion-target-selected' &&
          event.loopTarget === true,
      ),
    ).toBe(false);
    expect(
      events.some(
        (event) =>
          event.event === 'sequence-advancing' && event.type === 'TALK',
      ),
    ).toBe(true);
  });

  it('never stacks automatic speaking transitions for short clips', async () => {
    const clips = {
      talk1: motionClip('talk1', 1.2),
      talk2: motionClip('talk2', 1.4),
      talk3: motionClip('talk3', 1.1),
    };
    const { events, scheduler } = createHarness(clips);
    scheduler.setSpeakingActive(true);
    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['talk1', 'talk2', 'talk3'],
      playback: 'loop',
      type: 'TALK',
    });

    let maximumContributors = 0;
    for (let frame = 0; frame < 240; frame += 1) {
      scheduler.update(0.05);
      await settle();
      maximumContributors = Math.max(
        maximumContributors,
        scheduler.getDebugSnapshot().weights.length,
      );
    }

    expect(maximumContributors).toBeLessThanOrEqual(2);
    expect(
      events.some(
        (event) =>
          event.event === 'transition-retargeted' &&
          event.reason === 'speaking-sequence',
      ),
    ).toBe(false);
    expect(
      events.filter((event) => event.event === 'sequence-advancing').length,
    ).toBeGreaterThan(3);
  });

  it('chooses a pose-and-velocity-compatible speaking successor', async () => {
    const clips = {
      talk1: directedMotionClip('talk1', 0, 2),
      talk2: directedMotionClip('talk2', 1.1, 3.1),
      talk3: directedMotionClip('talk3', -4, -2),
    };
    const { events, scheduler } = createHarness(clips, {
      ...TIMING,
      bodyTransitionMs: 100,
    });
    scheduler.setSpeakingActive(true);
    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['talk1', 'talk2', 'talk3'],
      playback: 'loop',
      type: 'TALK',
    });
    await settle();
    scheduler.update(1.1);
    await settle();

    expect(scheduler.getDebugSnapshot().active?.url).toBe('talk2');
    expect(
      events.some(
        (event) =>
          event.event === 'motion-target-selected' &&
          event.selected === 'talk2',
      ),
    ).toBe(true);
    expect(
      events.findIndex((event) => event.event === 'sequence-target-prepared'),
    ).toBeLessThan(
      events.findIndex((event) => event.event === 'sequence-due'),
    );
  });

  it('keeps authored clip speed independent from slow transition timing', async () => {
    const clips = {
      talk1: motionClip('talk1', 1.2),
      talk2: motionClip('talk2', 1.4),
    };
    const { scheduler } = createHarness(clips, {
      bodyTransitionMs: 1000,
      speakingDebounceMs: 500,
      idleInterimMs: 300,
      speakingTransition: {
        entry_ms: [1800, 1800],
        exit_ms: [1800, 1800],
      },
    });
    scheduler.setSpeakingActive(true);
    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['talk1', 'talk2'],
      playback: 'loop',
      type: 'TALK',
    });

    scheduler.update(0.5);
    expect(scheduler.getDebugSnapshot().active?.url).toBe('talk1');
    expect(scheduler.getDebugSnapshot().weights[0]?.actionTime).toBeCloseTo(
      0.5,
      8,
    );

    scheduler.update(0.6);
    await settle();
    expect(scheduler.getDebugSnapshot().active?.url).toBe('talk2');
    const talk2Start = scheduler.getDebugSnapshot().weights.find(
      (entry) => entry.url === 'talk2',
    )?.actionTime ?? 0;
    scheduler.update(0.5);
    expect(
      scheduler.getDebugSnapshot().weights.find(
        (entry) => entry.url === 'talk2',
      )?.actionTime,
    ).toBeCloseTo(talk2Start + 0.5, 8);
  });

  it('finishes an Idle transition and interim before resuming speech', async () => {
    const clips = {
      idle: motionClip('idle'),
      talk1: motionClip('talk1'),
      talk2: motionClip('talk2'),
    };
    const { events, scheduler, weight } = createHarness(clips, {
      ...TIMING,
      bodyTransitionMs: 400,
    });
    scheduler.setSpeakingActive(true);
    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['talk1', 'talk2'],
      fallbackAnimationUrls: ['idle'],
      playback: 'loop',
      type: 'TALK',
    });
    scheduler.update(0.4);
    scheduler.setSpeakingActive(false);
    scheduler.update(0.501);
    await settle();
    expect(scheduler.getDebugSnapshot().transition?.reason).toBe(
      'speaking-gap',
    );

    scheduler.setSpeakingActive(true);
    await settle();
    expect(
      events.some(
        (event) =>
          event.event === 'speaking-resume-deferred' &&
          event.phase === 'idle-transition',
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.event === 'transition-retargeted' &&
          event.reason === 'speaking-resume',
      ),
    ).toBe(false);

    scheduler.update(0.401);
    expect(scheduler.getDebugSnapshot().active?.type).toBe('IDLE');
    expect(weight('idle')).toBeCloseTo(1, 8);
    scheduler.update(0.299);
    expect(scheduler.getDebugSnapshot().active?.type).toBe('IDLE');
    scheduler.update(0.002);
    await settle();

    expect(scheduler.getDebugSnapshot().active?.type).toBe('TALK');
    expect(
      events.some(
        (event) =>
          event.event === 'transition-started' &&
          event.reason === 'speaking-resume',
      ),
    ).toBe(true);
  });

  it('falls back to the model rest pose when the permanent Idle slot is empty', async () => {
    const clips = {
      talk1: motionClip('talk1'),
      talk2: motionClip('talk2'),
    };
    const { events, scheduler, weight } = createHarness(clips, {
      ...TIMING,
      bodyTransitionMs: 400,
    });
    scheduler.setSpeakingActive(true);
    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['talk1', 'talk2'],
      playback: 'loop',
      type: 'TALK',
    });
    scheduler.update(0.4);
    scheduler.setSpeakingActive(false);
    scheduler.update(1.7);
    await settle();
    scheduler.update(0.2);

    expect(weight('talk1')).toBeLessThan(1);
    expect(
      events.some(
        (event) =>
          event.event === 'transition-started' &&
          event.reason === 'speaking-gap' &&
          event.to === 'rest-pose',
      ),
    ).toBe(true);
  });

  it('protects the Idle interim when the Idle slot uses the rest pose', async () => {
    const clips = {
      talk1: motionClip('talk1'),
      talk2: motionClip('talk2'),
    };
    const { scheduler } = createHarness(clips, {
      ...TIMING,
      bodyTransitionMs: 400,
    });
    scheduler.setSpeakingActive(true);
    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['talk1', 'talk2'],
      playback: 'loop',
      type: 'TALK',
    });
    scheduler.update(0.4);
    scheduler.setSpeakingActive(false);
    scheduler.update(0.501);
    await settle();
    expect(scheduler.getDebugSnapshot().transition).toMatchObject({
      reason: 'speaking-gap',
      to: 'rest-pose',
    });

    scheduler.setSpeakingActive(true);
    scheduler.update(0.401);
    expect(scheduler.getDebugSnapshot().active).toBeNull();
    scheduler.update(0.3);
    await settle();

    expect(scheduler.getDebugSnapshot().active?.type).toBe('TALK');
  });

  it('smoothly recycles one Speaking clip and still schedules Idle after silence', async () => {
    const clips = {
      idle: motionClip('idle'),
      talk: motionClip('talk'),
    };
    const { events, scheduler } = createHarness(clips, {
      ...TIMING,
      bodyTransitionMs: 400,
    });
    scheduler.setSpeakingActive(true);
    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['talk'],
      fallbackAnimationUrls: ['idle'],
      playback: 'loop',
      type: 'TALK',
    });
    scheduler.update(0.4);
    expect(
      events.some((event) => event.event === 'sequence-scheduled'),
    ).toBe(true);

    scheduler.update(0.8);
    await settle();
    expect(scheduler.getDebugSnapshot().weights).toHaveLength(2);
    expect(
      new Set(
        scheduler.getDebugSnapshot().weights.map((entry) => entry.id),
      ).size,
    ).toBe(2);

    scheduler.setSpeakingActive(false);
    scheduler.update(0.501);
    await settle();
    expect(
      events.some(
        (event) =>
          (event.event === 'transition-started' ||
            event.event === 'transition-retargeted') &&
          event.reason === 'speaking-gap' &&
          event.to === 'idle',
      ),
    ).toBe(true);
  });

  it('starts the Idle route when the speaking debounce expires', async () => {
    const clips = {
      idle: motionClip('idle'),
      talk: motionClip('talk'),
    };
    const { events, scheduler } = createHarness(clips, {
      ...TIMING,
      bodyTransitionMs: 400,
    });
    scheduler.setSpeakingActive(true);
    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['talk'],
      fallbackAnimationUrls: ['idle'],
      playback: 'loop',
      type: 'TALK',
    });
    scheduler.update(1.9);
    scheduler.setSpeakingActive(false);
    scheduler.update(0.499);
    await settle();
    expect(
      events.some(
        (event) =>
          (event.event === 'transition-started' ||
            event.event === 'transition-retargeted') &&
          event.reason === 'speaking-gap',
      ),
    ).toBe(false);
    scheduler.update(0.002);
    await settle();

    expect(
      events.some(
        (event) =>
          (event.event === 'transition-started' ||
            event.event === 'transition-retargeted') &&
          event.reason === 'speaking-gap',
      ),
    ).toBe(true);
  });

  it('releases a failed one-shot override after transitioning to Idle fallback', async () => {
    const clips = { idle: motionClip('idle') };
    const { scheduler } = createHarness(clips);
    const onComplete = vi.fn();

    await scheduler.request({
      animationRequest: 9,
      animationUrls: ['missing'],
      fallbackAnimationUrls: ['idle'],
      onComplete,
      playback: 'once',
      type: 'CUSTOM',
    });

    expect(onComplete).toHaveBeenCalledOnce();
    expect(scheduler.getDebugSnapshot().active?.url).toBe('idle');
  });

  it('discards an obsolete async load instead of playing it late', async () => {
    let resolveSlow: ((clip: THREE.AnimationClip) => void) | undefined;
    const slow = new Promise<THREE.AnimationClip>((resolve) => {
      resolveSlow = resolve;
    });
    const idle = motionClip('idle');
    const mixer = new THREE.AnimationMixer(new THREE.Object3D());
    const events: AnimationSchedulerDebugEvent[] = [];
    const scheduler = new AnimationScheduler(mixer, {
      debug: (event) => events.push(event),
      loadClip: (url) => (url === 'slow' ? slow : Promise.resolve(idle)),
      timing: TIMING,
    });

    const obsolete = scheduler.request({
      animationRequest: 1,
      animationUrls: ['slow'],
      playback: 'once',
      type: 'CUSTOM',
    });
    await scheduler.request({
      animationRequest: 0,
      animationUrls: ['idle'],
      playback: 'loop',
      type: 'IDLE',
    });
    resolveSlow?.(motionClip('slow'));
    await obsolete;

    expect(scheduler.getDebugSnapshot().active?.url).toBe('idle');
    expect(
      events.some(
        (event) => event.event === 'load-discarded' && event.type === 'CUSTOM',
      ),
    ).toBe(true);
  });

  it('completes only the current one-shot request', async () => {
    const clips = {
      first: motionClip('first', 1),
      second: motionClip('second', 1),
    };
    const { scheduler } = createHarness(clips, {
      ...TIMING,
      bodyTransitionMs: 100,
    });
    const firstComplete = vi.fn();
    const secondComplete = vi.fn();

    await scheduler.request({
      animationRequest: 1,
      animationUrls: ['first'],
      onComplete: firstComplete,
      playback: 'once',
      type: 'CUSTOM',
    });
    scheduler.update(0.3);
    await scheduler.request({
      animationRequest: 2,
      animationUrls: ['second'],
      onComplete: secondComplete,
      playback: 'once',
      type: 'CUSTOM',
    });
    scheduler.update(1.1);

    expect(firstComplete).not.toHaveBeenCalled();
    expect(secondComplete).toHaveBeenCalledOnce();
  });
});
