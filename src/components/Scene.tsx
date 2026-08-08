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
import type { DragInertiaState } from '../drag-inertia';
import { resolveLightingSettings } from '../settings-defaults';

interface SceneProps {
  animation: PlayableAnimationType;
  animationRequest: number;
  animationUrls?: readonly string[];
  fallbackAnimationUrls?: readonly string[];
  preloadAnimationUrls?: readonly string[];
  audioLevel: number;
  bodySpeaking: boolean;
  characterSize: number;
  dragInertia?: DragInertiaState;
  enablePan?: boolean;
  framingMargin?: number;
  groundShadow?: boolean;
  lighting?: PersonaLightingSettings;
  modelUrl: string;
  onAnimationComplete: () => void;
  playback: 'loop' | 'once';
  speaking: boolean;
  bodyTransitionMs: number;
  speakingDebounceMs: number;
  idleInterimMs: number;
  speakingTransition: PersonaSpeakingTransitionSettings;
  clickThrough?: boolean;
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
}: {
  characterSize: number;
  framingMargin: number;
  object: THREE.Object3D | null;
}) {
  const getThreeState = useThree((state) => state.get);
  const controlsReady = useThree((state) => Boolean(state.controls));
  const framedObject = useRef<THREE.Object3D | null>(null);
  const framedCharacterSize = useRef<number | null>(null);
  const framedMargin = useRef<number | null>(null);

  useLayoutEffect(() => {
    const { camera, controls } = getThreeState();
    if (
      !object ||
      (framedObject.current === object &&
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
  }, [characterSize, controlsReady, framingMargin, getThreeState, object]);

  return null;
}

/**
 * Drives the avatar window's click-through so it floats over the desktop like a
 * desktop pet: the window ignores the mouse everywhere except over the
 * character. While the window is ignoring input, Electron still forwards
 * mousemove (setIgnoreMouseEvents(true, { forward: true })), so this raycasts
 * the cursor against the character silhouette each move and re-enables input
 * only while the cursor is over an actual mesh — transparent gaps stay
 * click-through. A held button never flips to passthrough mid-orbit/drag.
 */
function PassthroughController({
  enabled,
  object,
}: {
  enabled: boolean;
  object: THREE.Object3D | null;
}) {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    const bridge = window.personaBridge;
    if (!bridge?.setMousePassthrough) return;

    if (!enabled) {
      // Locked to interactive: the whole window takes the mouse.
      bridge.setMousePassthrough(false);
      return;
    }

    const canvas = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let passthrough = true;
    let buttonDown = false;
    let clientX = 0;
    let clientY = 0;
    let frame = 0;
    let scheduled = false;

    const apply = (next: boolean) => {
      if (next === passthrough) return;
      passthrough = next;
      bridge.setMousePassthrough(next);
    };

    const hitTest = () => {
      scheduled = false;
      if (buttonDown) {
        apply(false);
        return;
      }
      if (!object) {
        apply(true);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      apply(raycaster.intersectObject(object, true).length === 0);
    };

    const onMove = (event: MouseEvent) => {
      clientX = event.clientX;
      clientY = event.clientY;
      if (!scheduled) {
        scheduled = true;
        frame = requestAnimationFrame(hitTest);
      }
    };
    const onDown = () => {
      buttonDown = true;
      apply(false);
    };
    const onUp = () => {
      buttonDown = false;
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mousedown', onDown, { capture: true });
    window.addEventListener('mouseup', onUp, { capture: true });
    // Match the window's initial ignoring state set by the main process.
    bridge.setMousePassthrough(true);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mousedown', onDown, { capture: true });
      window.removeEventListener('mouseup', onUp, { capture: true });
      // Leave the window interactive so a later mount is never stuck ignoring.
      bridge.setMousePassthrough(false);
    };
  }, [camera, enabled, gl, object]);

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
      />
      <Avatar {...props} onReady={handleAvatarReady} />
      <PassthroughController
        enabled={props.clickThrough ?? true}
        object={avatarScene}
      />
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
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        enablePan={props.enablePan ?? true}
        enableZoom
        minDistance={1.4}
        maxDistance={12}
        panSpeed={0.7}
        rotateSpeed={0.45}
        screenSpacePanning
        zoomSpeed={0.8}
      />
    </Canvas>
  );
}
