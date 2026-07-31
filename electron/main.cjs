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
  screen,
  Tray,
} = require("electron");
const { createBridgeServer, DEFAULT_PORT } = require("./bridge-server.cjs");
const { createPersonaMcpHandler } = require("./mcp-server.cjs");
const {
  createMcpSettingsStatus,
} = require("./mcp-settings-status.cjs");
const { createSettingsStore } = require("./settings-store.cjs");
const {
  configureHyprlandWindow,
  getHyprlandWindowPlacement,
} = require("./hyprland-window.cjs");
const { createAudioListener } = require("./audio-listener.cjs");
const { isAllowedRendererNavigation } = require("./navigation-policy.cjs");
const { snapshotHasConfiguredModel } = require("./model-readiness.cjs");
const { parseProtocolUrl, voiceState } = require("./protocol-actions.cjs");
const {
  createSettingsWindowPresentationGate,
} = require("./settings-window-presentation.cjs");

const WINDOW_WIDTH = 430;
const WINDOW_HEIGHT = 680;
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
    const configured = await configureHyprlandWindow({
      pid: process.pid,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
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
  return url.href;
}

function secureRendererWindow(window, allowedRendererUrl) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedRendererNavigation(targetUrl, allowedRendererUrl)) {
      event.preventDefault();
    }
  });
}

function createWindow() {
  if (avatarWindow && !avatarWindow.isDestroyed()) return avatarWindow;

  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 320,
    minHeight: 480,
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
      const assetPath = settingsStore?.resolveAssetRequest(request.url);
      if (!assetPath) {
        return new Response("Asset not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(assetPath).href);
    });

    ipcMain.handle("persona:get-snapshot", () => latestEvent);
    ipcMain.handle("persona:settings-get", () => settingsStore.getSnapshot());
    ipcMain.handle("persona:settings-import-model", async (_event, metadata) => {
      const filePath = await selectAssetFile("model");
      if (!filePath) return null;
      return publishSettings(
        settingsStore.importModel({ filePath, model_name: metadata?.model_name }),
      );
    });
    ipcMain.handle("persona:settings-create-animation", (_event, metadata) =>
      publishSettings(settingsStore.createAnimation(metadata)),
    );
    ipcMain.handle(
      "persona:settings-add-animation-clips",
      async (_event, animationId) => {
        const filePaths = await selectAssetFile("animation", true);
        if (filePaths.length === 0) return null;
        return publishSettings(
          settingsStore.addAnimationClips(animationId, filePaths),
        );
      },
    );
    ipcMain.handle(
      "persona:settings-update-animation",
      (_event, animationId, metadata) =>
        publishSettings(
          settingsStore.updateAnimation(animationId, metadata),
        ),
    );
    ipcMain.handle(
      "persona:settings-delete-animation",
      (_event, animationId) =>
        publishSettings(settingsStore.deleteAnimation(animationId)),
    );
    ipcMain.handle(
      "persona:settings-delete-animation-clip",
      (_event, animationId, clipId) =>
        publishSettings(
          settingsStore.deleteAnimationClip(animationId, clipId),
        ),
    );
    ipcMain.handle(
      "persona:settings-reset-packaged-animations",
      () => publishSettings(settingsStore.resetPackagedAnimations()),
    );
    ipcMain.handle(
      "persona:settings-delete-model",
      (_event, modelId) => {
        const model = settingsStore
          .getSnapshot()
          .models.find((candidate) => candidate.id === modelId);
        if (!model?.removable) {
          throw new Error("Packaged models cannot be deleted.");
        }
        return publishSettings(settingsStore.deleteModel(modelId));
      },
    );
    ipcMain.handle("persona:settings-set-default-model", (_event, modelId) =>
      publishSettings(settingsStore.setDefaultModel(modelId)),
    );
    ipcMain.handle("persona:settings-set-character-size", (_event, size) =>
      publishSettings(settingsStore.setCharacterSize(size)),
    );
    ipcMain.handle(
      "persona:settings-set-model-lighting",
      (_event, modelId, lighting) =>
        publishSettings(settingsStore.setModelLighting(modelId, lighting)),
    );
    ipcMain.handle(
      "persona:settings-reset-model-lighting",
      (_event, modelId) =>
        publishSettings(settingsStore.resetModelLighting(modelId)),
    );
    ipcMain.handle("persona:settings-get-mcp-status", () =>
      createMcpSettingsStatus({
        error: mcpServerError,
        health: mcpServerHealth,
        port: mcpServerPort,
        settingsSnapshot: settingsStore.getSnapshot(),
      }),
    );
    ipcMain.on("persona:hide", () => void hideOverlay());
    // The resolved theme lives in renderer storage, so the window chrome can
    // only be corrected once the settings renderer reports it. Accepts the two
    // known theme names and never a caller-supplied colour.
    ipcMain.on("persona:settings-set-window-theme", (event, theme) => {
      if (theme !== "dark" && theme !== "light") return;
      if (!settingsWindow || settingsWindow.isDestroyed()) return;
      if (event.sender !== settingsWindow.webContents) return;
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

    audioListener = createAudioListener({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
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
    if (audioListener && modelConfigured) void audioListener.start();
    if (!audioListener) {
      handleListenerStatus({
        available: false,
        capturing: false,
        monitoring: false,
        source: null,
      });
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
