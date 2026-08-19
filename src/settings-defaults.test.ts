import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LIGHTING,
  lightingNumberInRange,
  loadPackagedSettingsFallback,
  resolveLightingSettings,
} from './settings-defaults';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lighting settings', () => {
  it('fills every default when a stored model profile is partial', () => {
    expect(
      resolveLightingSettings({
        environment_intensity: 0.35,
        exposure: undefined,
      }),
    ).toEqual({
      ...DEFAULT_LIGHTING,
      environment_intensity: 0.35,
    });
  });

  it('returns an independent default profile when no override exists', () => {
    const resolved = resolveLightingSettings();

    expect(resolved).toEqual(DEFAULT_LIGHTING);
    expect(resolved).not.toBe(DEFAULT_LIGHTING);
  });
});

describe('packaged settings fallback', () => {
  it('preserves packaged animation expression metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          schema_version: 1,
          default_model_id: null,
          models: [],
          animations: [
            {
              id: 'packaged-happy',
              animation_name: 'happy',
              animation_description: 'A happy reaction.',
              animation_trigger_scenario: 'Use for positive moments.',
              animation_type: 'HAPPY',
              expression_name: 'happy',
              expression_weight: 0.75,
              asset_paths: ['animations/happy.vrma'],
            },
          ],
        }),
      }),
    );

    const settings = await loadPackagedSettingsFallback();
    expect(
      settings.animations.find(
        (animation) => animation.id === 'packaged-happy',
      ),
    ).toMatchObject({
      expression_name: 'happy',
      expression_weight: 0.75,
    });
  });
});

describe('lightingNumberInRange', () => {
  it('accepts a value the store will also accept', () => {
    expect(lightingNumberInRange('exposure', 1.5)).toBe(1.5);
    expect(lightingNumberInRange('environment_intensity', 0)).toBe(0);
    expect(lightingNumberInRange('key_light_intensity', 4)).toBe(4);
  });

  it('rejects a value outside the field’s own range', () => {
    // exposure starts at 0.1, not 0: the ranges are per field, and a value
    // valid for one control is not automatically valid for another.
    expect(lightingNumberInRange('exposure', 0)).toBeNull();
    expect(lightingNumberInRange('exposure', 3.5)).toBeNull();
    expect(lightingNumberInRange('environment_intensity', 2.5)).toBeNull();
    expect(lightingNumberInRange('ambient_intensity', -1)).toBeNull();
  });

  it('rejects what an empty or half-typed number field reports', () => {
    expect(lightingNumberInRange('exposure', Number.NaN)).toBeNull();
    expect(
      lightingNumberInRange('exposure', Number.POSITIVE_INFINITY),
    ).toBeNull();
  });

  it('keeps every default inside its own range', () => {
    for (const field of [
      'exposure',
      'environment_intensity',
      'key_light_intensity',
      'ambient_intensity',
    ] as const) {
      expect(lightingNumberInRange(field, DEFAULT_LIGHTING[field])).toBe(
        DEFAULT_LIGHTING[field],
      );
    }
  });
});
