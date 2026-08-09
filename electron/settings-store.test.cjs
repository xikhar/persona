"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  DEFAULT_MODEL_LIGHTING,
  createSettingsStore,
  validateAnimationMetadata,
  validateGlbFile,
} = require("./settings-store.cjs");

function writeEmptyPackagedLibrary(root) {
  const packagedLibraryPath = path.join(root, "library.json");
  fs.writeFileSync(
    packagedLibraryPath,
    JSON.stringify({
      schema_version: 1,
      default_model_id: null,
      models: [],
      animations: [],
    }),
  );
  return packagedLibraryPath;
}

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-settings-"));
  const userDataPath = path.join(root, "user-data");
  const packagedLibraryPath = writeEmptyPackagedLibrary(root);
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return { root, userDataPath, packagedLibraryPath };
}

function writeGlb(filePath) {
  const contents = Buffer.alloc(12);
  contents.write("glTF", 0, "ascii");
  contents.writeUInt32LE(2, 4);
  contents.writeUInt32LE(contents.length, 8);
  fs.writeFileSync(filePath, contents);
}

function writePackagedLibrary(root) {
  const packagedLibraryPath = path.join(root, "library.json");
  fs.writeFileSync(
    packagedLibraryPath,
    JSON.stringify({
      schema_version: 1,
      default_model_id: "configured-model",
      models: [
        {
          id: "configured-model",
          model_name: "Configured model",
          asset_path: "models/configured.vrm",
        },
      ],
      animations: [
        {
          id: "configured-motion",
          animation_name: "configured-motion",
          animation_description: "A configured packaged motion.",
          animation_trigger_scenario: "Use when the configured motion is appropriate.",
          animation_type: null,
          asset_paths: ["animations/configured.vrma"],
        },
      ],
    }),
  );
  return packagedLibraryPath;
}

test("starts with permanent empty Idle and Speaking actions", (context) => {
  const { userDataPath, packagedLibraryPath } = fixture(context);
  const snapshot = createSettingsStore({ userDataPath, packagedLibraryPath }).getSnapshot();

  assert.equal(snapshot.character_size, 1);
  assert.equal(snapshot.developer_settings_enabled, false);
  assert.equal(snapshot.body_transition_ms, 700);
  assert.equal(snapshot.speaking_debounce_ms, 350);
  assert.equal(snapshot.idle_interim_ms, 350);
  assert.deepEqual(snapshot.speaking_transition, {
    entry_ms: [810, 945],
    exit_ms: [630, 855],
  });
  assert.equal(snapshot.packaged_animation_change_count, 0);
  assert.equal(snapshot.default_model_id, null);
  assert.deepEqual(snapshot.models, []);
  assert.deepEqual(
    snapshot.animations.map(
      ({
        animation_name,
        animation_type,
        expression_name,
        expression_weight,
        removable,
        asset_urls,
      }) => ({
        animation_name,
        animation_type,
        expression_name,
        expression_weight,
        removable,
        asset_urls,
      }),
    ),
    [
      {
        animation_name: "idle",
        animation_type: "IDLE",
        expression_name: null,
        expression_weight: 1,
        removable: false,
        asset_urls: [],
      },
      {
        animation_name: "speaking",
        animation_type: "TALK",
        expression_name: null,
        expression_weight: 1,
        removable: false,
        asset_urls: [],
      },
    ],
  );
});

test("imports, persists, resolves, and deletes user assets", (context) => {
  const { root, userDataPath, packagedLibraryPath } = fixture(context);
  const sourceModel = path.join(root, "assistant.vrm");
  const alternateModel = path.join(root, "alternate.vrm");
  const sourceAnimation = path.join(root, "wave.vrma");
  writeGlb(sourceModel);
  writeGlb(alternateModel);
  writeGlb(sourceAnimation);
  const store = createSettingsStore({ userDataPath, packagedLibraryPath });

  let snapshot = store.importModel({
    filePath: sourceModel,
    model_name: "Studio Assistant",
  });
  const model = snapshot.models.find((candidate) => candidate.origin === "user");
  assert.ok(model);
  assert.equal(snapshot.default_model_id, model.id);
  snapshot = store.importModel({
    filePath: alternateModel,
    model_name: "Alternate Assistant",
  });
  const alternate = snapshot.models.find(
    (candidate) => candidate.model_name === "Alternate Assistant",
  );
  assert.ok(alternate);
  assert.equal(snapshot.default_model_id, model.id);

  snapshot = store.createAnimation({
    animation_name: "wave-hello",
    animation_description: "A friendly wave.",
    animation_trigger_scenario: "Use when greeting the user.",
  });
  let animation = snapshot.animations.find(
    (candidate) => candidate.animation_name === "wave-hello",
  );
  assert.ok(animation);
  assert.deepEqual(animation.asset_urls, []);
  snapshot = store.addAnimationClips(animation.id, [sourceAnimation]);
  animation = snapshot.animations.find(
    (candidate) => candidate.id === animation.id,
  );
  assert.deepEqual(
    animation.clips.map((clip) => clip.animation_name),
    ["wave-hello1"],
  );
  assert.match(animation.asset_urls[0], /^persona-asset:\/\/animation\//);
  const storedAnimation = store.resolveAssetRequest(animation.asset_urls[0]);
  assert.ok(storedAnimation);
  assert.equal(fs.existsSync(storedAnimation), true);
  assert.equal(
    store.resolveAssetRequest("persona-asset://animation/../settings.json"),
    null,
  );

  snapshot = store.deleteAnimation(animation.id);
  assert.equal(
    snapshot.animations.some((candidate) => candidate.id === animation.id),
    false,
  );
  assert.equal(fs.existsSync(storedAnimation), false);
  snapshot = store.deleteModel(model.id);
  assert.equal(snapshot.default_model_id, alternate.id);
  snapshot = store.deleteModel(alternate.id);
  assert.equal(snapshot.default_model_id, null);

  const reloaded = createSettingsStore({ userDataPath, packagedLibraryPath }).getSnapshot();
  assert.equal(
    reloaded.models.some((candidate) => candidate.id === model.id),
    false,
  );
});

test("holds a hub-sourced model in memory only, never in settings.json", (context) => {
  const { root, userDataPath, packagedLibraryPath } = fixture(context);
  const store = createSettingsStore({ userDataPath, packagedLibraryPath });
  const localModelPath = path.join(root, "local.vrm");
  writeGlb(localModelPath);
  const localModel = store
    .importModel({ filePath: localModelPath, model_name: "Local Character" })
    .models.find((candidate) => candidate.origin === "user");

  const buffer = Buffer.alloc(16);
  buffer.write("glTF", 0, "ascii");
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt32LE(buffer.length, 8);

  let snapshot = store.setActiveHubModel(buffer, { model_name: "Hub Character" });
  const hubModel = snapshot.models.find((candidate) => candidate.origin === "hub");
  assert.ok(hubModel);
  assert.equal(hubModel.model_name, "Hub Character");
  assert.equal(hubModel.removable, false);
  // Selecting the hub character becomes the active model immediately...
  assert.equal(snapshot.default_model_id, hubModel.id);

  const resolved = store.resolveAssetRequest(hubModel.asset_url);
  assert.ok(resolved);
  assert.equal(Buffer.isBuffer(resolved.buffer), true);
  assert.equal(resolved.buffer.equals(buffer), true);
  assert.equal(store.resolveAssetRequest("persona-asset://hub/not-the-id.vrm"), null);

  // ...but that's tracked in memory only: the persisted default_model_id
  // still points at the local model the user had selected before, never at
  // the hub model's ephemeral id.
  const settingsPath = path.join(userDataPath, "settings.json");
  const persisted = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(persisted.default_model_id, localModel.id);
  assert.equal("models" in persisted && persisted.models.some(
    (model) => model.id === hubModel.id,
  ), false);

  snapshot = store.clearActiveHubModel();
  assert.equal(snapshot.models.some((candidate) => candidate.origin === "hub"), false);
  assert.equal(store.resolveAssetRequest(hubModel.asset_url), null);
  // The user's prior local selection is restored, not lost, once the hub
  // model is gone.
  assert.equal(snapshot.default_model_id, localModel.id);

  const reloaded = createSettingsStore({ userDataPath, packagedLibraryPath }).getSnapshot();
  assert.equal(reloaded.models.some((candidate) => candidate.origin === "hub"), false);
  assert.equal(reloaded.default_model_id, localModel.id);
});

test("rejects a hub download that is not a valid glTF binary", (context) => {
  const { userDataPath, packagedLibraryPath } = fixture(context);
  const store = createSettingsStore({ userDataPath, packagedLibraryPath });

  assert.throws(
    () => store.setActiveHubModel(Buffer.from("this is not a glb file!"), { model_name: "Bad" }),
    /valid VRM/,
  );
  assert.throws(
    () => store.setActiveHubModel(Buffer.alloc(0), { model_name: "Empty" }),
    /empty or invalid/,
  );
  assert.equal(
    store.getSnapshot().models.some((candidate) => candidate.origin === "hub"),
    false,
  );
});

test("keeps user library records when migrating the earlier settings schema", (context) => {
  const { userDataPath, packagedLibraryPath } = fixture(context);
  const modelId = "11111111-1111-4111-8111-111111111111";
  const animationId = "22222222-2222-4222-8222-222222222222";
  const modelDirectory = path.join(userDataPath, "assets", "models");
  const animationDirectory = path.join(userDataPath, "assets", "animations");
  fs.mkdirSync(modelDirectory, { recursive: true });
  fs.mkdirSync(animationDirectory, { recursive: true });
  writeGlb(path.join(modelDirectory, `${modelId}.vrm`));
  writeGlb(path.join(animationDirectory, `${animationId}.vrma`));
  fs.writeFileSync(
    path.join(userDataPath, "settings.json"),
    JSON.stringify({
      schema_version: 1,
      default_model_id: modelId,
      character_size: 1.15,
      models: [
        {
          id: modelId,
          model_name: "Migrated model",
          stored_filename: `${modelId}.vrm`,
        },
      ],
      animations: [
        {
          id: animationId,
          animation_name: "migrated-motion",
          animation_description: "A retained user motion.",
          animation_trigger_scenario: "Use when migration is being verified.",
          stored_filename: `${animationId}.vrma`,
        },
      ],
    }),
  );

  const snapshot = createSettingsStore({ userDataPath, packagedLibraryPath }).getSnapshot();
  assert.equal(snapshot.schema_version, 9);
  assert.equal(snapshot.default_model_id, modelId);
  assert.equal(snapshot.character_size, 1.15);
  assert.ok(snapshot.models.some((model) => model.id === modelId));
  assert.ok(
    snapshot.animations.some((animation) => animation.id === animationId),
  );
});

test("uses copy-on-write packaged edits and resets only that layer", (context) => {
  const { root, userDataPath } = fixture(context);
  const packagedLibraryPath = writePackagedLibrary(root);
  const sourceAnimation = path.join(root, "wave.vrma");
  writeGlb(sourceAnimation);
  const store = createSettingsStore({ userDataPath, packagedLibraryPath });
  const original = store
    .getSnapshot()
    .animations.find(
      (animation) => animation.animation_name === "configured-motion",
    );
  assert.ok(original);
  const originalCount = store.getSnapshot().animations.length;

  let snapshot = store.updateAnimation(original.id, {
    animation_name: original.animation_name,
    animation_description: "A user-edited description.",
    animation_trigger_scenario: "Use for a user-edited scenario.",
  });
  assert.equal(snapshot.packaged_animation_change_count, 1);
  assert.equal(
    snapshot.animations.find((animation) => animation.id === original.id)
      .modified,
    true,
  );

  snapshot = store.deleteAnimation(original.id);
  assert.equal(snapshot.animations.length, originalCount - 1);
  const created = store.createAnimation({
    animation_name: "user-motion",
    animation_description: "A user motion.",
    animation_trigger_scenario: "Use when the user asks for it.",
  });
  const userMotion = created.animations.find(
    (animation) => animation.animation_name === "user-motion",
  );
  store.addAnimationClips(userMotion.id, [sourceAnimation]);
  snapshot = store.resetPackagedAnimations();
  assert.equal(snapshot.packaged_animation_change_count, 0);
  assert.equal(snapshot.animations.length, originalCount + 1);
  assert.ok(
    snapshot.animations.some(
      (animation) => animation.animation_name === "user-motion",
    ),
  );
  assert.equal(
    snapshot.animations.find((animation) => animation.id === original.id)
      .animation_description,
    original.animation_description,
  );

  const reloaded = createSettingsStore({
    userDataPath,
    packagedLibraryPath,
  }).getSnapshot();
  assert.equal(reloaded.packaged_animation_change_count, 0);
  assert.ok(
    reloaded.animations.some(
      (animation) => animation.animation_name === "user-motion",
    ),
  );
  assert.equal(
    reloaded.animations.find((animation) => animation.id === original.id)
      .animation_description,
    original.animation_description,
  );
});

test("validates custom metadata, files, duplicates, and appearance settings", (context) => {
  const { root, userDataPath, packagedLibraryPath } = fixture(context);
  const sourceAnimation = path.join(root, "wave.vrma");
  writeGlb(sourceAnimation);
  const store = createSettingsStore({ userDataPath, packagedLibraryPath });
  const metadata = {
    animation_name: "user-wave",
    animation_description: "A wave.",
    animation_trigger_scenario: "Use when saying hello.",
  };
  store.createAnimation(metadata);

  assert.throws(
    () => store.createAnimation(metadata),
    /already exists/,
  );
  assert.throws(
    () =>
      validateAnimationMetadata({
        ...metadata,
        animation_name: "Wave Hello",
      }),
    /lowercase letters/,
  );
  assert.throws(() => store.setCharacterSize(2), /between/);
  assert.equal(store.setCharacterSize(1.25).character_size, 1.25);
  assert.throws(() => store.setBodyTransitionMs(49), /between/);
  assert.equal(store.setBodyTransitionMs(400).body_transition_ms, 400);
  assert.throws(() => store.setSpeakingDebounceMs(3001), /between/);
  assert.equal(store.setSpeakingDebounceMs(650).speaking_debounce_ms, 650);
  assert.throws(() => store.setIdleInterimMs(-1), /between/);
  assert.equal(store.setIdleInterimMs(450).idle_interim_ms, 450);
  assert.throws(() => store.setAvatarWindowSize(100, 700), /width/);
  assert.throws(() => store.setAvatarWindowSize(500, 100), /height/);
  assert.deepEqual(store.setAvatarWindowSize(900, 1200).avatar_window, {
    width: 900,
    height: 1200,
  });
  assert.throws(
    () =>
      store.setSpeakingTransition({
        entry_ms: [44, 450],
        exit_ms: [450, 450],
      }),
    /between/,
  );
  assert.deepEqual(
    store.setSpeakingTransition({
      entry_ms: [1575, 1575],
      exit_ms: [675, 788],
    }).speaking_transition,
    { entry_ms: [1575, 1575], exit_ms: [675, 788] },
  );
  assert.deepEqual(
    createSettingsStore({ userDataPath, packagedLibraryPath }).getSnapshot()
      .speaking_transition,
    { entry_ms: [1575, 1575], exit_ms: [675, 788] },
  );
  assert.equal(store.enableDeveloperSettings().developer_settings_enabled, true);
  assert.equal(
    createSettingsStore({ userDataPath, packagedLibraryPath }).getSnapshot()
      .developer_settings_enabled,
    true,
  );
  assert.deepEqual(store.resetDeveloperSettings().speaking_transition, {
    entry_ms: [810, 945],
    exit_ms: [630, 855],
  });
  assert.equal(store.getSnapshot().body_transition_ms, 700);
  assert.equal(store.getSnapshot().speaking_debounce_ms, 350);
  assert.equal(store.getSnapshot().idle_interim_ms, 350);
  assert.equal(store.getSnapshot().developer_settings_enabled, true);
  assert.equal(
    store.setVroidHubPlaintextStorageAllowed(true)
      .vroid_hub_allow_plaintext_storage,
    true,
  );
  assert.equal(
    store.resetDeveloperSettings().vroid_hub_allow_plaintext_storage,
    false,
  );

  const invalidModel = path.join(root, "invalid.vrm");
  fs.writeFileSync(invalidModel, "not glTF");
  assert.throws(
    () => validateGlbFile(invalidModel, ".vrm"),
    /empty or invalid|glTF/,
  );
});

test("stores complete independent lighting profiles and enforces UI ranges", (context) => {
  const { root, userDataPath } = fixture(context);
  const packagedLibraryPath = writePackagedLibrary(root);
  const sourceModel = path.join(root, "lighting-model.vrm");
  writeGlb(sourceModel);
  const store = createSettingsStore({ userDataPath, packagedLibraryPath });
  let snapshot = store.importModel({
    filePath: sourceModel,
    model_name: "Lighting model",
  });
  const userModel = snapshot.models.find(
    (model) => model.model_name === "Lighting model",
  );
  assert.ok(userModel);

  snapshot = store.setModelLighting("configured-model", {
    environment_intensity: 0.35,
  });
  assert.deepEqual(snapshot.model_lighting["configured-model"], {
    ...DEFAULT_MODEL_LIGHTING,
    environment_intensity: 0.35,
  });

  snapshot = store.setModelLighting(userModel.id, {
    tone_mapping: "aces",
    exposure: 1.4,
  });
  assert.deepEqual(snapshot.model_lighting[userModel.id], {
    ...DEFAULT_MODEL_LIGHTING,
    tone_mapping: "aces",
    exposure: 1.4,
  });
  assert.equal(
    snapshot.model_lighting["configured-model"].environment_intensity,
    0.35,
  );

  for (const lighting of [
    { exposure: 3.01 },
    { environment_intensity: 2.01 },
    { key_light_intensity: 4.01 },
    { ambient_intensity: 4.01 },
    { environment_enabled: "false" },
  ]) {
    assert.throws(
      () => store.setModelLighting("configured-model", lighting),
      /must be between|must be a boolean/,
    );
  }
  assert.throws(
    () => store.setModelLighting("missing-model", { exposure: 1 }),
    /not installed/,
  );

  const reloadedStore = createSettingsStore({
    userDataPath,
    packagedLibraryPath,
  });
  const reloaded = reloadedStore.getSnapshot();
  assert.deepEqual(
    reloaded.model_lighting["configured-model"],
    snapshot.model_lighting["configured-model"],
  );
  assert.deepEqual(
    reloaded.model_lighting[userModel.id],
    snapshot.model_lighting[userModel.id],
  );

  snapshot = reloadedStore.deleteModel(userModel.id);
  assert.equal(snapshot.model_lighting[userModel.id], undefined);
  snapshot = reloadedStore.resetModelLighting("configured-model");
  assert.deepEqual(snapshot.model_lighting, {});
});

test("sanitizes partial and invalid lighting records loaded from disk", (context) => {
  const { root, userDataPath } = fixture(context);
  const packagedLibraryPath = writePackagedLibrary(root);
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(
    path.join(userDataPath, "settings.json"),
    JSON.stringify({
      schema_version: 3,
      model_lighting: {
        "configured-model": {
          tone_mapping: "invalid",
          exposure: 1.25,
          environment_enabled: "true",
          environment_intensity: 0.4,
          key_light_intensity: 8,
        },
        "missing-model": {
          exposure: 2,
        },
      },
      models: [],
      animations: [],
    }),
  );

  const snapshot = createSettingsStore({
    userDataPath,
    packagedLibraryPath,
  }).getSnapshot();
  assert.deepEqual(snapshot.model_lighting, {
    "configured-model": {
      ...DEFAULT_MODEL_LIGHTING,
      exposure: 1.25,
      environment_intensity: 0.4,
    },
  });
});

test("migrates reserved legacy uploads into the permanent system actions", (context) => {
  const { userDataPath, packagedLibraryPath } = fixture(context);
  const idleId = "33333333-3333-4333-8333-333333333333";
  const speakingId = "44444444-4444-4444-8444-444444444444";
  const animationDirectory = path.join(
    userDataPath,
    "assets",
    "animations",
  );
  fs.mkdirSync(animationDirectory, { recursive: true });
  writeGlb(path.join(animationDirectory, `${idleId}.vrma`));
  writeGlb(path.join(animationDirectory, `${speakingId}.vrma`));
  fs.writeFileSync(
    path.join(userDataPath, "settings.json"),
    JSON.stringify({
      schema_version: 2,
      animations: [
        {
          id: idleId,
          animation_name: "idle",
          animation_description: "A relaxed standing loop.",
          animation_trigger_scenario: "Use while Persona is waiting.",
          stored_filename: `${idleId}.vrma`,
        },
        {
          id: speakingId,
          animation_name: "talk1",
          animation_description: "A conversational motion.",
          animation_trigger_scenario: "Use while Persona is speaking.",
          stored_filename: `${speakingId}.vrma`,
        },
      ],
    }),
  );

  const snapshot = createSettingsStore({ userDataPath, packagedLibraryPath }).getSnapshot();

  const idle = snapshot.animations.find(
    (animation) => animation.animation_name === "idle",
  );
  const speaking = snapshot.animations.find(
    (animation) => animation.animation_name === "speaking",
  );
  assert.equal(idle?.animation_type, "IDLE");
  assert.deepEqual(
    idle?.clips.map((clip) => clip.animation_name),
    ["idle1"],
  );
  assert.equal(speaking?.animation_type, "TALK");
  assert.deepEqual(
    speaking?.clips.map((clip) => clip.animation_name),
    ["speaking1"],
  );
});

test("groups multiple uploaded clips under one action and removes them independently", (context) => {
  const { root, userDataPath, packagedLibraryPath } = fixture(context);
  const firstSource = path.join(root, "first.vrma");
  const secondSource = path.join(root, "second.vrma");
  writeGlb(firstSource);
  writeGlb(secondSource);
  const store = createSettingsStore({ userDataPath, packagedLibraryPath });
  let snapshot = store.createAnimation({
    animation_name: "wave",
    animation_description: "A friendly wave.",
    animation_trigger_scenario: "Use when greeting the user.",
  });
  const actionId = snapshot.animations.find(
    (animation) => animation.animation_name === "wave",
  ).id;

  snapshot = store.addAnimationClips(actionId, [firstSource, secondSource]);
  let action = snapshot.animations.find(
    (animation) => animation.id === actionId,
  );
  assert.deepEqual(
    action.clips.map((clip) => clip.animation_name),
    ["wave1", "wave2"],
  );
  assert.equal(action.asset_urls.length, 2);
  const removedPath = store.resolveAssetRequest(action.clips[0].asset_url);

  snapshot = store.deleteAnimationClip(actionId, action.clips[0].id);
  action = snapshot.animations.find((animation) => animation.id === actionId);
  assert.deepEqual(
    action.clips.map((clip) => clip.animation_name),
    ["wave2"],
  );
  assert.equal(fs.existsSync(removedPath), false);
  assert.throws(() => store.deleteAnimation("system-idle"), /cannot be removed/);
  assert.throws(
    () => store.deleteAnimation("system-speaking"),
    /cannot be removed/,
  );
});

test("persists every voice source mode and migrates schema 4 settings", (context) => {
  const { userDataPath, packagedLibraryPath } = fixture(context);
  const store = createSettingsStore({ userDataPath, packagedLibraryPath });
  assert.deepEqual(store.getSnapshot().voice_source, {
    mode: "default",
    process_pattern: null,
    source_id: null,
    source_name: null,
  });

  let snapshot = store.setVoiceSource({
    mode: "custom",
    process_pattern: "  local-tts|open-webui  ",
  });
  assert.equal(snapshot.schema_version, 9);
  assert.deepEqual(snapshot.voice_source, {
    mode: "custom",
    process_pattern: "local-tts|open-webui",
    source_id: null,
    source_name: null,
  });
  assert.throws(
    () => store.setVoiceSource({ mode: "custom", process_pattern: "[" }),
    /valid regular expression/,
  );

  snapshot = store.setVoiceSource({
    mode: "application",
    process_pattern: null,
    source_id: "process:win32:Vm9pY2U",
    source_name: "Voice",
  });
  assert.deepEqual(snapshot.voice_source, {
    mode: "application",
    process_pattern: null,
    source_id: "process:win32:Vm9pY2U",
    source_name: "Voice",
  });

  snapshot = store.setVoiceSource({ mode: "external" });
  assert.deepEqual(snapshot.voice_source, {
    mode: "external",
    process_pattern: null,
    source_id: null,
    source_name: null,
  });

  assert.throws(
    () =>
      store.setVoiceSource({
        mode: "application",
        source_id: "arbitrary",
        source_name: "Voice",
      }),
    /valid application/,
  );

  fs.writeFileSync(
    path.join(userDataPath, "settings.json"),
    JSON.stringify({
      schema_version: 4,
      models: [],
      animations: [],
      animation_clips: {},
      model_lighting: {},
      voice_source: {
        mode: "custom",
        process_pattern: "voice-engine",
      },
    }),
  );
  const migrated = createSettingsStore({
    userDataPath,
    packagedLibraryPath,
  }).getSnapshot();
  assert.equal(migrated.schema_version, 9);
  assert.deepEqual(migrated.voice_source, {
    mode: "custom",
    process_pattern: "voice-engine",
    source_id: null,
    source_name: null,
  });
});

test("migrates schema 6 into locked developer settings without losing transition values", (context) => {
  const { userDataPath, packagedLibraryPath } = fixture(context);
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(
    path.join(userDataPath, "settings.json"),
    JSON.stringify({
      schema_version: 6,
      models: [],
      animations: [],
      animation_clips: {},
      model_lighting: {},
      speaking_transition: {
        entry_factor: 2.5,
        exit_factor: 0.75,
      },
    }),
  );

  const snapshot = createSettingsStore({
    userDataPath,
    packagedLibraryPath,
  }).getSnapshot();
  assert.equal(snapshot.schema_version, 9);
  assert.equal(snapshot.developer_settings_enabled, false);
  assert.equal(snapshot.body_transition_ms, 700);
  assert.deepEqual(snapshot.speaking_transition, {
    entry_ms: [1125, 1125],
    exit_ms: [338, 338],
  });
});

test("migrates schema 7 with packaged scheduler delay defaults", (context) => {
  const { userDataPath, packagedLibraryPath } = fixture(context);
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(
    path.join(userDataPath, "settings.json"),
    JSON.stringify({
      schema_version: 7,
      models: [],
      animations: [],
      animation_clips: {},
      model_lighting: {},
      body_transition_seconds: 0.6,
    }),
  );

  const snapshot = createSettingsStore({
    userDataPath,
    packagedLibraryPath,
  }).getSnapshot();
  assert.equal(snapshot.schema_version, 9);
  assert.equal(snapshot.body_transition_ms, 600);
  assert.equal(snapshot.speaking_debounce_ms, 350);
  assert.equal(snapshot.idle_interim_ms, 350);
});

test("migrates schema 8 scheduler factors and seconds to milliseconds", (context) => {
  const { userDataPath, packagedLibraryPath } = fixture(context);
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(
    path.join(userDataPath, "settings.json"),
    JSON.stringify({
      schema_version: 8,
      models: [],
      animations: [],
      animation_clips: {},
      model_lighting: {},
      body_transition_seconds: 0.8,
      speaking_debounce_ms: 2150,
      idle_interim_ms: 0,
      speaking_transition: {
        entry_factor: [1.8, 2.1],
        exit_factor: [1.4, 1.9],
      },
    }),
  );

  const snapshot = createSettingsStore({
    userDataPath,
    packagedLibraryPath,
  }).getSnapshot();
  assert.equal(snapshot.schema_version, 9);
  assert.equal(snapshot.body_transition_ms, 800);
  assert.equal(snapshot.speaking_debounce_ms, 2150);
  assert.equal(snapshot.idle_interim_ms, 0);
  assert.deepEqual(snapshot.speaking_transition, {
    entry_ms: [810, 945],
    exit_ms: [630, 855],
  });
});

test("validates animation expression metadata", () => {
  const base = {
    animation_name: "happy",
    animation_description: "Happy action.",
    animation_trigger_scenario: "Use when happy.",
  };

  assert.deepEqual(validateAnimationMetadata(base), {
    ...base,
    expression_name: null,
    expression_weight: 1,
  });

  assert.deepEqual(
    validateAnimationMetadata({
      ...base,
      expression_name: "sad",
      expression_weight: 0.75,
    }),
    {
      ...base,
      expression_name: "sad",
      expression_weight: 0.75,
    },
  );

  assert.throws(
    () =>
      validateAnimationMetadata({
        ...base,
        expression_name: "smirk",
        expression_weight: 1,
      }),
    /Expression must be/,
  );

  assert.throws(
    () =>
      validateAnimationMetadata({
        ...base,
        expression_name: "happy",
        expression_weight: 1.1,
      }),
    /between 0 and 1/,
  );

  assert.throws(
    () =>
      validateAnimationMetadata({
        ...base,
        expression_name: "happy",
        expression_weight: -0.1,
      }),
    /between 0 and 1/,
  );
});

test("persists animation expression metadata", (context) => {
  const { userDataPath, packagedLibraryPath } = fixture(context);
  const store = createSettingsStore({
    userDataPath,
    packagedLibraryPath,
  });

  let snapshot = store.createAnimation({
    animation_name: "sad-action",
    animation_description: "A sad action.",
    animation_trigger_scenario: "Use when sad.",
    expression_name: "sad",
    expression_weight: 0.8,
  });

  let animation = snapshot.animations.find(
    (candidate) => candidate.animation_name === "sad-action",
  );

  assert.ok(animation);
  assert.equal(animation.expression_name, "sad");
  assert.equal(animation.expression_weight, 0.8);

  const reloaded = createSettingsStore({
    userDataPath,
    packagedLibraryPath,
  }).getSnapshot();

  animation = reloaded.animations.find(
    (candidate) => candidate.animation_name === "sad-action",
  );

  assert.ok(animation);
  assert.equal(animation.expression_name, "sad");
  assert.equal(animation.expression_weight, 0.8);
});