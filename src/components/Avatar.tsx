import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import {
  advanceDragInertia,
  applyPendingDrag,
  applyPendingOrbit,
  cameraAzimuth,
  isDragInertiaAtRest,
  orbitSweep,
  queueOrbitRadians,
  torsoLeanAngle,
  TORSO_LEAN_WEIGHTS,
  leanWeightsFor,
  worldPerPixel,
  type DragInertiaState,
} from '../drag-inertia';
import { useVrmLoader } from '../hooks/useVrmLoader';
import { useVrmAnimation } from '../hooks/useVrmAnimation';
import { useAmplitudeLipSync } from '../hooks/useAmplitudeLipSync';
import { useBlink } from '../hooks/useBlink';
import { useActionExpression } from '../hooks/useActionExpression';
import {
  animationUrlSignature,
  type PlayableAnimationType,
} from '../animation-catalog';

// Reused every frame so the render loop allocates nothing.
const CAMERA_RIGHT = new THREE.Vector3();
const CAMERA_UP = new THREE.Vector3();
const ORBIT_TARGET = new THREE.Vector3();
const LAG = new THREE.Vector3();
const LEAN_AXIS = new THREE.Vector3();
const PARENT_ROTATION = new THREE.Quaternion();
const LEAN = new THREE.Quaternion();
const TWIST = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

const TORSO_BONES = TORSO_LEAN_WEIGHTS.map(([name]) => name);

function orbitTarget(controls: unknown, fallback: THREE.Vector3): THREE.Vector3 {
  const target = (controls as { target?: unknown } | null)?.target;
  return target instanceof THREE.Vector3 ? target : fallback;
}

interface Torso {
  /**
   * Each joint with its share of the lean; the shares sum to one. `pose` is the
   * rotation the animation left, kept so the lean can be taken back off.
   */
  bones: { node: THREE.Object3D; weight: number; pose: THREE.Quaternion }[];
  /** Hips-to-head distance at rest, so the lean scales with the model. */
  length: number;
}

/**
 * The normalized humanoid rig is what animation drives and what `vrm.update`
 * copies onto the render skeleton, so the lean has to be written there.
 */
function readTorso(vrm: {
  humanoid: {
    getNormalizedBoneNode(name: string): THREE.Object3D | null;
  };
  scene: THREE.Object3D;
}): Torso | null {
  vrm.scene.updateMatrixWorld(true);
  const hips = vrm.humanoid.getNormalizedBoneNode('hips');
  const head = vrm.humanoid.getNormalizedBoneNode('head');
  if (!hips || !head) return null;
  const present = TORSO_BONES.filter(
    (name) => vrm.humanoid.getNormalizedBoneNode(name) !== null,
  );
  const bones = leanWeightsFor(present).flatMap(([name, weight]) => {
    const node = vrm.humanoid.getNormalizedBoneNode(name);
    return node ? [{ node, weight, pose: new THREE.Quaternion() }] : [];
  });
  if (bones.length === 0) return null;
  const length = hips
    .getWorldPosition(new THREE.Vector3())
    .distanceTo(head.getWorldPosition(new THREE.Vector3()));
  return length > 0 ? { bones, length } : null;
}

interface AvatarProps {
  animation: PlayableAnimationType;
  animationRequest: number;
  animationUrls?: readonly string[];
  fallbackAnimationUrls?: readonly string[];
  preloadAnimationUrls?: readonly string[];
  expressionName?: PersonaExpressionName | null;
  expressionWeight?: number;
  audioLevel: number;
  bodySpeaking: boolean;
  dragInertia?: DragInertiaState;
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
  expressionName,
  expressionWeight,
  audioLevel,
  bodySpeaking,
  dragInertia,
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
  const updateActionExpression = useActionExpression(
    vrm,
    expressionName,
    expressionWeight,
  );

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

  const torsoRef = useRef<Torso | null>(null);
  const lastAzimuth = useRef<number | null>(null);

  useLayoutEffect(() => {
    torsoRef.current = null;
    // Re-framing jumps the camera, and that jump is not an orbit gesture.
    lastAzimuth.current = null;
    if (vrm) onReady?.(vrm.scene);
  }, [onReady, vrm]);

  useFrame((state, delta) => {
    if (!vrm) return;
    updateAnimation(delta);
    updateActionExpression();
    updateBlink(delta);
    updateLipSync(delta, audioLevel, speaking || bodySpeaking);

    let leaned: Torso | null = null;
    if (dragInertia) {
      const torso = (torsoRef.current ??= readTorso(vrm));
      const { camera } = state;
      const target = orbitTarget(
        state.controls,
        vrm.scene.getWorldPosition(ORBIT_TARGET),
      );

      // Orbiting sweeps the camera around the target; the character itself
      // never moves, so read the sweep off the camera rather than the pointer.
      const azimuth = cameraAzimuth(
        camera.position.x,
        camera.position.z,
        target.x,
        target.z,
      );
      const previousAzimuth = lastAzimuth.current;
      lastAzimuth.current = azimuth;
      if (previousAzimuth !== null) {
        queueOrbitRadians(dragInertia, orbitSweep(previousAzimuth, azimuth));
      }
      applyPendingOrbit(dragInertia);

      if (camera instanceof THREE.PerspectiveCamera) {
        applyPendingDrag(
          dragInertia,
          worldPerPixel(
            camera.position.distanceTo(target),
            camera.fov,
            state.size.height,
          ),
        );
      }
      advanceDragInertia(dragInertia, delta);

      if (torso && !isDragInertiaAtRest(dragInertia)) {
        leaned = torso;
        // The lag is screen-relative, so it rides the camera basis. Held in
        // world axes it would swing along the view direction once the user had
        // orbited a quarter turn, and read as barely moving at all.
        CAMERA_RIGHT.setFromMatrixColumn(camera.matrixWorld, 0);
        CAMERA_UP.setFromMatrixColumn(camera.matrixWorld, 1);
        LAG.set(0, 0, 0)
          .addScaledVector(CAMERA_RIGHT, dragInertia.x)
          .addScaledVector(CAMERA_UP, dragInertia.y);

        // Into the frame the torso rotates in. Its matrix is a frame stale,
        // which at these angles is not visible.
        const parent = torso.bones[0].node.parent;
        if (parent) {
          LAG.applyQuaternion(
            parent.getWorldQuaternion(PARENT_ROTATION).invert(),
          );
        }

        // Tip the torso toward the lag, about the axis square to it and to up.
        // A vertical lag leaves no axis to turn about, so it leans none.
        LEAN_AXIS.crossVectors(UP, LAG);
        const horizontal = LEAN_AXIS.length();
        const lean =
          horizontal > 0 ? torsoLeanAngle(horizontal, torso.length) : 0;
        if (lean !== 0) LEAN_AXIS.divideScalar(horizontal);

        for (const { node, weight, pose } of torso.bones) {
          pose.copy(node.quaternion);
          if (lean !== 0) {
            node.quaternion.premultiply(
              LEAN.setFromAxisAngle(LEAN_AXIS, lean * weight),
            );
          }
          node.quaternion.premultiply(
            TWIST.setFromAxisAngle(UP, dragInertia.yaw * weight),
          );
        }
        // Spring bones simulate against joint world matrices, so the lean has
        // to be committed before vrm.update runs them for this frame.
        vrm.scene.updateMatrixWorld(true);
      }
    }

    vrm.update(delta);

    // `vrm.update` has copied the lean onto the render skeleton and the springs
    // have answered it, so it is delivered. Take it back off: three-vrm never
    // resets the normalized rig, so a lean left in place is layered on again
    // every frame a clip is not driving that joint.
    if (leaned) {
      for (const { node, pose } of leaned.bones) node.quaternion.copy(pose);
    }
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
