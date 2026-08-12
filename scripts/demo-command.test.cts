import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test("demo builds and launches the real listener runtime", () => {
  const projectRoot = path.join(__dirname, "..");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
  const mainProcess = fs.readFileSync(
    path.join(projectRoot, "electron", "main.cjs"),
    "utf8",
  );

  assert.equal(packageJson.scripts.demo, "npm run build && electron .");
  assert.doesNotMatch(mainProcess, /--demo|demoMode|startDemo/);
});

test('development recompiles runtime TypeScript and restarts Electron', () => {
  const projectRoot = path.join(__dirname, '..');
  const packageJson: unknown = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  assert.ok(
    packageJson != null &&
      typeof packageJson === 'object' &&
      'scripts' in packageJson &&
      packageJson.scripts != null &&
      typeof packageJson.scripts === 'object',
  );
  const scripts = packageJson.scripts;
  assert.ok('dev' in scripts && typeof scripts.dev === 'string');
  assert.match(scripts.dev, /tsc -p tsconfig\.runtime\.json --watch/);
  assert.match(scripts.dev, /nodemon[^\n]+--watch electron --ext cjs/);
});
