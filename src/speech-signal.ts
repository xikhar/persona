// The native listeners have already removed their platform noise floor before
// emitting a normalized level. Keep the renderer attack threshold low so the
// body reacts to the beginning of a word instead of waiting for a louder
// syllable. The scheduler, rather than this signal, owns what happens after a
// level falls back to silence.
export const BODY_SPEECH_LEVEL_THRESHOLD = 0.006;

export function bodySpeechSignalActive({
  audioLevel,
  audioLevelObserved,
  voiceSpeaking,
}: {
  audioLevel: number;
  audioLevelObserved: boolean;
  voiceSpeaking: boolean;
}): boolean {
  return audioLevelObserved
    ? audioLevel > BODY_SPEECH_LEVEL_THRESHOLD
    : voiceSpeaking;
}
