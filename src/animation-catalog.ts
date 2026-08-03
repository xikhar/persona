export type AnimationType =
  | 'IDLE'
  | 'GREETING'
  | 'TALK'
  | 'HAPPY'
  | 'FINGER_GUN'
  | 'DANCE';
export type PlayableAnimationType = AnimationType | 'CUSTOM';

export function immediateVoiceAnimation(
  voice: Pick<VoiceState, 'activity' | 'outputMuted' | 'phase'>,
): 'TALK' | null {
  // Voice state can start Speaking immediately, but it must never end the
  // requested Speaking sequence directly. Raw level silence is debounced by
  // the animation scheduler, which owns the eventual transition to Idle.
  if (voice.phase !== 'active' || voice.outputMuted) return null;
  if (voice.activity === 'speaking') return 'TALK';
  return null;
}

export function animationUrlsForType(
  animations: readonly PersonaAnimationSettings[],
  type: PlayableAnimationType,
): string[] {
  return animations
    .filter((animation) => animation.animation_type === type)
    .flatMap((animation) => animation.asset_urls);
}

export function animationUrlSignature(
  animationUrls: readonly string[] | undefined,
): string {
  return JSON.stringify(animationUrls ?? []);
}

export function randomAnimationUrl(
  choices: readonly string[],
  previous: string | null = null,
  random: () => number = Math.random,
): string | null {
  if (choices.length === 0) return null;
  const candidates =
    choices.length > 1 && previous != null
      ? choices.filter((choice) => choice !== previous)
      : choices;
  const randomIndex = Math.min(
    candidates.length - 1,
    Math.floor(Math.max(0, random()) * candidates.length),
  );
  return candidates[randomIndex] ?? null;
}
