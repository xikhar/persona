import { describe, expect, it } from 'vitest';
import { errorMessage } from './settings-errors';

describe('errorMessage', () => {
  it('strips the wrapper Electron puts on a rejected IPC call', () => {
    expect(
      errorMessage(
        new Error(
          "Error invoking remote method 'persona:settings-delete-model': Error: Packaged models cannot be deleted.",
        ),
      ),
    ).toBe('Packaged models cannot be deleted.');
  });

  it('keeps a message the main process did not wrap', () => {
    expect(errorMessage(new Error('Connect your VRoid Hub account first.')))
      .toBe('Connect your VRoid Hub account first.');
  });

  it('only strips the prefix at the front, not a mention inside a message', () => {
    const message =
      "Saving failed. Error invoking remote method 'persona:x': Error: nested";
    expect(errorMessage(new Error(message))).toBe(message);
  });

  it('describes a rejection that was never an Error', () => {
    expect(errorMessage('plain string failure')).toBe('plain string failure');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage({ code: 42 })).toBe('[object Object]');
  });
});
