import { Suspense, useEffect, useLayoutEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import { useVrmLoader } from '../hooks/useVrmLoader';
import { useVrmAnimation } from '../hooks/useVrmAnimation';
import { useAmplitudeLipSync } from '../hooks/useAmplitudeLipSync';
import { useBlink } from '../hooks/useBlink';
import {
  animationUrlSignature,
  type PlayableAnimationType,
} from '../animation-catalog';

interface AvatarProps {
  animation: PlayableAnimationType;
  animationRequest: number;
  animationUrls?: readonly string[];
  fallbackAnimationUrls?: readonly string[];
  preloadAnimationUrls?: readonly string[];
  audioLevel: number;
  bodySpeaking: boolean;
  modelUrl: string;
  onAnimationComplete: () => void;
  playback: 'loop' | 'once';
  speaking: boolean;
  bodyTransitionMs: number;
  speakingDebounceMs: number;
  idleInterimMs: number;
  speakingTransition: PersonaSpeakingTransitionSettings;
  onReady?: (scene: THREE.Object3D) => void;
}

function AvatarModel({
  animation,
  animationRequest,
  animationUrls,
  fallbackAnimationUrls,
  preloadAnimationUrls,
  audioLevel,
  bodySpeaking,
  modelUrl,
  onAnimationComplete,
  playback,
  speaking,
  bodyTransitionMs,
  speakingDebounceMs,
  idleInterimMs,
  speakingTransition,
  onReady,
}: AvatarProps) {
  const vrm = useVrmLoader(modelUrl);
  const { play, update: updateAnimation } = useVrmAnimation(
    vrm,
    speakingTransition,
    bodyTransitionMs,
    speakingDebounceMs,
    idleInterimMs,
    bodySpeaking,
    preloadAnimationUrls,
  );
  const updateLipSync = useAmplitudeLipSync(vrm);
  const updateBlink = useBlink(vrm);

  const animationUrlsKey = animationUrlSignature(animationUrls);
  const stableAnimationUrls = useMemo(
    () => JSON.parse(animationUrlsKey) as string[],
    [animationUrlsKey],
  );
  const fallbackAnimationUrlsKey = animationUrlSignature(
    fallbackAnimationUrls,
  );
  const stableFallbackAnimationUrls = useMemo(
    () => JSON.parse(fallbackAnimationUrlsKey) as string[],
    [fallbackAnimationUrlsKey],
  );

  useEffect(() => {
    void play(animation, {
      animationRequest,
      animationUrls: stableAnimationUrls,
      fallbackAnimationUrls: stableFallbackAnimationUrls,
      onComplete: onAnimationComplete,
      playback,
    });
  }, [
    animation,
    animationRequest,
    onAnimationComplete,
    play,
    playback,
    stableAnimationUrls,
    stableFallbackAnimationUrls,
  ]);

  useLayoutEffect(() => {
    if (vrm) onReady?.(vrm.scene);
  }, [onReady, vrm]);

  useFrame((_, delta) => {
    if (!vrm) return;
    updateAnimation(delta);
    updateBlink(delta);
    updateLipSync(delta, audioLevel, speaking || bodySpeaking);
    vrm.update(delta);
  });

  return vrm ? <primitive object={vrm.scene} /> : null;
}

export function Avatar(props: AvatarProps) {
  return (
    <Suspense fallback={null}>
      <AvatarModel {...props} />
    </Suspense>
  );
}
