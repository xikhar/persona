import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  NativeProcessAudioListener,
  createNdjsonParser,
  resolveNativeHelperPath,
  type CaptureProcess,
} from './native-process-audio-listener.cjs';
import type { AudioActivity } from './audio-activity-gate.cjs';
import type { DiscoverVoiceProcessesOptions } from './process-discovery.cjs';
import type { AudioListenerStatus } from './types.cjs';

class FakeChild extends EventEmitter implements CaptureProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(): boolean {
    this.emit('exit', 0, 'SIGTERM');
    return true;
  }
}

function fakeChild(): FakeChild {
  return new FakeChild();
}

test("NDJSON parser buffers partial messages and rejects malformed lines", () => {
  const messages: unknown[] = [];
  const invalid: string[] = [];
  const parse = createNdjsonParser(
    (message) => messages.push(message),
    (line) => invalid.push(line),
  );
  parse('{"type":"rea');
  parse('dy"}\nnot-json\n{"type":"level","level":0.2}\n');
  assert.deepEqual(messages, [
    { type: "ready" },
    { type: "level", level: 0.2 },
  ]);
  assert.deepEqual(invalid, ["not-json"]);
});

test("resolves development and packaged helper locations on both native platforms", () => {
  assert.equal(
    resolveNativeHelperPath({
      platform: "win32",
      projectRoot: "C:\\project",
      isPackaged: true,
      resourcesPath: "C:\\resources",
    }),
    "C:\\resources\\native\\win32\\persona-audio-listener.exe",
  );
  assert.equal(
    resolveNativeHelperPath({
      platform: "win32",
      projectRoot: "C:\\project",
      isPackaged: false,
    }),
    "C:\\project\\native\\bin\\win32\\persona-audio-listener.exe",
  );
  assert.equal(
    resolveNativeHelperPath({
      platform: "darwin",
      projectRoot: "/project",
      isPackaged: false,
    }),
    "/project/native/bin/darwin/persona-audio-listener",
  );
});

test("native listener activates on audio, smooths speech, and never hides the window", async () => {
  const activities: AudioActivity[] = [];
  const sessions: boolean[] = [];
  const statuses: AudioListenerStatus[] = [];
  const child = fakeChild();
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    processDiscovery: async () => ({ pids: [10, 11], rootPids: [10] }),
    spawnProcess: () => child,
    onActivity: (activity) => activities.push(activity),
    onSession: (active) => sessions.push(active),
    onStatus: (status) => statuses.push(status),
    sessionIdleMs: 35,
    speechReleaseMs: 15,
  });

  await listener.start();
  child.stdout.emit("data", '{"type":"ready","source":"Codex"}\n');
  child.stdout.emit("data", '{"type":"level","level":0.3}\n');
  child.stdout.emit("data", '{"type":"level","level":0}\n');
  await new Promise((resolve) => setTimeout(resolve, 22));

  assert.deepEqual(sessions, [true]);
  assert.deepEqual(activities, ["listening", "speaking", "listening"]);
  assert.equal(statuses.at(-1)?.capturing, true);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(sessions, [true, false]);
  listener.stop();
});

test("native listener cannot attach after it is stopped during discovery", async () => {
  let finishDiscovery: (value: { pids: number[]; rootPids: number[] }) => void = () => {
    throw new Error('Discovery resolver was not initialized.');
  };
  let spawnCount = 0;
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    processDiscovery: () =>
      new Promise((resolve) => {
        finishDiscovery = resolve;
      }),
    spawnProcess: () => {
      spawnCount += 1;
      return fakeChild();
    },
  });

  const starting = listener.start();
  listener.stop();
  finishDiscovery({ pids: [10], rootPids: [10] });
  await starting;

  assert.equal(spawnCount, 0);
});

test("native listener resolves the configured application before capture", async () => {
  const captured: { options: DiscoverVoiceProcessesOptions | null } = {
    options: null,
  };
  const voiceSource = {
    mode: "application",
    process_pattern: null,
    source_id: "process:darwin:Vm9pY2U",
    source_name: "Voice",
  };
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    voiceSource,
    processDiscovery: async (options) => {
      captured.options = options;
      return { pids: [], rootPids: [] };
    },
  });

  await listener.start();
  listener.stop();

  assert.ok(captured.options);
  assert.deepEqual(captured.options.voiceSource, voiceSource);
});

test("keeps the capture target stable while dynamic worker PIDs churn", async () => {
  const spawns: (readonly string[])[] = [];
  const children: FakeChild[] = [];
  let discovery = { pids: [10, 11], rootPids: [10] };
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    processDiscovery: async () => discovery,
    spawnProcess: (_path, args) => {
      spawns.push([...args]);
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });

  await listener.start();
  // First spawn uses the full matched tree so the audio service is tapped.
  assert.deepEqual(spawns[0], ["--pid", "10", "--pid", "11"]);

  // The native tap resolves only the audio-service PID to a Core Audio object.
  const firstChild = children[0];
  assert.ok(firstChild);
  firstChild.stdout.emit(
    "data",
    '{"type":"ready","source":"macOS process audio","pids":[11]}\n',
  );

  // Learning the resolved set re-keys the existing capture in place.
  await listener.poll();
  assert.equal(spawns.length, 1);
  const stabilized = spawns.length;

  // A dynamic tool worker joining/leaving the matched tree must NOT recreate
  // the tap once the target has stabilized.
  discovery = { pids: [10, 11, 12], rootPids: [10] };
  await listener.poll();
  discovery = { pids: [10, 11], rootPids: [10] };
  await listener.poll();
  assert.equal(spawns.length, stabilized);

  // A real audio-source change (resolved PID leaves the tree) DOES re-attach.
  discovery = { pids: [10, 13], rootPids: [10] };
  await listener.poll();
  assert.equal(spawns.length, stabilized + 1);
  assert.deepEqual(spawns.at(-1), ["--pid", "10", "--pid", "13"]);

  // Learning the replacement audio-service PID must not recreate that tap.
  const latestChild = children.at(-1);
  assert.ok(latestChild);
  latestChild.stdout.emit(
    "data",
    '{"type":"ready","source":"macOS process audio","pids":[13]}\n',
  );
  await listener.poll();
  assert.equal(spawns.length, stabilized + 1);

  listener.stop();
});
