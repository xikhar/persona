"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  net,
  nativeImage,
  nativeTheme,
  protocol,
  safeStorage,
  screen,
  shell,
  Tray,
} = require("electron");
const {
  createBridgeServer,
  DEFAULT_PORT,
  OAUTH_CALLBACK_PATH,
} = require("./bridge-server.cjs");
const { createPersonaMcpHandler } = require("./mcp-server.cjs");
const {
  createMcpSettingsStatus,
} = require("./mcp-settings-status.cjs");
const {
  createSettingsStore,
  DEFAULT_AVATAR_WINDOW_SIZE,
  MIN_AVATAR_WINDOW_WIDTH,
  MIN_AVATAR_WINDOW_HEIGHT,
} = require("./settings-store.cjs");
const { createVroidHubAuth } = require("./vroid-hub-auth.cjs");
const {
  characterModelPageUrl,
  createVroidHubClient,
} = require("./vroid-hub-client.cjs");
const {
  clearVroidHubCredentials,
  readVroidHubCredentials,
  writeVroidHubCredentials,
} = require("./vroid-hub-credentials.cjs");
const {
  configureHyprlandWindow,
  getHyprlandWindowPlacement,
} = require("./hyprland-window.cjs");
const { createAudioListener } = require("./audio-listener.cjs");
const { listVoiceSources } = require("./voice-source-discovery.cjs");
const { isAllowedRendererNavigation } = require("./navigation-policy.cjs");
const { createSettingsIpcGate } = require("./settings-ipc.cjs");
const { snapshotHasConfiguredModel } = require("./model-readiness.cjs");
const { parseProtocolUrl, voiceState } = require("./protocol-actions.cjs");
const {
  createSettingsWindowPresentationGate,
} = require("./settings-window-presentation.cjs");
const {
  normalizeVoiceSource,
  resolveVoiceSourcePattern,
  settingsPatternFromVoiceSource,
} = require("./voice-source.cjs");

const SETTINGS_WINDOW_WIDTH = 1180;
const SETTINGS_WINDOW_HEIGHT = 780;
// Chromium paints this behind newly exposed areas during a resize, so it must
// track the renderer's --bg-window token in src/styles.css.
const SETTINGS_WINDOW_BACKGROUND = {
  dark: "#0d0e12",
  light: "#e6e8ec",
};
const PERSONA_ASSET_SCHEME = "persona-asset";
const startInBackground = process.argv.includes("--background");
const startInSettings = process.argv.includes("--settings");
const protocolScheme = "persona";
const debugEnabled = process.env.PERSONA_DEBUG === "1";

let avatarWindow = null;
let settingsWindow = null;
let settingsWindowPresentationGate = null;
let settingsStore = null;
let vroidHubAuth = null;
let vroidHubClient = null;
let vroidCredentialsFilePath = null;
let bridge = null;
let mcpHandler = null;
let isQuitting = false;
let latestEvent = null;
let latestListenerStatus = null;
let latestVoiceState = null;
let audioListener = null;
let tray = null;
let hyprlandConfigured = false;
let hyprlandConfiguring = false;
let hyprlandConfigurationTimer = null;
let hyprlandLastPosition = null;
let hyprlandConfigurationGeneration = 0;
let rendererLoadHookAttached = false;
let animationCommandRequestId = 0;
let modelConfigured = false;
let mcpServerError = null;
let mcpServerHealth = "starting";
let mcpServerPort = Number(
  process.env.PERSONA_BRIDGE_PORT || DEFAULT_PORT,
);
let mcpAnimationCatalogSignature = null;
const pendingRendererEvents = new Map();

protocol.registerSchemesAsPrivileged([
  {
    scheme: PERSONA_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
app.setName("Persona");

function debugLog(...values) {
  if (debugEnabled) console.error("[persona]", ...values);
}

function positionWindow(window) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = window.getBounds();
  const margin = 24;
  window.setPosition(
    Math.round(display.workArea.x + display.workArea.width - bounds.width - margin),
    Math.round(display.workArea.y + display.workArea.height - bounds.height - margin),
    false,
  );
}

function hasConfiguredModel() {
  return modelConfigured;
}

function avatarWindowSize() {
  return settingsStore?.getSnapshot().avatar_window ?? DEFAULT_AVATAR_WINDOW_SIZE;
}

function applyAvatarWindowSize() {
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  const { width, height } = avatarWindowSize();
  avatarWindow.setSize(width, height);
  scheduleHyprlandWindowConfiguration({ force: true, reposition: false });
}

function scheduleHyprlandWindowConfiguration({
  attempt = 0,
  force = false,
  position = null,
  reposition = !hyprlandConfigured,
} = {}) {
  if (
    (hyprlandConfigured && !force) ||
    hyprlandConfiguring ||
    !avatarWindow ||
    avatarWindow.isDestroyed()
  ) {
    return;
  }
  clearTimeout(hyprlandConfigurationTimer);
  const generation = hyprlandConfigurationGeneration;
  const targetWindow = avatarWindow;
  const delays = [0, 80, 200, 500, 1000];
  hyprlandConfigurationTimer = setTimeout(async () => {
    hyprlandConfigurationTimer = null;
    if (
      generation !== hyprlandConfigurationGeneration ||
      !avatarWindow ||
      avatarWindow !== targetWindow ||
      avatarWindow.isDestroyed()
    ) {
      return;
    }
    hyprlandConfiguring = true;
    const { width, height } = avatarWindowSize();
    const configured = await configureHyprlandWindow({
      pid: process.pid,
      width,
      height,
      onDebug: debugLog,
      position,
      reposition,
    });
    if (generation !== hyprlandConfigurationGeneration) return;
    hyprlandConfigured = configured;
    hyprlandConfiguring = false;
    if (!hyprlandConfigured && attempt + 1 < delays.length) {
      scheduleHyprlandWindowConfiguration({
        attempt: attempt + 1,
        force: true,
        position,
        reposition,
      });
    }
  }, delays[attempt] ?? delays.at(-1));
  hyprlandConfigurationTimer.unref?.();
}

function showOverlay({ focus = false } = {}) {
  if (!hasConfiguredModel()) {
    showSettings();
    return;
  }
  const window = createWindow();
  if (window.isMinimized()) window.restore();
  if (focus) {
    if (!window.isVisible()) window.show();
    window.focus();
  } else if (!window.isVisible()) {
    window.showInactive();
  }
  scheduleHyprlandWindowConfiguration();
}

async function hideOverlay() {
  debugLog("hide overlay");
  const targetWindow = avatarWindow;
  if (!targetWindow || targetWindow.isDestroyed()) return;
  const placement = await getHyprlandWindowPlacement(process.pid);
  if (avatarWindow !== targetWindow || targetWindow.isDestroyed()) return;
  if (placement) {
    hyprlandLastPosition = { x: placement.x, y: placement.y };
  }
  targetWindow.hide();
}

function destroyOverlayForSetup() {
  clearTimeout(hyprlandConfigurationTimer);
  hyprlandConfigurationGeneration += 1;
  hyprlandConfigurationTimer = null;
  hyprlandConfigured = false;
  hyprlandConfiguring = false;
  hyprlandLastPosition = null;
  rendererLoadHookAttached = false;
  pendingRendererEvents.clear();
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.destroy();
  }
  avatarWindow = null;
}

function toggleOverlay() {
  if (!hasConfiguredModel()) {
    showSettings();
    return;
  }
  if (avatarWindow?.isVisible()) void hideOverlay();
  else showOverlay({ focus: true });
}

function rendererUrl(view = null) {
  const url = new URL(
    process.env.VITE_DEV_SERVER_URL ||
      pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href,
  );
  if (view) url.searchParams.set("view", view);
  if (debugEnabled) url.searchParams.set("animationDebug", "1");
  return url.href;
}

function secureRendererWindow(window, allowedRendererUrl) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (debugEnabled) {
    window.webContents.on("console-message", (details) => {
      const message = details?.message;
      if (message?.startsWith("[persona:animation]")) {
        console.error(message);
      }
    });
  }
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedRendererNavigation(targetUrl, allowedRendererUrl)) {
      event.preventDefault();
    }
  });
}

function createWindow() {
  if (avatarWindow && !avatarWindow.isDestroyed()) return avatarWindow;

  const { width, height } = avatarWindowSize();
  const window = new BrowserWindow({
    width,
    height,
    minWidth: MIN_AVATAR_WINDOW_WIDTH,
    minHeight: MIN_AVATAR_WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "Persona",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  avatarWindow = window;

  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setOpacity(1);
  window.once("ready-to-show", () => {
    if (window.isDestroyed()) return;
    positionWindow(window);
    scheduleHyprlandWindowConfiguration();
  });
  window.on("show", () => {
    if (window.isDestroyed()) return;
    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setOpacity(1);
    scheduleHyprlandWindowConfiguration({
      force: true,
      position: hyprlandLastPosition,
      reposition: !hyprlandConfigured || hyprlandLastPosition != null,
    });
  });
  window.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    void hideOverlay();
  });
  window.on("closed", () => {
    if (avatarWindow !== window) return;
    clearTimeout(hyprlandConfigurationTimer);
    hyprlandConfigurationTimer = null;
    hyprlandConfigured = false;
    hyprlandConfiguring = false;
    rendererLoadHookAttached = false;
    avatarWindow = null;
  });

  const avatarRendererUrl = rendererUrl();
  secureRendererWindow(window, avatarRendererUrl);
  void window.loadURL(avatarRendererUrl);
  return window;
}

function settingsWindowBackground(theme) {
  return SETTINGS_WINDOW_BACKGROUND[theme] ?? SETTINGS_WINDOW_BACKGROUND.dark;
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow;

  const window = new BrowserWindow({
    width: SETTINGS_WINDOW_WIDTH,
    height: SETTINGS_WINDOW_HEIGHT,
    minWidth: 920,
    minHeight: 640,
    show: false,
    title: "Persona Settings",
    // Best guess until the renderer reports the theme it actually resolved,
    // which it does before the window is shown on ready-to-show.
    backgroundColor: settingsWindowBackground(
      nativeTheme.shouldUseDarkColors ? "dark" : "light",
    ),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const presentationGate = createSettingsWindowPresentationGate();
  settingsWindow = window;
  settingsWindowPresentationGate = presentationGate;

  const settingsRendererUrl = rendererUrl("settings");
  secureRendererWindow(window, settingsRendererUrl);
  window.once("ready-to-show", () => {
    if (
      settingsWindow !== window ||
      settingsWindowPresentationGate !== presentationGate
    ) {
      return;
    }
    if (presentationGate.markReadyToShow()) focusSettingsWindow();
  });
  window.on("closed", () => {
    if (settingsWindow !== window) return;
    settingsWindow = null;
    settingsWindowPresentationGate = null;
  });
  void window.loadURL(settingsRendererUrl);
  return window;
}

function focusSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  settingsWindow.setFocusable(true);
  if (settingsWindow.isMinimized()) settingsWindow.restore();
  settingsWindow.show();
  settingsWindow.moveTop();
  settingsWindow.focus();
  settingsWindow.webContents.focus();
}

function showSettings() {
  const window = createSettingsWindow();
  if (settingsWindowPresentationGate?.requestShow()) {
    focusSettingsWindow();
  }
  return window;
}

function animationCatalogSignature(snapshot) {
  return JSON.stringify(
    snapshot.animations.map((animation) => ({
      description: animation.animation_description,
      id: animation.id,
      name: animation.animation_name,
      playableClipCount: animation.asset_urls.length,
      trigger: animation.animation_trigger_scenario,
    })),
  );
}

function publishSettings(snapshot) {
  const wasConfigured = modelConfigured;
  modelConfigured = snapshotHasConfiguredModel(snapshot);
  const nextAnimationCatalogSignature = animationCatalogSignature(snapshot);
  if (nextAnimationCatalogSignature !== mcpAnimationCatalogSignature) {
    mcpAnimationCatalogSignature = nextAnimationCatalogSignature;
    mcpHandler?.notifyToolsChanged();
  }
  for (const window of [avatarWindow, settingsWindow]) {
    if (window && !window.isDestroyed() && !window.webContents.isLoading()) {
      window.webContents.send("persona:settings-updated", snapshot);
    }
  }
  refreshTrayMenu();
  if (!wasConfigured && modelConfigured) {
    void audioListener?.start();
    showOverlay();
  } else if (wasConfigured && !modelConfigured) {
    audioListener?.stop();
    const inactiveState = voiceState("idle", "inactive");
    latestVoiceState = inactiveState.state;
    emitToRenderer(inactiveState);
    destroyOverlayForSetup();
    setImmediate(focusSettingsWindow);
  }
  return snapshot;
}

function vroidHubRedirectUri() {
  return `http://127.0.0.1:${mcpServerPort}${OAUTH_CALLBACK_PATH}`;
}

// Builds vroidHubAuth/vroidHubClient from a VRoid Hub OAuth app's client
// id/secret (the user's own, saved via Settings). Requires OS-backed
// encryption to be available, since the resulting session tokens are
// persisted through it.
function configureVroidHub(clientId, clientSecret) {
  vroidHubAuth = createVroidHubAuth({
    clientId,
    clientSecret,
    redirectUri: vroidHubRedirectUri(),
    authFilePath: path.join(app.getPath("userData"), "vroid-hub-auth.json"),
    encrypt: (buffer) => safeStorage.encryptString(buffer.toString("utf8")),
    decrypt: (buffer) => Buffer.from(safeStorage.decryptString(buffer), "utf8"),
  });
  vroidHubClient = createVroidHubClient({ applicationId: clientId });
}

// The VRoid Hub bridge is exposed through the same preload script as the
// avatar overlay window, which renders untrusted user-supplied model/motion
// files. Every persona:vroid-* handler is sensitive (OAuth credentials,
// session control, licensed downloads), so each one must confirm its call
// came from the Settings window, matching persona:report-error and
// persona:settings-set-window-theme's existing sender checks below.
// isEncryptionAvailable() alone is not a reliable secrecy guarantee on
// Linux: without a running keyring (GNOME Secret Service or KWallet over
// D-Bus), Electron's safeStorage can select the basic_text backend, which
// provides no real protection. A packaged build must not tell the user their
// VRoid Hub client secret and session tokens are OS-keychain-backed when they
// are not, so this checks the actual selected backend rather than trusting
// isEncryptionAvailable() by itself. Local development still opts into
// Electron's plaintext backend for convenience. Packaged Linux builds can only
// do the same when the gated Developer setting explicitly allows it.
function vroidHubPlaintextStorageAllowed(snapshot = settingsStore?.getSnapshot()) {
  return (
    process.platform === "linux" &&
    snapshot?.vroid_hub_allow_plaintext_storage === true
  );
}

function syncVroidHubStorageBackend(snapshot = settingsStore?.getSnapshot()) {
  if (process.platform !== "linux") return;
  safeStorage.setUsePlainTextEncryption(
    !app.isPackaged || vroidHubPlaintextStorageAllowed(snapshot),
  );
}

function vroidHubSecureStorageAvailable(snapshot = settingsStore?.getSnapshot()) {
  if (vroidHubPlaintextStorageAllowed(snapshot)) return true;
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (!app.isPackaged) return true;
  return safeStorage.getSelectedStorageBackend?.() !== "basic_text";
}

const { handleFromSettings, isSettingsSender } = createSettingsIpcGate({
  ipcMain,
  getSettingsWindow: () => settingsWindow,
});

function vroidHubStatus() {
  return {
    configured: vroidHubAuth != null,
    connected: vroidHubAuth?.isConnected() ?? false,
    redirect_uri: vroidHubRedirectUri(),
  };
}

function broadcastVroidHubStatus() {
  if (
    settingsWindow &&
    !settingsWindow.isDestroyed() &&
    !settingsWindow.webContents.isLoading()
  ) {
    settingsWindow.webContents.send("persona:vroid-status-updated", vroidHubStatus());
  }
}

// getValidAccessToken drops the saved session when VRoid Hub rejects it, so
// the Settings page has to be told or it keeps offering a connected account
// that no longer exists.
async function vroidHubAccessToken(options) {
  if (!vroidHubAuth?.isConnected()) {
    throw new Error("Connect your VRoid Hub account first.");
  }
  try {
    return await vroidHubAuth.getValidAccessToken(options);
  } finally {
    if (!vroidHubAuth?.isConnected()) broadcastVroidHubStatus();
  }
}

// Runs an API call with the current access token, and on a 401 runs it once
// more behind a forced refresh.
//
// Revoking Persona on hub.vroid.com invalidates the access token immediately,
// but nothing tells the app: expires_at still looks fine, so no refresh is due
// and every call just answers 401. Forcing the refresh puts the question to
// the token endpoint, which is the only authority on whether the whole
// authorization is gone — it answers invalid_grant, the session is cleared,
// and the user finally gets "reconnect your account" instead of a bare 401.
// Deciding that from the API's 401 alone would be the mistake this path exists
// to avoid: destroying credentials on the say-so of one resource-server reply.
async function withVroidHubAuthRetry(call) {
  try {
    return await call(await vroidHubAccessToken());
  } catch (error) {
    if (error?.status !== 401) throw error;
    return call(await vroidHubAccessToken({ forceRefresh: true }));
  }
}

function refreshVroidHubStoragePolicy(snapshot = settingsStore?.getSnapshot()) {
  syncVroidHubStorageBackend(snapshot);
  if (!vroidCredentialsFilePath) return;
  if (!vroidHubSecureStorageAvailable(snapshot)) {
    vroidHubAuth?.disconnect();
    vroidHubAuth = null;
    vroidHubClient = null;
    publishSettings(settingsStore.clearActiveHubModel());
    return;
  }
  const vroidCredentials = readVroidHubCredentials({
    credentialsFilePath: vroidCredentialsFilePath,
    decrypt: (buffer) =>
      Buffer.from(safeStorage.decryptString(buffer), "utf8"),
  });
  if (vroidCredentials) {
    configureVroidHub(
      vroidCredentials.clientId,
      vroidCredentials.clientSecret,
    );
  }
}

// Invoked from the loopback bridge server once VRoid Hub redirects back with
// an authorization code (see electron/bridge-server.cjs's
// /vroid-oauth-callback route). Throwing here surfaces a failure page to the
// system browser without exposing any Electron internals to it.
async function completeVroidHubLogin({ code, state, error }) {
  if (!vroidHubAuth) throw new Error("VRoid Hub is not configured.");
  if (error) {
    throw new Error(`VRoid Hub sign-in was cancelled or denied (${error}).`);
  }
  await vroidHubAuth.exchangeCode(code, state);
  broadcastVroidHubStatus();
}

function resolveListenerProcessPattern(snapshot = settingsStore?.getSnapshot()) {
  const voiceSource = normalizeVoiceSource(snapshot?.voice_source);
  if (!["default", "custom"].includes(voiceSource.mode)) return null;
  return resolveVoiceSourcePattern({
    environment: process.env,
    settingsPattern: settingsPatternFromVoiceSource(voiceSource),
  });
}

function createConfiguredAudioListener(snapshot = settingsStore?.getSnapshot()) {
  const voiceSource = normalizeVoiceSource(snapshot?.voice_source);
  return createAudioListener({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    processPattern: resolveListenerProcessPattern(snapshot),
    voiceSource,
    onActivity: (activity) => {
      debugLog("listener activity", activity);
      handleBridgeEvent(voiceState(activity));
    },
    onDebug: debugEnabled ? (nodes) => debugLog("listener output nodes", nodes) : null,
    onLevel: (level) => handleBridgeEvent({ type: "audio-level", level }),
    onSession: (active) => {
      debugLog("listener session", active);
      handleBridgeEvent(voiceState(active ? "listening" : "idle", active ? "active" : "inactive"));
    },
    onStatus: (status) => {
      debugLog("listener status", status);
      handleListenerStatus(status);
    },
  });
}

function reportInactiveListenerStatus(snapshot = settingsStore?.getSnapshot()) {
  const voiceSource = normalizeVoiceSource(snapshot?.voice_source);
  handleListenerStatus({
    available: voiceSource.mode === "external",
    capturing: false,
    monitoring: false,
    source:
      voiceSource.mode === "external" ? "External integration" : null,
  });
}

function restartAudioListener() {
  audioListener?.stop();
  audioListener = createConfiguredAudioListener();
  if (audioListener && modelConfigured) {
    void audioListener.start();
  } else if (audioListener) {
    handleListenerStatus({
      available: true,
      capturing: false,
      monitoring: false,
      source: null,
    });
  } else {
    reportInactiveListenerStatus();
  }
}

function playConfiguredAnimation(animationName) {
  if (!hasConfiguredModel()) return false;
  const installedAnimation = settingsStore?.getAnimation(animationName);
  if (
    installedAnimation == null ||
    installedAnimation.asset_urls.length === 0
  ) {
    return false;
  }
  animationCommandRequestId += 1;
  handleBridgeEvent({
    type: "animation",
    animation: installedAnimation.animation_type ?? "CUSTOM",
    animationName: installedAnimation.animation_name,
    animationUrls: installedAnimation.asset_urls,
    expressionName: installedAnimation.expression_name,
    expressionWeight: installedAnimation.expression_weight,
    source: "command",
    requestId: animationCommandRequestId,
  });
  return true;
}

async function selectAssetFile(kind, multiple = false) {
  const extension = kind === "model" ? "vrm" : "vrma";
  const options = {
    title: kind === "model" ? "Add a VRM model" : "Add a VRMA animation",
    properties: ["openFile", ...(multiple ? ["multiSelections"] : [])],
    filters: [
      {
        name: kind === "model" ? "VRM models" : "VRMA animations",
        extensions: [extension],
      },
    ],
  };
  const result =
    settingsWindow && !settingsWindow.isDestroyed()
      ? await dialog.showOpenDialog(settingsWindow, options)
      : await dialog.showOpenDialog(options);
  if (result.canceled) return multiple ? [] : null;
  return multiple ? result.filePaths : result.filePaths[0] ?? null;
}

function flushPendingRendererEvents() {
  rendererLoadHookAttached = false;
  if (!avatarWindow || avatarWindow.isDestroyed() || avatarWindow.webContents.isLoading()) return;
  for (const event of pendingRendererEvents.values()) {
    avatarWindow.webContents.send("persona:event", event);
  }
  pendingRendererEvents.clear();
}

function ensureRendererLoadHook() {
  if (
    rendererLoadHookAttached ||
    !avatarWindow ||
    avatarWindow.isDestroyed() ||
    !avatarWindow.webContents.isLoading()
  ) {
    return;
  }
  rendererLoadHookAttached = true;
  avatarWindow.webContents.once("did-finish-load", flushPendingRendererEvents);
}

function emitToRenderer(event) {
  latestEvent = event;
  pendingRendererEvents.set(event.type, event);
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  if (avatarWindow.webContents.isLoading()) {
    ensureRendererLoadHook();
    return;
  }
  avatarWindow.webContents.send("persona:event", event);
  pendingRendererEvents.delete(event.type);
}

function handleBridgeEvent(event) {
  if (event.type !== "audio-level" || event.level > 0.025) debugLog("event", event);
  const canShowAvatar = hasConfiguredModel();
  if (event.type === "state") {
    latestVoiceState = event.state;
    if (
      canShowAvatar &&
      (event.state.phase === "starting" || event.state.phase === "active")
    ) {
      showOverlay();
    }
  } else if (
    canShowAvatar &&
    event.type === "audio-level" &&
    event.level > 0.025
  ) {
    showOverlay();
  } else if (canShowAvatar && event.type === "animation") {
    showOverlay();
  }
  if (canShowAvatar) emitToRenderer(event);
}

function handleIntegrationEvent(event) {
  if (event.type === "animation-command") {
    return playConfiguredAnimation(event.animationName);
  }
  handleBridgeEvent(event);
  return true;
}

function handleListenerStatus(status) {
  latestListenerStatus = status;
  if (hasConfiguredModel()) {
    emitToRenderer({ type: "listener-status", status });
  }
}

async function handleMcpWindowAction(action) {
  if (!hasConfiguredModel()) return false;
  if (action === "show") showOverlay({ focus: true });
  else if (action === "hide") await hideOverlay();
  else if (avatarWindow?.isVisible()) await hideOverlay();
  else showOverlay({ focus: true });
  return avatarWindow?.isVisible() ?? false;
}

function getMcpStatus() {
  return {
    modelConfigured: hasConfiguredModel(),
    windowVisible: avatarWindow?.isVisible() ?? false,
    voiceState: latestVoiceState,
    listener: latestListenerStatus,
  };
}

function handleProtocolUrl(rawUrl) {
  const commands = parseProtocolUrl(rawUrl, protocolScheme);
  if (!commands) return false;
  let handled = true;
  for (const command of commands) {
    if (command.type === "show") showOverlay({ focus: true });
    else if (command.type === "hide") void hideOverlay();
    else if (command.type === "toggle") toggleOverlay();
    else if (command.type === "event") handleBridgeEvent(command.event);
    else if (command.type === "animation-command") {
      handled = playConfiguredAnimation(command.animationName) && handled;
    }
  }
  return handled;
}

function handleProtocolArgv(argv) {
  const protocolUrl = argv.find((value) => value.startsWith(`${protocolScheme}://`));
  if (protocolUrl) handleProtocolUrl(protocolUrl);
}

function refreshTrayMenu() {
  if (!tray) return;
  const ready = hasConfiguredModel();
  const quitItem = {
    label: "Quit",
    click: () => {
      isQuitting = true;
      app.quit();
    },
  };
  const template = ready
    ? [
        { label: "Show Persona", click: () => showOverlay({ focus: true }) },
        { label: "Hide Persona", click: () => void hideOverlay() },
        { label: "Settings…", click: showSettings },
        { type: "separator" },
        {
          label: "Preview listening",
          click: () => handleBridgeEvent(voiceState("listening")),
        },
        {
          label: "Preview speaking",
          click: () => handleBridgeEvent(voiceState("speaking")),
        },
        { type: "separator" },
        quitItem,
      ]
    : [
        { label: "Set up Persona…", click: showSettings },
        { type: "separator" },
        quitItem,
      ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const iconPath = path.join(
    __dirname,
    "..",
    app.isPackaged ? "dist" : "public",
    "assets",
    "avatar.png",
  );
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip("Persona");
  refreshTrayMenu();
  tray.on("click", toggleOverlay);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const handled = argv.some((value) => value.startsWith(`${protocolScheme}://`));
    handleProtocolArgv(argv);
    if (argv.includes("--settings")) showSettings();
    else if (!handled && !argv.includes("--background")) showOverlay({ focus: true });
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleProtocolUrl(url);
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId("com.xikhar.persona");
    app.dock?.hide();
    if (app.isPackaged) app.setAsDefaultProtocolClient(protocolScheme);
    settingsStore = createSettingsStore({
      userDataPath: app.getPath("userData"),
      packagedLibraryPath: path.join(
        __dirname,
        "..",
        app.isPackaged ? "dist" : "public",
        "assets",
        "library.json",
      ),
    });
    const initialSettingsSnapshot = settingsStore.getSnapshot();
    modelConfigured = snapshotHasConfiguredModel(initialSettingsSnapshot);
    mcpAnimationCatalogSignature = animationCatalogSignature(
      initialSettingsSnapshot,
    );
    protocol.handle(PERSONA_ASSET_SCHEME, (request) => {
      const resolved = settingsStore?.resolveAssetRequest(request.url);
      if (!resolved) {
        return new Response("Asset not found", { status: 404 });
      }
      if (typeof resolved === "string") {
        return net.fetch(pathToFileURL(resolved).href);
      }
      // An in-memory hub model: never touches disk, served directly from its
      // buffer.
      return new Response(resolved.buffer, {
        headers: { "content-type": "model/gltf-binary" },
      });
    });

    // VRoid Hub OAuth is opt-in and advanced: it's off until the user
    // registers their own OAuth app at hub.vroid.com/oauth/applications and
    // pastes its client id/secret into Settings (see docs/INTEGRATIONS.md).
    // Those credentials are encrypted at rest the same way as the resulting
    // session tokens. The redirect URI is served by the local loopback
    // bridge below, not the persona:// deep link, so it works identically in
    // `npm run dev`/`demo` and packaged builds.
    syncVroidHubStorageBackend(initialSettingsSnapshot);
    vroidCredentialsFilePath = path.join(
      app.getPath("userData"),
      "vroid-hub-credentials.json",
    );
    if (vroidHubSecureStorageAvailable(initialSettingsSnapshot)) {
      const vroidCredentials = readVroidHubCredentials({
        credentialsFilePath: vroidCredentialsFilePath,
        decrypt: (buffer) =>
          Buffer.from(safeStorage.decryptString(buffer), "utf8"),
      });
      if (vroidCredentials) {
        configureVroidHub(vroidCredentials.clientId, vroidCredentials.clientSecret);
      }
    }

    ipcMain.handle("persona:get-snapshot", () => latestEvent);
    ipcMain.handle("persona:settings-get", () => settingsStore.getSnapshot());
    handleFromSettings("persona:settings-import-model", async (metadata) => {
      const filePath = await selectAssetFile("model");
      if (!filePath) return null;
      return publishSettings(
        settingsStore.importModel({ filePath, model_name: metadata?.model_name }),
      );
    });
    handleFromSettings("persona:settings-create-animation", (metadata) =>
      publishSettings(settingsStore.createAnimation(metadata)),
    );
    handleFromSettings(
      "persona:settings-add-animation-clips",
      async (animationId) => {
        const filePaths = await selectAssetFile("animation", true);
        if (filePaths.length === 0) return null;
        return publishSettings(
          settingsStore.addAnimationClips(animationId, filePaths),
        );
      },
    );
    handleFromSettings(
      "persona:settings-update-animation",
      (animationId, metadata) =>
        publishSettings(
          settingsStore.updateAnimation(animationId, metadata),
        ),
    );
    handleFromSettings(
      "persona:settings-delete-animation",
      (animationId) =>
        publishSettings(settingsStore.deleteAnimation(animationId)),
    );
    handleFromSettings(
      "persona:settings-delete-animation-clip",
      (animationId, clipId) =>
        publishSettings(
          settingsStore.deleteAnimationClip(animationId, clipId),
        ),
    );
    handleFromSettings(
      "persona:settings-reset-packaged-animations",
      () => publishSettings(settingsStore.resetPackagedAnimations()),
    );
    handleFromSettings(
      "persona:settings-delete-model",
      (modelId) => {
        const model = settingsStore
          .getSnapshot()
          .models.find((candidate) => candidate.id === modelId);
        if (!model?.removable) {
          throw new Error("Packaged models cannot be deleted.");
        }
        return publishSettings(settingsStore.deleteModel(modelId));
      },
    );
    handleFromSettings("persona:settings-set-default-model", (modelId) =>
      publishSettings(settingsStore.setDefaultModel(modelId)),
    );
    handleFromSettings("persona:settings-set-character-size", (size) =>
      publishSettings(settingsStore.setCharacterSize(size)),
    );
    handleFromSettings(
      "persona:settings-set-avatar-window-size",
      (width, height) => {
        const snapshot = publishSettings(
          settingsStore.setAvatarWindowSize(width, height),
        );
        applyAvatarWindowSize();
        return snapshot;
      },
    );
    handleFromSettings(
      "persona:settings-set-speaking-transition",
      (transition) =>
        publishSettings(settingsStore.setSpeakingTransition(transition)),
    );
    handleFromSettings(
      "persona:settings-set-body-transition-ms",
      (milliseconds) =>
        publishSettings(settingsStore.setBodyTransitionMs(milliseconds)),
    );
    handleFromSettings(
      "persona:settings-set-speaking-debounce-ms",
      (milliseconds) =>
        publishSettings(settingsStore.setSpeakingDebounceMs(milliseconds)),
    );
    handleFromSettings(
      "persona:settings-set-idle-interim-ms",
      (milliseconds) =>
        publishSettings(settingsStore.setIdleInterimMs(milliseconds)),
    );
    handleFromSettings("persona:settings-enable-developer", () =>
      publishSettings(settingsStore.enableDeveloperSettings()),
    );
    handleFromSettings("persona:settings-reset-developer", () => {
      const snapshot = publishSettings(settingsStore.resetDeveloperSettings());
      refreshVroidHubStoragePolicy(snapshot);
      broadcastVroidHubStatus();
      return settingsStore.getSnapshot();
    });
    handleFromSettings(
      "persona:settings-set-vroid-plaintext-storage",
      (allowed) => {
        const snapshot = publishSettings(
          settingsStore.setVroidHubPlaintextStorageAllowed(allowed),
        );
        syncVroidHubStorageBackend(snapshot);
        if (!vroidHubSecureStorageAvailable(snapshot)) {
          vroidHubAuth?.disconnect();
          vroidHubAuth = null;
          vroidHubClient = null;
          publishSettings(settingsStore.clearActiveHubModel());
        } else if (vroidCredentialsFilePath) {
          const vroidCredentials = readVroidHubCredentials({
            credentialsFilePath: vroidCredentialsFilePath,
            decrypt: (buffer) =>
              Buffer.from(safeStorage.decryptString(buffer), "utf8"),
          });
          if (vroidCredentials) {
            configureVroidHub(
              vroidCredentials.clientId,
              vroidCredentials.clientSecret,
            );
          }
        }
        broadcastVroidHubStatus();
        return settingsStore.getSnapshot();
      },
    );
    handleFromSettings("persona:settings-set-voice-source", (voiceSource) => {
      const snapshot = publishSettings(settingsStore.setVoiceSource(voiceSource));
      restartAudioListener();
      return snapshot;
    });
    handleFromSettings("persona:settings-list-voice-sources", async () => {
      try {
        return {
          ...(await listVoiceSources()),
          error: null,
          events_url: `http://127.0.0.1:${mcpServerPort}/events`,
          listener: latestListenerStatus,
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          events_url: `http://127.0.0.1:${mcpServerPort}/events`,
          listener: latestListenerStatus,
          platform: process.platform,
          sources: [],
        };
      }
    });
    handleFromSettings(
      "persona:settings-set-model-lighting",
      (modelId, lighting) =>
        publishSettings(settingsStore.setModelLighting(modelId, lighting)),
    );
    handleFromSettings(
      "persona:settings-reset-model-lighting",
      (modelId) =>
        publishSettings(settingsStore.resetModelLighting(modelId)),
    );
    handleFromSettings("persona:settings-get-mcp-status", () =>
      createMcpSettingsStatus({
        error: mcpServerError,
        health: mcpServerHealth,
        port: mcpServerPort,
        settingsSnapshot: settingsStore.getSnapshot(),
      }),
    );
    handleFromSettings("persona:vroid-get-status", () => vroidHubStatus());
    handleFromSettings("persona:vroid-get-credentials", () => {
      if (!vroidHubSecureStorageAvailable()) {
        return { clientId: null, hasClientSecret: false };
      }
      const credentials = readVroidHubCredentials({
        credentialsFilePath: vroidCredentialsFilePath,
        decrypt: (buffer) =>
          Buffer.from(safeStorage.decryptString(buffer), "utf8"),
      });
      return {
        clientId: credentials?.clientId ?? null,
        hasClientSecret: credentials != null,
      };
    });
    handleFromSettings(
      "persona:vroid-set-credentials",
      (clientId, clientSecret) => {
        if (!vroidHubSecureStorageAvailable()) {
          throw new Error(
            "This OS has no secure credential storage available, so VRoid Hub credentials cannot be saved.",
          );
        }
        writeVroidHubCredentials(
          {
            credentialsFilePath: vroidCredentialsFilePath,
            encrypt: (buffer) => safeStorage.encryptString(buffer.toString("utf8")),
          },
          { clientId, clientSecret },
        );
        // A new OAuth app means any existing session belongs to the old one.
        vroidHubAuth?.disconnect();
        publishSettings(settingsStore.clearActiveHubModel());
        configureVroidHub(clientId.trim(), clientSecret.trim());
        broadcastVroidHubStatus();
        return vroidHubStatus();
      },
    );
    handleFromSettings("persona:vroid-clear-credentials", () => {
      clearVroidHubCredentials({ credentialsFilePath: vroidCredentialsFilePath });
      vroidHubAuth?.disconnect();
      vroidHubAuth = null;
      vroidHubClient = null;
      publishSettings(settingsStore.clearActiveHubModel());
      broadcastVroidHubStatus();
      return vroidHubStatus();
    });
    handleFromSettings("persona:vroid-connect", () => {
      if (!vroidHubAuth) {
        throw new Error(
          "VRoid Hub is not configured. Add your VRoid Hub app credentials in Settings first.",
        );
      }
      void shell.openExternal(vroidHubAuth.buildAuthorizeUrl());
      return vroidHubStatus();
    });
    handleFromSettings("persona:vroid-disconnect", () => {
      vroidHubAuth?.disconnect();
      publishSettings(settingsStore.clearActiveHubModel());
      return vroidHubStatus();
    });
    handleFromSettings("persona:vroid-list-characters", async () => {
      return withVroidHubAuthRetry((token) =>
        vroidHubClient.listCharacters(token),
      );
    });
    // Portraits load one card at a time after the list renders, so a slow or
    // unreachable image CDN delays a thumbnail rather than the whole picker.
    // Only ids from the last listing resolve to a URL (see the client), and a
    // missing portrait is a null, not an error — the card just keeps its
    // placeholder icon.
    handleFromSettings(
      "persona:vroid-character-portrait",
      async (characterId) => {
        if (typeof characterId !== "string" || characterId === "") {
          throw new Error("A character id is required.");
        }
        return (await vroidHubClient?.loadCharacterPortrait(characterId)) ?? null;
      },
    );
    handleFromSettings(
      "persona:vroid-select-character",
      async (characterId, characterName) => {
        // No re-fetch of the character list to check characterId is in it:
        // that's not a real gate anyway, since /api/download_licenses below
        // is VRoid Hub's own authority on whether this id is licensable, and
        // the renderer already has this id from the list it just rendered.
        // Safe to run twice: a 401 can only come from the two authorized
        // calls, and replaying them just mints a second download license.
        const buffer = await withVroidHubAuthRetry((token) =>
          vroidHubClient.loadCharacterModel(token, characterId),
        );
        return publishSettings(
          settingsStore.setActiveHubModel(buffer, {
            model_name: characterName,
          }),
        );
      },
    );
    // Builds the model's Hub page from bare ids rather than trusting a full
    // URL from the renderer. characterModelPageUrl validates both ids and
    // owns the path's shape, where it can be tested — this handler can't.
    handleFromSettings(
      "persona:vroid-open-character-page",
      (characterId, characterModelId) => {
        void shell.openExternal(
          characterModelPageUrl(characterId, characterModelId),
        );
      },
    );
    ipcMain.on("persona:hide", () => void hideOverlay());
    // The avatar window is frameless with no OS-drawn titlebar, and its only
    // draggable surface (left-click) is already claimed by orbit controls,
    // so window manager "drag the titlebar" gestures don't apply to it. This
    // gives the renderer an explicit, platform-independent way to reposition
    // it (bound to an Alt+drag gesture) instead of relying on each OS/desktop
    // environment's own window-move affordance.
    ipcMain.on("persona:move-by", (_event, dx, dy) => {
      if (!avatarWindow || avatarWindow.isDestroyed()) return;
      if (
        typeof dx !== "number" ||
        typeof dy !== "number" ||
        !Number.isFinite(dx) ||
        !Number.isFinite(dy)
      ) {
        return;
      }
      const bounds = avatarWindow.getBounds();
      avatarWindow.setPosition(
        Math.round(bounds.x + dx),
        Math.round(bounds.y + dy),
      );
    });
    // The resolved theme lives in renderer storage, so the window chrome can
    // only be corrected once the settings renderer reports it. Accepts the two
    // known theme names and never a caller-supplied colour.
    ipcMain.on("persona:settings-set-window-theme", (event, theme) => {
      if (theme !== "dark" && theme !== "light") return;
      // A send has no reply channel to reject through, so an unexpected sender
      // is dropped rather than thrown at the main process.
      if (!isSettingsSender(event)) return;
      const background = settingsWindowBackground(theme);
      settingsWindow.setBackgroundColor(background);
      debugLog("settings window background", theme, background);
      if (settingsWindowPresentationGate?.markThemeApplied()) {
        focusSettingsWindow();
      }
    });

    mcpHandler = createPersonaMcpHandler({
      onAnimation: playConfiguredAnimation,
      onWindowAction: handleMcpWindowAction,
      getStatus: getMcpStatus,
      getAnimations: () =>
        settingsStore
          .getSnapshot()
          .animations.filter((animation) => animation.asset_urls.length > 0),
    });
    bridge = createBridgeServer({
      port: mcpServerPort,
      onEvent: handleIntegrationEvent,
      mcpHandler,
      // Always wired in, not gated on vroidHubAuth at creation time: the user
      // can configure VRoid Hub credentials from Settings at any point after
      // the bridge server starts, and completeVroidHubLogin itself already
      // rejects if vroidHubAuth still isn't set by the time a callback lands.
      onOauthCallback: completeVroidHubLogin,
    });
    try {
      const address = await bridge.listen();
      if (address && typeof address === "object") {
        mcpServerPort = address.port;
      }
      mcpServerHealth = "online";
      mcpServerError = null;
    } catch (error) {
      mcpServerHealth = "unavailable";
      mcpServerError =
        error instanceof Error ? error.message : String(error);
      console.error(
        "[persona] local integration server unavailable:",
        mcpServerError,
      );
      bridge = null;
    }

    createTray();
    globalShortcut.register("CommandOrControl+Shift+A", toggleOverlay);
    handleProtocolArgv(process.argv);

    audioListener = createConfiguredAudioListener();
    if (audioListener && modelConfigured) {
      void audioListener.start();
    } else if (audioListener) {
      handleListenerStatus({
        available: true,
        capturing: false,
        monitoring: false,
        source: null,
      });
    } else {
      reportInactiveListenerStatus();
    }

    if (!modelConfigured || startInSettings) {
      showSettings();
    } else if (!startInBackground) {
      createWindow();
      showOverlay({ focus: true });
    }
  });
}

app.on("activate", () => showOverlay({ focus: true }));

app.on("before-quit", () => {
  isQuitting = true;
  clearTimeout(hyprlandConfigurationTimer);
  audioListener?.stop();
  globalShortcut.unregisterAll();
  void mcpHandler?.close();
  void bridge
    ?.close()
    .catch((error) => debugLog("integration server close failed", error));
});

app.on("window-all-closed", () => {
  // The tray, protocol handler, and adapter server keep Persona available.
});
