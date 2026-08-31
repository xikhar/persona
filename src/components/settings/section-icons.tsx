import type { ReactNode } from 'react';
import type { SettingsSection } from '../../settings-sections';
import { Icon } from './Icon';

export const SECTION_ICONS: Record<SettingsSection, ReactNode> = {
  models: (
    <Icon>
      <circle cx="8" cy="5.5" r="2.6" />
      <path d="M2.9 13.6c0-2.3 2.28-4.1 5.1-4.1s5.1 1.8 5.1 4.1" />
    </Icon>
  ),
  animations: (
    <Icon>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M6.8 5.8 10.9 8l-4.1 2.2z" />
    </Icon>
  ),
  kimodo: (
    <Icon>
      <path d="M8 1.8 9 5l3.2 1-3.2 1L8 10.2 7 7 3.8 6 7 5z" />
      <path d="M12.2 10.2l.5 1.6 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" />
    </Icon>
  ),
  appearance: (
    <Icon>
      <path d="M2.6 5.6v-2a1 1 0 0 1 1-1h2M10.4 2.6h2a1 1 0 0 1 1 1v2M13.4 10.4v2a1 1 0 0 1-1 1h-2M5.6 13.4h-2a1 1 0 0 1-1-1v-2" />
    </Icon>
  ),
  voice: (
    <Icon>
      <path d="M3.2 6.4v3.2M5.4 4.8v6.4M7.6 3.6v8.8M9.8 5.2v5.6M12.8 6.8v2.4" />
    </Icon>
  ),
  mcp: (
    <Icon>
      <path d="M6 2.4v2.6M10 2.4v2.6M4.6 5h6.8v2.9A3.4 3.4 0 0 1 8 11.3 3.4 3.4 0 0 1 4.6 7.9z" />
      <path d="M8 11.3v2.3" />
    </Icon>
  ),
  developer: (
    <Icon>
      <path d="M5.2 2.8 2.4 8l2.8 5.2M10.8 2.8 13.6 8l-2.8 5.2M9.2 2.2 6.8 13.8" />
    </Icon>
  ),
};
