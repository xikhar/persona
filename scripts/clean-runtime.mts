import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EMITTED_RUNTIME_PATTERN = /\.cjs(?:\.map)?$/;

export function cleanRuntimeOutput(
  roots: readonly string[] = ['electron', 'scripts'],
): void {
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        cleanRuntimeOutput([entryPath]);
      } else if (entry.isFile() && EMITTED_RUNTIME_PATTERN.test(entry.name)) {
        fs.unlinkSync(entryPath);
      }
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === path.resolve(invokedPath)) {
  cleanRuntimeOutput();
}
