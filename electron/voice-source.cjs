"use strict";

const DEFAULT_VOICE_SOURCE = Object.freeze({
  mode: "default",
  process_pattern: null,
});

const DEFAULT_VOICE_APP_PATTERN_SOURCE =
  "(?:^|[\\\\/\\s._=-])(?:codex(?:-desktop)?|chatgpt|openai(?:-codex)?)(?=$|[\\\\/\\s._=-])";

const DEFAULT_VOICE_APP_PATTERN = new RegExp(
  DEFAULT_VOICE_APP_PATTERN_SOURCE,
  "i",
);

const MAX_VOICE_SOURCE_PATTERN_LENGTH = 200;

function compileVoiceSourcePattern(source) {
  if (typeof source !== "string" || !source.trim()) {
    return DEFAULT_VOICE_APP_PATTERN;
  }
  try {
    return new RegExp(source, "i");
  } catch {
    return DEFAULT_VOICE_APP_PATTERN;
  }
}

function sanitizeVoiceSourcePattern(value) {
  if (typeof value !== "string") {
    throw new Error("Process pattern is required.");
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Process pattern is required.");
  }
  if (normalized.length > MAX_VOICE_SOURCE_PATTERN_LENGTH) {
    throw new Error(
      `Process pattern must be ${MAX_VOICE_SOURCE_PATTERN_LENGTH} characters or fewer.`,
    );
  }
  try {
    // Ensure the pattern compiles before persisting it.
    new RegExp(normalized, "i");
  } catch {
    throw new Error("Process pattern must be a valid regular expression.");
  }
  return normalized;
}

function normalizeVoiceSource(value) {
  const mode = value?.mode === "custom" ? "custom" : "default";
  if (mode === "default") {
    return { mode: "default", process_pattern: null };
  }
  try {
    return {
      mode: "custom",
      process_pattern: sanitizeVoiceSourcePattern(value?.process_pattern),
    };
  } catch {
    return { ...DEFAULT_VOICE_SOURCE };
  }
}

function settingsPatternFromVoiceSource(voiceSource) {
  const normalized = normalizeVoiceSource(voiceSource);
  return normalized.mode === "custom" ? normalized.process_pattern : null;
}

function resolveVoiceSourcePattern({
  environment = process.env,
  settingsPattern = null,
} = {}) {
  const envSource = environment?.PERSONA_TARGET_PROCESS_PATTERN;
  if (typeof envSource === "string" && envSource.trim()) {
    return compileVoiceSourcePattern(envSource);
  }
  if (typeof settingsPattern === "string" && settingsPattern.trim()) {
    return compileVoiceSourcePattern(settingsPattern);
  }
  return DEFAULT_VOICE_APP_PATTERN;
}

function configuredPattern(environment = process.env) {
  return resolveVoiceSourcePattern({ environment });
}

module.exports = {
  DEFAULT_VOICE_APP_PATTERN,
  DEFAULT_VOICE_APP_PATTERN_SOURCE,
  DEFAULT_VOICE_SOURCE,
  MAX_VOICE_SOURCE_PATTERN_LENGTH,
  compileVoiceSourcePattern,
  configuredPattern,
  normalizeVoiceSource,
  resolveVoiceSourcePattern,
  sanitizeVoiceSourcePattern,
  settingsPatternFromVoiceSource,
};
