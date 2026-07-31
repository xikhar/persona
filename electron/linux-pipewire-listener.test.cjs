"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  LinuxPipeWireListener,
  enrichPipeWireNodes,
  findCodexOutputNode,
  isCodexOutputNode,
  isCodexProcessTree,
  normalizeRms,
  pcm16Rms,
} = require("./linux-pipewire-listener.cjs");

function pipeWireNode(id, properties, state = "idle") {
  return {
    id,
    type: "PipeWire:Interface:Node",
    info: { props: properties, state },
  };
}

test("selects the running Codex output stream and ignores other applications", () => {
  const helium = pipeWireNode(20, {
    "application.name": "Helium",
    "media.class": "Stream/Output/Audio",
    "object.serial": 120,
  });
  const idleCodex = pipeWireNode(30, {
    "application.process.binary": "codex-desktop",
    "media.class": "Stream/Output/Audio",
    "object.serial": 130,
  });
  const runningCodex = pipeWireNode(
    31,
    {
      "application.name": "Codex",
      "media.class": "Stream/Output/Audio",
      "object.serial": 131,
    },
    "running",
  );

  assert.equal(isCodexOutputNode(helium), false);
  assert.equal(isCodexOutputNode(idleCodex), true);
  assert.equal(findCodexOutputNode([helium, idleCodex, runningCodex]), runningCodex);
});

test("rejects Codex nodes that are not playback streams", () => {
  const input = pipeWireNode(30, {
    "application.name": "Codex",
    "media.class": "Stream/Input/Audio",
  });
  assert.equal(isCodexOutputNode(input), false);
});

test("recognizes a generic Electron audio node through its Codex process ancestry", () => {
  const audioService = pipeWireNode(
    41,
    {
      "application.name": "ALSA plug-in [electron]",
      "application.process.binary": "electron",
      "application.process.id": 421,
      "media.class": "Stream/Output/Audio",
      "object.serial": 141,
    },
    "running",
  );
  const processes = new Map([
    [421, { identity: "electron --type=utility --utility-sub-type=audio.mojom.AudioService", parentId: 400 }],
    [400, { identity: "electron --class=codex-desktop --app-id=codex-desktop", parentId: 1 }],
  ]);
  const processReader = (processId) => processes.get(processId);

  assert.equal(isCodexProcessTree(421, processReader), true);
  assert.equal(isCodexOutputNode(audioService, (processId) => isCodexProcessTree(processId, processReader)), true);
});

test("inherits process identity from a playback node's PipeWire client", () => {
  const client = {
    id: 72,
    type: "PipeWire:Interface:Client",
    info: {
      props: {
        "application.name": "PipeWire ALSA [electron]",
        "application.process.binary": "electron",
        "application.process.id": 421,
      },
    },
  };
  const playback = pipeWireNode(
    105,
    {
      "application.name": "PipeWire ALSA [electron]",
      "client.id": 72,
      "media.class": "Stream/Output/Audio",
      "node.name": "alsa_playback.electron",
      "object.serial": 2725,
    },
    "running",
  );
  const [, enrichedPlayback] = enrichPipeWireNodes([client, playback]);

  assert.equal(enrichedPlayback.info.props["application.process.id"], 421);
  assert.equal(isCodexOutputNode(enrichedPlayback, (processId) => processId === 421), true);
});

test("calculates and normalizes signed 16-bit PCM amplitude", () => {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(16_384, 0);
  pcm.writeInt16LE(-16_384, 2);
  pcm.writeInt16LE(0, 4);
  pcm.writeInt16LE(0, 6);
  assert.ok(Math.abs(pcm16Rms(pcm) - Math.sqrt(0.125)) < 0.0001);
  assert.equal(normalizeRms(0.001), 0);
  assert.ok(normalizeRms(0.1) > 0.7);
  assert.equal(normalizeRms(1), 1);
});

test("matches a custom process pattern for local voice apps", () => {
  const localApp = pipeWireNode(50, {
    "application.name": "Local TTS",
    "application.process.binary": "local-tts",
    "media.class": "Stream/Output/Audio",
    "object.serial": 150,
  }, "running");
  const pattern = /local-tts/i;
  assert.equal(isCodexOutputNode(localApp, null, pattern), true);
  assert.equal(isCodexOutputNode(localApp), false);
  assert.equal(findCodexOutputNode([localApp], null, pattern), localApp);
});

test("does not emit duplicate listener status updates", () => {
  const updates = [];
  const listener = new LinuxPipeWireListener({
    onStatus: (status) => updates.push(status),
  });
  const status = {
    available: true,
    capturing: false,
    monitoring: true,
    source: null,
  };

  listener.reportStatus(status);
  listener.reportStatus({ ...status });

  assert.deepEqual(updates, [status]);
});

test("holds the speaking state across short silence gaps", async () => {
  const activities = [];
  const listener = new LinuxPipeWireListener({
    onActivity: (activity) => activities.push(activity),
    speechReleaseMs: 30,
  });
  listener.currentNode = {};

  const speech = Buffer.alloc(320, 0);
  for (let offset = 0; offset < speech.length; offset += 2) {
    speech.writeInt16LE(4_000, offset);
  }
  const silence = Buffer.alloc(320, 0);

  listener.handleAudio(speech);
  listener.handleAudio(silence);
  await new Promise((resolve) => setTimeout(resolve, 10));
  listener.handleAudio(speech);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(activities, ["speaking"]);

  listener.handleAudio(silence);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(activities, ["speaking", "listening"]);
});
