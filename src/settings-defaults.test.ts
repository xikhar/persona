import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LIGHTING,
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
