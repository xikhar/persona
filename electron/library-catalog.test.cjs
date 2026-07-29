"use strict";

const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const {
  describeAnimations,
  inferAnimationType,
  readPackagedLibrary,
  validatePackagedLibrary,
} = require("./library-catalog.cjs");

test("keeps permanent empty system actions in the packaged library", () => {
  // Read the committed blob so the guard survives local uncommitted edits
  // (e.g. the documented `cp library.json.example library.json` setup step).
  const repoRoot = path.join(__dirname, "..");
  let committedJson;
  try {
    committedJson = execSync(
      "git show HEAD:public/assets/library.json",
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    // Not in a git repo or file not tracked — fall back to disk.
    committedJson = require("node:fs").readFileSync(
      path.join(repoRoot, "public", "assets", "library.json"),
      "utf8",
    );
  }
  const library = validatePackagedLibrary(JSON.parse(committedJson));

  assert.equal(library.default_model_id, null);
  assert.deepEqual(library.models, []);
  assert.deepEqual(
    library.animations.map(
      ({ id, animation_name, animation_type, asset_paths }) => ({
        id,
        animation_name,
        animation_type,
        asset_paths,
      }),
    ),
    [
      {
        id: "system-idle",
        animation_name: "idle",
        animation_type: "IDLE",
        asset_paths: [],
      },
      {
        id: "system-speaking",
        animation_name: "speaking",
        animation_type: "TALK",
        asset_paths: [],
      },
    ],
  );
});

test("keeps the local packaged-library example valid and complete", () => {
  const library = readPackagedLibrary(
    path.join(
      __dirname,
      "..",
      "public",
      "assets",
      "library.json.example",
    ),
  );

  assert.ok(library.default_model_id);
  assert.ok(library.models.length > 0);
  assert.ok(library.animations.length > 0);
  assert.ok(
    library.animations.every(
      (animation) =>
        animation.animation_description &&
        animation.animation_trigger_scenario &&
        animation.asset_paths.length > 0,
    ),
  );
});

test("rejects unsafe packaged paths and describes configured animations", () => {
  assert.throws(
    () =>
      validatePackagedLibrary({
        schema_version: 1,
        default_model_id: null,
        models: [
          {
            id: "model",
            model_name: "Model",
            asset_path: "../private.vrm",
          },
        ],
        animations: [],
      }),
    /relative/,
  );

  const description = describeAnimations([
    {
      animation_name: "wave",
      animation_description: "A small friendly wave.",
      animation_trigger_scenario: "Use when saying hello.",
    },
  ]);
  assert.match(description, /wave: A small friendly wave/);
  assert.match(description, /Trigger scenario: Use when saying hello/);
});

test("resolves explicit and first-model packaged defaults", () => {
  const library = validatePackagedLibrary({
    schema_version: 1,
    default_model_id: "configured-model",
    models: [
      {
        id: "configured-model",
        model_name: "Configured model",
        asset_path: "models/configured.vrm",
      },
    ],
    animations: [],
  });
  assert.equal(library.default_model_id, "configured-model");

  const firstModelDefault = validatePackagedLibrary({
    schema_version: 1,
    default_model_id: null,
    models: [
      {
        id: "first-model",
        model_name: "First model",
        asset_path: "models/first.vrm",
      },
      {
        id: "second-model",
        model_name: "Second model",
        asset_path: "models/second.vrm",
      },
    ],
    animations: [],
  });
  assert.equal(firstModelDefault.default_model_id, "first-model");

  assert.throws(
    () =>
      validatePackagedLibrary({
        schema_version: 1,
        default_model_id: "missing-model",
        models: [],
        animations: [],
      }),
    /does not exist/,
  );
});

test("infers live roles from reserved animation names and numbered variants", () => {
  assert.equal(inferAnimationType("idle"), "IDLE");
  assert.equal(inferAnimationType("idle-2"), "IDLE");
  assert.equal(inferAnimationType("talk1"), "TALK");
  assert.equal(inferAnimationType("talk-2"), "TALK");
  assert.equal(inferAnimationType("greeting3"), "GREETING");
  assert.equal(inferAnimationType("happy"), "HAPPY");
  assert.equal(inferAnimationType("finger-gun1"), "FINGER_GUN");
  assert.equal(inferAnimationType("dance2"), "DANCE");
  assert.equal(inferAnimationType("wave-hello"), null);
  assert.equal(inferAnimationType(null), null);
});
