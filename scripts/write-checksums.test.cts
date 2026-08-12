import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { releaseFiles, writeChecksums } from './write-checksums.cjs';

test("writes stable SHA-256 entries for installers and ignores unpacked files", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "persona-checksums-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(directory, "Persona-0.1.0-beta.0-linux-x64.AppImage"),
    "persona",
  );
  fs.writeFileSync(path.join(directory, "builder-debug.yml"), "internal");

  assert.deepEqual(releaseFiles(directory), [
    "Persona-0.1.0-beta.0-linux-x64.AppImage",
  ]);
  const output = writeChecksums(directory);
  assert.match(
    fs.readFileSync(output, "utf8"),
    /^[a-f0-9]{64} {2}Persona-0\.1\.0-beta\.0-linux-x64\.AppImage\n$/,
  );
});
