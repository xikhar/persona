/**
 * Secondary motion for window drags and camera orbits.
 *
 * Orbit controls move the camera and Alt+drag moves the window. Neither moves
 * the character, so its spring bones have no acceleration to react to and the
 * model stays rigid exactly when the user is handling it. This turns both
 * gestures into a transient lag that the existing three-vrm spring simulation
 * answers; nothing here simulates hair or cloth itself.
 *
 * The lag is delivered as a lean of the torso rather than a move of the model
 * root, because a VRM spring may declare a `center` node and is then blind to
 * any motion of that node — moving the root is cancelled outright by the two
 * common conventions, a center on the scene root (what VRoid writes) and a
 * center on the hips. Leaning the spine moves the joints relative to every
 * such center, since the rotation happens below all of them.
 *
 * A rotation cannot reproduce a vertical lag, so a purely up-and-down gesture
 * leans less than a sideways one. The horizontal component carries the effect.
 */

export interface DragInertiaSettings {
  /** Fraction of the drag distance the body lags behind the window. */
  gain: number;
  /** Spring constant pulling the body back to rest. */
  stiffness: number;
  /** Velocity damping; below 2*sqrt(stiffness) the body overshoots. */
  damping: number;
  /** Maximum lag in world units, so a fast drag cannot fling the model away. */
  maxOffset: number;
  /** Fraction of an orbit sweep the body twists before catching up. */
  yawGain: number;
  /** Maximum twist in radians. */
  maxYaw: number;
}

export const DEFAULT_DRAG_INERTIA: DragInertiaSettings = {
  gain: 0.35,
  stiffness: 120,
  damping: 14,
  maxOffset: 0.25,
  // A sustained gesture settles at roughly
  //   rate * gain * damping / stiffness
  // because the spring eats the lag as fast as the gesture adds it. Orbiting
  // sweeps a couple of radians per second at most, an order of magnitude less
  // than a window drag covers in world units, so the angular gain has to be
  // correspondingly larger to land in the same visible range.
  yawGain: 1.0,
  maxYaw: 0.3,
};

export interface DragInertiaState {
  /**
   * Current offset of the model root from its rest position, along the
   * camera's right and up axes. Screen-relative rather than world-relative
   * because the gesture that drives it is: a drag to the right of the screen
   * has to lag the body to the left of the screen whatever way the camera
   * happens to be facing. The caller maps these onto the camera basis.
   */
  x: number;
  y: number;
  /** Offset velocity, in world units per second. */
  vx: number;
  vy: number;
  /** Current twist of the model root about the vertical axis, in radians. */
  yaw: number;
  vyaw: number;
  /** Drag pixels recorded since the last frame drained them. */
  pendingX: number;
  pendingY: number;
  /** Orbit sweep in radians recorded since the last frame drained it. */
  pendingYaw: number;
}

export function createDragInertiaState(): DragInertiaState {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    yaw: 0,
    vyaw: 0,
    pendingX: 0,
    pendingY: 0,
    pendingYaw: 0,
  };
}

/**
 * Records a drag in screen pixels. The render loop owns the pixel-to-world
 * conversion because only it knows the current camera distance, so drags are
 * buffered here rather than applied immediately.
 */
export function queueDragPixels(
  state: DragInertiaState,
  dxPixels: number,
  dyPixels: number,
): void {
  if (!Number.isFinite(dxPixels) || !Number.isFinite(dyPixels)) return;
  state.pendingX += dxPixels;
  state.pendingY += dyPixels;
}

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

/**
 * Angle of the camera around the vertical axis through what it is looking at.
 * Measured against the orbit target rather than the model, so panning — which
 * translates camera and target together — does not read as a rotation.
 */
export function cameraAzimuth(
  cameraX: number,
  cameraZ: number,
  targetX: number,
  targetZ: number,
): number {
  return Math.atan2(cameraX - targetX, cameraZ - targetZ);
}

/**
 * A hand gesture cannot sweep more than this in one frame. Anything larger is
 * the camera being repositioned in code -- re-framing after a character-size
 * change snaps it back to the front, for one -- and must not be mistaken for
 * the user spinning the view.
 */
export const MAX_ORBIT_SWEEP_PER_FRAME = 0.5;

/**
 * Signed sweep between two azimuths, the shortest way round so crossing the
 * -pi/pi seam is not a spin. Returns 0 for a jump too large to be a gesture.
 */
export function orbitSweep(
  previousAzimuth: number,
  azimuth: number,
  maxSweep: number = MAX_ORBIT_SWEEP_PER_FRAME,
): number {
  if (!Number.isFinite(previousAzimuth) || !Number.isFinite(azimuth)) return 0;
  let sweep = azimuth - previousAzimuth;
  if (sweep > Math.PI) sweep -= 2 * Math.PI;
  else if (sweep < -Math.PI) sweep += 2 * Math.PI;
  return Math.abs(sweep) > maxSweep ? 0 : sweep;
}

/**
 * World distance spanned by one screen pixel at the subject's depth, so a drag
 * lags the body by the distance it actually travelled rather than by a
 * resolution- or zoom-dependent guess.
 */
export function worldPerPixel(
  distance: number,
  verticalFovDegrees: number,
  viewportHeightPixels: number,
): number {
  if (!(viewportHeightPixels > 0) || !(distance > 0)) return 0;
  const halfFov = (verticalFovDegrees * Math.PI) / 360;
  return (2 * distance * Math.tan(halfFov)) / viewportHeightPixels;
}

/**
 * Angle to tip the torso by so its top trails the gesture by `lagDistance`.
 * Saturates instead of growing without bound, so a long torso and a short one
 * lean by a comparable amount for the same drag.
 */
export function torsoLeanAngle(
  lagDistance: number,
  torsoLength: number,
): number {
  if (!Number.isFinite(lagDistance) || !(torsoLength > 0)) return 0;
  return Math.atan(lagDistance / torsoLength);
}

/**
 * How the lean is shared out along the torso, top heavy on purpose.
 *
 * Rigid props are mounted low, on the chest, and a rig may carry very long
 * ones. Sharing the lean evenly swung a pair of wings by 21cm, which reads as
 * the wings being thrown rather than the body moving. Sparing them entirely
 * is just as wrong, since a body that leans should carry what is strapped to
 * it. Weighting the top joint leaves the wings a 5cm follow. The spring
 * response is the same either way: hair hangs off the head and the chest
 * chain off the upper chest, both above every joint here.
 */
export const TORSO_LEAN_WEIGHTS: readonly (readonly [string, number])[] = [
  ['upperChest', 0.85],
  ['chest', 0.1],
  ['spine', 0.05],
];

/**
 * Picks the weights for the torso bones a rig actually has and rescales them
 * to sum to one, so a rig missing the upper chest still leans by the full
 * angle rather than a fraction of it.
 */
export function leanWeightsFor(
  present: readonly string[],
): readonly (readonly [string, number])[] {
  const found = TORSO_LEAN_WEIGHTS.filter(([name]) => present.includes(name));
  const total = found.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return [];
  return found.map(([name, weight]) => [name, weight / total] as const);
}

/**
 * Records an orbit sweep in radians. Orbiting moves the camera rather than
 * the character, so on its own it gives the spring bones nothing to react to.
 * The body answers with a brief twist that unwinds back to zero, which leaves
 * the character's facing unchanged once it settles.
 */
export function queueOrbitRadians(
  state: DragInertiaState,
  deltaRadians: number,
): void {
  if (!Number.isFinite(deltaRadians)) return;
  state.pendingYaw += deltaRadians;
}

export function applyPendingOrbit(
  state: DragInertiaState,
  settings: DragInertiaSettings = DEFAULT_DRAG_INERTIA,
): void {
  const { pendingYaw } = state;
  state.pendingYaw = 0;
  if (pendingYaw === 0) return;
  state.yaw = clamp(state.yaw - pendingYaw * settings.yawGain, settings.maxYaw);
}

/**
 * Applies buffered drag pixels as a lag offset. `worldPerPixel` converts
 * screen distance to world distance at the model's current depth. Screen Y
 * grows downward and the camera's up axis grows upward, so the vertical axis
 * is flipped here rather than at every call site.
 */
export function applyPendingDrag(
  state: DragInertiaState,
  worldPerPixel: number,
  settings: DragInertiaSettings = DEFAULT_DRAG_INERTIA,
): void {
  const { pendingX, pendingY } = state;
  state.pendingX = 0;
  state.pendingY = 0;
  if (!Number.isFinite(worldPerPixel) || worldPerPixel <= 0) return;
  if (pendingX === 0 && pendingY === 0) return;

  const lagX = -pendingX * worldPerPixel * settings.gain;
  const lagY = pendingY * worldPerPixel * settings.gain;
  state.x = clamp(state.x + lagX, settings.maxOffset);
  state.y = clamp(state.y + lagY, settings.maxOffset);
}

const MAX_STEP_SECONDS = 1 / 120;
const MAX_FRAME_SECONDS = 0.1;
const REST_EPSILON = 1e-5;

/**
 * Advances the spring toward rest. Long frames are split into fixed substeps
 * so a hitch cannot make the explicit integrator blow up.
 */
export function advanceDragInertia(
  state: DragInertiaState,
  deltaSeconds: number,
  settings: DragInertiaSettings = DEFAULT_DRAG_INERTIA,
): void {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
  if (isDragInertiaAtRest(state)) return;

  let remaining = Math.min(deltaSeconds, MAX_FRAME_SECONDS);
  while (remaining > 0) {
    const step = Math.min(MAX_STEP_SECONDS, remaining);
    remaining -= step;
    state.vx += (-settings.stiffness * state.x - settings.damping * state.vx) * step;
    state.vy += (-settings.stiffness * state.y - settings.damping * state.vy) * step;
    state.vyaw +=
      (-settings.stiffness * state.yaw - settings.damping * state.vyaw) * step;
    state.x += state.vx * step;
    state.y += state.vy * step;
    state.yaw += state.vyaw * step;
  }

  // Snap to exact rest so an idle avatar stops writing to its transform.
  if (
    Math.abs(state.x) < REST_EPSILON &&
    Math.abs(state.y) < REST_EPSILON &&
    Math.abs(state.yaw) < REST_EPSILON &&
    Math.abs(state.vx) < REST_EPSILON &&
    Math.abs(state.vy) < REST_EPSILON &&
    Math.abs(state.vyaw) < REST_EPSILON
  ) {
    state.x = 0;
    state.y = 0;
    state.yaw = 0;
    state.vx = 0;
    state.vy = 0;
    state.vyaw = 0;
  }
}

export function isDragInertiaAtRest(state: DragInertiaState): boolean {
  return (
    state.x === 0 &&
    state.y === 0 &&
    state.yaw === 0 &&
    state.vx === 0 &&
    state.vy === 0 &&
    state.vyaw === 0
  );
}
