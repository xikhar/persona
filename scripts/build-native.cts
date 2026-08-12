import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = path.join(__dirname, "..");

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

export function macosCompilerArguments(): string[] {
  return [
    "--sdk",
    "macosx",
    "clang++",
    "-std=c++20",
    "-fobjc-arc",
    "-O2",
    "-mmacosx-version-min=14.2",
    "native/macos/PersonaAudioListener.mm",
    "-framework",
    "Foundation",
    "-framework",
    "CoreAudio",
    "-o",
    "native/bin/darwin/persona-audio-listener",
  ];
}

export function windowsBuildCommand(developerShell: string): string {
  const compiler = [
    "cl.exe /nologo /std:c++20 /EHsc /O2 /DUNICODE /D_UNICODE",
    "native\\windows\\PersonaAudioListener.cpp",
    "/Fe:native\\bin\\win32\\persona-audio-listener.exe",
  ].join(" ");
  return `call "${developerShell}" -no_logo -arch=x64 -host_arch=x64 && ${compiler}`;
}

function runWindowsBuildCommand(command: string): void {
  try {
    // execSync uses ComSpec on Windows and preserves the nested quotes required
    // to call a batch file whose path contains spaces.
    execSync(command, {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      windowsHide: true,
    });
  } catch (error) {
    const status =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      Number.isInteger(error.status)
        ? String(error.status)
        : 'unknown';
    throw new Error(`Windows native build failed with exit code ${status}.`, {
      cause: error,
    });
  }
}

export function buildNative(
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "darwin") {
    const outputDirectory = path.join(PROJECT_ROOT, "native", "bin", "darwin");
    fs.mkdirSync(outputDirectory, { recursive: true });
    run("xcrun", macosCompilerArguments());
    return path.join(outputDirectory, "persona-audio-listener");
  }
  if (platform === "win32") {
    const outputDirectory = path.join(PROJECT_ROOT, "native", "bin", "win32");
    fs.mkdirSync(outputDirectory, { recursive: true });
    const installerRoot = process.env["ProgramFiles(x86)"];
    const vswhere = installerRoot
      ? path.join(installerRoot, "Microsoft Visual Studio", "Installer", "vswhere.exe")
      : null;
    if (!vswhere || !fs.existsSync(vswhere)) {
      throw new Error("Visual Studio Build Tools were not found.");
    }
    const discovery = spawnSync(
      vswhere,
      ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
      { encoding: "utf8", windowsHide: true },
    );
    const installationPath = discovery.stdout.trim();
    if (discovery.status !== 0 || !installationPath) {
      throw new Error("The Visual C++ x64 build tools were not found.");
    }
    const developerShell = path.join(installationPath, "Common7", "Tools", "VsDevCmd.bat");
    runWindowsBuildCommand(windowsBuildCommand(developerShell));
    return path.join(outputDirectory, "persona-audio-listener.exe");
  }
  console.log("Persona uses PipeWire commands directly on Linux; no native helper build is needed.");
  return null;
}

if (require.main === module) {
  try {
    const output = buildNative();
    if (output) console.log(`Built ${output}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
