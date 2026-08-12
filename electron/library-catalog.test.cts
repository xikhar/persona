import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  describeAnimations,
  inferAnimationType,
  readPackagedLibrary,
  validatePackagedLibrary,
} from './library-catalog.cjs';

test("keeps the permanent system actions in the packaged library", () => {
  const repoRoot = path.join(__dirname, "..");
  let committedJson;
  try {
    committedJson = execSync("git show HEAD:public/assets/library.json", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    committedJson = fs.readFileSync(
      path.join(repoRoot, "public", "assets", "library.json"),
      "utf8",
    );
  }
  const library = validatePackagedLibrary(JSON.parse(committedJson));

  assert.equal(library.default_model_id, "avatar-sample-a");
  assert.deepEqual(library.models, [
    {
      asset_path: "models/AvatarSample_A.vrm",
      id: "avatar-sample-a",
      model_name: "AvatarSample_A",
    },
  ]);
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
        asset_paths: ["animations/idle.vrma"],
      },
      {
        id: "system-speaking",
        animation_name: "speaking",
        animation_type: "TALK",
        asset_paths: [
          "animations/speaking-chunk00.vrma",
          "animations/speaking-chunk1.vrma",
          "animations/speaking-chunk11.vrma",
          "animations/speaking-chunk2.vrma",
          "animations/speaking-chunk22.vrma",
          "animations/speaking-chunk3.vrma",
          "animations/speaking-chunk33.vrma",
          "animations/speaking-chunk4.vrma",
          "animations/speaking-chunk44.vrma",
          "animations/speaking-chunk5.vrma",
          "animations/speaking-chunk55.vrma",
          "animations/speaking-chunk6.vrma",
          "animations/speaking-chunk66.vrma",
          "animations/speaking-chunk7.vrma",
          "animations/speaking-chunk77.vrma",
          "animations/speaking-chunk8.vrma",
          "animations/speaking-chunk88.vrma",
        ],
      },
    ],
  );
  assert.deepEqual(
    library.animations.map(({ expression_name, expression_weight }) => ({
      expression_name,
      expression_weight,
    })),
    [
      { expression_name: null, expression_weight: 1 },
      { expression_name: null, expression_weight: 1 },
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

test("preserves packaged animation expression metadata", () => {
  const catalog = validatePackagedLibrary({
    schema_version: 1,
    default_model_id: null,
    models: [],
    animations: [
      {
        id: "packaged-happy",
        animation_name: "happy",
        animation_description: "A happy reaction.",
        animation_trigger_scenario: "Use for positive moments.",
        animation_type: "HAPPY",
        expression_name: "happy",
        expression_weight: 0.75,
        asset_paths: ["animations/happy.vrma"],
      },
    ],
  });

  const animation = catalog.animations.find(
    (item) => item.id === "packaged-happy",
  );

  assert.ok(animation);
  assert.equal(animation.expression_name, "happy");
  assert.equal(animation.expression_weight, 0.75);
});

test("defaults missing packaged animation expression metadata", () => {
  const catalog = validatePackagedLibrary({
    schema_version: 1,
    default_model_id: null,
    models: [],
    animations: [
      {
        id: "packaged-wave",
        animation_name: "wave",
        animation_description: "A friendly wave.",
        animation_trigger_scenario: "Use when greeting someone.",
        animation_type: null,
        asset_paths: ["animations/wave.vrma"],
      },
    ],
  });

  const animation = catalog.animations.find(
    (item) => item.id === "packaged-wave",
  );

  assert.ok(animation);
  assert.equal(animation.expression_name, null);
  assert.equal(animation.expression_weight, 1);
});

test("rejects invalid packaged animation expression metadata", () => {
  const animation = {
    id: "packaged-happy",
    animation_name: "happy",
    animation_description: "A happy reaction.",
    animation_trigger_scenario: "Use for positive moments.",
    animation_type: "HAPPY",
    asset_paths: ["animations/happy.vrma"],
  };

  assert.throws(
    () =>
      validatePackagedLibrary({
        schema_version: 1,
        default_model_id: null,
        models: [],
        animations: [
          {
            ...animation,
            expression_name: "x".repeat(121),
          },
        ],
      }),
    /Invalid packaged expression name/,
  );

  assert.throws(
    () =>
      validatePackagedLibrary({
        schema_version: 1,
        default_model_id: null,
        models: [],
        animations: [
          {
            ...animation,
            expression_name: "happy",
            expression_weight: -0.1,
          },
        ],
      }),
    /Invalid packaged expression weight/,
  );

  assert.throws(
    () =>
      validatePackagedLibrary({
        schema_version: 1,
        default_model_id: null,
        models: [],
        animations: [
          {
            ...animation,
            expression_name: "happy",
            expression_weight: 1.1,
          },
        ],
      }),
    /Invalid packaged expression weight/,
  );
});
