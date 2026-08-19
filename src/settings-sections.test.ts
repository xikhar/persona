import { describe, expect, it } from 'vitest';
import {
  SECTIONS,
  settingsSection,
  type SettingsSection,
} from './settings-sections';

const ALL_SECTIONS: SettingsSection[] = [
  'models',
  'animations',
  'appearance',
  'voice',
  'mcp',
  'developer',
];

describe('settings sections', () => {
  it('describes every section the page can show', () => {
    expect(SECTIONS.map((section) => section.id)).toEqual(ALL_SECTIONS);
  });

  it('gives every section a label, description, and eyebrow', () => {
    for (const section of SECTIONS) {
      expect(section.label).not.toBe('');
      expect(section.description).not.toBe('');
      expect(section.eyebrow).not.toBe('');
    }
  });

  it('resolves each section id to its own descriptor', () => {
    for (const id of ALL_SECTIONS) {
      expect(settingsSection(id).id).toBe(id);
    }
  });

  it('groups the character sections under one eyebrow', () => {
    expect(settingsSection('models').eyebrow).toBe('Character configuration');
    expect(settingsSection('animations').eyebrow).toBe(
      'Character configuration',
    );
    expect(settingsSection('appearance').eyebrow).toBe(
      'Character configuration',
    );
    expect(settingsSection('voice').eyebrow).toBe('Voice output listener');
    expect(settingsSection('mcp').eyebrow).toBe('Local integration');
  });

  it('refuses a section it does not describe rather than rendering a blank header', () => {
    expect(() => settingsSection('nowhere' as SettingsSection)).toThrow(
      /Unknown settings section/,
    );
  });
});
