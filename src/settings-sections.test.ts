import { describe, expect, it } from 'vitest';
import {
  SECTIONS,
  sectionSummary,
  settingsSection,
  type SectionSummaryFacts,
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

const FACTS: SectionSummaryFacts = {
  avatarWindow: { height: 680, width: 430 },
  characterSize: 1,
  clipCount: 18,
  developerEnabled: false,
  mcp: { playableActions: 2, tools: 4 },
  modelCount: 3,
  playableActionCount: 2,
  voiceHeading: 'Automatic detection',
};

describe('sectionSummary', () => {
  it('answers the question each section is actually about', () => {
    expect(sectionSummary('models', FACTS)).toBe('3 models');
    expect(sectionSummary('animations', FACTS)).toBe('2 actions · 18 clips');
    expect(sectionSummary('appearance', FACTS)).toBe('100% · 430×680');
    expect(sectionSummary('voice', FACTS)).toBe('Automatic detection');
    expect(sectionSummary('mcp', FACTS)).toBe('4 tools · 2 playable actions');
    expect(sectionSummary('developer', FACTS)).toBe(
      'Developer settings locked',
    );
  });

  it('never leaves a section without a summary', () => {
    for (const { id } of SECTIONS) {
      expect(sectionSummary(id, FACTS)).not.toBe('');
    }
  });

  it('agrees with itself on singulars', () => {
    const one = { ...FACTS, clipCount: 1, modelCount: 1, playableActionCount: 1 };
    expect(sectionSummary('models', one)).toBe('1 model');
    expect(sectionSummary('animations', one)).toBe('1 action · 1 clip');
    expect(sectionSummary('mcp', { ...FACTS, mcp: { playableActions: 1, tools: 1 } })).toBe(
      '1 tool · 1 playable action',
    );
  });

  it('says what is missing rather than counting to zero', () => {
    expect(sectionSummary('models', { ...FACTS, modelCount: 0 })).toBe(
      'No model configured',
    );
    expect(
      sectionSummary('animations', { ...FACTS, clipCount: 0, playableActionCount: 0 }),
    ).toBe('0 actions · no clips');
  });

  it('waits for the main process before describing MCP', () => {
    expect(sectionSummary('mcp', { ...FACTS, mcp: null })).toBe(
      'Local agent connection',
    );
  });

  it('rounds the character size the way the control shows it', () => {
    expect(sectionSummary('appearance', { ...FACTS, characterSize: 1.155 })).toBe(
      '116% · 430×680',
    );
  });
});
