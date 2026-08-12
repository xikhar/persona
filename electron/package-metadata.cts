import fs from 'node:fs';
import path from 'node:path';
import { isRecord } from './types.cjs';

export interface PackageMetadata {
  version: string;
}

export function readPackageMetadata(
  packagePath = path.join(__dirname, '..', 'package.json'),
): PackageMetadata {
  const parsed: unknown = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (!isRecord(parsed) || typeof parsed.version !== 'string') {
    throw new Error(`Package metadata has no valid version: ${packagePath}`);
  }
  return { version: parsed.version };
}
