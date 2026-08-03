import { describe, expect, it } from 'vitest';
import {
  BODY_SPEECH_LEVEL_THRESHOLD,
  bodySpeechSignalActive,
} from './speech-signal';

describe('body speech signal', () => {
  it('uses voice state until an integration supplies live levels', () => {
    expect(
      bodySpeechSignalActive({
        audioLevel: 0,
        audioLevelObserved: false,
        voiceSpeaking: true,
      }),
    ).toBe(true);
  });

  it('exposes raw word gaps to the scheduler once levels are available', () => {
    expect(
      bodySpeechSignalActive({
        audioLevel: 0,
        audioLevelObserved: true,
        voiceSpeaking: true,
      }),
    ).toBe(false);
    expect(
      bodySpeechSignalActive({
        audioLevel: BODY_SPEECH_LEVEL_THRESHOLD + 0.001,
        audioLevelObserved: true,
        voiceSpeaking: true,
      }),
    ).toBe(true);
  });

  it('reacts to live output before the coarser voice state catches up', () => {
    expect(
      bodySpeechSignalActive({
        audioLevel: 1,
        audioLevelObserved: true,
        voiceSpeaking: false,
      }),
    ).toBe(true);
  });

  it('does not require a loud syllable to begin moving', () => {
    expect(
      bodySpeechSignalActive({
        audioLevel: BODY_SPEECH_LEVEL_THRESHOLD + 0.001,
        audioLevelObserved: true,
        voiceSpeaking: false,
      }),
    ).toBe(true);
  });
});
