import assert from 'node:assert/strict';
import test from 'node:test';
import {
  macosCompilerArguments,
  windowsBuildCommand,
} from './build-native.cjs';

test("builds the macOS listener against the supported Core Audio target", () => {
  const args = macosCompilerArguments();
  assert.ok(args.includes("-mmacosx-version-min=14.2"));
  assert.ok(args.includes("native/macos/PersonaAudioListener.mm"));
  assert.deepEqual(
    args.filter((argument) => argument === "CoreAudio"),
    ["CoreAudio"],
  );
});

test("emits one complete Windows compiler invocation after the developer shell", () => {
  const command = windowsBuildCommand(
    "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\Common7\\Tools\\VsDevCmd.bat",
  );
  assert.equal(
    command,
    'call "C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise\\Common7\\Tools\\VsDevCmd.bat" -no_logo -arch=x64 -host_arch=x64 && cl.exe /nologo /std:c++20 /EHsc /O2 /DUNICODE /D_UNICODE native\\windows\\PersonaAudioListener.cpp /Fe:native\\bin\\win32\\persona-audio-listener.exe',
  );
  assert.equal(command.split(" && ").length, 2);
});
