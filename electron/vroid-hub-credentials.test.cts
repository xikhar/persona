import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  clearVroidHubCredentials,
  readVroidHubCredentials,
  writeVroidHubCredentials,
} from './vroid-hub-credentials.cjs';

function fixture(context: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-vroid-creds-"));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return path.join(root, "vroid-hub-credentials.json");
}

// Not real encryption, just proves the store actually transforms bytes and
// round-trips through the injected callbacks rather than assuming identity.
function hexCodec(): {
  encrypt: (buffer: Buffer) => Buffer;
  decrypt: (buffer: Buffer) => Buffer;
} {
  return {
    encrypt: (buffer: Buffer) => Buffer.from(buffer.toString("hex")),
    decrypt: (buffer: Buffer) => Buffer.from(buffer.toString(), "hex"),
  };
}

test("round-trips client id and secret through encrypt/decrypt", (context) => {
  const credentialsFilePath = fixture(context);
  const { encrypt, decrypt } = hexCodec();

  writeVroidHubCredentials(
    { credentialsFilePath, encrypt },
    { clientId: "client-123", clientSecret: "secret-456" },
  );

  const raw = JSON.parse(fs.readFileSync(credentialsFilePath, "utf8"));
  assert.equal(typeof raw.encrypted, "string");
  assert.doesNotMatch(raw.encrypted, /client-123|secret-456/);

  const read = readVroidHubCredentials({ credentialsFilePath, decrypt });
  assert.deepEqual(read, { clientId: "client-123", clientSecret: "secret-456" });
});

test("trims whitespace around client id and secret", (context) => {
  const credentialsFilePath = fixture(context);
  const { encrypt, decrypt } = hexCodec();

  writeVroidHubCredentials(
    { credentialsFilePath, encrypt },
    { clientId: "  client-123  ", clientSecret: "  secret-456  " },
  );

  assert.deepEqual(readVroidHubCredentials({ credentialsFilePath, decrypt }), {
    clientId: "client-123",
    clientSecret: "secret-456",
  });
});

test("rejects a blank client id or secret", (context) => {
  const credentialsFilePath = fixture(context);
  const { encrypt } = hexCodec();

  assert.throws(() =>
    writeVroidHubCredentials(
      { credentialsFilePath, encrypt },
      { clientId: "", clientSecret: "secret-456" },
    ),
  );
  assert.throws(() =>
    writeVroidHubCredentials(
      { credentialsFilePath, encrypt },
      { clientId: "client-123", clientSecret: "   " },
    ),
  );
  assert.throws(() =>
    writeVroidHubCredentials(
      { credentialsFilePath, encrypt },
      { clientId: undefined, clientSecret: "secret-456" },
    ),
  );
});

test("returns null when no credentials file exists", (context) => {
  const credentialsFilePath = fixture(context);
  const { decrypt } = hexCodec();
  assert.equal(readVroidHubCredentials({ credentialsFilePath, decrypt }), null);
});

test("returns null for a corrupt or malformed file", (context) => {
  const credentialsFilePath = fixture(context);
  const { decrypt } = hexCodec();

  fs.mkdirSync(path.dirname(credentialsFilePath), { recursive: true });
  fs.writeFileSync(credentialsFilePath, "not json");
  assert.equal(readVroidHubCredentials({ credentialsFilePath, decrypt }), null);

  fs.writeFileSync(credentialsFilePath, JSON.stringify({ encrypted: 42 }));
  assert.equal(readVroidHubCredentials({ credentialsFilePath, decrypt }), null);

  fs.writeFileSync(
    credentialsFilePath,
    JSON.stringify({ encrypted: Buffer.from("{}").toString("hex") }),
  );
  assert.equal(readVroidHubCredentials({ credentialsFilePath, decrypt }), null);
});

test("clearVroidHubCredentials removes the file and is idempotent", (context) => {
  const credentialsFilePath = fixture(context);
  const { encrypt, decrypt } = hexCodec();

  writeVroidHubCredentials(
    { credentialsFilePath, encrypt },
    { clientId: "client-123", clientSecret: "secret-456" },
  );
  assert.ok(fs.existsSync(credentialsFilePath));

  clearVroidHubCredentials({ credentialsFilePath });
  assert.equal(fs.existsSync(credentialsFilePath), false);
  assert.equal(readVroidHubCredentials({ credentialsFilePath, decrypt }), null);

  // Calling again on an already-absent file must not throw.
  clearVroidHubCredentials({ credentialsFilePath });
});
