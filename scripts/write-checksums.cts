import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RELEASE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.AppImage',
  '.deb',
  '.dmg',
  '.exe',
  '.zip',
]);

export function releaseFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && RELEASE_EXTENSIONS.has(path.extname(entry.name)))
    .map((entry) => entry.name)
    .sort();
}

export function writeChecksums(directory: string): string {
  const files = releaseFiles(directory);
  if (files.length === 0) throw new Error(`No Persona release files found in ${directory}`);
  const lines = files.map((filename) => {
    const contents = fs.readFileSync(path.join(directory, filename));
    const digest = nodeCrypto.createHash("sha256").update(contents).digest("hex");
    return `${digest}  ${filename}`;
  });
  const output = path.join(directory, "SHA256SUMS.txt");
  fs.writeFileSync(output, `${lines.join("\n")}\n`);
  return output;
}

if (require.main === module) {
  try {
    const directory = path.resolve(process.argv[2] || "release");
    console.log(`Wrote ${writeChecksums(directory)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
