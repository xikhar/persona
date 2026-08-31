/**
 * The icon set for row actions and control marks.
 *
 * All 16×16 on the same 1.4 stroke as the nav glyphs, drawn with
 * `currentColor` so a button's intent colour carries into its icon without a
 * second rule. Icon-only buttons must still carry an `aria-label`.
 */
import type { ReactNode } from 'react';

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.4"
      viewBox="0 0 16 16"
    >
      {children}
    </svg>
  );
}

export function TrashIcon() {
  return (
    <Glyph>
      <path d="M3 4.4h10M6.4 4.4V3.2a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8v1.2" />
      <path d="M4.4 4.4l.5 8a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.5-8" />
      <path d="M6.7 6.9v3.8M9.3 6.9v3.8" />
    </Glyph>
  );
}

export function PlayIcon() {
  return (
    <Glyph>
      <path d="M5.6 3.6 12 8l-6.4 4.4z" />
    </Glyph>
  );
}

export function DownloadIcon() {
  return (
    <Glyph>
      <path d="M8 2.5v7.2M5.2 7.2 8 10l2.8-2.8" />
      <path d="M3 12.8h10" />
    </Glyph>
  );
}

export function PlusIcon() {
  return (
    <Glyph>
      <path d="M8 3.4v9.2M3.4 8h9.2" />
    </Glyph>
  );
}

export function CopyIcon() {
  return (
    <Glyph>
      <rect x="5.6" y="5.6" width="7.4" height="7.4" rx="1.4" />
      <path d="M10.4 3.6a1.4 1.4 0 0 0-1.4-1.2H4.4A1.4 1.4 0 0 0 3 3.8v4.6a1.4 1.4 0 0 0 1.2 1.4" />
    </Glyph>
  );
}

export function RefreshIcon() {
  return (
    <Glyph>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13.2 2.6v3h-3" />
    </Glyph>
  );
}

export function PencilIcon() {
  return (
    <Glyph>
      <path d="m10.3 3.1 2.6 2.6-7 7-3.2.6.6-3.2z" />
      <path d="m9.1 4.3 2.6 2.6" />
    </Glyph>
  );
}

export function CheckIcon() {
  return (
    <Glyph>
      <path d="m3.4 8.4 3 3 6.2-6.8" />
    </Glyph>
  );
}

export function AutomaticIcon() {
  return (
    <Glyph>
      <path d="M8 2.4v2M8 11.6v2M2.4 8h2M11.6 8h2M4.1 4.1l1.4 1.4M10.5 10.5l1.4 1.4M11.9 4.1l-1.4 1.4M5.5 10.5l-1.4 1.4" />
      <circle cx="8" cy="8" r="2.1" />
    </Glyph>
  );
}

export function WindowIcon() {
  return (
    <Glyph>
      <rect x="2.4" y="3.2" width="11.2" height="9.6" rx="1.4" />
      <path d="M2.4 6.1h11.2" />
    </Glyph>
  );
}

export function RegexIcon() {
  return (
    <Glyph>
      <path d="M8 3.2v5.4M5.5 4.6l5 2.7M10.5 4.6l-5 2.7" />
      <circle cx="4.4" cy="12" r="0.9" />
    </Glyph>
  );
}

export function ExternalIcon() {
  return (
    <Glyph>
      <path d="M9.4 3h3.6v3.6M12.8 3.2 7.6 8.4" />
      <path d="M12 9.6v2.6a1.2 1.2 0 0 1-1.2 1.2H3.9a1.2 1.2 0 0 1-1.2-1.2V5.3a1.2 1.2 0 0 1 1.2-1.2h2.7" />
    </Glyph>
  );
}

export function GitHubIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      focusable="false"
      viewBox="0 0 16 16"
    >
      <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.23.49-2.7-1.08-2.7-1.08-.37-.93-.9-1.18-.9-1.18-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.88 2.34.67.07-.52.28-.88.51-1.08-1.78-.2-3.65-.89-3.65-3.96 0-.88.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.12 0 0 .68-.22 2.2.82A7.67 7.67 0 0 1 8 3.81c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.52.56.83 1.27.83 2.15 0 3.08-1.87 3.75-3.66 3.95.29.25.54.74.54 1.5l-.01 2.23c0 .21.15.46.55.38A8 8 0 0 0 8 0Z" />
    </svg>
  );
}
