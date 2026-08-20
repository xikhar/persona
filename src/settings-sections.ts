/** The Settings window's navigation, and the section its content follows. */
export type SettingsSection =
  | 'models'
  | 'animations'
  | 'appearance'
  | 'voice'
  | 'mcp'
  | 'developer';

export interface SettingsSectionDescriptor {
  /** The line above the heading, naming what the section configures. */
  eyebrow: string;
  id: SettingsSection;
  /** The nav entry's second line. */
  description: string;
  /** The nav entry and the content heading. */
  label: string;
}

export const SECTIONS: readonly SettingsSectionDescriptor[] = [
  {
    id: 'models',
    label: 'Models',
    description: 'Character library',
    eyebrow: 'Character configuration',
  },
  {
    id: 'animations',
    label: 'Actions',
    description: 'Motion library',
    eyebrow: 'Character configuration',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'Visual tuning',
    eyebrow: 'Character configuration',
  },
  {
    id: 'voice',
    label: 'Voice',
    description: 'Audio source',
    eyebrow: 'Voice output listener',
  },
  {
    id: 'mcp',
    label: 'MCP',
    description: 'Agent connection',
    eyebrow: 'Local integration',
  },
  {
    id: 'developer',
    label: 'Developer',
    description: 'Advanced tuning',
    eyebrow: 'Advanced configuration',
  },
];

export function settingsSection(
  section: SettingsSection,
): SettingsSectionDescriptor {
  const descriptor = SECTIONS.find((candidate) => candidate.id === section);
  // Unreachable through the typed nav, but the lookup is index-shaped and the
  // header would otherwise render an empty title on a future section id.
  if (!descriptor) throw new Error(`Unknown settings section: ${section}`);
  return descriptor;
}

/** The facts a section's header summary can be built from. */
export interface SectionSummaryFacts {
  avatarWindow: { height: number; width: number };
  characterSize: number;
  clipCount: number;
  developerEnabled: boolean;
  mcp: { playableActions: number; tools: number } | null;
  modelCount: number;
  playableActionCount: number;
  voiceHeading: string;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The line beside a section's title. Each section answers the question a
 * reader arriving at it actually has, rather than repeating one library count
 * across every screen.
 */
export function sectionSummary(
  section: SettingsSection,
  facts: SectionSummaryFacts,
): string {
  switch (section) {
    case 'models':
      return facts.modelCount === 0
        ? 'No model configured'
        : plural(facts.modelCount, 'model');
    case 'animations':
      return facts.clipCount === 0
        ? `${plural(facts.playableActionCount, 'action')} · no clips`
        : `${plural(facts.playableActionCount, 'action')} · ${plural(facts.clipCount, 'clip')}`;
    case 'appearance':
      return `${Math.round(facts.characterSize * 100)}% · ${facts.avatarWindow.width}×${facts.avatarWindow.height}`;
    case 'voice':
      return facts.voiceHeading;
    case 'mcp':
      return facts.mcp
        ? `${plural(facts.mcp.tools, 'tool')} · ${plural(facts.mcp.playableActions, 'playable action')}`
        : 'Local agent connection';
    case 'developer':
      return facts.developerEnabled
        ? 'Developer settings enabled'
        : 'Developer settings locked';
  }
}
