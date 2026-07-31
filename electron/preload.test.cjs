"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadPreload() {
  const exposed = new Map();
  const invocations = [];
  const sent = [];
  const listeners = new Map();
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        exposed.set(name, api);
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        invocations.push([channel, ...args]);
        return Promise.resolve({ channel, args });
      },
      off(channel, handler) {
        listeners.get(channel)?.delete(handler);
      },
      on(channel, handler) {
        const handlers = listeners.get(channel) ?? new Set();
        handlers.add(handler);
        listeners.set(channel, handlers);
      },
      send(channel, ...args) {
        sent.push([channel, ...args]);
      },
    },
  };
  const source = fs.readFileSync(
    path.join(__dirname, "preload.cjs"),
    "utf8",
  );
  vm.runInNewContext(source, {
    require(id) {
      assert.equal(id, "electron");
      return electron;
    },
  });
  return { exposed, invocations, listeners, sent };
}

test("preload exposes only narrow Persona and settings IPC operations", async () => {
  const { exposed, invocations, listeners, sent } = loadPreload();
  const bridge = exposed.get("personaBridge");
  const settings = exposed.get("personaSettings");

  assert.deepEqual([...exposed.keys()], ["personaBridge", "personaSettings"]);
  await bridge.getSnapshot();
  bridge.hide();
  await settings.get();
  await settings.importModel({ model_name: "Studio Assistant" });
  await settings.createAnimation({
    animation_name: "wave-hello",
    animation_description: "A friendly wave.",
    animation_trigger_scenario: "Use for greetings.",
  });
  await settings.addAnimationClips("animation-id");
  await settings.updateAnimation("animation-id", {
    animation_name: "wave-hello",
    animation_description: "An updated friendly wave.",
    animation_trigger_scenario: "Use for greetings.",
  });
  await settings.deleteAnimation("animation-id");
  await settings.deleteAnimationClip("animation-id", "clip-id");
  await settings.resetPackagedAnimations();
  await settings.deleteModel("model-id");
  await settings.setDefaultModel("model-id");
  await settings.setCharacterSize(1.2);
  await settings.setVoiceSource({
    mode: "custom",
    process_pattern: "local-tts",
  });
  await settings.setModelLighting("model-id", {
    exposure: 1.2,
    environment_intensity: 0.35,
  });
  await settings.resetModelLighting("model-id");
  await settings.getMcpStatus();
  settings.setWindowTheme("light");

  assert.deepEqual(invocations, [
    ["persona:get-snapshot"],
    ["persona:settings-get"],
    ["persona:settings-import-model", { model_name: "Studio Assistant" }],
    [
      "persona:settings-create-animation",
      {
        animation_name: "wave-hello",
        animation_description: "A friendly wave.",
        animation_trigger_scenario: "Use for greetings.",
      },
    ],
    ["persona:settings-add-animation-clips", "animation-id"],
    [
      "persona:settings-update-animation",
      "animation-id",
      {
        animation_name: "wave-hello",
        animation_description: "An updated friendly wave.",
        animation_trigger_scenario: "Use for greetings.",
      },
    ],
    ["persona:settings-delete-animation", "animation-id"],
    [
      "persona:settings-delete-animation-clip",
      "animation-id",
      "clip-id",
    ],
    ["persona:settings-reset-packaged-animations"],
    ["persona:settings-delete-model", "model-id"],
    ["persona:settings-set-default-model", "model-id"],
    ["persona:settings-set-character-size", 1.2],
    [
      "persona:settings-set-voice-source",
      { mode: "custom", process_pattern: "local-tts" },
    ],
    [
      "persona:settings-set-model-lighting",
      "model-id",
      {
        exposure: 1.2,
        environment_intensity: 0.35,
      },
    ],
    ["persona:settings-reset-model-lighting", "model-id"],
    ["persona:settings-get-mcp-status"],
  ]);
  assert.deepEqual(sent, [
    ["persona:hide"],
    ["persona:settings-set-window-theme", "light"],
  ]);

  const snapshots = [];
  const unsubscribe = settings.subscribe((snapshot) => snapshots.push(snapshot));
  const handler = [...listeners.get("persona:settings-updated")][0];
  handler({}, { character_size: 1.3 });
  unsubscribe();
  assert.deepEqual(snapshots, [{ character_size: 1.3 }]);
  assert.equal(listeners.get("persona:settings-updated").size, 0);
});
