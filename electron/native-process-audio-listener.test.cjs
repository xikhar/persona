"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  NativeProcessAudioListener,
  createNdjsonParser,
  resolveNativeHelperPath,
} = require("./native-process-audio-listener.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit("exit", 0, "SIGTERM");
  return child;
}

test("NDJSON parser buffers partial messages and rejects malformed lines", () => {
  const messages = [];
  const invalid = [];
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
  const activities = [];
  const sessions = [];
  const statuses = [];
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
  assert.equal(statuses.at(-1).capturing, true);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(sessions, [true, false]);
  listener.stop();
});

test("native listener cannot attach after it is stopped during discovery", async () => {
  let finishDiscovery;
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
  let discoveryOptions = null;
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
      discoveryOptions = options;
      return { pids: [], rootPids: [] };
    },
  });

  await listener.start();
  listener.stop();

  assert.deepEqual(discoveryOptions.voiceSource, voiceSource);
});

test("keeps the capture target stable while dynamic worker PIDs churn", async () => {
  const spawns = [];
  const children = [];
  let discovery = { pids: [10, 11], rootPids: [10] };
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    processDiscovery: async () => discovery,
    spawnProcess: (_path, args) => {
      spawns.push(args);
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });

  await listener.start();
  // First spawn uses the full matched tree so the audio service is tapped.
  assert.deepEqual(spawns[0], ["--pid", "10", "--pid", "11"]);

  // The native tap resolves only the audio-service PID to a Core Audio object.
  children[0].stdout.emit(
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
  children.at(-1).stdout.emit(
    "data",
    '{"type":"ready","source":"macOS process audio","pids":[13]}\n',
  );
  await listener.poll();
  assert.equal(spawns.length, stabilized + 1);

  listener.stop();
});
