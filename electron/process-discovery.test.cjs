"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  configuredPattern,
  parseMacProcessList,
  parseWindowsProcessList,
  selectVoiceProcessTree,
} = require("./process-discovery.cjs");

test("parses macOS ps output and includes a Codex helper process tree", () => {
  const processes = parseMacProcessList(`
  10 1 /Applications/Codex.app/Contents/MacOS/Codex /Applications/Codex.app/Contents/MacOS/Codex
  11 10 /Applications/Codex Helper /Applications/Codex.app/Contents/Frameworks/Codex Helper --type=utility
  20 1 /Applications/Music.app/MacOS/Music /Applications/Music.app/MacOS/Music
`);
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
  assert.equal(parseWindowsProcessList('{"ProcessId":7,"Name":"ChatGPT.exe"}')[0].pid, 7);
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
        command: "/usr/bin/local-tts",
      },
      {
        pid: 51,
        parentId: 1,
        name: "Codex",
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
        command: "/home/user/Projects/persona/release/persona",
      },
    ],
    { ownProcessId: 999 },
  );
  assert.deepEqual(selected, { pids: [], rootPids: [] });
});
