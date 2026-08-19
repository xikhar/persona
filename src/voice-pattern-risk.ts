/**
 * A cheap look for the shape of regular expression that can take exponential
 * time to fail.
 *
 * Persona runs the advanced pattern against process identity on the main
 * thread every time it looks for the voice source, so a pattern that backtracks
 * catastrophically freezes the application rather than simply failing to match.
 * There is no way to bound a `RegExp`'s running time in Node, so the field
 * warns instead.
 *
 * This is deliberately a warning and not a rejection: it recognises the classic
 * nested-quantifier shape, not every pattern that can blow up, and a nested
 * quantifier over a narrow character class is often perfectly fine. The user
 * stays in charge of their own setting; they just get told what they are
 * pointing at their own main thread.
 */

/** Length of the quantifier at `index`, or 0 if there is no unbounded one. */
function unboundedQuantifierLength(pattern: string, index: number): number {
  const char = pattern[index];
  if (char === '*' || char === '+') return 1;
  if (char !== '{') return 0;
  // `{2,}` is unbounded; `{2,4}` and `{3}` are not.
  const closing = pattern.indexOf('}', index);
  if (closing === -1) return 0;
  return /^\{\d*,\}$/.test(pattern.slice(index, closing + 1))
    ? closing + 1 - index
    : 0;
}

/** Whether `source` applies an unbounded quantifier to anything at all. */
function containsUnboundedQuantifier(source: string): boolean {
  let index = 0;
  let inCharacterClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (inCharacterClass) {
      if (char === ']') inCharacterClass = false;
      index += 1;
      continue;
    }
    if (char === '[') {
      inCharacterClass = true;
      index += 1;
      continue;
    }
    if (unboundedQuantifierLength(source, index) > 0) return true;
    index += 1;
  }
  return false;
}

/**
 * True when a group that already repeats without bound is itself repeated
 * without bound — `(a+)+`, `(\w*)*`, `(x{1,}){2,}`. That is the shape that
 * turns a failing match into exponential backtracking.
 */
export function hasNestedUnboundedQuantifier(pattern: string): boolean {
  const openGroups: number[] = [];
  let index = 0;
  let inCharacterClass = false;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (inCharacterClass) {
      if (char === ']') inCharacterClass = false;
      index += 1;
      continue;
    }
    if (char === '[') {
      inCharacterClass = true;
    } else if (char === '(') {
      openGroups.push(index);
    } else if (char === ')') {
      const start = openGroups.pop();
      if (
        start !== undefined &&
        unboundedQuantifierLength(pattern, index + 1) > 0 &&
        containsUnboundedQuantifier(pattern.slice(start + 1, index))
      ) {
        return true;
      }
    }
    index += 1;
  }
  return false;
}

export type VoicePatternRisk = 'invalid' | 'backtracking' | null;

/** What is worth telling the user about the pattern they have typed. */
export function voicePatternRisk(pattern: string): VoicePatternRisk {
  const trimmed = pattern.trim();
  if (trimmed === '') return null;
  try {
    new RegExp(trimmed, 'i');
  } catch {
    return 'invalid';
  }
  return hasNestedUnboundedQuantifier(trimmed) ? 'backtracking' : null;
}

export function voicePatternRiskMessage(risk: VoicePatternRisk): string | null {
  if (risk === 'invalid') {
    return 'This is not a valid regular expression, so Persona will keep using automatic detection.';
  }
  if (risk === 'backtracking') {
    return 'This pattern repeats a group that already repeats. Persona matches it on its main thread, so a pattern shaped like this can freeze the app instead of just failing to match. Prefer a plain substring or alternation.';
  }
  return null;
}
