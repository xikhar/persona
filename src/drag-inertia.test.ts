import { describe, expect, it } from 'vitest';
import {
  advanceDragInertia,
  applyPendingDrag,
  createDragInertiaState,
  DEFAULT_DRAG_INERTIA,
  applyPendingOrbit,
  cameraAzimuth,
  isDragInertiaAtRest,
  leanWeightsFor,
  MAX_ORBIT_SWEEP_PER_FRAME,
  orbitSweep,
  queueDragPixels,
  queueOrbitRadians,
  torsoLeanAngle,
  worldPerPixel,
} from './drag-inertia';

const WORLD_PER_PIXEL = 0.004;

function settle(state: ReturnType<typeof createDragInertiaState>) {
  for (let frame = 0; frame < 600; frame += 1) {
    advanceDragInertia(state, 1 / 60);
    if (isDragInertiaAtRest(state)) return frame;
  }
  return -1;
}

describe('cameraAzimuth', () => {
  it('ignores a pan, which moves camera and target together', () => {
    const before = cameraAzimuth(0, 4, 0, 0);
    const after = cameraAzimuth(1.5, 4.5, 1.5, 0.5);
    expect(after).toBeCloseTo(before);
  });

  it('follows the camera swinging around a fixed target', () => {
    expect(cameraAzimuth(0, 4, 0, 0)).toBeCloseTo(0);
    expect(cameraAzimuth(4, 0, 0, 0)).toBeCloseTo(Math.PI / 2);
  });
});

describe('orbitSweep', () => {
  it('reports the signed delta of an ordinary gesture', () => {
    expect(orbitSweep(0.2, 0.35)).toBeCloseTo(0.15);
    expect(orbitSweep(0.35, 0.2)).toBeCloseTo(-0.15);
  });

  it('takes the short way across the -pi/pi seam', () => {
    expect(orbitSweep(Math.PI - 0.05, -Math.PI + 0.05)).toBeCloseTo(0.1);
  });

  it('discards a camera jump too large to be a hand gesture', () => {
    // Re-framing after a character-size change snaps the camera to the front.
    // That is not the user spinning the view.
    expect(orbitSweep(1.5, 0)).toBe(0);
    expect(orbitSweep(0, MAX_ORBIT_SWEEP_PER_FRAME + 0.01)).toBe(0);
    expect(orbitSweep(0, MAX_ORBIT_SWEEP_PER_FRAME - 0.01)).not.toBe(0);
  });

  it('treats a non-finite azimuth as no sweep', () => {
    expect(orbitSweep(Number.NaN, 0.2)).toBe(0);
    expect(orbitSweep(0.2, Number.NaN)).toBe(0);
  });
});

describe('torsoLeanAngle', () => {
  it('tips further the further the body has to trail', () => {
    expect(torsoLeanAngle(0, 0.6)).toBe(0);
    expect(torsoLeanAngle(0.1, 0.6)).toBeGreaterThan(0);
    expect(torsoLeanAngle(0.2, 0.6)).toBeGreaterThan(torsoLeanAngle(0.1, 0.6));
  });

  it('leans a short torso and a long one by a comparable amount', () => {
    // Same lag as a fraction of the torso, so the visual answer matches even
    // though a chibi model is half the height of a tall one.
    expect(torsoLeanAngle(0.15, 0.3)).toBeCloseTo(torsoLeanAngle(0.3, 0.6));
  });

  it('saturates rather than growing without bound', () => {
    expect(torsoLeanAngle(1e6, 0.6)).toBeLessThan(Math.PI / 2);
  });

  it('keeps sign, so the body trails whichever way the drag went', () => {
    expect(torsoLeanAngle(-0.2, 0.6)).toBeCloseTo(-torsoLeanAngle(0.2, 0.6));
  });

  it('returns zero for a rig with no measurable torso', () => {
    expect(torsoLeanAngle(0.2, 0)).toBe(0);
    expect(torsoLeanAngle(Number.NaN, 0.6)).toBe(0);
  });
});

describe('leanWeightsFor', () => {
  const ALL = ['upperChest', 'chest', 'spine'];

  it('always sums to one, so the lean angle is the angle asked for', () => {
    for (const present of [ALL, ['chest', 'spine'], ['spine'], ['upperChest']]) {
      const total = leanWeightsFor(present).reduce((s, [, w]) => s + w, 0);
      expect(total).toBeCloseTo(1);
    }
  });

  it('puts most of the lean on the highest joint', () => {
    const [top, ...rest] = leanWeightsFor(ALL);
    expect(top[0]).toBe('upperChest');
    // Rigid props hang off the chest, below this joint, and get thrown when
    // the lean is shared out evenly.
    for (const [, weight] of rest) expect(weight).toBeLessThan(top[1]);
    expect(top[1]).toBeGreaterThan(0.5);
  });

  it('descends down the chain', () => {
    const weights = leanWeightsFor(ALL).map(([, w]) => w);
    for (let i = 1; i < weights.length; i += 1) {
      expect(weights[i]).toBeLessThanOrEqual(weights[i - 1]);
    }
  });

  it('leans by the full angle on a rig missing the upper joints', () => {
    expect(leanWeightsFor(['spine'])).toEqual([['spine', 1]]);
  });

  it('returns nothing for a rig with no torso at all', () => {
    expect(leanWeightsFor([])).toEqual([]);
    expect(leanWeightsFor(['head'])).toEqual([]);
  });
});

describe('worldPerPixel', () => {
  it('scales with distance so the feel survives zooming', () => {
    expect(worldPerPixel(4, 20, 680)).toBeCloseTo(worldPerPixel(2, 20, 680) * 2);
  });

  it('shrinks as the viewport gains pixels', () => {
    expect(worldPerPixel(2, 20, 1360)).toBeCloseTo(
      worldPerPixel(2, 20, 680) / 2,
    );
  });

  it('returns zero rather than infinity for a degenerate viewport', () => {
    expect(worldPerPixel(2, 20, 0)).toBe(0);
    expect(worldPerPixel(0, 20, 680)).toBe(0);
  });
});

describe('drag inertia', () => {
  it('starts at rest and stays there without a drag', () => {
    const state = createDragInertiaState();
    expect(isDragInertiaAtRest(state)).toBe(true);
    advanceDragInertia(state, 1 / 60);
    expect(isDragInertiaAtRest(state)).toBe(true);
  });

  it('lags opposite the drag, flipping screen Y into camera up', () => {
    const state = createDragInertiaState();
    queueDragPixels(state, 100, 40);
    applyPendingDrag(state, WORLD_PER_PIXEL);

    // Window moved right and down, so the body trails left and up.
    expect(state.x).toBeCloseTo(-100 * WORLD_PER_PIXEL * DEFAULT_DRAG_INERTIA.gain);
    expect(state.y).toBeCloseTo(40 * WORLD_PER_PIXEL * DEFAULT_DRAG_INERTIA.gain);
  });

  it('accumulates the same lag regardless of how the drag is split up', () => {
    const oneEvent = createDragInertiaState();
    queueDragPixels(oneEvent, 60, 0);
    applyPendingDrag(oneEvent, WORLD_PER_PIXEL);

    const manyEvents = createDragInertiaState();
    for (let i = 0; i < 6; i += 1) {
      queueDragPixels(manyEvents, 10, 0);
      applyPendingDrag(manyEvents, WORLD_PER_PIXEL);
    }

    expect(manyEvents.x).toBeCloseTo(oneEvent.x);
  });

  it('drains pending pixels so one drag is never applied twice', () => {
    const state = createDragInertiaState();
    queueDragPixels(state, 100, 0);
    applyPendingDrag(state, WORLD_PER_PIXEL);
    const afterFirst = state.x;
    applyPendingDrag(state, WORLD_PER_PIXEL);
    expect(state.x).toBe(afterFirst);
  });

  it('clamps a fast fling to the configured maximum lag', () => {
    const state = createDragInertiaState();
    queueDragPixels(state, 100000, -100000);
    applyPendingDrag(state, WORLD_PER_PIXEL);

    expect(state.x).toBeCloseTo(-DEFAULT_DRAG_INERTIA.maxOffset);
    expect(state.y).toBeCloseTo(-DEFAULT_DRAG_INERTIA.maxOffset);
  });

  it('overshoots through rest before settling, so the body visibly wobbles', () => {
    const state = createDragInertiaState();
    queueDragPixels(state, 100, 0);
    applyPendingDrag(state, WORLD_PER_PIXEL);
    const start = state.x;
    expect(start).toBeLessThan(0);

    let overshoot = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      advanceDragInertia(state, 1 / 60);
      overshoot = Math.max(overshoot, state.x);
    }
    expect(overshoot).toBeGreaterThan(0);
    expect(overshoot).toBeLessThan(Math.abs(start));
  });

  it('returns to exact rest within about a second', () => {
    const state = createDragInertiaState();
    queueDragPixels(state, 120, 80);
    applyPendingDrag(state, WORLD_PER_PIXEL);

    const frames = settle(state);
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThan(120);
    expect(state.x).toBe(0);
    expect(state.y).toBe(0);
  });

  it('stays bounded when a long frame hitch is integrated', () => {
    const state = createDragInertiaState();
    queueDragPixels(state, 100, 0);
    applyPendingDrag(state, WORLD_PER_PIXEL);

    advanceDragInertia(state, 5);
    expect(Number.isFinite(state.x)).toBe(true);
    expect(Math.abs(state.x)).toBeLessThanOrEqual(DEFAULT_DRAG_INERTIA.maxOffset);
  });

  it('twists opposite an orbit sweep and unwinds to the original facing', () => {
    const state = createDragInertiaState();
    queueOrbitRadians(state, 0.1);
    applyPendingOrbit(state);
    expect(state.yaw).toBeCloseTo(-0.1 * DEFAULT_DRAG_INERTIA.yawGain);

    expect(settle(state)).toBeGreaterThan(0);
    // Facing must return exactly, or orbiting would slowly rotate the model.
    expect(state.yaw).toBe(0);
  });

  it('clamps a long orbit sweep to the configured maximum twist', () => {
    const state = createDragInertiaState();
    for (let i = 0; i < 40; i += 1) {
      queueOrbitRadians(state, 0.5);
      applyPendingOrbit(state);
    }
    expect(state.yaw).toBeCloseTo(-DEFAULT_DRAG_INERTIA.maxYaw);
  });

  it('holds a visible twist while an orbit gesture is sustained', () => {
    // A steady drag: about 2 rad/s for a second, at 60fps. The spring eats
    // the lag as fast as the sweep adds it, so this settles at an equilibrium
    // rather than accumulating. That equilibrium is what has to be visible;
    // at a low gain it collapsed to a degree or two and read as nothing.
    const state = createDragInertiaState();
    let smallest = Infinity;
    for (let frame = 0; frame < 60; frame += 1) {
      queueOrbitRadians(state, 2 / 60);
      applyPendingOrbit(state);
      advanceDragInertia(state, 1 / 60);
      if (frame > 10) smallest = Math.min(smallest, Math.abs(state.yaw));
    }
    expect(smallest).toBeGreaterThan(0.1);
  });

  it('reports rest only when the twist has settled too', () => {
    const state = createDragInertiaState();
    queueOrbitRadians(state, 0.5);
    applyPendingOrbit(state);
    expect(isDragInertiaAtRest(state)).toBe(false);
  });

  it('ignores non-finite input rather than poisoning the spring', () => {
    const state = createDragInertiaState();
    queueDragPixels(state, Number.NaN, 10);
    applyPendingDrag(state, WORLD_PER_PIXEL);
    expect(state.x).toBe(0);
    expect(state.y).toBe(0);

    queueDragPixels(state, 100, 0);
    applyPendingDrag(state, Number.NaN);
    expect(state.x).toBe(0);
    expect(state.pendingX).toBe(0);

    advanceDragInertia(state, Number.NaN);
    expect(isDragInertiaAtRest(state)).toBe(true);
  });
});
