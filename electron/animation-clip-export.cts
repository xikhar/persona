import fs from 'node:fs';
import path from 'node:path';
import type { PersonaSettingsSnapshot } from '../shared/persona-api.js';

interface AnimationClipExportStore {
  getSnapshot(): Pick<PersonaSettingsSnapshot, 'animation_clips'>;
  resolveAssetRequest(rawUrl: string): string | { buffer: Buffer } | null;
}

interface AnimationClipExportOptions {
  clipId: string;
  selectDestination(suggestedFilename: string): Promise<string | null>;
  store: AnimationClipExportStore;
}

async function pathsReferToSameFile(left: string, right: string): Promise<boolean> {
  if (path.resolve(left) === path.resolve(right)) return true;
  try {
    const [leftStats, rightStats] = await Promise.all([
      fs.promises.stat(left),
      fs.promises.stat(right),
    ]);
    return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino;
  } catch {
    return false;
  }
}

/**
 * Exports one Persona-owned reusable clip without accepting a renderer path.
 * The caller owns the native save dialog; this helper owns clip lookup and IO.
 */
export async function exportAnimationLibraryClip({
  clipId,
  selectDestination,
  store,
}: AnimationClipExportOptions): Promise<boolean> {
  const clip = store.getSnapshot().animation_clips.find(
    (candidate) => candidate.id === clipId,
  );
  if (!clip) throw new Error('Animation clip was not found.');

  const sourcePath = store.resolveAssetRequest(clip.asset_url);
  if (typeof sourcePath !== 'string') {
    throw new Error('Animation clip file is unavailable.');
  }

  const destinationPath = await selectDestination(`${clip.clip_name}.vrma`);
  if (!destinationPath) return false;
  if (!(await pathsReferToSameFile(sourcePath, destinationPath))) {
    await fs.promises.copyFile(sourcePath, destinationPath);
  }
  return true;
}
