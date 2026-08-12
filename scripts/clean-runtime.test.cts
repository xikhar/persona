import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';

function fixture(context: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-runtime-clean-'));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

test('runtime cleanup removes only generated CommonJS output', (context) => {
  const root = fixture(context);
  const electronDirectory = path.join(root, 'electron');
  const nestedDirectory = path.join(electronDirectory, 'nested');
  const scriptsDirectory = path.join(root, 'scripts');
  fs.mkdirSync(nestedDirectory, { recursive: true });
  fs.mkdirSync(scriptsDirectory, { recursive: true });
  for (const filePath of [
    path.join(electronDirectory, 'main.cjs'),
    path.join(electronDirectory, 'main.cjs.map'),
    path.join(nestedDirectory, 'stale.cjs'),
    path.join(scriptsDirectory, 'tool.cjs'),
  ]) {
    fs.writeFileSync(filePath, 'generated');
  }
  const sourcePath = path.join(electronDirectory, 'main.cts');
  fs.writeFileSync(sourcePath, 'source');

  const cleanerPath = path.join(__dirname, 'clean-runtime.mts');
  const result = spawnSync(process.execPath, [cleanerPath], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(sourcePath), true);
  assert.equal(fs.existsSync(path.join(electronDirectory, 'main.cjs')), false);
  assert.equal(fs.existsSync(path.join(electronDirectory, 'main.cjs.map')), false);
  assert.equal(fs.existsSync(path.join(nestedDirectory, 'stale.cjs')), false);
  assert.equal(fs.existsSync(path.join(scriptsDirectory, 'tool.cjs')), false);
});
