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
    'getClickThrough', 'getSnapshot', 'hide', 'moveBy', 'setMousePassthrough',
    'subscribe',
  ] as const);
  const settings = requiredApi(exposed, 'personaSettings', [
    'get', 'importModel', 'createAnimation', 'addAnimationClips',
    'updateAnimation', 'deleteAnimation', 'deleteAnimationClip',
    'resetPackagedAnimations', 'deleteModel', 'setDefaultModel',
    'setCharacterSize', 'setAvatarWindowSize', 'getClickThroughMode',
    'setClickThroughEnabled', 'setSpeakingTransition',
    'setBodyTransitionMs', 'setSpeakingDebounceMs', 'setIdleInterimMs',
    'enableDeveloperSettings', 'resetDeveloperSettings',
    'setVroidHubPlaintextStorageAllowed', 'setVoiceSource',
    'listVoiceSources', 'setModelLighting', 'resetModelLighting',
    'getMcpStatus', 'openKimodoRepository', 'setWindowTheme', 'subscribe',
    'attachAnimationClip', 'attachAnimationClips', 'detachAnimationClip',
    'deleteAnimationLibraryClip', 'exportAnimationLibraryClip', 'importAnimationClips',
    'createAnimationWithClips', 'clearAnimationGenerations',
    'getAnimationGeneratorStatus', 'setAnimationGeneratorConfig',
    'checkAnimationGenerator', 'generateAnimation', 'listAnimationGenerations',
    'retryAnimationGeneration', 'discardAnimationGeneration',
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
  await bridge.getClickThrough();
  await bridge.getSnapshot();
  bridge.hide();
  bridge.moveBy(12, -4);
  bridge.setMousePassthrough(true);
  await settings.get();
  await settings.importModel({ model_name: "Studio Assistant" });
  await settings.createAnimation({
    animation_name: "wave-hello",
    animation_description: "A friendly wave.",
    animation_trigger_scenario: "Use for greetings.",
  });
  await settings.createAnimationWithClips({
    animation_name: 'wave-with-clip',
    animation_description: 'A linked wave.',
    animation_trigger_scenario: 'Use for linked greetings.',
  }, ['clip-id']);
  await settings.addAnimationClips("animation-id");
  await settings.importAnimationClips();
  await settings.attachAnimationClip("animation-id", "clip-id");
  await settings.attachAnimationClips("animation-id", ["clip-id", "clip-id-2"]);
  await settings.detachAnimationClip("animation-id", "clip-id");
  await settings.deleteAnimationLibraryClip("clip-id");
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
  await settings.getClickThroughMode();
  await settings.setClickThroughEnabled(true);
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
  await settings.openKimodoRepository();
  await settings.exportAnimationLibraryClip('clip-id');
  await settings.getAnimationGeneratorStatus();
  await settings.setAnimationGeneratorConfig({
    enabled: true,
    server_url: 'http://127.0.0.1:8090',
    model: 'soma-rp-v1.1',
    mcp_enabled: false,
  });
  await settings.checkAnimationGenerator();
  await settings.generateAnimation({ prompt: 'Wave' });
  await settings.listAnimationGenerations();
  await settings.retryAnimationGeneration('job-id');
  await settings.discardAnimationGeneration('job-id');
  await settings.clearAnimationGenerations();
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
    ["persona:get-click-through"],
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
    [
      'persona:settings-create-animation-with-clips',
      {
        animation_name: 'wave-with-clip',
        animation_description: 'A linked wave.',
        animation_trigger_scenario: 'Use for linked greetings.',
      },
      ['clip-id'],
    ],
    ["persona:settings-add-animation-clips", "animation-id"],
    ["persona:settings-import-animation-clips"],
    ["persona:settings-attach-animation-clip", "animation-id", "clip-id"],
    ["persona:settings-attach-animation-clips", "animation-id", ["clip-id", "clip-id-2"]],
    ["persona:settings-delete-animation-clip", "animation-id", "clip-id"],
    ["persona:settings-delete-animation-library-clip", "clip-id"],
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
    ["persona:settings-get-click-through-mode"],
    ["persona:settings-set-click-through", true],
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
    ["persona:settings-open-kimodo-repository"],
    ["persona:settings-export-animation-library-clip", "clip-id"],
    ["persona:settings-animation-generator-status"],
    [
      "persona:settings-animation-generator-set-config",
      {
        enabled: true,
        server_url: 'http://127.0.0.1:8090',
        model: 'soma-rp-v1.1',
        mcp_enabled: false,
      },
    ],
    ["persona:settings-animation-generator-check"],
    ["persona:settings-animation-generator-start", { prompt: 'Wave' }],
    ["persona:settings-animation-generator-list"],
    ["persona:settings-animation-generator-retry", "job-id"],
    ["persona:settings-animation-generator-discard", "job-id"],
    ["persona:settings-animation-generator-clear"],
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
    ["persona:set-mouse-passthrough", true],
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

test('preload retains startup animation events until the avatar subscribes', () => {
  const { exposed, listeners } = loadPreload();
  const bridge = requiredApi(exposed, 'personaBridge', ['subscribe'] as const);
  const eventListeners = listeners.get('persona:event');
  assert.ok(eventListeners);
  const preloadListener = [...eventListeners][0];
  assert.ok(preloadListener);
  const first = {
    type: 'animation',
    animation: 'CUSTOM',
    animationName: 'wave',
    animationUrls: ['persona-asset://animation/wave.vrma'],
    expressionName: null,
    expressionWeight: 1,
    source: 'command',
    requestId: 1,
  };
  const second = { ...first, requestId: 2 };
  const received: unknown[] = [];

  preloadListener({}, first);
  const unsubscribe = bridge.subscribe((event: unknown) => received.push(event));
  assert.equal(typeof unsubscribe, 'function');
  assert.deepEqual(received, [first]);

  preloadListener({}, second);
  assert.deepEqual(received, [first, second]);
  (unsubscribe as () => void)();

  const third = { ...first, requestId: 3 };
  preloadListener({}, third);
  const receivedAfterRemount: unknown[] = [];
  bridge.subscribe((event: unknown) => receivedAfterRemount.push(event));
  assert.deepEqual(receivedAfterRemount, [third]);
});
