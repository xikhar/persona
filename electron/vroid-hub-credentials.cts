import fs from 'node:fs';
import path from 'node:path';

/**
 * Encrypted-at-rest storage for a user-supplied VRoid Hub OAuth app's
 * client ID/secret (registered at hub.vroid.com/oauth/applications),
 * separate from the OAuth session tokens stored by vroid-hub-auth.cts.
 * Same on-disk shape and injected encrypt/decrypt callbacks as that module.
 */

export interface VroidHubCredentials {
  clientId: string;
  clientSecret: string;
}

export interface VroidHubCredentialsInput {
  clientId?: unknown;
  clientSecret?: unknown;
}

interface CredentialsStorage {
  credentialsFilePath: string;
  decrypt: (encrypted: Buffer) => Buffer;
}

interface WritableCredentialsStorage {
  credentialsFilePath: string;
  encrypt: (plaintext: Buffer) => Buffer;
}

function requiredField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

export function readVroidHubCredentials({
  credentialsFilePath,
  decrypt,
}: CredentialsStorage): VroidHubCredentials | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsFilePath, "utf8"));
    if (typeof parsed?.encrypted !== "string") return null;
    const decrypted = decrypt(Buffer.from(parsed.encrypted, "base64"));
    const record = JSON.parse(decrypted.toString("utf8"));
    if (
      typeof record?.client_id !== "string" ||
      typeof record?.client_secret !== "string"
    ) {
      return null;
    }
    return { clientId: record.client_id, clientSecret: record.client_secret };
  } catch {
    return null;
  }
}

export function writeVroidHubCredentials(
  { credentialsFilePath, encrypt }: WritableCredentialsStorage,
  { clientId, clientSecret }: VroidHubCredentialsInput,
): void {
  const record = {
    client_id: requiredField(clientId, "Client ID"),
    client_secret: requiredField(clientSecret, "Client secret"),
  };
  fs.mkdirSync(path.dirname(credentialsFilePath), { recursive: true });
  const encrypted = encrypt(Buffer.from(JSON.stringify(record), "utf8")).toString(
    "base64",
  );
  const temporaryPath = `${credentialsFilePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify({ encrypted }), {
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, credentialsFilePath);
}

export function clearVroidHubCredentials({
  credentialsFilePath,
}: Pick<CredentialsStorage, 'credentialsFilePath'>): void {
  try {
    fs.unlinkSync(credentialsFilePath);
  } catch {
    // Already absent.
  }
}
