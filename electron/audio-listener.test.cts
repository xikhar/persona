import assert from 'node:assert/strict';
import test from 'node:test';
import { createAudioListener } from './audio-listener.cjs';
import { LinuxPipeWireListener } from './linux-pipewire-listener.cjs';
import { NativeProcessAudioListener } from './native-process-audio-listener.cjs';

test("selects the native listener implementation for each supported platform", () => {
  assert.ok(createAudioListener({ platform: "linux" }) instanceof LinuxPipeWireListener);
  assert.ok(createAudioListener({ platform: "darwin" }) instanceof NativeProcessAudioListener);
  assert.ok(createAudioListener({ platform: "win32" }) instanceof NativeProcessAudioListener);
  assert.equal(createAudioListener({ platform: "freebsd" }), null);
  assert.equal(
    createAudioListener({
      platform: "linux",
      voiceSource: { mode: "external" },
    }),
    null,
  );
});
