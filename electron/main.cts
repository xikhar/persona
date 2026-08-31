import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
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
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import {
  createBridgeServer,
  DEFAULT_PORT,
  OAUTH_CALLBACK_PATH,
  type BridgeServer,
  type IntegrationEvent,
  type OauthCallbackParameters,
} from './bridge-server.cjs';
import {
  createClickThroughState,
  type MouseIgnoreFlags,
} from './click-through.cjs';
import {
  createPersonaMcpHandler,
  type PersonaMcpHandler,
  type WindowAction,
} from './mcp-server.cjs';
import {
  createMcpSettingsStatus,
  type McpHealth,
} from './mcp-settings-status.cjs';
import {
  createSettingsStore,
  DEFAULT_AVATAR_WINDOW_SIZE,
  MIN_AVATAR_WINDOW_WIDTH,
  MIN_AVATAR_WINDOW_HEIGHT,
  type SettingsSnapshot,
  type SettingsStore,
} from './settings-store.cjs';
import {
  createVroidHubAuth,
  type VroidHubAccessToken,
  type VroidHubAuth,
} from './vroid-hub-auth.cjs';
import {
  characterModelPageUrl,
  createVroidHubClient,
  type VroidHubClient,
} from './vroid-hub-client.cjs';
import {
  clearVroidHubCredentials,
  readVroidHubCredentials,
  writeVroidHubCredentials,
} from './vroid-hub-credentials.cjs';
import {
  configureHyprlandWindow,
  getHyprlandWindowPlacement,
  type WindowPosition,
} from './hyprland-window.cjs';
import { clampWindowPosition } from './window-bounds.cjs';
import {
  createAudioListener,
  type AudioListener,
} from './audio-listener.cjs';
import { listVoiceSources } from './voice-source-discovery.cjs';
import { isAllowedRendererNavigation } from './navigation-policy.cjs';
import {
  drainRendererEventsForLoad,
  PendingRendererEvents,
} from './renderer-event-queue.cjs';
import { reconcileHeldExpression as reconcileHold } from './expression-hold.cjs';
import { createSettingsIpcGate } from './settings-ipc.cjs';
import { snapshotHasConfiguredModel } from './model-readiness.cjs';
import { parseProtocolUrl, voiceState } from './protocol-actions.cjs';
import {
  createSettingsWindowPresentationGate,
  type SettingsWindowPresentationGate,
} from './settings-window-presentation.cjs';
import {
  normalizeVoiceSource,
  resolveVoiceSourcePattern,
  settingsPatternFromVoiceSource,
} from './voice-source.cjs';
import type {
  AudioListenerStatus,
  AvatarRendererEvent,
  ClickThroughSnapshot,
  VoiceState,
} from './types.cjs';
import { isRecord } from './types.cjs';
import {
  createAnimationGenerator,
  type AnimationGeneratorService,
} from './animation-generator.cjs';
import { exportAnimationLibraryClip } from './animation-clip-export.cjs';

// Derived rather than imported so it cannot drift from the union the renderer
// actually receives.
type ExpressionHoldEvent = Extract<
  AvatarRendererEvent,
  { type: 'expression-hold' }
>;

type WindowTheme = keyof typeof SETTINGS_WINDOW_BACKGROUND;
type AssetKind = 'model' | 'animation';

interface HttpStatusErrorLike {
  status: number;
}

function requiredIpcString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${field} is required.`);
  }
  return value;
}

const SETTINGS_WINDOW_WIDTH = 1180;
const SETTINGS_WINDOW_HEIGHT = 780;
// Chromium paints this behind newly exposed areas during a resize, so it must
// track the renderer's --bg-window token in src/styles.css.
const SETTINGS_WINDOW_BACKGROUND = {
  dark: "#0d0e12",
  light: "#e6e8ec",
};
const PERSONA_ASSET_SCHEME = "persona-asset";
const KIMODO_REPOSITORY_URL = "https://github.com/localai-org/kimodo.cpp";
// An integration that crashes, is killed, or simply forgets to send
// expression-release would otherwise leave the character's face frozen with no
// way for the user to recover it. Drop a held expression after this long.
const EXPRESSION_HOLD_TIMEOUT_MS = 5 * 60_000;
const startInBackground = process.argv.includes("--background");
const startInSettings = process.argv.includes("--settings");
const protocolScheme = "persona";
const debugEnabled = process.env.PERSONA_DEBUG === "1";

let avatarWindow: BrowserWindow | null = null;
let avatarRendererLoaded = false;
let settingsWindow: BrowserWindow | null = null;
let settingsWindowPresentationGate: SettingsWindowPresentationGate | null = null;
let settingsStore: SettingsStore | null = null;
let vroidHubAuth: VroidHubAuth | null = null;
let vroidHubClient: VroidHubClient | null = null;
let vroidCredentialsFilePath: string | null = null;
let bridge: BridgeServer | null = null;
let mcpHandler: PersonaMcpHandler | null = null;
let animationGenerator: AnimationGeneratorService | null = null;
let isQuitting = false;
let latestEvent: AvatarRendererEvent | null = null;
let latestListenerStatus: AudioListenerStatus | null = null;
let latestVoiceState: VoiceState | null = null;
let audioListener: AudioListener | null = null;
let tray: Tray | null = null;
let hyprlandConfigured = false;
let hyprlandConfiguring = false;
let hyprlandConfigurationTimer: NodeJS.Timeout | null = null;
let hyprlandLastPosition: WindowPosition | null = null;
let hyprlandConfigurationGeneration = 0;
let animationCommandRequestId = 0;
let modelConfigured = false;
let mcpServerError: string | null = null;
let mcpServerHealth: McpHealth = "starting";
let mcpServerPort = Number(
  process.env.PERSONA_BRIDGE_PORT || DEFAULT_PORT,
);
let mcpAnimationCatalogSignature: string | null = null;
// The hold is kept whole, not just as a resolved expression name: the source
// action and model are what a settings change has to be reconciled against,
// and the event is what a freshly loaded renderer has to be re-sent.
let heldExpression: {
  animationName: string;
  modelId: string | null;
  event: ExpressionHoldEvent;
} | null = null;
let heldExpressionTimer: NodeJS.Timeout | null = null;
const pendingRendererEvents = new PendingRendererEvents();
const clickThrough = createClickThroughState(process.platform);

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

function debugLog(...values: unknown[]): void {
  if (debugEnabled) console.error("[persona]", ...values);
}

/**
 * The corner the avatar launches in, on the display the cursor is on. Sized
 * from settings rather than `getBounds()`: an X11 resize lands asynchronously,
 * so bounds read straight after `setSize` can still describe the old window.
 */
function avatarCornerPosition(): WindowPosition {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = avatarWindowSize();
  const margin = 24;
  return {
    x: Math.round(display.workArea.x + display.workArea.width - width - margin),
    y: Math.round(display.workArea.y + display.workArea.height - height - margin),
  };
}

function positionWindow(window: BrowserWindow): void {
  const { x, y } = avatarCornerPosition();
  window.setPosition(x, y, false);
}

function hasConfiguredModel(): boolean {
  return modelConfigured;
}

function avatarWindowSize() {
  return settingsStore?.getSnapshot().avatar_window ?? DEFAULT_AVATAR_WINDOW_SIZE;
}

function applyAvatarWindowSize(): void {
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  const { width, height } = avatarWindowSize();
  avatarWindow.setSize(width, height);
  scheduleHyprlandWindowConfiguration({ force: true, reposition: false });
}

function clearHyprlandConfigurationTimer(): void {
  if (hyprlandConfigurationTimer) {
    clearTimeout(hyprlandConfigurationTimer);
    hyprlandConfigurationTimer = null;
  }
}

function scheduleHyprlandWindowConfiguration({
  attempt = 0,
  force = false,
  position = null,
  reposition = !hyprlandConfigured,
}: {
  attempt?: number;
  force?: boolean;
  position?: WindowPosition | null;
  reposition?: boolean;
} = {}): void {
  if (
    (hyprlandConfigured && !force) ||
    hyprlandConfiguring ||
    !avatarWindow ||
    avatarWindow.isDestroyed()
  ) {
    return;
  }
  clearHyprlandConfigurationTimer();
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

function showOverlay({ focus = false }: { focus?: boolean } = {}): void {
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

async function hideOverlay(): Promise<void> {
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

/**
 * Deliberately not `sendToRenderer`: that queues for replay to a renderer that
 * has not loaded, and one still loading frames the character correctly anyway.
 */
function sendResetView(): void {
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  if (avatarWindow.webContents.isLoading()) return;
  const event: AvatarRendererEvent = { type: "reset-view" };
  avatarWindow.webContents.send("persona:event", event);
}

/**
 * A pan and a drag can between them leave nothing on screen to aim a
 * correction at, which is why this lives on the tray and not on the window.
 */
function recenterAvatar(): void {
  // One sample shared by all three paths below: each read takes the cursor
  // afresh, and a pointer crossing displays between them would split them.
  const corner = avatarCornerPosition();
  // Showing the window replays the last placement -- here, the stranded spot
  // being escaped from -- so aim that path at the corner as well.
  hyprlandLastPosition = corner;
  showOverlay();
  const window = avatarWindow;
  if (!window || window.isDestroyed()) return;
  applyAvatarWindowSize();
  window.setPosition(corner.x, corner.y, false);
  // Neither default is right here: `reposition` is false once the window has
  // been configured, and a null `position` means the monitor it is stranded on.
  scheduleHyprlandWindowConfiguration({
    force: true,
    position: corner,
    reposition: true,
  });
  sendResetView();
}

function destroyOverlayForSetup(): void {
  releaseHeldExpression("reset");
  clearHyprlandConfigurationTimer();
  hyprlandConfigurationGeneration += 1;
  hyprlandConfigurationTimer = null;
  hyprlandConfigured = false;
  hyprlandConfiguring = false;
  hyprlandLastPosition = null;
  pendingRendererEvents.clear();
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.destroy();
  }
  avatarWindow = null;
  avatarRendererLoaded = false;
}

function toggleOverlay(): void {
  if (!hasConfiguredModel()) {
    showSettings();
    return;
  }
  if (avatarWindow?.isVisible()) void hideOverlay();
  else showOverlay({ focus: true });
}

function rendererUrl(view: string | null = null): string {
  const url = new URL(
    process.env.VITE_DEV_SERVER_URL ||
      pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href,
  );
  if (view) url.searchParams.set("view", view);
  if (debugEnabled) url.searchParams.set("animationDebug", "1");
  return url.href;
}

function secureRendererWindow(
  window: BrowserWindow,
  allowedRendererUrl: string,
): void {
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

function createWindow(): BrowserWindow {
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
  avatarRendererLoaded = false;

  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setOpacity(1);
  applyClickThroughFlags(window);
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
    clearHyprlandConfigurationTimer();
    hyprlandConfigured = false;
    hyprlandConfiguring = false;
    avatarWindow = null;
    avatarRendererLoaded = false;
  });

  // Every load needs the flush, including reloads and loads during which no
  // event happened to arrive: a held expression has to be restored either way.
  window.webContents.on("did-start-loading", () => {
    if (avatarWindow === window) avatarRendererLoaded = false;
  });
  window.webContents.on("did-finish-load", () => {
    if (avatarWindow !== window) return;
    avatarRendererLoaded = true;
    flushPendingRendererEvents();
  });

  const avatarRendererUrl = rendererUrl();
  secureRendererWindow(window, avatarRendererUrl);
  void window.loadURL(avatarRendererUrl);
  return window;
}

function settingsWindowBackground(theme: WindowTheme): string {
  return SETTINGS_WINDOW_BACKGROUND[theme] ?? SETTINGS_WINDOW_BACKGROUND.dark;
}

function createSettingsWindow(): BrowserWindow {
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

function focusSettingsWindow(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  settingsWindow.setFocusable(true);
  if (settingsWindow.isMinimized()) settingsWindow.restore();
  settingsWindow.show();
  settingsWindow.moveTop();
  settingsWindow.focus();
  settingsWindow.webContents.focus();
}

function showSettings(): BrowserWindow {
  const window = createSettingsWindow();
  if (settingsWindowPresentationGate?.requestShow()) {
    focusSettingsWindow();
  }
  return window;
}

function animationCatalogSignature(snapshot: SettingsSnapshot): string {
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

function publishSettings(snapshot: SettingsSnapshot): SettingsSnapshot {
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
  reconcileHeldExpression(snapshot);
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

function vroidHubRedirectUri(): string {
  return `http://127.0.0.1:${mcpServerPort}${OAUTH_CALLBACK_PATH}`;
}

// Builds vroidHubAuth/vroidHubClient from a VRoid Hub OAuth app's client
// id/secret (the user's own, saved via Settings). Requires OS-backed
// encryption to be available, since the resulting session tokens are
// persisted through it.
function configureVroidHub(clientId: string, clientSecret: string): void {
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
function vroidHubPlaintextStorageAllowed(
  snapshot: SettingsSnapshot | undefined = settingsStore?.getSnapshot(),
): boolean {
  return (
    process.platform === "linux" &&
    snapshot?.vroid_hub_allow_plaintext_storage === true
  );
}

function syncVroidHubStorageBackend(
  snapshot: SettingsSnapshot | undefined = settingsStore?.getSnapshot(),
): void {
  if (process.platform !== "linux") return;
  safeStorage.setUsePlainTextEncryption(
    !app.isPackaged || vroidHubPlaintextStorageAllowed(snapshot),
  );
}

function vroidHubSecureStorageAvailable(
  snapshot: SettingsSnapshot | undefined = settingsStore?.getSnapshot(),
): boolean {
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

function broadcastVroidHubStatus(): void {
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
async function vroidHubAccessToken(
  options: Parameters<VroidHubAuth['getValidAccessToken']>[0] = {},
): Promise<VroidHubAccessToken> {
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
function isHttpStatusError(error: unknown): error is HttpStatusErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
  );
}

async function withVroidHubAuthRetry<TResult>(
  call: (token: VroidHubAccessToken) => Promise<TResult>,
): Promise<TResult> {
  try {
    return await call(await vroidHubAccessToken());
  } catch (error) {
    if (!isHttpStatusError(error) || error.status !== 401) throw error;
    return call(await vroidHubAccessToken({ forceRefresh: true }));
  }
}

function refreshVroidHubStoragePolicy(
  snapshot: SettingsSnapshot | undefined = settingsStore?.getSnapshot(),
): void {
  syncVroidHubStorageBackend(snapshot);
  if (!vroidCredentialsFilePath) return;
  if (!vroidHubSecureStorageAvailable(snapshot)) {
    vroidHubAuth?.disconnect();
    vroidHubAuth = null;
    vroidHubClient = null;
    if (settingsStore) publishSettings(settingsStore.clearActiveHubModel());
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
// an authorization code (see electron/bridge-server.cts's
// /vroid-oauth-callback route). Throwing here surfaces a failure page to the
// system browser without exposing any Electron internals to it.
async function completeVroidHubLogin({
  code,
  state,
  error,
}: OauthCallbackParameters): Promise<void> {
  if (!vroidHubAuth) throw new Error("VRoid Hub is not configured.");
  if (error) {
    throw new Error(`VRoid Hub sign-in was cancelled or denied (${error}).`);
  }
  await vroidHubAuth.exchangeCode(code, state);
  broadcastVroidHubStatus();
}

function resolveListenerProcessPattern(
  snapshot: SettingsSnapshot | undefined = settingsStore?.getSnapshot(),
): RegExp | null {
  const voiceSource = normalizeVoiceSource(snapshot?.voice_source);
  if (!["default", "custom"].includes(voiceSource.mode)) return null;
  return resolveVoiceSourcePattern({
    environment: process.env,
    settingsPattern: settingsPatternFromVoiceSource(voiceSource),
  });
}

function createConfiguredAudioListener(
  snapshot: SettingsSnapshot | undefined = settingsStore?.getSnapshot(),
): AudioListener | null {
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

function reportInactiveListenerStatus(
  snapshot: SettingsSnapshot | undefined = settingsStore?.getSnapshot(),
): void {
  const voiceSource = normalizeVoiceSource(snapshot?.voice_source);
  handleListenerStatus({
    available: voiceSource.mode === "external",
    capturing: false,
    monitoring: false,
    source:
      voiceSource.mode === "external" ? "External integration" : null,
  });
}

function restartAudioListener(): void {
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

function playConfiguredAnimation(animationName: string): boolean {
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

function clearHeldExpressionTimer(): void {
  if (heldExpressionTimer) {
    clearTimeout(heldExpressionTimer);
    heldExpressionTimer = null;
  }
}

// Releasing when nothing is held is a no-op rather than an error: an
// integration that lost track of its own state should be able to send
// expression-release blindly and end up in the default lifecycle.
function releaseHeldExpression(
  reason: "integration" | "timeout" | "reset" | "settings",
): void {
  clearHeldExpressionTimer();
  if (heldExpression == null) return;
  debugLog("expression release", {
    expression: heldExpression.event.expressionName,
    reason,
  });
  heldExpression = null;
  // A reset destroys the overlay and clears the pending queue on the next
  // statement, so there is no renderer left to tell.
  if (reason !== "reset") handleBridgeEvent({ type: "expression-release" });
}

// Unlike playConfiguredAnimation this deliberately does not require
// asset_urls: holding an expression never plays the VRMA, so an action whose
// clips are missing can still contribute its configured expression.
function holdConfiguredExpression(animationName: string): boolean {
  if (!hasConfiguredModel()) return false;
  const installedAnimation = settingsStore?.getAnimation(animationName);
  if (installedAnimation == null || !installedAnimation.expression_name) {
    return false;
  }
  clearHeldExpressionTimer();
  const event: ExpressionHoldEvent = {
    type: "expression-hold",
    expressionName: installedAnimation.expression_name,
    expressionWeight: installedAnimation.expression_weight,
  };
  heldExpression = {
    animationName,
    modelId: settingsStore?.getSnapshot()?.default_model_id ?? null,
    event,
  };
  heldExpressionTimer = setTimeout(
    () => releaseHeldExpression("timeout"),
    EXPRESSION_HOLD_TIMEOUT_MS,
  );
  heldExpressionTimer.unref?.();
  handleBridgeEvent(event);
  return true;
}

// Editing or deleting the held action, or switching models, can leave the
// renderer showing an expression the configuration no longer describes.
function reconcileHeldExpression(snapshot: SettingsSnapshot): void {
  if (heldExpression == null) return;
  const outcome = reconcileHold(
    {
      animationName: heldExpression.animationName,
      modelId: heldExpression.modelId,
      expressionName: heldExpression.event.expressionName,
      expressionWeight: heldExpression.event.expressionWeight ?? 1,
    },
    snapshot,
  );
  if (outcome === "keep") return;
  debugLog("expression hold invalidated", { outcome });
  releaseHeldExpression("settings");
}

function selectAssetFile(kind: AssetKind, multiple: true): Promise<string[]>;
function selectAssetFile(
  kind: AssetKind,
  multiple?: false,
): Promise<string | null>;
async function selectAssetFile(
  kind: AssetKind,
  multiple = false,
): Promise<string | string[] | null> {
  const extension = kind === "model" ? "vrm" : "vrma";
  const options: OpenDialogOptions = {
    title: kind === "model" ? "Add a VRM model" : "Add a VRMA animation",
    properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
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

async function selectAnimationClipExportDestination(
  suggestedFilename: string,
): Promise<string | null> {
  const options: SaveDialogOptions = {
    title: 'Download VRMA clip',
    defaultPath: suggestedFilename,
    filters: [{ name: 'VRM animations', extensions: ['vrma'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const result = settingsWindow && !settingsWindow.isDestroyed()
    ? await dialog.showSaveDialog(settingsWindow, options)
    : await dialog.showSaveDialog(options);
  return result.canceled ? null : result.filePath ?? null;
}

function flushPendingRendererEvents(): void {
  if (
    !avatarWindow ||
    avatarWindow.isDestroyed() ||
    !avatarRendererLoaded
  ) return;
  for (const event of drainRendererEventsForLoad(
    pendingRendererEvents,
    heldExpression?.event ?? null,
  )) {
    avatarWindow.webContents.send("persona:event", event);
  }
}

function sendToRenderer(event: AvatarRendererEvent): void {
  const pendingKey = pendingRendererEvents.add(event);
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  // The did-finish-load listener will flush whatever is queued here.
  if (!avatarRendererLoaded) return;
  avatarWindow.webContents.send("persona:event", event);
  pendingRendererEvents.delete(pendingKey);
}

function emitToRenderer(event: AvatarRendererEvent): void {
  latestEvent = event;
  sendToRenderer(event);
}

function clickThroughSnapshot(): ClickThroughSnapshot {
  return { enabled: clickThrough.isEnabled(), mode: clickThrough.mode };
}

// Queued and flushed like any other renderer event, but never becomes the
// get-snapshot "last event", which the renderer reads for its initial voice
// state.
function emitClickThrough(): void {
  sendToRenderer({ type: "click-through", ...clickThroughSnapshot() });
}

// Changing the mouse-ignore flags drops the window out of the always-on-top
// band, so the app behind it covers the avatar the moment a click passes
// through. Re-assert the level with every change, and the workspace visibility
// with it: setting the level is what disturbs that too, which is why the two
// travel together everywhere else in this file. The only call sites that touch
// these flags are here.
function applyMouseIgnore(window: BrowserWindow, flags: MouseIgnoreFlags): void {
  window.setIgnoreMouseEvents(flags.ignore, { forward: flags.forward });
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function applyClickThroughFlags(window: BrowserWindow): void {
  applyMouseIgnore(window, clickThrough.windowFlags());
}

function setClickThroughEnabled(enabled: boolean): void {
  clickThrough.setEnabled(enabled);
  // Take effect at once rather than waiting for the renderer's next hit-test,
  // so the tray toggle is a reliable way back to a clickable window.
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    applyClickThroughFlags(avatarWindow);
  }
  emitClickThrough();
  refreshTrayMenu();
  // The tray toggle and the Settings control both land here, so the stored
  // choice cannot drift from the flags the window is actually wearing.
  if (settingsStore) {
    publishSettings(settingsStore.setClickThroughEnabled(enabled));
  }
}

function handleBridgeEvent(event: AvatarRendererEvent): void {
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

function handleIntegrationEvent(event: IntegrationEvent): boolean {
  if (event.type === "animation-command") {
    return playConfiguredAnimation(event.animationName);
  }
  if (event.type === "expression-hold-command") {
    return holdConfiguredExpression(event.animationName);
  }
  if (event.type === "expression-release-command") {
    releaseHeldExpression("integration");
    return true;
  }
  handleBridgeEvent(event);
  return true;
}

function handleListenerStatus(status: AudioListenerStatus): void {
  latestListenerStatus = status;
  if (hasConfiguredModel()) {
    emitToRenderer({ type: "listener-status", status });
  }
}

async function handleMcpWindowAction(action: WindowAction): Promise<boolean> {
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

function handleProtocolUrl(rawUrl: string): boolean {
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

function handleProtocolArgv(argv: readonly string[]): void {
  const protocolUrl = argv.find((value) => value.startsWith(`${protocolScheme}://`));
  if (protocolUrl) handleProtocolUrl(protocolUrl);
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const ready = hasConfiguredModel();
  const quitItem: MenuItemConstructorOptions = {
    label: "Quit",
    click: () => {
      isQuitting = true;
      app.quit();
    },
  };
  const template: MenuItemConstructorOptions[] = ready
    ? [
        { label: "Show Persona", click: () => showOverlay({ focus: true }) },
        { label: "Hide Persona", click: () => void hideOverlay() },
        { label: "Recenter Persona", click: recenterAvatar },
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
        {
          label:
            clickThrough.mode === "silhouette"
              ? "Click-through (float over the desktop)"
              : "Click-through (whole window)",
          type: "checkbox",
          checked: clickThrough.isEnabled(),
          // The Settings control reaches setClickThroughEnabled through an IPC
          // handler that turns a failed write into a notice; a menu callback
          // has nowhere to reject to, and the flags have already changed by
          // then, so a disk failure here must not take the process down.
          click: (item) => {
            try {
              setClickThroughEnabled(item.checked);
            } catch (error) {
              console.error(
                "[persona] could not save the click-through choice:",
                error,
              );
            }
          },
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

function createTray(): void {
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
    const store = createSettingsStore({
      userDataPath: app.getPath("userData"),
      packagedLibraryPath: path.join(
        __dirname,
        "..",
        app.isPackaged ? "dist" : "public",
        "assets",
        "library.json",
      ),
    });
    settingsStore = store;
    animationGenerator = createAnimationGenerator(app.getPath('userData'), {
      assertCanAddGeneratedClip: () => store.assertCanAddAnimationClips(),
      addGeneratedClip: (filePath, metadata) =>
        store.addGeneratedAnimationClip(filePath, metadata),
      findGeneratedClip: (jobId) => {
        const clip = store.getSnapshot().animation_clips.find(
          (candidate) => candidate.generation_job_id === jobId,
        );
        return clip ? { id: clip.id, clip_name: clip.clip_name } : null;
      },
      publishSettings: (snapshot) => {
        publishSettings(snapshot);
      },
      onJobUpdated: (job) => {
        if (
          settingsWindow &&
          !settingsWindow.isDestroyed() &&
          !settingsWindow.webContents.isLoading()
        ) {
          settingsWindow.webContents.send(
            'persona:animation-generation-updated',
            job,
          );
        }
      },
    });
    const initialSettingsSnapshot = store.getSnapshot();
    modelConfigured = snapshotHasConfiguredModel(initialSettingsSnapshot);
    // Seeded before the avatar window is created, so its first flags already
    // match the stored choice rather than flipping once something notices.
    clickThrough.setEnabled(initialSettingsSnapshot.click_through_enabled);
    mcpAnimationCatalogSignature = animationCatalogSignature(
      initialSettingsSnapshot,
    );
    protocol.handle(PERSONA_ASSET_SCHEME, (request) => {
      const resolved = store.resolveAssetRequest(request.url);
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
    const credentialsFilePath = path.join(
      app.getPath("userData"),
      "vroid-hub-credentials.json",
    );
    vroidCredentialsFilePath = credentialsFilePath;
    if (vroidHubSecureStorageAvailable(initialSettingsSnapshot)) {
      const vroidCredentials = readVroidHubCredentials({
        credentialsFilePath,
        decrypt: (buffer) =>
          Buffer.from(safeStorage.decryptString(buffer), "utf8"),
      });
      if (vroidCredentials) {
        configureVroidHub(vroidCredentials.clientId, vroidCredentials.clientSecret);
      }
    }

    ipcMain.handle("persona:get-snapshot", () => latestEvent);
    // Click-through is deliberately not the get-snapshot "last event", so the
    // renderer reads it separately. Pulling it on mount means a renderer that
    // loaded after the event was pushed, or reloaded later, still learns the
    // mode instead of silently assuming it is off.
    ipcMain.handle("persona:get-click-through", () => clickThroughSnapshot());
    ipcMain.handle("persona:settings-get", () => store.getSnapshot());
    handleFromSettings(
      "persona:settings-import-model",
      async (metadata: unknown) => {
        const filePath = await selectAssetFile("model");
        if (!filePath) return null;
        return publishSettings(
          store.importModel({
            filePath,
            model_name: isRecord(metadata) ? metadata.model_name : undefined,
          }),
        );
      },
    );
    handleFromSettings("persona:settings-create-animation", (metadata: unknown) =>
      publishSettings(store.createAnimation(metadata)),
    );
    handleFromSettings(
      'persona:settings-create-animation-with-clips',
      (metadata: unknown, clipIds: unknown) => {
        if (!Array.isArray(clipIds)) throw new Error('Animation clip ids are required.');
        return publishSettings(store.createAnimationWithClips(
          metadata,
          clipIds.map((clipId) => requiredIpcString(clipId, 'Animation clip id')),
        ));
      },
    );
    handleFromSettings(
      "persona:settings-add-animation-clips",
      async (animationId: unknown) => {
        const filePaths = await selectAssetFile("animation", true);
        if (filePaths.length === 0) return null;
        return publishSettings(
          store.addAnimationClips(
            requiredIpcString(animationId, 'Animation id'),
            filePaths,
          ),
        );
      },
    );
    handleFromSettings(
      'persona:settings-import-animation-clips',
      async () => {
        const filePaths = await selectAssetFile('animation', true);
        if (filePaths.length === 0) return null;
        return publishSettings(store.importAnimationClips(filePaths));
      },
    );
    handleFromSettings(
      "persona:settings-update-animation",
      (animationId: unknown, metadata: unknown) =>
        publishSettings(
          store.updateAnimation(
            requiredIpcString(animationId, 'Animation id'),
            metadata,
          ),
        ),
    );
    handleFromSettings(
      "persona:settings-delete-animation",
      (animationId: unknown) =>
        publishSettings(
          store.deleteAnimation(requiredIpcString(animationId, 'Animation id')),
        ),
    );
    handleFromSettings(
      "persona:settings-delete-animation-clip",
      (animationId: unknown, clipId: unknown) =>
        publishSettings(
          store.detachAnimationClip(
            requiredIpcString(animationId, 'Animation id'),
            requiredIpcString(clipId, 'Animation clip id'),
          ),
        ),
    );
    handleFromSettings(
      'persona:settings-attach-animation-clip',
      (animationId: unknown, clipId: unknown) =>
        publishSettings(store.attachAnimationClip(
          requiredIpcString(animationId, 'Animation id'),
          requiredIpcString(clipId, 'Animation clip id'),
        )),
    );
    handleFromSettings(
      'persona:settings-attach-animation-clips',
      (animationId: unknown, clipIds: unknown) => {
        if (!Array.isArray(clipIds)) throw new Error('Animation clip ids are required.');
        return publishSettings(store.attachAnimationClips(
          requiredIpcString(animationId, 'Animation id'),
          clipIds.map((clipId) => requiredIpcString(clipId, 'Animation clip id')),
        ));
      },
    );
    handleFromSettings(
      'persona:settings-delete-animation-library-clip',
      (clipId: unknown) => publishSettings(store.deleteAnimationLibraryClip(
        requiredIpcString(clipId, 'Animation clip id'),
      )),
    );
    handleFromSettings(
      'persona:settings-export-animation-library-clip',
      (clipId: unknown) => exportAnimationLibraryClip({
        clipId: requiredIpcString(clipId, 'Animation clip id'),
        selectDestination: selectAnimationClipExportDestination,
        store,
      }),
    );
    handleFromSettings(
      "persona:settings-reset-packaged-animations",
      () => publishSettings(store.resetPackagedAnimations()),
    );
    handleFromSettings(
      "persona:settings-delete-model",
      (modelIdValue: unknown) => {
        const modelId = requiredIpcString(modelIdValue, 'Model id');
        const model = store
          .getSnapshot()
          .models.find((candidate) => candidate.id === modelId);
        if (!model?.removable) {
          throw new Error("Packaged models cannot be deleted.");
        }
        return publishSettings(store.deleteModel(modelId));
      },
    );
    handleFromSettings("persona:settings-set-default-model", (modelId: unknown) =>
      publishSettings(
        store.setDefaultModel(requiredIpcString(modelId, 'Model id')),
      ),
    );
    handleFromSettings("persona:settings-set-character-size", (size: unknown) =>
      publishSettings(store.setCharacterSize(size)),
    );
    handleFromSettings(
      "persona:settings-set-avatar-window-size",
      (width: unknown, height: unknown) => {
        const snapshot = publishSettings(
          store.setAvatarWindowSize(width, height),
        );
        applyAvatarWindowSize();
        return snapshot;
      },
    );
    // Derived from the platform rather than stored, so Settings reads it apart
    // from the snapshot and the rule stays in one place.
    handleFromSettings(
      "persona:settings-get-click-through-mode",
      () => clickThrough.mode,
    );
    handleFromSettings(
      "persona:settings-set-click-through",
      (enabled: unknown) => {
        setClickThroughEnabled(enabled === true);
        return store.getSnapshot();
      },
    );
    handleFromSettings(
      "persona:settings-set-look-at-cursor",
      (enabled: unknown) => publishSettings(store.setLookAtCursor(enabled)),
    );
    handleFromSettings(
      "persona:settings-set-speaking-transition",
      (transition: unknown) =>
        publishSettings(store.setSpeakingTransition(transition)),
    );
    handleFromSettings(
      "persona:settings-set-body-transition-ms",
      (milliseconds: unknown) =>
        publishSettings(store.setBodyTransitionMs(milliseconds)),
    );
    handleFromSettings(
      "persona:settings-set-speaking-debounce-ms",
      (milliseconds: unknown) =>
        publishSettings(store.setSpeakingDebounceMs(milliseconds)),
    );
    handleFromSettings(
      "persona:settings-set-idle-interim-ms",
      (milliseconds: unknown) =>
        publishSettings(store.setIdleInterimMs(milliseconds)),
    );
    handleFromSettings("persona:settings-enable-developer", () =>
      publishSettings(store.enableDeveloperSettings()),
    );
    handleFromSettings("persona:settings-reset-developer", () => {
      const snapshot = publishSettings(store.resetDeveloperSettings());
      refreshVroidHubStoragePolicy(snapshot);
      broadcastVroidHubStatus();
      return store.getSnapshot();
    });
    handleFromSettings(
      "persona:settings-set-vroid-plaintext-storage",
      (allowed: unknown) => {
        const snapshot = publishSettings(
          store.setVroidHubPlaintextStorageAllowed(allowed),
        );
        syncVroidHubStorageBackend(snapshot);
        if (!vroidHubSecureStorageAvailable(snapshot)) {
          vroidHubAuth?.disconnect();
          vroidHubAuth = null;
          vroidHubClient = null;
          publishSettings(store.clearActiveHubModel());
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
        return store.getSnapshot();
      },
    );
    handleFromSettings("persona:settings-set-voice-source", (voiceSource: unknown) => {
      const snapshot = publishSettings(store.setVoiceSource(voiceSource));
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
      (modelId: unknown, lighting: unknown) =>
        publishSettings(
          store.setModelLighting(
            requiredIpcString(modelId, 'Model id'),
            lighting,
          ),
        ),
    );
    handleFromSettings(
      "persona:settings-reset-model-lighting",
      (modelId: unknown) =>
        publishSettings(
          store.resetModelLighting(requiredIpcString(modelId, 'Model id')),
        ),
    );
    handleFromSettings("persona:settings-get-mcp-status", () =>
      createMcpSettingsStatus({
        error: mcpServerError,
        health: mcpServerHealth,
        port: mcpServerPort,
        settingsSnapshot: store.getSnapshot(),
      }),
    );
    handleFromSettings('persona:settings-open-kimodo-repository', () =>
      shell.openExternal(KIMODO_REPOSITORY_URL),
    );
    handleFromSettings('persona:settings-animation-generator-status', () => {
      if (!animationGenerator) throw new Error('Animation generator is unavailable.');
      return animationGenerator.getStatus();
    });
    handleFromSettings(
      'persona:settings-animation-generator-set-config',
      (config: unknown) => {
        if (!animationGenerator) throw new Error('Animation generator is unavailable.');
        return animationGenerator.setConfig(config);
      },
    );
    handleFromSettings('persona:settings-animation-generator-check', () => {
      if (!animationGenerator) throw new Error('Animation generator is unavailable.');
      return animationGenerator.check();
    });
    handleFromSettings('persona:settings-animation-generator-start', (request: unknown) => {
      if (!animationGenerator) throw new Error('Animation generator is unavailable.');
      return animationGenerator.start(request, 'settings');
    });
    handleFromSettings('persona:settings-animation-generator-retry', (jobId: unknown) => {
      if (!animationGenerator) throw new Error('Animation generator is unavailable.');
      return animationGenerator.retry(requiredIpcString(jobId, 'Animation generation job id'));
    });
    handleFromSettings('persona:settings-animation-generator-discard', (jobId: unknown) => {
      if (!animationGenerator) throw new Error('Animation generator is unavailable.');
      return animationGenerator.discard(requiredIpcString(jobId, 'Animation generation job id'));
    });
    handleFromSettings('persona:settings-animation-generator-list', () =>
      animationGenerator?.listJobs() ?? [],
    );
    handleFromSettings('persona:settings-animation-generator-clear', () => {
      if (!animationGenerator) throw new Error('Animation generator is unavailable.');
      return animationGenerator.clearJobs();
    });
    handleFromSettings("persona:vroid-get-status", () => vroidHubStatus());
    handleFromSettings("persona:vroid-get-credentials", () => {
      if (!vroidHubSecureStorageAvailable()) {
        return { clientId: null, hasClientSecret: false };
      }
      const credentials = readVroidHubCredentials({
        credentialsFilePath,
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
      (clientIdValue: unknown, clientSecretValue: unknown) => {
        const clientId = requiredIpcString(clientIdValue, 'Client ID');
        const clientSecret = requiredIpcString(
          clientSecretValue,
          'Client secret',
        );
        if (!vroidHubSecureStorageAvailable()) {
          throw new Error(
            "This OS has no secure credential storage available, so VRoid Hub credentials cannot be saved.",
          );
        }
        writeVroidHubCredentials(
          {
            credentialsFilePath,
            encrypt: (buffer) => safeStorage.encryptString(buffer.toString("utf8")),
          },
          { clientId, clientSecret },
        );
        // A new OAuth app means any existing session belongs to the old one.
        vroidHubAuth?.disconnect();
        publishSettings(store.clearActiveHubModel());
        configureVroidHub(clientId.trim(), clientSecret.trim());
        broadcastVroidHubStatus();
        return vroidHubStatus();
      },
    );
    handleFromSettings("persona:vroid-clear-credentials", () => {
      clearVroidHubCredentials({ credentialsFilePath });
      vroidHubAuth?.disconnect();
      vroidHubAuth = null;
      vroidHubClient = null;
      publishSettings(store.clearActiveHubModel());
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
      publishSettings(store.clearActiveHubModel());
      return vroidHubStatus();
    });
    handleFromSettings("persona:vroid-list-characters", async () => {
      if (!vroidHubClient) {
        throw new Error("Connect your VRoid Hub account first.");
      }
      const client = vroidHubClient;
      return withVroidHubAuthRetry((token) =>
        client.listCharacters(token),
      );
    });
    // Portraits load one card at a time after the list renders, so a slow or
    // unreachable image CDN delays a thumbnail rather than the whole picker.
    // Only ids from the last listing resolve to a URL (see the client), and a
    // missing portrait is a null, not an error — the card just keeps its
    // placeholder icon.
    handleFromSettings(
      "persona:vroid-character-portrait",
      async (characterIdValue: unknown) => {
        const characterId = requiredIpcString(
          characterIdValue,
          'A character id',
        );
        return (await vroidHubClient?.loadCharacterPortrait(characterId)) ?? null;
      },
    );
    handleFromSettings(
      "persona:vroid-select-character",
      async (characterId: unknown, characterName: unknown) => {
        // No re-fetch of the character list to check characterId is in it:
        // that's not a real gate anyway, since /api/download_licenses below
        // is VRoid Hub's own authority on whether this id is licensable, and
        // the renderer already has this id from the list it just rendered.
        // Safe to run twice: a 401 can only come from the two authorized
        // calls, and replaying them just mints a second download license.
        if (!vroidHubClient) {
          throw new Error("Connect your VRoid Hub account first.");
        }
        const client = vroidHubClient;
        const buffer = await withVroidHubAuthRetry((token) =>
          client.loadCharacterModel(token, characterId),
        );
        return publishSettings(
          store.setActiveHubModel(buffer, {
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
      (characterId: unknown, characterModelId: unknown) => {
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
      // No titlebar to drag it back with, so a drag off every display would
      // leave nothing to grab.
      const position = clampWindowPosition(
        { ...bounds, x: bounds.x + dx, y: bounds.y + dy },
        screen.getAllDisplays().map((display) => display.workArea),
      );
      avatarWindow.setPosition(position.x, position.y);
    });
    // The renderer owns the fine-grained decision, forwarding a silhouette
    // hit-test as the cursor moves. A send has no reply channel to reject
    // through, so anything but a boolean from the avatar window is dropped.
    ipcMain.on("persona:set-mouse-passthrough", (event, ignore) => {
      if (!avatarWindow || avatarWindow.isDestroyed()) return;
      if (event.sender !== avatarWindow.webContents) return;
      const flags = clickThrough.passthroughFlags(ignore);
      if (!flags) return;
      applyMouseIgnore(avatarWindow, flags);
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
      settingsWindow?.setBackgroundColor(background);
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
        store
          .getSnapshot()
          .animations.filter((animation) => animation.asset_urls.length > 0),
      getAnimationClips: () => store.getSnapshot().animation_clips,
      onCreateAnimationAction: (metadata, clipIds) => {
        if (!animationGenerator?.getStatus().config.mcp_enabled) {
          throw new Error('Agent animation changes are disabled in Persona Settings.');
        }
        const snapshot = publishSettings(store.createAnimationWithClips(metadata, clipIds));
        const action = snapshot.animations.find(
          (candidate) => candidate.animation_name === metadata.animation_name,
        );
        if (!action) throw new Error('Persona could not find the newly created action.');
        return action;
      },
      onAttachAnimationClip: (actionName, clipId) => {
        if (!animationGenerator?.getStatus().config.mcp_enabled) {
          throw new Error('Agent animation changes are disabled in Persona Settings.');
        }
        const action = store.getAnimation(actionName);
        if (!action) throw new Error('Animation action is not installed.');
        const snapshot = publishSettings(store.attachAnimationClip(action.id, clipId));
        const updated = snapshot.animations.find((candidate) => candidate.id === action.id);
        if (!updated) throw new Error('Persona could not find the updated action.');
        return updated;
      },
      onGenerateAnimation: (request) => {
        if (!animationGenerator) throw new Error('Animation generator is unavailable.');
        return animationGenerator.start(request, 'mcp');
      },
      getAnimationGeneration: (jobId) =>
        animationGenerator?.getJob(jobId) ?? null,
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
  clearHyprlandConfigurationTimer();
  audioListener?.stop();
  animationGenerator?.close();
  globalShortcut.unregisterAll();
  void mcpHandler?.close();
  void bridge
    ?.close()
    .catch((error) => debugLog("integration server close failed", error));
});

app.on("window-all-closed", () => {
  // The tray, protocol handler, and adapter server keep Persona available.
});
