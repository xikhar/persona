import { describe, expect, it } from 'vitest';
import {
  animationExpression,
  animationUrlSignature,
  animationUrlsForType,
  immediateVoiceAnimation,
  randomAnimationUrl,
} from './animation-catalog';

describe('Persona animation contract', () => {
  it('enters speaking directly when voice is already active at startup', () => {
    expect(
      immediateVoiceAnimation({
        activity: 'speaking',
        outputMuted: false,
        phase: 'active',
      }),
    ).toBe('TALK');
    expect(
      immediateVoiceAnimation({
        activity: 'listening',
        outputMuted: false,
        phase: 'active',
      }),
    ).toBeNull();
    expect(
      immediateVoiceAnimation({
        activity: 'speaking',
        outputMuted: true,
        phase: 'active',
      }),
    ).toBeNull();
    expect(
      immediateVoiceAnimation({
        activity: 'idle',
        outputMuted: false,
        phase: 'inactive',
      }),
    ).toBeNull();
  });

  it('uses no clip for the empty idle pose when no asset is configured', () => {
    expect(randomAnimationUrl([])).toBeNull();
  });

  it('chooses randomly while avoiding an immediate repeat', () => {
    const choices = ['first.vrma', 'second.vrma', 'third.vrma'];
    expect(randomAnimationUrl(choices, null, () => 0)).toBe('first.vrma');
    expect(randomAnimationUrl(choices, 'first.vrma', () => 0)).toBe(
      'second.vrma',
    );
    expect(randomAnimationUrl(choices, 'first.vrma', () => 0.99)).toBe(
      'third.vrma',
    );
  });

  it('combines every configured asset for the same live role', () => {
    const animations = [
      {
        animation_type: 'TALK',
        asset_urls: ['talk1.vrma'],
      },
      {
        animation_type: 'IDLE',
        asset_urls: ['idle.vrma'],
      },
      {
        animation_type: 'TALK',
        asset_urls: ['talk2.vrma', 'talk3.vrma'],
      },
    ] as PersonaAnimationSettings[];

    expect(animationUrlsForType(animations, 'TALK')).toEqual([
      'talk1.vrma',
      'talk2.vrma',
      'talk3.vrma',
    ]);
  });

  it('keeps equivalent animation URL lists stable across settings snapshots', () => {
    expect(animationUrlSignature(['one.vrma', 'two.vrma'])).toBe(
      animationUrlSignature(['one.vrma', 'two.vrma']),
    );
    expect(animationUrlSignature(['one.vrma', 'two.vrma'])).not.toBe(
      animationUrlSignature(['two.vrma', 'one.vrma']),
    );
  });

  it('resolves expression metadata for Settings previews', () => {
    expect(
      animationExpression({
        expression_name: 'sad',
        expression_weight: 0.75,
      } as PersonaAnimationSettings),
    ).toEqual({
      expressionName: 'sad',
      expressionWeight: 0.75,
    });

    expect(animationExpression(null)).toEqual({
      expressionName: null,
      expressionWeight: 1,
    });
  });
});

