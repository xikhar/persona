import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import {
  ContactShadows,
  Environment,
  OrbitControls,
} from '@react-three/drei';
import dawnEnvironment from '@pmndrs/assets/hdri/dawn.exr';
import * as THREE from 'three';
import { Avatar } from './Avatar';
import type { PlayableAnimationType } from '../animation-catalog';
import { calculateFullBodyFraming } from '../camera-framing';
import { drawingBufferPixel, passthroughForAlpha } from '../click-through';
import type { DragInertiaState } from '../drag-inertia';
import { resolveLightingSettings } from '../settings-defaults';

interface SceneProps {
  animation: PlayableAnimationType;
  animationRequest: number;
  animationUrls?: readonly string[];
  fallbackAnimationUrls?: readonly string[];
  preloadAnimationUrls?: readonly string[];
  expressionName?: PersonaExpressionName | null;
  expressionWeight?: number;
  audioLevel: number;
  bodySpeaking: boolean;
  onExpressionsChange?: (
    modelUrl: string,
    expressions: readonly string[],
  ) => void;
  characterSize: number;
  dragInertia?: DragInertiaState;
  enablePan?: boolean;
  framingMargin?: number;
  groundShadow?: boolean;
  // `null` rather than merely absent: a model with no saved lighting profile is
  // a normal state that a caller reads out of a record and forwards as-is.
  lighting?: PersonaLightingSettings | null;
  modelUrl: string;
  onAnimationComplete: () => void;
  playback: 'loop' | 'once';
  /** Increments to ask the camera to frame the character again. */
  resetRequest?: number;
  speaking: boolean;
  bodyTransitionMs: number;
  speakingDebounceMs: number;
  idleInterimMs: number;
  speakingTransition: PersonaSpeakingTransitionSettings;
  silhouetteHitTest?: boolean;
}

interface TargetControls {
  target: THREE.Vector3;
  update: () => void;
}

interface Grounding {
  far: number;
  position: [number, number, number];
  scale: number;
}

function supportsTarget(controls: unknown): controls is TargetControls {
  if (!controls || typeof controls !== 'object') return false;
  const candidate = controls as Partial<TargetControls>;
  return candidate.target instanceof THREE.Vector3 &&
    typeof candidate.update === 'function';
}

function LightingController({
  lighting,
}: {
  lighting: PersonaLightingSettings;
}) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/immutability
    gl.toneMapping =
      lighting.tone_mapping === 'aces'
        ? THREE.ACESFilmicToneMapping
        : THREE.NoToneMapping;
    gl.toneMappingExposure = lighting.exposure;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    // eslint-disable-next-line react-hooks/immutability
    scene.environmentIntensity = lighting.environment_enabled
      ? lighting.environment_intensity
      : 0;
  }, [
    gl,
    scene,
    lighting.tone_mapping,
    lighting.exposure,
    lighting.environment_enabled,
    lighting.environment_intensity,
  ]);

  return null;
}

function FullBodyCamera({
  characterSize,
  framingMargin,
  object,
  resetRequest,
}: {
  characterSize: number;
  framingMargin: number;
  object: THREE.Object3D | null;
  resetRequest: number;
}) {
  const getThreeState = useThree((state) => state.get);
  const controlsReady = useThree((state) => Boolean(state.controls));
  const framedObject = useRef<THREE.Object3D | null>(null);
  const framedCharacterSize = useRef<number | null>(null);
  const framedMargin = useRef<number | null>(null);
  const framedRequest = useRef(resetRequest);

  useLayoutEffect(() => {
    const { camera, controls } = getThreeState();
    // Nothing the user does to the camera is recorded here, so a framing that
    // matches the last computed one can still be pointing somewhere else.
    const requested = framedRequest.current !== resetRequest;
    if (
      !object ||
      (!requested &&
        framedObject.current === object &&
        framedCharacterSize.current === characterSize &&
        framedMargin.current === framingMargin) ||
      !(camera instanceof THREE.PerspectiveCamera) ||
      !supportsTarget(controls)
    ) {
      return;
    }

    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;

    const framing = calculateFullBodyFraming(
      box,
      camera.fov,
      camera.aspect,
      framingMargin,
      1.5 * characterSize,
    );
    camera.position.copy(framing.position);
    camera.near = Math.max(0.01, framing.distance / 100);
    camera.far = Math.max(100, framing.distance * 100);
    camera.lookAt(framing.target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    controls.target.copy(framing.target);
    controls.update();
    framedObject.current = object;
    framedCharacterSize.current = characterSize;
    framedMargin.current = framingMargin;
    framedRequest.current = resetRequest;
  }, [
    characterSize,
    controlsReady,
    framingMargin,
    getThreeState,
    object,
    resetRequest,
  ]);

  return null;
}

/**
 * Keeps the avatar window click-through everywhere except over the character.
 * While the window ignores the mouse Electron still forwards mousemove, so this
 * samples the alpha the frame already drew under the cursor and hands input
 * back only where the character is actually visible.
 *
 * Alpha rather than a raycast: the rig is ~29k skinned triangles, and three.js
 * transforms every vertex by its bones on the CPU for each cast, which costs
 * far more than a frame. Reading one pixel is independent of model complexity,
 * and is truer to what the user sees, since alpha-cut hair reads as the
 * background it looks like instead of as the quad it is drawn on.
 */
function PassthroughController({ enabled }: { enabled: boolean }) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    const bridge = window.personaBridge;
    if (!bridge?.setMousePassthrough) return;

    // Say nothing until the main process reports the mode, so a renderer that
    // has not heard yet cannot contradict the flags the window already has.
    if (!enabled) return;

    const canvas = gl.domElement;
    const context = gl.getContext();
    const sample = new Uint8Array(4);
    let passthrough = true;
    // Only a press this window received. A button held from a gesture that
    // began on the desktop is still forwarded here while the window ignores the
    // mouse, and must not make the window grab what it started on.
    let gestureActive = false;
    let clientX = 0;
    let clientY = 0;
    // Nothing is decided until a real cursor position has arrived. Sampling
    // every frame would otherwise answer for the seeded origin, and whether
    // that corner happens to be transparent is a fact about the current
    // framing rather than anything the mode can rely on.
    let havePointer = false;

    const apply = (next: boolean) => {
      if (next === passthrough) return;
      passthrough = next;
      bridge.setMousePassthrough(next);
    };

    // The drawing buffer only holds this frame's pixels until it is handed to
    // the compositor, so the sample has to be taken inside the render rather
    // than from the event that asked for it.
    //
    // Every presented frame is sampled, not only the ones a pointer event asked
    // for. The character keeps moving under a cursor that is standing still, so
    // an answer left over from a frame the idle animation has since walked away
    // from sends the click to the wrong window: through a character that has
    // swayed under the cursor, or into the avatar from a gap it has left. A
    // measured run showed the read costing 1.6-4.5ms of waiting on the GPU
    // without moving frame times off 60Hz at all, because that wait replaces
    // the one the frame would otherwise spend at vsync.
    const previous = scene.onAfterRender;
    // eslint-disable-next-line react-hooks/immutability
    scene.onAfterRender = function afterRender(...args) {
      previous.apply(this, args);
      // A render into an offscreen target is not the frame the user sees.
      if (gl.getRenderTarget() !== null) return;
      // A gesture keeps the window regardless of what is under the cursor, so
      // the answer is known without the pixel. Reading it anyway would stall
      // the pipeline once per frame of a drag, which is the motion that most
      // needs the frames.
      if (gestureActive) {
        apply(false);
        return;
      }
      // The window is already ignoring when the mode turns on, so leaving the
      // main process's flags standing is the right answer until the first
      // forwarded move says where the cursor actually is.
      if (!havePointer) return;
      const pixel = drawingBufferPixel(
        canvas.getBoundingClientRect(),
        { width: canvas.width, height: canvas.height },
        clientX,
        clientY,
      );
      if (!pixel) {
        // The cursor is outside the canvas and there is no pixel to read out
        // there. Nothing outside it is ever drawn, so decide rather than leave
        // the last decision standing.
        apply(true);
        return;
      }
      context.readPixels(
        pixel.x,
        pixel.y,
        1,
        1,
        context.RGBA,
        context.UNSIGNED_BYTE,
        sample,
      );
      apply(passthroughForAlpha({ alpha: sample[3] ?? 0, gestureActive }));
    };

    // Pointer events, not mouse events: useWindowDrag cancels `pointerdown` for
    // Alt+drag, which suppresses the compatibility mouse events afterwards, and
    // the cursor position would then freeze until an unrelated click revived
    // it. Captured on window so the same hook's stopPropagation cannot hide
    // them either.
    const onPointerDown = () => {
      gestureActive = true;
      apply(false);
    };
    // A release can land outside the window with no pointerup ever arriving,
    // the hazard useWindowDrag documents, so the button mask ends the gesture
    // too rather than trusting the release alone.
    const onPointerMove = (event: PointerEvent) => {
      clientX = event.clientX;
      clientY = event.clientY;
      havePointer = true;
      if (event.buttons === 0) gestureActive = false;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.buttons === 0) gestureActive = false;
    };
    // A cancelled pointer never reports a release: a compositor gesture
    // takeover or a lifted touch contact leaves no `pointerup`, and for touch
    // no further `pointermove` either. A gesture cleared only by those two
    // would stay active forever, pinning the whole window interactive with the
    // tray toggle as the only way out.
    const onPointerCancel = () => {
      gestureActive = false;
    };

    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('pointermove', onPointerMove, { capture: true });
    window.addEventListener('pointerup', onPointerUp, { capture: true });
    window.addEventListener('pointercancel', onPointerCancel, {
      capture: true,
    });
    // Match the window's initial ignoring state set by the main process.
    bridge.setMousePassthrough(true);

    return () => {
      scene.onAfterRender = previous;
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointermove', onPointerMove, { capture: true });
      window.removeEventListener('pointerup', onPointerUp, { capture: true });
      window.removeEventListener('pointercancel', onPointerCancel, {
        capture: true,
      });
      // Leave the window interactive so a later mount is never stuck ignoring.
      bridge.setMousePassthrough(false);
    };
  }, [enabled, gl, scene]);

  return null;
}

export function Scene(props: SceneProps) {
  const lighting = resolveLightingSettings(props.lighting);
  const [avatarScene, setAvatarScene] = useState<THREE.Object3D | null>(null);
  const [grounding, setGrounding] = useState<Grounding | null>(null);
  const handleAvatarReady = useCallback((scene: THREE.Object3D) => {
    setAvatarScene(scene);
    scene.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(scene);
    if (box.isEmpty()) {
      setGrounding(null);
      return;
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    setGrounding({
      far: Math.max(size.y, 1),
      position: [center.x, box.min.y + 0.005, center.z],
      scale: Math.max(size.x, size.z, 0.8) * 1.8,
    });
  }, []);

  return (
    <Canvas
      camera={{ position: [0, 2, 4.8], fov: 20 }}
      dpr={[1, 1.5]}
      gl={{
        antialias: true,
        alpha: true,
        toneMapping: lighting.tone_mapping === 'aces'
          ? THREE.ACESFilmicToneMapping
          : THREE.NoToneMapping,
        toneMappingExposure: lighting.exposure,
        outputColorSpace: THREE.SRGBColorSpace,
      }}
      style={{ background: 'transparent' }}
    >
      <LightingController lighting={lighting} />
      <directionalLight
        color={[1, 1, 1]}
        position={[-3, 3, 3]}
        intensity={lighting.key_light_intensity}
      />
      <ambientLight
        color={[
          0.0036765073221525194,
          0.0036765073221525194,
          0.0036765073221525194,
        ]}
        intensity={lighting.ambient_intensity}
      />
      {lighting.environment_enabled && (
        <Environment files={dawnEnvironment} />
      )}
      <FullBodyCamera
        characterSize={props.characterSize}
        framingMargin={props.framingMargin ?? 1.12}
        object={avatarScene}
        resetRequest={props.resetRequest ?? 0}
      />
      <Avatar {...props} onReady={handleAvatarReady} />
      <PassthroughController enabled={props.silhouetteHitTest ?? false} />
      {props.groundShadow && grounding && (
        <ContactShadows
          blur={2.4}
          color="#050506"
          far={grounding.far}
          frames={1}
          key={`${props.modelUrl}-ground-shadow`}
          opacity={0.42}
          position={grounding.position}
          resolution={256}
          scale={grounding.scale}
        />
      )}
      {/* The full-body framing at the 0.4 size floor sits ~12.3 units out
          for the packaged models in a default 430x680 window; 14 keeps the
          orbit clamp from swallowing the smallest size. */}
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        enablePan={props.enablePan ?? true}
        enableZoom
        minDistance={1.4}
        maxDistance={14}
        panSpeed={0.7}
        rotateSpeed={0.45}
        screenSpacePanning
        zoomSpeed={0.8}
      />
    </Canvas>
  );
}
