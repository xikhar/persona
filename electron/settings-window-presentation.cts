export interface SettingsWindowPresentationGate {
  markReadyToShow(): boolean;
  markThemeApplied(): boolean;
  requestShow(): boolean;
}

export function createSettingsWindowPresentationGate(): SettingsWindowPresentationGate {
  let readyToShow = false;
  let themeApplied = false;
  let showRequested = false;

  function takeShowRequest(): boolean {
    if (!readyToShow || !themeApplied || !showRequested) return false;
    showRequested = false;
    return true;
  }

  return {
    markReadyToShow() {
      readyToShow = true;
      return takeShowRequest();
    },
    markThemeApplied() {
      themeApplied = true;
      return takeShowRequest();
    },
    requestShow() {
      showRequested = true;
      return takeShowRequest();
    },
  };
}
