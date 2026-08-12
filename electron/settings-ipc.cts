export interface SettingsIpcEvent {
  sender: object;
}

export interface SettingsIpcMain {
  handle(
    channel: string,
    listener: (event: SettingsIpcEvent, ...args: unknown[]) => unknown,
  ): void;
}

export interface SettingsWindowLike {
  isDestroyed(): boolean;
  webContents: object;
}

export interface SettingsIpcGate {
  handleFromSettings<TResult>(
    channel: string,
    handler: (...args: unknown[]) => TResult,
  ): void;
  isSettingsSender(event: SettingsIpcEvent): boolean;
}

// Both windows load the same preload, so the avatar window holds the same IPC
// surface as Settings. Gating registration rather than each handler's first
// line is deliberate: ~20 settings channels were once added without the guard.
export function createSettingsIpcGate({
  ipcMain,
  getSettingsWindow,
}: {
  ipcMain: SettingsIpcMain;
  getSettingsWindow: () => SettingsWindowLike | null;
}): SettingsIpcGate {
  // The one place the sender rule is derived, so tightening it later cannot
  // reach one caller and miss the other.
  function settingsWebContents() {
    const settingsWindow = getSettingsWindow();
    if (!settingsWindow || settingsWindow.isDestroyed()) return null;
    return settingsWindow.webContents;
  }

  function isSettingsSender(event: SettingsIpcEvent): boolean {
    const settings = settingsWebContents();
    return settings != null && event.sender === settings;
  }

  function requireSettingsSender(event: SettingsIpcEvent): void {
    const settings = settingsWebContents();
    if (!settings) {
      throw new Error("The Settings window is not available.");
    }
    if (event.sender !== settings) {
      throw new Error("This request must come from the Settings window.");
    }
  }

  function handleFromSettings<TResult>(
    channel: string,
    handler: (...args: unknown[]) => TResult,
  ): void {
    ipcMain.handle(channel, (event, ...args) => {
      requireSettingsSender(event);
      return handler(...args);
    });
  }

  return { handleFromSettings, isSettingsSender };
}
