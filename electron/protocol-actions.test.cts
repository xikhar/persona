import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProtocolUrl } from './protocol-actions.cjs';

test("maps Persona URLs to lifecycle and clamped level events", () => {
  const commands = parseProtocolUrl("persona://speaking?level=3");
  assert.deepEqual(commands, [
    { type: 'event', event: { type: 'state', state: {
      activity: 'speaking',
      microphoneMuted: false,
      outputMuted: false,
      phase: 'active',
    } } },
    { type: 'event', event: { type: 'audio-level', level: 1 } },
  ]);
  assert.deepEqual(parseProtocolUrl("persona://inactive"), [
    { type: 'event', event: { type: 'state', state: {
      activity: 'idle',
      microphoneMuted: false,
      outputMuted: false,
      phase: 'inactive',
    } } },
  ]);
});

test("maps window and configured animation URLs without accepting another scheme", () => {
  assert.deepEqual(parseProtocolUrl("persona://toggle"), [{ type: "toggle" }]);
  assert.deepEqual(parseProtocolUrl("persona://animation?name=wave-hello"), [
    { type: "animation-command", animationName: "wave-hello" },
  ]);
  assert.equal(parseProtocolUrl("persona://animation?name=Wave%20Hello"), null);
  assert.equal(parseProtocolUrl("persona://animation"), null);
  assert.equal(parseProtocolUrl("another-product://show"), null);
  assert.equal(parseProtocolUrl("not a URL"), null);
});
