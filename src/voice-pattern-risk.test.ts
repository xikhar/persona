import { describe, expect, it } from 'vitest';
import {
  hasNestedUnboundedQuantifier,
  voicePatternRisk,
  voicePatternRiskMessage,
} from './voice-pattern-risk';

// Mirrors DEFAULT_VOICE_APP_PATTERN_SOURCE in electron/voice-source.cts.
const PACKAGED_PATTERN =
  '(?:^|[\\\\/\\s._=-])(?:codex(?:-desktop)?|chatgpt|openai(?:-codex)?)(?=$|[\\\\/\\s._=-])';

describe('hasNestedUnboundedQuantifier', () => {
  it('finds the classic exponential shapes', () => {
    expect(hasNestedUnboundedQuantifier('(a+)+')).toBe(true);
    expect(hasNestedUnboundedQuantifier('(a*)*')).toBe(true);
    expect(hasNestedUnboundedQuantifier('(a+)*b')).toBe(true);
    expect(hasNestedUnboundedQuantifier('(\\w*)+')).toBe(true);
    expect(hasNestedUnboundedQuantifier('(?:x{1,})+')).toBe(true);
    expect(hasNestedUnboundedQuantifier('(x{2,}){3,}')).toBe(true);
  });

  it('finds one nested deep inside a larger pattern', () => {
    expect(hasNestedUnboundedQuantifier('^app-(?:name|(v+)+)$')).toBe(true);
  });

  it('leaves ordinary patterns alone', () => {
    expect(hasNestedUnboundedQuantifier('my-voice-app|local-tts')).toBe(false);
    expect(hasNestedUnboundedQuantifier('codex.*desktop')).toBe(false);
    expect(hasNestedUnboundedQuantifier('(chatgpt|codex)')).toBe(false);
    expect(hasNestedUnboundedQuantifier('^(\\w+)$')).toBe(false);
  });

  it('does not count a bounded repeat as unbounded', () => {
    // `?` and `{n,m}` cannot drive exponential backtracking on their own.
    expect(hasNestedUnboundedQuantifier('(a?)+')).toBe(false);
    expect(hasNestedUnboundedQuantifier('(a{1,3})+')).toBe(false);
  });

  it('does not read a quantifier out of a character class', () => {
    // The `+` and `*` here are literal characters, not repeats.
    expect(hasNestedUnboundedQuantifier('([+*])+')).toBe(false);
  });

  it('does not read an escaped parenthesis as a group', () => {
    expect(hasNestedUnboundedQuantifier('\\(a+\\)+')).toBe(false);
  });

  it('clears the pattern Persona ships', () => {
    expect(hasNestedUnboundedQuantifier(PACKAGED_PATTERN)).toBe(false);
  });
});

describe('voicePatternRisk', () => {
  it('says nothing about an empty field', () => {
    expect(voicePatternRisk('')).toBeNull();
    expect(voicePatternRisk('   ')).toBeNull();
  });

  it('reports a pattern that will not compile', () => {
    expect(voicePatternRisk('my-app(')).toBe('invalid');
    expect(voicePatternRiskMessage('invalid')).toMatch(/not a valid/i);
  });

  it('reports a pattern that can backtrack catastrophically', () => {
    expect(voicePatternRisk('(a+)+b')).toBe('backtracking');
    expect(voicePatternRiskMessage('backtracking')).toMatch(/freeze/i);
  });

  it('is quiet about a pattern a user would reasonably write', () => {
    expect(voicePatternRisk('my-voice-app|local-tts')).toBeNull();
    expect(voicePatternRisk(PACKAGED_PATTERN)).toBeNull();
    expect(voicePatternRiskMessage(null)).toBeNull();
  });

  it('prefers the compile failure when a pattern is both broken and risky', () => {
    expect(voicePatternRisk('(a+)+(')).toBe('invalid');
  });
});
