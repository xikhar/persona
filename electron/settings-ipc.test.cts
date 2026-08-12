import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createSettingsIpcGate,
  type SettingsIpcEvent,
  type SettingsIpcMain,
  type SettingsWindowLike,
} from './settings-ipc.cjs';

type TestHandler = (event: SettingsIpcEvent, ...args: unknown[]) => unknown;

function createGateHarness() {
  const handlers = new Map<string, TestHandler>();
  const ipcMain: SettingsIpcMain = {
    handle(channel: string, handler: TestHandler): void {
      handlers.set(channel, handler);
    },
  };
  const settingsWebContents = { name: "settings" };
  let settingsWindow: SettingsWindowLike | null = {
    isDestroyed: () => false,
    webContents: settingsWebContents,
  };
  const gate = createSettingsIpcGate({
    ipcMain,
    getSettingsWindow: () => settingsWindow,
  });
  return {
    ...gate,
    handlers,
    fromAvatar: { sender: { name: "avatar" } },
    fromSettings: { sender: settingsWebContents },
    closeSettingsWindow() {
      settingsWindow = null;
    },
    destroySettingsWindow() {
      settingsWindow = { isDestroyed: () => true, webContents: settingsWebContents };
    },
  };
}

function requiredHandler(
  handlers: ReadonlyMap<string, TestHandler>,
  channel: string,
): TestHandler {
  const handler = handlers.get(channel);
  assert.ok(handler, `Missing test IPC handler for ${channel}`);
  return handler;
}

test("runs a gated handler on the Settings window's own arguments", async () => {
  const harness = createGateHarness();
  const calls: unknown[][] = [];
  harness.handleFromSettings("persona:settings-set-model-lighting", (...args) => {
    calls.push(args);
    return "snapshot";
  });

  const result = await requiredHandler(harness.handlers,
    "persona:settings-set-model-lighting",
  )(harness.fromSettings, "model-id", { exposure: 1.2 });

  assert.equal(result, "snapshot");
  assert.deepEqual(calls, [["model-id", { exposure: 1.2 }]]);
});

test("rejects a gated handler invoked from the avatar window", async () => {
  const harness = createGateHarness();
  let called = false;
  harness.handleFromSettings("persona:settings-delete-model", () => {
    called = true;
  });

  await assert.rejects(
    async () =>
      requiredHandler(harness.handlers, "persona:settings-delete-model")(
        harness.fromAvatar,
        "model-id",
      ),
    /must come from the Settings window/,
  );
  assert.equal(called, false);
});

test("rejects a gated handler while no Settings window exists", async () => {
  for (const shutSettingsWindow of ["close", "destroy"] as const) {
    const harness = createGateHarness();
    let called = false;
    harness.handleFromSettings("persona:settings-enable-developer", () => {
      called = true;
    });
    if (shutSettingsWindow === 'close') harness.closeSettingsWindow();
    else harness.destroySettingsWindow();

    await assert.rejects(
      async () =>
        requiredHandler(harness.handlers, "persona:settings-enable-developer")(
          harness.fromSettings,
        ),
      /Settings window is not available/,
    );
    assert.equal(called, false);
  }
});

test("recognises only the Settings window as a settings sender", () => {
  const harness = createGateHarness();
  assert.equal(harness.isSettingsSender(harness.fromSettings), true);
  assert.equal(harness.isSettingsSender(harness.fromAvatar), false);
  harness.destroySettingsWindow();
  assert.equal(harness.isSettingsSender(harness.fromSettings), false);
  harness.closeSettingsWindow();
  assert.equal(harness.isSettingsSender(harness.fromSettings), false);
});

// Pins the channels any renderer can reach, so a mutator registered through a
// bare ipcMain.handle/on fails here rather than in review.
test("main registers every settings and VRoid Hub channel behind the gate", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const channels = (pattern: RegExp): string[] =>
    [...source.matchAll(pattern)]
      .map((match) => match[1])
      .filter((channel): channel is string => channel !== undefined)
      .sort();

  const ungated = channels(/ipcMain\.\w+\(\s*['"]([^'"]+)['"]/g);
  const gated = channels(/handleFromSettings\(\s*['"]([^'"]+)['"]/g);

  // Any ipcMain method, any quote style, and the channel named inline, so a
  // handleOnce or a single-quoted registration cannot slip past the pin.
  assert.equal(
    [...source.matchAll(/ipcMain\.\w+\(/g)].length,
    ungated.length,
    "every ipcMain registration must name its channel as a literal",
  );
  assert.deepEqual(ungated, [
    "persona:get-snapshot",
    "persona:hide",
    "persona:move-by",
    "persona:settings-get",
    "persona:settings-set-window-theme",
  ]);
  assert.match(
    source.slice(source.indexOf('ipcMain.on("persona:settings-set-window-theme"')),
    /^[^)]*\)[\s\S]{0,600}?isSettingsSender\(event\)/,
    "the one ungated settings channel must still check its sender by hand",
  );
  assert.ok(
    gated.filter((channel) => channel.startsWith("persona:settings-")).length >
      15,
    "expected the settings mutators to be registered through the gate",
  );
  for (const channel of gated) {
    assert.match(channel, /^persona:(settings|vroid)-/);
  }
  assert.ok(
    gated.includes("persona:settings-set-vroid-plaintext-storage") &&
      gated.includes("persona:settings-delete-model") &&
      gated.includes("persona:settings-enable-developer") &&
      gated.includes("persona:vroid-get-credentials"),
  );
});
