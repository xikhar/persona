import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  readAssetContract,
  validateAssets,
} from './check-assets.cjs';
import { isRecord } from '../electron/types.cjs';

interface AssetFixture {
  assetRoot: string;
  libraryPath: string;
  manifestPath: string;
}

interface ManifestAsset {
  license: string | null;
  path: string;
  role: 'animation' | 'model';
  source: string | null;
}

interface AssetManifest {
  assets: ManifestAsset[];
  distributionAllowed: boolean;
}

function readManifest(manifestPath: string): AssetManifest {
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (
    !isRecord(parsed) ||
    typeof parsed.distributionAllowed !== 'boolean' ||
    !Array.isArray(parsed.assets)
  ) {
    throw new Error('Invalid test asset manifest.');
  }
  const assets = parsed.assets.map((asset): ManifestAsset => {
    if (
      !isRecord(asset) ||
      typeof asset.path !== 'string' ||
      (asset.role !== 'animation' && asset.role !== 'model') ||
      (asset.license !== null && typeof asset.license !== 'string') ||
      (asset.source !== null && typeof asset.source !== 'string')
    ) {
      throw new Error('Invalid test asset manifest entry.');
    }
    return {
      license: asset.license,
      path: asset.path,
      role: asset.role,
      source: asset.source,
    };
  });
  return { assets, distributionAllowed: parsed.distributionAllowed };
}

function createFixture(context: TestContext): AssetFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-assets-"));
  const assetRoot = path.join(root, "assets");
  fs.mkdirSync(assetRoot, { recursive: true });
  const libraryPath = path.join(assetRoot, "library.json");
  const manifestPath = path.join(assetRoot, "manifest.json");
  for (const filename of ["library.json", "manifest.json"]) {
    fs.copyFileSync(
      path.join(__dirname, "..", "public", "assets", filename),
      path.join(assetRoot, filename),
    );
  }
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { assetRoot, libraryPath, manifestPath };
}

function configureFixtureAssets(fixture: AssetFixture): void {
  fs.writeFileSync(
    fixture.libraryPath,
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
          animation_description: "A configured motion.",
          animation_trigger_scenario: "Use for asset validation.",
          animation_type: null,
          asset_paths: ["animations/configured.vrma"],
        },
      ],
    }),
  );
  fs.writeFileSync(
    fixture.manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      distributionAllowed: false,
      assets: [
        {
          path: "models/configured.vrm",
          role: "model",
          license: null,
          source: null,
        },
        {
          path: "animations/configured.vrma",
          role: "animation",
          license: null,
          source: null,
        },
      ],
    }),
  );
}

test("development accepts an empty catalog and ignored local media", (context) => {
  assert.deepEqual(validateAssets(), []);
  const fixture = createFixture(context);
  const ignoredMedia = path.join(fixture.assetRoot, "local-only.vrm");
  fs.writeFileSync(ignoredMedia, "untracked local media");
  assert.deepEqual(validateAssets(fixture), []);
});

test("manifest assigns every catalog asset its intended generic role", () => {
  const assetRoot = path.join(__dirname, "..", "public", "assets");
  const manifest = readManifest(path.join(assetRoot, "manifest.json"));
  const contract = readAssetContract(path.join(assetRoot, "library.json"));
  assert.deepEqual(
    Object.fromEntries(manifest.assets.map((asset) => [asset.path, asset.role])),
    contract.roles,
  );
});

test("published character assets carry licenses separate from the project MIT license", () => {
  const assetRoot = path.join(__dirname, "..", "public", "assets");
  const manifest = readManifest(path.join(assetRoot, "manifest.json"));

  assert.equal(manifest.distributionAllowed, true);
  assert.ok(manifest.assets.length > 0);
  const model = manifest.assets.find((asset) => asset.role === "model");
  const animations = manifest.assets.filter((asset) => asset.role === "animation");
  assert.deepEqual(model, {
    path: "models/AvatarSample_A.vrm",
    role: "model",
    license:
      "VRoid Project Sample Model Terms; excluded from Persona's MIT License",
    source:
      "https://hub.vroid.com/en/characters/2843975675147313744/models/5644550979324015604",
  });
  assert.ok(animations.length > 0);
  assert.ok(
    animations.every(
      (asset) =>
        asset.license === "Excluded from Persona's MIT License" &&
        typeof asset.source === "string" &&
        asset.source.length > 0,
    ),
  );
});

test("example manifest covers every path in the example library", () => {
  const assetRoot = path.join(__dirname, "..", "public", "assets");
  const contract = readAssetContract(
    path.join(assetRoot, "library.json.example"),
  );
  const manifest = readManifest(path.join(assetRoot, "manifest.json.example"));

  assert.deepEqual(
    manifest.assets.map((asset) => asset.path).sort(),
    contract.paths,
  );
  assert.deepEqual(
    Object.fromEntries(manifest.assets.map((asset) => [asset.path, asset.role])),
    contract.roles,
  );
  assert.equal(manifest.distributionAllowed, false);
});

test("development rejects a partial local media set", (context) => {
  const fixture = createFixture(context);
  configureFixtureAssets(fixture);
  const contract = readAssetContract(fixture.libraryPath);
  const firstAsset = contract.paths[0];
  assert.ok(firstAsset);
  const partial = path.join(fixture.assetRoot, firstAsset);
  fs.mkdirSync(path.dirname(partial), { recursive: true });
  fs.writeFileSync(partial, "local test media");
  assert.ok(
    validateAssets(fixture).some((error) =>
      error.includes("Runtime asset files do not match"),
    ),
  );
});

test("test-only assets are rejected by the release gate", (context) => {
  const fixture = createFixture(context);
  configureFixtureAssets(fixture);
  for (const relative of ["models/configured.vrm", "animations/configured.vrma"]) {
    const absolute = path.join(fixture.assetRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, "local test media");
  }
  const errors = validateAssets({ ...fixture, release: true });
  assert.ok(errors.some((error) => error.includes("distribution is disabled")));
});
