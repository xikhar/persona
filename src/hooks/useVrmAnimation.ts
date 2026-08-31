import { useCallback, useEffect, useRef } from 'react';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';
import type { VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';
import {
  animationUrlSignature,
  type PlayableAnimationType,
} from '../animation-catalog';
import {
  AnimationScheduler,
  DEFAULT_BODY_TRANSITION_MS,
  DEFAULT_IDLE_INTERIM_MS,
  DEFAULT_SPEAKING_DEBOUNCE_MS,
  DEFAULT_SPEAKING_TRANSITION,
  type AnimationPlayback,
  type AnimationScheduleRequest,
  type AnimationSchedulerDebugEvent,
  type AnimationTransition,
} from '../animation-scheduler';

interface PlayOptions {
  animationRequest: number;
  animationUrls?: readonly string[];
  fallbackAnimationUrls?: readonly string[];
  onComplete?: () => void;
  playback?: AnimationPlayback;
  transition?: AnimationTransition;
}

const animationDebugEnabled =
  new URLSearchParams(window.location.search).get('animationDebug') === '1';

function logAnimationEvent(event: AnimationSchedulerDebugEvent): void {
  if (!animationDebugEnabled) return;
  console.debug(
    `[persona:animation] ${event.event}`,
    JSON.stringify(event),
  );
}

export function useVrmAnimation(
  vrm: VRM | null,
  speakingTransition: PersonaSpeakingTransitionSettings,
  bodyTransitionMs: number,
  speakingDebounceMs: number,
  idleInterimMs: number,
  speakingActive: boolean,
  preloadAnimationUrls: readonly string[] = [],
) {
  const scheduler = useRef<AnimationScheduler | null>(null);
  const animationCache = useRef(new Map<string, VRMAnimation>());
  const clipCache = useRef(
    new WeakMap<VRM, Map<string, THREE.AnimationClip>>(),
  );

  const loadAnimation = useCallback(async (url: string) => {
    const cached = animationCache.current.get(url);
    if (cached) return cached;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const animation = gltf.userData.vrmAnimations?.[0] as VRMAnimation | undefined;
    if (!animation) throw new Error(`No VRM animation found in ${url}`);
    animationCache.current.set(url, animation);
    return animation;
  }, []);

  const loadClip = useCallback(
    async (url: string) => {
      if (!vrm) throw new Error('A VRM model is required to load an animation.');
      let clips = clipCache.current.get(vrm);
      if (!clips) {
        clips = new Map();
        clipCache.current.set(vrm, clips);
      }
      const cached = clips.get(url);
      if (cached) return cached;
      const animation = await loadAnimation(url);
      const clip = createVRMAnimationClip(animation, vrm);
      clips.set(url, clip);
      return clip;
    },
    [loadAnimation, vrm],
  );

  useEffect(() => {
    if (!vrm) return;
    const nextScheduler = new AnimationScheduler(
      new THREE.AnimationMixer(vrm.scene),
      {
        ...(animationDebugEnabled ? { debug: logAnimationEvent } : {}),
        loadClip,
        timing: {
          bodyTransitionMs: DEFAULT_BODY_TRANSITION_MS,
          speakingDebounceMs: DEFAULT_SPEAKING_DEBOUNCE_MS,
          idleInterimMs: DEFAULT_IDLE_INTERIM_MS,
          speakingTransition: DEFAULT_SPEAKING_TRANSITION,
        },
      },
    );
    scheduler.current = nextScheduler;
    return () => {
      nextScheduler.dispose();
      if (scheduler.current === nextScheduler) scheduler.current = null;
    };
  }, [loadClip, vrm]);

  useEffect(() => {
    scheduler.current?.setSpeakingActive(speakingActive);
  }, [speakingActive]);

  useEffect(() => {
    scheduler.current?.setTiming({
      bodyTransitionMs,
      speakingDebounceMs,
      idleInterimMs,
      speakingTransition,
    });
  }, [bodyTransitionMs, idleInterimMs, speakingDebounceMs, speakingTransition]);

  const preloadKey = animationUrlSignature(preloadAnimationUrls);
  useEffect(() => {
    const urls = JSON.parse(preloadKey) as string[];
    scheduler.current?.prepare(urls);
  }, [preloadKey]);

  const play = useCallback(
    async (
      type: PlayableAnimationType,
      {
        animationRequest,
        animationUrls = [],
        fallbackAnimationUrls = [],
        onComplete,
        playback = 'loop',
        transition = 'smooth',
      }: PlayOptions,
    ) => {
      const activeScheduler = scheduler.current;
      // Loading a model is not completion. `play` is recreated when `vrm`
      // becomes ready, so Avatar's request effect will retry the same command
      // against the newly created scheduler. Completing here would silently
      // discard a one-shot delivered during application startup.
      if (!vrm || !activeScheduler) return;
      const request: AnimationScheduleRequest = {
        animationRequest,
        animationUrls,
        fallbackAnimationUrls,
        onComplete,
        playback,
        transition,
        type,
      };
      await activeScheduler.request(request);
    },
    [vrm],
  );

  const update = useCallback((delta: number) => {
    scheduler.current?.update(delta);
  }, []);

  return { play, update };
}
