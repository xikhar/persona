import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioActivityGate } from './audio-activity-gate.cjs';
import type { AudioActivity } from './audio-activity-gate.cjs';

test("holds body speech across short pauses and releases after sustained silence", async () => {
  const activities: AudioActivity[] = [];
  const levels: number[] = [];
  const gate = new AudioActivityGate({
    onActivity: (activity) => activities.push(activity),
    onLevel: (level) => levels.push(level),
    speechReleaseMs: 30,
  });

  gate.handleLevel(0.2);
  gate.handleLevel(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  gate.handleLevel(0.3);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(activities, ["speaking"]);

  gate.handleLevel(0);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(activities, ["speaking", "listening"]);
  assert.equal(levels.at(-1), 0);
});

test("reset cancels a pending release transition", async () => {
  const activities: AudioActivity[] = [];
  const gate = new AudioActivityGate({
    onActivity: (activity) => activities.push(activity),
    speechReleaseMs: 15,
  });
  gate.handleLevel(0.3);
  gate.handleLevel(0);
  gate.reset();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(activities, ["speaking"]);
});
