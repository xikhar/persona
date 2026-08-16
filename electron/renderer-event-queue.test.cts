import assert from 'node:assert/strict';
import test from 'node:test';
import {
  drainRendererEventsForLoad,
  PendingRendererEvents,
  pendingRendererEventKey,
} from './renderer-event-queue.cjs';

const hold = (expressionName: string, expressionWeight = 1) =>
  ({ type: 'expression-hold', expressionName, expressionWeight }) as const;
const release = { type: 'expression-release' } as const;

test('expression hold and release share one slot', () => {
  assert.equal(pendingRendererEventKey(hold('embarrassed')), 'expression');
  assert.equal(pendingRendererEventKey(release), 'expression');
  assert.equal(
    pendingRendererEventKey({ type: 'audio-level', level: 0.5 }),
    'audio-level',
  );
});

test('a hold/release/hold burst replays as the latest intent', () => {
  const queue = new PendingRendererEvents();
  queue.add(hold('embarrassed'));
  queue.add(release);
  queue.add(hold('happy', 0.8));

  // Keyed by event type this drained as [hold happy, release] — the release
  // kept the position it was first inserted at and undid the second hold.
  assert.deepEqual(queue.drain(), [hold('happy', 0.8)]);
});

test('a release after a hold replays as released', () => {
  const queue = new PendingRendererEvents();

  queue.add(hold('embarrassed'));
  queue.add(release);
  assert.deepEqual(queue.drain(), [release]);
});

test('other event types keep their own slots and insertion order', () => {
  const queue = new PendingRendererEvents();
  const speaking = {
    type: 'state',
    state: {
      activity: 'speaking',
      microphoneMuted: false,
      outputMuted: false,
      phase: 'active',
    },
  } as const;

  queue.add({ type: 'audio-level', level: 0.1 });
  queue.add(hold('embarrassed'));
  queue.add(speaking);
  queue.add({ type: 'audio-level', level: 0.9 });
  assert.deepEqual(queue.drain(), [
    { type: 'audio-level', level: 0.9 },
    hold('embarrassed'),
    speaking,
  ]);
});

test('draining and clearing empty the queue', () => {
  const queue = new PendingRendererEvents();

  queue.add(hold('embarrassed'));
  assert.equal(queue.drain().length, 1);
  assert.deepEqual(queue.drain(), []);

  const key = queue.add(hold('happy'));
  queue.delete(key);
  assert.deepEqual(queue.drain(), []);
  queue.add(release);
  queue.clear();
  assert.deepEqual(queue.drain(), []);
});

test('a renderer reload replays a hold that was already delivered', () => {
  const queue = new PendingRendererEvents();
  const embarrassed = hold('embarrassed', 0.9);

  // Initial delivery drains the one-shot queue.
  queue.add(embarrassed);
  assert.deepEqual(drainRendererEventsForLoad(queue, embarrassed), [embarrassed]);
  assert.deepEqual(queue.drain(), []);

  // A fresh renderer has no expression history, but the main process still
  // owns the active hold, so it must receive the hold again.
  assert.deepEqual(drainRendererEventsForLoad(queue, embarrassed), [embarrassed]);
});

test('a queued expression event takes precedence over persistent hold replay', () => {
  const queue = new PendingRendererEvents();
  queue.add(release);

  assert.deepEqual(
    drainRendererEventsForLoad(queue, hold('embarrassed')),
    [release],
  );
});
