import { readPackageMetadata } from '../electron/package-metadata.cjs';

const packageVersion = readPackageMetadata().version;

export function expectedReleaseTag(version = packageVersion): string {
  return `v${version}`;
}

export function validateReleaseTag(
  tag: string | undefined,
  version = packageVersion,
): string {
  const expected = expectedReleaseTag(version);
  if (tag !== expected) {
    throw new Error(`Release tag ${JSON.stringify(tag)} must match ${expected}.`);
  }
  return expected;
}

if (require.main === module) {
  try {
    validateReleaseTag(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
