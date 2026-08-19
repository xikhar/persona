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
