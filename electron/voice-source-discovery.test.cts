import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listVoiceSources,
  pipeWireSources,
  processSources,
} from './voice-source-discovery.cjs';

test("lists distinct PipeWire playback streams and ignores input nodes", () => {
  const sources = pipeWireSources([
    {
      id: 1,
      type: "PipeWire:Interface:Node",
      info: {
        state: "running",
        props: {
          "application.name": "Electron",
          "application.process.binary": "voice-ui",
          "media.class": "Stream/Output/Audio",
          "node.name": "voice-output",
        },
      },
    },
    {
      id: 2,
      type: "PipeWire:Interface:Node",
      info: {
        state: "running",
        props: {
          "application.name": "Electron",
          "application.process.binary": "music-ui",
          "media.class": "Stream/Output/Audio",
          "node.name": "music-output",
        },
      },
    },
    {
      id: 3,
      type: "PipeWire:Interface:Node",
      info: {
        props: {
          "application.name": "Microphone",
          "media.class": "Stream/Input/Audio",
        },
      },
    },
  ]);
  assert.equal(sources.length, 2);
  assert.ok(sources[0] && sources[1]);
  assert.notEqual(sources[0].id, sources[1].id);
});

test("lists unique native applications without exposing arguments or Persona children", () => {
  const sources = processSources(
    "darwin",
    [
      {
        pid: 10,
        parentId: 1,
        name: "/Applications/Voice.app/Contents/MacOS/Voice",
        executable: "/Applications/Voice.app/Contents/MacOS/Voice",
        command: "Voice --api-key secret",
      },
      {
        pid: 11,
        parentId: 10,
        name: "/Applications/Voice.app/Contents/MacOS/Voice",
        executable: "/Applications/Voice.app/Contents/MacOS/Voice",
        command: "Voice --child",
      },
      {
        pid: 99,
        parentId: 1,
        name: "Persona",
        executable: "/Applications/Persona.app/Contents/MacOS/Persona",
        command: "Persona",
      },
      {
        pid: 100,
        parentId: 99,
        name: "Persona Helper",
        executable: "/Applications/Persona.app/Contents/MacOS/Persona Helper",
        command: "Persona Helper --renderer",
      },
    ],
    99,
  );
  assert.equal(sources.length, 1);
  assert.ok(sources[0]);
  assert.equal(sources[0].name, "Voice");
  assert.equal(sources[0].detail.includes("secret"), false);
});

test("routes discovery through each supported platform adapter", async () => {
  const linux = await listVoiceSources({
    platform: "linux",
    run: async () => ({
      stdout: JSON.stringify([
        {
          id: 10,
          type: "PipeWire:Interface:Node",
          info: {
            props: {
              "application.name": "Voice",
              "media.class": "Stream/Output/Audio",
              "node.name": "voice-output",
            },
          },
        },
      ]),
    }),
  });
  assert.ok(linux.sources[0]);
  assert.equal(linux.sources[0].name, "Voice");

  const mac = await listVoiceSources({
    platform: "darwin",
    ownProcessId: 999,
    run: async (_command, args) => ({
      stdout: args[1]?.includes("ppid") === true
        ? "10 1 /Applications/Voice Engine.app/Contents/MacOS/Voice Engine\n"
        : "10 /Applications/Voice Engine.app/Contents/MacOS/Voice Engine --serve\n",
    }),
  });
  assert.ok(mac.sources[0]);
  assert.equal(mac.sources[0].name, "Voice Engine");

  const windows = await listVoiceSources({
    platform: "win32",
    ownProcessId: 999,
    run: async () => ({
      stdout: JSON.stringify({
        ProcessId: 20,
        ParentProcessId: 1,
        Name: "Voice.exe",
        ExecutablePath: "C:\\Apps\\Voice.exe",
        CommandLine: "Voice.exe --serve",
      }),
    }),
  });
  assert.ok(windows.sources[0]);
  assert.equal(windows.sources[0].name, "Voice");
});
