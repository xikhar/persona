import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { resolveNativeHelperPath } from '../electron/native-process-audio-listener.cjs';
import { isRecord } from '../electron/types.cjs';

export function testNative(platform: NodeJS.Platform = process.platform): void {
  if (!["darwin", "win32"].includes(platform)) {
    console.log("Persona's Linux listener is covered by the Node test suite.");
    return;
  }
  const executable = resolveNativeHelperPath({
    platform,
    isPackaged: false,
    projectRoot: path.join(__dirname, ".."),
  });
  const result = spawnSync(executable, ["--self-test"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || `Native self-test exited with ${result.status}.`);
  }
  const message: unknown = JSON.parse(result.stdout.trim());
  if (!isRecord(message) || message.type !== 'ready') {
    throw new Error('Native self-test returned an invalid response.');
  }
  console.log(`${String(message.source)} passed.`);
}

if (require.main === module) {
  try {
    testNative();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
