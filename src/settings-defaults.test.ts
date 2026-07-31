import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIGHTING,
  resolveLightingSettings,
} from './settings-defaults';

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
