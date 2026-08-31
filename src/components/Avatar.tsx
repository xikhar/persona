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
import type { AnimationTransition } from '../animation-scheduler';
import {
  advanceExcitement,
  advanceGaze,
  advanceGlance,
  createExcitementState,
  createGazeState,
  createGlanceState,
  DEFAULT_GAZE,
  GAZE_BONE_WEIGHTS,
  gazeWeightsFor,
  isGazeAtRest,
  reachScaleFor,
  rigTurnFor,
  type ExcitementState,
  type GazeState,
  type GazeTarget,
  type GlanceState,
} from '../gaze';
import { type PointerFocusState } from '../pointer-focus';

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
const HEAD_WORLD = new THREE.Vector3();
const HEAD_SCREEN = new THREE.Vector3();
const CURSOR_WORLD = new THREE.Vector3();
const HEAD_FORWARD = new THREE.Vector3();
const HEAD_ROTATION = new THREE.Quaternion();
const LOOK_REST = new THREE.Vector3();
const GAZE_YAW = new THREE.Quaternion();
const GAZE_PITCH = new THREE.Quaternion();
const RIGHT = new THREE.Vector3(1, 0, 0);

const TORSO_BONES = TORSO_LEAN_WEIGHTS.map(([name]) => name);
const GAZE_BONES = GAZE_BONE_WEIGHTS.map(([name]) => name);

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

interface GazeRig {
  /** Neck and head with their share of the turn; the shares sum to one. */
  bones: { node: THREE.Object3D; weight: number; pose: THREE.Quaternion }[];
  /** The head itself, which is what the cursor direction is measured from. */
  head: THREE.Object3D;
}

/**
 * The bones the gaze turns, read off the same normalized rig the torso lean
 * writes to, for the same reason: that is what `vrm.update` copies onto the
 * render skeleton.
 */
function readGazeRig(vrm: {
  humanoid: {
    getNormalizedBoneNode(name: string): THREE.Object3D | null;
  };
}): GazeRig | null {
  const head = vrm.humanoid.getNormalizedBoneNode('head');
  if (!head) return null;
  const present = GAZE_BONES.filter(
    (name) => vrm.humanoid.getNormalizedBoneNode(name) !== null,
  );
  const bones = gazeWeightsFor(present).flatMap(([name, weight]) => {
    const node = vrm.humanoid.getNormalizedBoneNode(name);
    return node ? [{ node, weight, pose: new THREE.Quaternion() }] : [];
  });
  return bones.length > 0 ? { bones, head } : null;
}

interface AvatarProps {
  animation: PlayableAnimationType;
  animationRequest: number;
  animationTransition?: AnimationTransition;
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

  onExpressionsChange?: (
    modelUrl: string,
    expressions: readonly string[],
  ) => void;

  playback: 'loop' | 'once';
  speaking: boolean;
  bodyTransitionMs: number;
  speakingDebounceMs: number;
  idleInterimMs: number;
  speakingTransition: PersonaSpeakingTransitionSettings;
  onReady?: (scene: THREE.Object3D) => void;
  /** Absent when the character should not watch the cursor. */
  pointerFocus?: PointerFocusState | undefined;
}

function AvatarModel({
  animation,
  animationRequest,
  animationTransition,
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
  onExpressionsChange,
  playback,
  speaking,
  bodyTransitionMs,
  speakingDebounceMs,
  idleInterimMs,
  speakingTransition,
  onReady,
  pointerFocus,
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

  useEffect(() => {
    const expressions =
      vrm?.expressionManager?.expressions.map(
        (expression) => expression.expressionName,
      ) ?? [];

    onExpressionsChange?.(modelUrl, expressions);
  }, [modelUrl, onExpressionsChange, vrm]);

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
      ...(animationTransition ? { transition: animationTransition } : {}),
    });
  }, [
    animation,
    animationRequest,
    animationTransition,
    onAnimationComplete,
    play,
    playback,
    stableAnimationUrls,
    stableFallbackAnimationUrls,
  ]);

  const torsoRef = useRef<Torso | null>(null);
  const lastAzimuth = useRef<number | null>(null);
  const gazeRigRef = useRef<GazeRig | null>(null);
  const gazeRef = useRef<GazeState>(createGazeState());
  const excitementRef = useRef<ExcitementState>(createExcitementState());
  const glanceRef = useRef<GlanceState>(createGlanceState());
  // The turn this put on the rig last frame, in three-vrm's angles. What it
  // reports is measured from wherever the head already points, so the previous
  // frame's turn has to be added back to get an absolute one.
  const appliedTurn = useRef({ yaw: 0, pitch: 0 });

  useLayoutEffect(() => {
    torsoRef.current = null;
    gazeRigRef.current = null;
    // Re-framing jumps the camera, and that jump is not an orbit gesture.
    lastAzimuth.current = null;
    if (vrm) onReady?.(vrm.scene);
  }, [onReady, vrm]);

  // three-vrm aims the eyes at an object in the scene, so the gaze needs a
  // real node to move rather than a bare position. It lives in the scene
  // rather than under the model: it is a point in the room the character is
  // looking at, and parenting it to the head would drag it round with the very
  // turn it is meant to cause.
  // three-vrm re-applies the eyes only when the angles it holds change, so a
  // gaze switched off mid-session would leave them fixed where they last
  // looked. Centring them on the way out is what makes the setting reversible.
  useEffect(() => {
    if (!pointerFocus) return;
    const gaze = gazeRef.current;
    const glance = glanceRef.current;
    const excitement = excitementRef.current;
    const turn = appliedTurn.current;
    return () => {
      vrm?.lookAt?.reset();
      // Everything that eases has to be let go of too. Left where it stood,
      // the first frame after switching back on applies the angle held at the
      // moment it went off, and only then eases out of it.
      Object.assign(gaze, createGazeState());
      Object.assign(glance, createGlanceState());
      Object.assign(excitement, createExcitementState());
      turn.yaw = 0;
      turn.pitch = 0;
    };
  }, [pointerFocus, vrm]);

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
        // which at these angles is not visible. readTorso never returns an
        // empty bone list, so the optional chain here is a formality.
        const parent = torso.bones[0]?.node.parent;
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
      }
    }

    let gazed: GazeRig | null = null;
    if (pointerFocus) {
      const rig = (gazeRigRef.current ??= readGazeRig(vrm));
      const gaze = gazeRef.current;
      const lookAt = vrm.lookAt;
      const { camera } = state;

      if (rig && lookAt) {
        rig.head.getWorldPosition(HEAD_WORLD);
        // Which way the face actually points, which is not something to assume:
        // a VRM 0.x rig faces -Z in its own frame, and `rotateVRM0` corrects
        // that by turning the scene above the rig rather than the rig itself.
        // `faceFront` is where three-vrm records the difference.
        lookAt.getLookAtWorldQuaternion(HEAD_ROTATION);
        HEAD_FORWARD.copy(lookAt.faceFront).applyQuaternion(HEAD_ROTATION);
        HEAD_SCREEN.copy(HEAD_WORLD).project(camera);

        // A gesture is the user moving the camera or the window, not pointing
        // at the character. Following the cursor through it would fight the
        // lean the same drag is already producing.
        const watching =
          pointerFocus.havePointer && !pointerFocus.gestureActive;
        const excitement = advanceExcitement(
          excitementRef.current,
          watching
            ? { x: pointerFocus.canvasX, y: pointerFocus.canvasY }
            : null,
          delta,
          DEFAULT_GAZE,
        );

        let target: GazeTarget | null = null;
        if (watching && camera instanceof THREE.PerspectiveCamera) {
          const headX = (HEAD_SCREEN.x * 0.5 + 0.5) * state.size.width;
          const headY = (HEAD_SCREEN.y * -0.5 + 0.5) * state.size.height;
          const dx = pointerFocus.canvasX - headX;
          const dy = pointerFocus.canvasY - headY;

          // The point being looked at sits out by the camera, carried sideways
          // by however far the cursor is from the head on screen. It has to be
          // between the viewer and the character rather than back on the
          // character's own depth: a point level with the head is one the head
          // can only face by turning a right angle, and a cursor resting on
          // the face would be a direction of no length at all. Out here, a
          // cursor on the face asks for a look straight down the lens.
          const distance = camera.position.distanceTo(HEAD_WORLD);
          const perPixel = worldPerPixel(
            distance,
            camera.fov,
            state.size.height,
          );
          const reach =
            perPixel *
            DEFAULT_GAZE.screenGain *
            reachScaleFor(excitement, DEFAULT_GAZE);
          // Off the camera basis, so the cursor keeps meaning the same place
          // on screen however far the user has orbited.
          CAMERA_RIGHT.setFromMatrixColumn(camera.matrixWorld, 0);
          CAMERA_UP.setFromMatrixColumn(camera.matrixWorld, 1);
          CURSOR_WORLD.copy(camera.position)
            .addScaledVector(CAMERA_RIGHT, dx * reach)
            .addScaledVector(CAMERA_UP, -dy * reach);

          // three-vrm works out the angles from the head to a point, which is
          // worth deferring to: it takes in which way the rig faces and
          // whatever the animation has already done to the neck.
          //
          // What it reports is how much further to turn from where the head is
          // pointing now, and the turn this made last frame is still on the
          // raw bones — only the normalized ones are put back after
          // `vrm.update`. Adding that turn back makes the angle an absolute
          // one again. Left as the remainder, easing toward it would chase a
          // target that retreats as the head approaches, settling at
          // `A / (1 + attention * commitment)` — half the asked-for turn at
          // full commitment, and a different fraction for every draw.
          lookAt.lookAt(CURSOR_WORLD);
          const applied = appliedTurn.current;
          target = {
            // In world units, not pixels, so how near the cursor counts as
            // near scales with how large the character is drawn.
            distance: Math.hypot(dx, dy) * perPixel,
            yaw: THREE.MathUtils.DEG2RAD * lookAt.yaw + applied.yaw,
            pitch: THREE.MathUtils.DEG2RAD * lookAt.pitch + applied.pitch,
          };
        } else {
          CURSOR_WORLD.copy(HEAD_WORLD).add(HEAD_FORWARD);
        }
        advanceGaze(gaze, target, delta, DEFAULT_GAZE);

        // The eyes go the rest of the way, re-aimed at a point blended back
        // toward straight ahead by attention. Aiming them at the cursor
        // outright would leave them unable to let go: three-vrm holds the last
        // angle it was handed, so a point simply left behind reads as a stare.
        LOOK_REST.copy(HEAD_WORLD).addScaledVector(
          HEAD_FORWARD,
          HEAD_WORLD.distanceTo(CURSOR_WORLD),
        );
        lookAt.lookAt(LOOK_REST.lerp(CURSOR_WORLD, gaze.attention));

        // How much of this look the head is joining in with. The eyes have
        // already been aimed above and go the whole way regardless.
        const commitment = advanceGlance(
          glanceRef.current,
          gaze.attention,
          delta,
          DEFAULT_GAZE,
        );

        // Recorded in three-vrm's own angles rather than the rig's, since that
        // is what next frame has to add back. The shares sum to one and these
        // angles are small, so the neck and head composing rather than summing
        // is a difference well under the eased step it feeds.
        appliedTurn.current.yaw = 0;
        appliedTurn.current.pitch = 0;

        if (!isGazeAtRest(gaze) && commitment > 1e-3) {
          gazed = rig;
          appliedTurn.current.yaw = gaze.yaw * commitment;
          appliedTurn.current.pitch = gaze.pitch * commitment;
          const turn = rigTurnFor(
            gaze.yaw * commitment,
            gaze.pitch * commitment,
            lookAt.faceFront.z,
          );
          // Tilt first and yaw outermost, the order three-vrm itself uses for
          // a look, and the one that keeps a turned head from also rolling.
          for (const { node, weight, pose } of rig.bones) {
            pose.copy(node.quaternion);
            node.quaternion
              .premultiply(
                GAZE_PITCH.setFromAxisAngle(RIGHT, turn.pitch * weight),
              )
              .premultiply(GAZE_YAW.setFromAxisAngle(UP, turn.yaw * weight));
          }
        }
      }
    }

    // Spring bones simulate against joint world matrices, so the lean and the
    // gaze have to be committed before vrm.update runs them for this frame.
    if (leaned || gazed) vrm.scene.updateMatrixWorld(true);

    vrm.update(delta);

    // `vrm.update` has copied both onto the render skeleton and the springs
    // have answered them, so they are delivered. Take them back off: three-vrm
    // never resets the normalized rig, so a rotation left in place is layered
    // on again every frame a clip is not driving that joint.
    if (leaned) {
      for (const { node, pose } of leaned.bones) node.quaternion.copy(pose);
    }
    if (gazed) {
      for (const { node, pose } of gazed.bones) node.quaternion.copy(pose);
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
