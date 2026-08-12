import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function getConnectSource() {
  const indexPath = path.join(__dirname, "..", "index.html");
  const index = fs.readFileSync(indexPath, "utf8");
  const policy = index.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
  )?.[1];

  assert.ok(policy, "index.html must define a Content Security Policy");
  return policy
    .split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("connect-src "));
}

test("allows embedded VRM textures to load through blob fetches", () => {
  const connectSource = getConnectSource();
  assert.ok(connectSource, "Content Security Policy must define connect-src");
  assert.match(connectSource, /(?:^|\s)blob:(?:\s|$)/);
});

test("allows the bundled reflection environment to load through a data fetch", () => {
  const connectSource = getConnectSource();
  assert.ok(connectSource, "Content Security Policy must define connect-src");
  assert.match(connectSource, /(?:^|\s)data:(?:\s|$)/);
});

test("allows only Persona's local asset protocol for imported character media", () => {
  const connectSource = getConnectSource();
  assert.ok(connectSource, "Content Security Policy must define connect-src");
  assert.match(connectSource, /(?:^|\s)persona-asset:(?:\s|$)/);
});
