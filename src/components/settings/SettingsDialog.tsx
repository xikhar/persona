import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * The window's one modal shape: adding and editing both open this, so the two
 * are the same task with a different title rather than two different screens.
 *
 * Owns what a modal has to own and a caller should not have to repeat — the
 * backdrop, Escape, the focus trap, returning focus where it came from, and
 * labelling the dialog by its own heading.
 */
export function SettingsDialog({
  busy = false,
  children,
  eyebrow,
  footer,
  onClose,
  title,
  wide = false,
}: {
  /** While true the dialog cannot be dismissed: work is in flight. */
  busy?: boolean;
  children: ReactNode;
  eyebrow: string;
  footer: ReactNode;
  onClose: () => void;
  title: string;
  /** Forms with several fields get more room than a confirmation does. */
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // The first field, so typing can start immediately; the dialog itself when
    // it holds nothing focusable.
    const first =
      dialogRef.current?.querySelector<HTMLElement>('[data-dialog-autofocus]') ??
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialogRef.current)?.focus();
    return () => opener?.focus();
  }, []);

  const focusable = (): HTMLElement[] =>
    [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];

  return createPortal(
    <div
      className="settings-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        aria-busy={busy}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`settings-dialog ${wide ? 'settings-dialog-wide' : ''}`}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== 'Tab') return;
          // Wrap at both ends so focus cannot leave the dialog for the page
          // behind it, which is still rendered and still clickable otherwise.
          const items = focusable();
          const first = items[0];
          const last = items.at(-1);
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="settings-dialog-head">
          <span className="eyebrow">{eyebrow}</span>
          <h2 id={titleId}>{title}</h2>
        </div>
        <div className="settings-dialog-body">{children}</div>
        <div className="settings-dialog-actions">{footer}</div>
      </div>
    </div>,
    document.body,
  );
}
