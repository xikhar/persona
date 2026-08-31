import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportAnimationLibraryClip } from './animation-clip-export.cjs';
import type { PersonaAnimationLibraryClip } from '../shared/persona-api.js';

function clip(overrides: Partial<PersonaAnimationLibraryClip> = {}): PersonaAnimationLibraryClip {
  return {
    id: '69c0e6fb-b0d4-460e-a202-35d538469a03',
    clip_name: 'friendly-wave',
    source: 'kimodo',
    asset_url: 'persona-asset://animation/69c0e6fb-b0d4-460e-a202-35d538469a03.vrma',
    created_at: '2026-09-01T00:00:00.000Z',
    prompt: 'A friendly wave.',
    generation_job_id: 'job-1',
    linked_action_ids: [],
    ...overrides,
  };
}

test('exports a saved clip through a caller-selected destination', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-clip-export-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'stored.vrma');
  const destinationPath = path.join(directory, 'downloaded.vrma');
  fs.writeFileSync(sourcePath, 'vrma-data');
  let suggestedFilename = '';

  const saved = await exportAnimationLibraryClip({
    clipId: clip().id,
    selectDestination: async (suggested) => {
      suggestedFilename = suggested;
      return destinationPath;
    },
    store: {
      getSnapshot: () => ({ animation_clips: [clip()] }),
      resolveAssetRequest: () => sourcePath,
    },
  });

  assert.equal(saved, true);
  assert.equal(suggestedFilename, 'friendly-wave.vrma');
  assert.equal(fs.readFileSync(destinationPath, 'utf8'), 'vrma-data');
});

test('leaves the filesystem untouched when the save dialog is cancelled', async () => {
  let resolved = false;
  const saved = await exportAnimationLibraryClip({
    clipId: clip().id,
    selectDestination: async () => null,
    store: {
      getSnapshot: () => ({ animation_clips: [clip()] }),
      resolveAssetRequest: () => {
        resolved = true;
        return '/owned/clip.vrma';
      },
    },
  });

  assert.equal(saved, false);
  assert.equal(resolved, true);
});

test('rejects unknown clips before opening a save dialog', async () => {
  let selected = false;
  await assert.rejects(
    exportAnimationLibraryClip({
      clipId: 'missing',
      selectDestination: async () => {
        selected = true;
        return '/tmp/clip.vrma';
      },
      store: {
        getSnapshot: () => ({ animation_clips: [] }),
        resolveAssetRequest: () => null,
      },
    }),
    /Animation clip was not found/,
  );
  assert.equal(selected, false);
});

test('rejects a library record whose owned file is unavailable', async () => {
  await assert.rejects(
    exportAnimationLibraryClip({
      clipId: clip().id,
      selectDestination: async () => '/tmp/clip.vrma',
      store: {
        getSnapshot: () => ({ animation_clips: [clip()] }),
        resolveAssetRequest: () => null,
      },
    }),
    /Animation clip file is unavailable/,
  );
});
