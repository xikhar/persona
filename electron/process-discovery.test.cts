import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configuredPattern,
  mergeMacProcessCommands,
  parseMacCommandList,
  parseMacProcessList,
  parseWindowsProcessList,
  selectVoiceProcessTree,
} from './process-discovery.cjs';
import { sourceFromProcess } from './voice-source.cjs';

test("parses macOS ps output and includes a Codex helper process tree", () => {
  const processes = mergeMacProcessCommands(
    parseMacProcessList(`
  10 1 /Applications/Codex.app/Contents/MacOS/Codex
  11 10 /Applications/Codex Helper.app/Contents/MacOS/Codex Helper
  20 1 /Applications/Music.app/MacOS/Music
`),
    parseMacCommandList(`
  10 /Applications/Codex.app/Contents/MacOS/Codex
  11 /Applications/Codex Helper.app/Contents/MacOS/Codex Helper --type=utility
  20 /Applications/Music.app/MacOS/Music
`),
  );
  assert.deepEqual(selectVoiceProcessTree(processes, { ownProcessId: 99 }), {
    pids: [10, 11],
    rootPids: [10],
  });
});

test("parses one or many Windows CIM process records", () => {
  const processes = parseWindowsProcessList(
    JSON.stringify([
      {
        ProcessId: 100,
        ParentProcessId: 1,
        Name: "Codex.exe",
        ExecutablePath: "C:\\Program Files\\Codex\\Codex.exe",
        CommandLine: '"C:\\\\Program Files\\\\Codex\\\\Codex.exe"',
      },
      {
        ProcessId: 101,
        ParentProcessId: 100,
        Name: "electron.exe",
        CommandLine: "electron.exe --type=utility",
      },
    ]),
  );
  assert.deepEqual(selectVoiceProcessTree(processes, { ownProcessId: 999 }), {
    pids: [100, 101],
    rootPids: [100],
  });
  assert.equal(parseWindowsProcessList('{"ProcessId":7,"Name":"ChatGPT.exe"}')[0]?.pid, 7);
});

test("selects a saved native application by stable executable identity", () => {
  const processes = [
    {
      pid: 70,
      parentId: 1,
      name: "Voice Engine",
      executable: "/Applications/Voice Engine.app/Contents/MacOS/Voice Engine",
      command: "Voice Engine --server",
    },
    {
      pid: 71,
      parentId: 70,
      name: "Voice Helper",
      executable: "/Applications/Voice Engine.app/Contents/MacOS/Voice Helper",
      command: "Voice Helper --audio",
    },
  ];
  const rootProcess = processes[0];
  assert.ok(rootProcess);
  const source = sourceFromProcess("darwin", rootProcess);
  assert.ok(source);
  assert.deepEqual(
    selectVoiceProcessTree(processes, {
      ownProcessId: 999,
      platform: "darwin",
      sourceId: source.id,
    }),
    { pids: [70, 71], rootPids: [70] },
  );
});

test("supports a custom target application pattern without accepting invalid regex", () => {
  assert.equal(configuredPattern({ PERSONA_TARGET_PROCESS_PATTERN: "my-voice-app" }).test("my-voice-app"), true);
  assert.equal(configuredPattern({ PERSONA_TARGET_PROCESS_PATTERN: "[" }).test("Codex"), true);
});

test("selects processes with an explicit pattern override", () => {
  const selected = selectVoiceProcessTree(
    [
      {
        pid: 50,
        parentId: 1,
        name: "local-tts",
        executable: "/usr/bin/local-tts",
        command: "/usr/bin/local-tts",
      },
      {
        pid: 51,
        parentId: 1,
        name: "Codex",
        executable: "/Applications/Codex.app/Contents/MacOS/Codex",
        command: "/Applications/Codex.app/Contents/MacOS/Codex",
      },
    ],
    { ownProcessId: 999, pattern: /local-tts/i },
  );
  assert.deepEqual(selected, { pids: [50], rootPids: [50] });
});

test("does not confuse Persona's project path with the Codex application", () => {
  const selected = selectVoiceProcessTree(
    [
      {
        pid: 40,
        parentId: 1,
        name: "persona",
        executable: "/home/user/Projects/persona/release/persona",
        command: "/home/user/Projects/persona/release/persona",
      },
    ],
    { ownProcessId: 999 },
  );
  assert.deepEqual(selected, { pids: [], rootPids: [] });
});
