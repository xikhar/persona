import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

type TestMethod = (...args: unknown[]) => unknown;
type TestApi = Record<string, TestMethod>;
type TestListener = (event: unknown, value: unknown) => void;

interface PreloadHarness {
  exposed: Map<string, TestApi>;
  invocations: unknown[][];
  listeners: Map<string, Set<TestListener>>;
  sent: unknown[][];
}

function requiredApi<const TMethod extends string>(
  exposed: ReadonlyMap<string, TestApi>,
  name: string,
  methods: readonly TMethod[],
): { [TKey in TMethod]: TestMethod } {
  const api = exposed.get(name);
  assert.ok(api, `Missing ${name} preload API`);
  for (const method of methods) {
    assert.equal(typeof api[method], 'function', `Missing ${name}.${method}`);
  }
  return api as { [TKey in TMethod]: TestMethod };
}

function loadPreload(): PreloadHarness {
  const exposed = new Map<string, TestApi>();
  const invocations: unknown[][] = [];
  const sent: unknown[][] = [];
  const listeners = new Map<string, Set<TestListener>>();
  const electron = {
    contextBridge: {
      exposeInMainWorld(name: string, api: TestApi) {
        exposed.set(name, api);
      },
    },
    ipcRenderer: {
      invoke(channel: string, ...args: unknown[]) {
        invocations.push([channel, ...args]);
        return Promise.resolve({ channel, args });
      },
      off(channel: string, handler: TestListener) {
        listeners.get(channel)?.delete(handler);
      },
      on(channel: string, handler: TestListener) {
        const handlers = listeners.get(channel) ?? new Set();
        handlers.add(handler);
        listeners.set(channel, handlers);
      },
      send(channel: string, ...args: unknown[]) {
        sent.push([channel, ...args]);
      },
    },
  };
  const source = fs.readFileSync(
    path.join(__dirname, "preload.cjs"),
    "utf8",
  );
  vm.runInNewContext(source, {
    exports: {},
    require(id: string) {
      assert.equal(id, "electron");
      return electron;
    },
  });
  return { exposed, invocations, listeners, sent };
}

test("preload exposes only narrow Persona and settings IPC operations", async () => {
  const { exposed, invocations, listeners, sent } = loadPreload();
  const bridge = requiredApi(exposed, 'personaBridge', [
    'getSnapshot', 'hide', 'moveBy', 'subscribe',
  ] as const);
  const settings = requiredApi(exposed, 'personaSettings', [
    'get', 'importModel', 'createAnimation', 'addAnimationClips',
    'updateAnimation', 'deleteAnimation', 'deleteAnimationClip',
    'resetPackagedAnimations', 'deleteModel', 'setDefaultModel',
    'setCharacterSize', 'setAvatarWindowSize', 'setSpeakingTransition',
    'setBodyTransitionMs', 'setSpeakingDebounceMs', 'setIdleInterimMs',
    'enableDeveloperSettings', 'resetDeveloperSettings',
    'setVroidHubPlaintextStorageAllowed', 'setVoiceSource',
    'listVoiceSources', 'setModelLighting', 'resetModelLighting',
    'getMcpStatus', 'setWindowTheme', 'subscribe',
  ] as const);
  const vroidHub = requiredApi(exposed, 'personaVroidHub', [
    'getStatus', 'getCredentials', 'setCredentials', 'clearCredentials',
    'connect', 'disconnect', 'listCharacters', 'getCharacterPortrait',
    'selectCharacter', 'openCharacterPage', 'subscribe',
  ] as const);

  assert.deepEqual(
    [...exposed.keys()],
    ["personaBridge", "personaSettings", "personaVroidHub"],
  );
  await bridge.getSnapshot();
  bridge.hide();
  bridge.moveBy(12, -4);
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
  await settings.setAvatarWindowSize(900, 1200);
  await settings.setSpeakingTransition({
    entry_ms: [720, 720],
    exit_ms: [765, 765],
  });
  await settings.setBodyTransitionMs(800);
  await settings.setSpeakingDebounceMs(350);
  await settings.setIdleInterimMs(350);
  await settings.enableDeveloperSettings();
  await settings.resetDeveloperSettings();
  await settings.setVroidHubPlaintextStorageAllowed(true);
  await settings.setVoiceSource({
    mode: "custom",
    process_pattern: "local-tts",
  });
  await settings.listVoiceSources();
  await settings.setModelLighting("model-id", {
    exposure: 1.2,
    environment_intensity: 0.35,
  });
  await settings.resetModelLighting("model-id");
  await settings.getMcpStatus();
  settings.setWindowTheme("light");
  await vroidHub.getStatus();
  await vroidHub.getCredentials();
  await vroidHub.setCredentials("client-id", "client-secret");
  await vroidHub.clearCredentials();
  await vroidHub.connect();
  await vroidHub.disconnect();
  await vroidHub.listCharacters();
  await vroidHub.getCharacterPortrait("character-id");
  await vroidHub.selectCharacter("character-id", "Character Name");
  await vroidHub.openCharacterPage("character-id", "character-model-id");

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
    ["persona:settings-set-avatar-window-size", 900, 1200],
    [
      "persona:settings-set-speaking-transition",
      { entry_ms: [720, 720], exit_ms: [765, 765] },
    ],
    ["persona:settings-set-body-transition-ms", 800],
    ["persona:settings-set-speaking-debounce-ms", 350],
    ["persona:settings-set-idle-interim-ms", 350],
    ["persona:settings-enable-developer"],
    ["persona:settings-reset-developer"],
    ["persona:settings-set-vroid-plaintext-storage", true],
    [
      "persona:settings-set-voice-source",
      { mode: "custom", process_pattern: "local-tts" },
    ],
    ["persona:settings-list-voice-sources"],
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
    ["persona:vroid-get-status"],
    ["persona:vroid-get-credentials"],
    ["persona:vroid-set-credentials", "client-id", "client-secret"],
    ["persona:vroid-clear-credentials"],
    ["persona:vroid-connect"],
    ["persona:vroid-disconnect"],
    ["persona:vroid-list-characters"],
    ["persona:vroid-character-portrait", "character-id"],
    ["persona:vroid-select-character", "character-id", "Character Name"],
    [
      "persona:vroid-open-character-page",
      "character-id",
      "character-model-id",
    ],
  ]);
  assert.deepEqual(sent, [
    ["persona:hide"],
    ["persona:move-by", 12, -4],
    ["persona:settings-set-window-theme", "light"],
  ]);

  const snapshots: unknown[] = [];
  const unsubscribe = settings.subscribe((snapshot: unknown) => snapshots.push(snapshot));
  if (typeof unsubscribe !== 'function') throw new Error('Invalid unsubscribe callback');
  const snapshotListeners = listeners.get("persona:settings-updated");
  assert.ok(snapshotListeners);
  const handler = [...snapshotListeners][0];
  assert.ok(handler);
  handler({}, { character_size: 1.3 });
  unsubscribe();
  assert.deepEqual(snapshots, [{ character_size: 1.3 }]);
  assert.equal(snapshotListeners.size, 0);

  const statuses: unknown[] = [];
  const unsubscribeVroid = vroidHub.subscribe((status: unknown) => statuses.push(status));
  if (typeof unsubscribeVroid !== 'function') throw new Error('Invalid unsubscribe callback');
  const statusListeners = listeners.get("persona:vroid-status-updated");
  assert.ok(statusListeners);
  const vroidHandler = [...statusListeners][0];
  assert.ok(vroidHandler);
  vroidHandler({}, { configured: true, connected: true });
  unsubscribeVroid();
  assert.deepEqual(statuses, [{ configured: true, connected: true }]);
  assert.equal(statusListeners.size, 0);
});
