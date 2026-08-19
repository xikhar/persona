/**
 * Electron wraps anything an `ipcMain.handle` callback throws, so a message the
 * main process wrote for the user arrives with its own plumbing in front of it:
 *
 *     Error invoking remote method 'persona:settings-delete-model': Error: …
 *
 * The Settings window shows these verbatim in its notice bar, so the prefix has
 * to come off. Anything that is not a wrapped IPC rejection is left alone.
 */
const IPC_REJECTION_PREFIX =
  /^Error invoking remote method '[^']+': Error: /;

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(IPC_REJECTION_PREFIX, '');
}
