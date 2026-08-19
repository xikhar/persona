import type { CSSProperties } from 'react';

/** The fraction of the track a point sits at, as a CSS percentage string. */
export function rangePercentage(
  point: number,
  minimum: number,
  maximum: number,
): string {
  if (maximum <= minimum) return '0%';
  const clamped = Math.min(maximum, Math.max(minimum, point));
  return `${((clamped - minimum) / (maximum - minimum)) * 100}%`;
}

/** Fill for a single-handle slider, read by `--range-progress` in the CSS. */
export function singleRangeStyle(
  value: number,
  minimum: number,
  maximum: number,
): CSSProperties {
  return {
    '--range-progress': rangePercentage(value, minimum, maximum),
  } as CSSProperties;
}

/** Fill between the two handles of a dual slider. */
export function dualRangeStyle(
  [start, end]: readonly [number, number],
  minimum: number,
  maximum: number,
): CSSProperties {
  return {
    '--range-start': rangePercentage(start, minimum, maximum),
    '--range-end': rangePercentage(end, minimum, maximum),
  } as CSSProperties;
}

/**
 * Moves one handle of a `[minimum, maximum]` range without letting it pass the
 * other. The two handles sit on stacked inputs, so nothing but this stops a
 * drag through the opposite handle from inverting the range.
 */
export function adjustRangeHandle(
  range: readonly [number, number],
  handle: 0 | 1,
  next: number,
): readonly [number, number] {
  const [start, end] = range;
  return handle === 0
    ? [Math.min(next, end), end]
    : [start, Math.max(next, start)];
}

/**
 * A typed expression weight, or null while the field holds something the model
 * cannot use — out of range, or half-typed on the way to a valid number.
 */
export function expressionWeightFrom(value: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
