import { describe, expect, it } from 'vitest';
import { expressionsForModel } from './model-expression-catalog';

describe('expressionsForModel', () => {
  it('only exposes expressions reported by the selected model', () => {
    const report = {
      modelUrl: 'persona-library://models/first',
      expressions: ['happy', 'surprised'],
    };

    expect(
      expressionsForModel(report, 'persona-library://models/first'),
    ).toEqual(['happy', 'surprised']);
    expect(
      expressionsForModel(report, 'persona-library://models/second'),
    ).toEqual([]);
  });

  it('keeps a stale report hidden until the newly selected model reports', () => {
    const staleReport = {
      modelUrl: 'persona-library://models/first',
      expressions: ['customFirst'],
    };

    expect(
      expressionsForModel(staleReport, 'persona-library://models/second'),
    ).toEqual([]);

    const currentReport = {
      modelUrl: 'persona-library://models/second',
      expressions: ['customSecond'],
    };
    expect(
      expressionsForModel(currentReport, 'persona-library://models/second'),
    ).toEqual(['customSecond']);
  });
});
