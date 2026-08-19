import { describe, expect, it } from 'vitest';
import {
  adjustRangeHandle,
  dualRangeStyle,
  expressionWeightFrom,
  rangePercentage,
  singleRangeStyle,
} from './range-slider';

describe('rangePercentage', () => {
  it('maps a point onto its share of the track', () => {
    expect(rangePercentage(45, 45, 3600)).toBe('0%');
    expect(rangePercentage(3600, 45, 3600)).toBe('100%');
    expect(rangePercentage(0.5, 0, 1)).toBe('50%');
  });

  it('clamps a point that sits outside the track', () => {
    expect(rangePercentage(-4, 0, 1)).toBe('0%');
    expect(rangePercentage(90, 0, 1)).toBe('100%');
  });

  it('does not divide by a zero-width track', () => {
    expect(rangePercentage(5, 5, 5)).toBe('0%');
  });
});

describe('slider styles', () => {
  it('exposes the single-handle fill as a custom property', () => {
    expect(singleRangeStyle(0.25, 0, 1)).toEqual({ '--range-progress': '25%' });
  });

  it('exposes both edges of a dual-handle fill', () => {
    expect(dualRangeStyle([810, 945], 45, 3600)).toEqual({
      '--range-start': rangePercentage(810, 45, 3600),
      '--range-end': rangePercentage(945, 45, 3600),
    });
  });
});

describe('adjustRangeHandle', () => {
  it('moves the requested handle and leaves the other alone', () => {
    expect(adjustRangeHandle([810, 945], 0, 700)).toEqual([700, 945]);
    expect(adjustRangeHandle([810, 945], 1, 1200)).toEqual([810, 1200]);
  });

  it('will not let the minimum handle pass the maximum', () => {
    // The two handles are stacked inputs, so a drag really can carry one past
    // the other; nothing else stops the range inverting.
    expect(adjustRangeHandle([810, 945], 0, 1400)).toEqual([945, 945]);
  });

  it('will not let the maximum handle pass the minimum', () => {
    expect(adjustRangeHandle([810, 945], 1, 200)).toEqual([810, 810]);
  });

  it('leaves a range untouched when the handle does not move', () => {
    expect(adjustRangeHandle([810, 945], 0, 810)).toEqual([810, 945]);
  });
});

describe('expressionWeightFrom', () => {
  it('accepts a weight the model can use, including both ends', () => {
    expect(expressionWeightFrom(0)).toBe(0);
    expect(expressionWeightFrom(0.65)).toBe(0.65);
    expect(expressionWeightFrom(1)).toBe(1);
  });

  it('rejects a weight outside the blend range', () => {
    expect(expressionWeightFrom(-0.1)).toBeNull();
    expect(expressionWeightFrom(1.5)).toBeNull();
  });

  it('rejects what a half-typed number field reports', () => {
    // An empty or partial <input type="number"> yields NaN from valueAsNumber.
    expect(expressionWeightFrom(Number.NaN)).toBeNull();
    expect(expressionWeightFrom(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
