"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DEFAULT_VOICE_APP_PATTERN,
  DEFAULT_VOICE_SOURCE,
  compileVoiceSourcePattern,
  configuredPattern,
  normalizeVoiceSource,
  resolveVoiceSourcePattern,
  sanitizeVoiceSourcePattern,
  settingsPatternFromVoiceSource,
} = require("./voice-source.cjs");

test("compiles the shared default ChatGPT and Codex pattern", () => {
  assert.equal(DEFAULT_VOICE_APP_PATTERN.test("Codex"), true);
  assert.equal(DEFAULT_VOICE_APP_PATTERN.test("ChatGPT.exe"), true);
  assert.equal(DEFAULT_VOICE_APP_PATTERN.test("openai-codex"), true);
  assert.equal(DEFAULT_VOICE_APP_PATTERN.test("persona"), false);
  assert.equal(
    compileVoiceSourcePattern("[").source,
    DEFAULT_VOICE_APP_PATTERN.source,
  );
});

test("prefers the environment override, then settings, then the default", () => {
  const fromEnv = resolveVoiceSourcePattern({
    environment: { PERSONA_TARGET_PROCESS_PATTERN: "local-tts" },
    settingsPattern: "settings-app",
  });
  assert.equal(fromEnv.test("local-tts"), true);
  assert.equal(fromEnv.test("settings-app"), false);

  const fromSettings = resolveVoiceSourcePattern({
    environment: {},
    settingsPattern: "settings-app",
  });
  assert.equal(fromSettings.test("settings-app"), true);
  assert.equal(fromSettings.test("Codex"), false);

  const fromDefault = resolveVoiceSourcePattern({
    environment: {},
    settingsPattern: null,
  });
  assert.equal(fromDefault.test("Codex"), true);
  assert.equal(configuredPattern({}).test("ChatGPT"), true);
});

test("sanitizes and normalizes persisted voice source values", () => {
  assert.equal(sanitizeVoiceSourcePattern("  my-voice-app  "), "my-voice-app");
  assert.throws(() => sanitizeVoiceSourcePattern(""), /required/);
  assert.throws(() => sanitizeVoiceSourcePattern("["), /valid regular expression/);
  assert.deepEqual(normalizeVoiceSource(null), DEFAULT_VOICE_SOURCE);
  assert.deepEqual(
    normalizeVoiceSource({ mode: "custom", process_pattern: "local-tts" }),
    { mode: "custom", process_pattern: "local-tts" },
  );
  assert.deepEqual(
    normalizeVoiceSource({ mode: "custom", process_pattern: "[" }),
    DEFAULT_VOICE_SOURCE,
  );
  assert.equal(
    settingsPatternFromVoiceSource({
      mode: "custom",
      process_pattern: "local-tts",
    }),
    "local-tts",
  );
  assert.equal(
    settingsPatternFromVoiceSource({ mode: "default", process_pattern: null }),
    null,
  );
});
