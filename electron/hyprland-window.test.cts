import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLuaCommands,
  calculateWindowPosition,
  findHyprlandClient,
  hyprctlEnvironment,
} from './hyprland-window.cjs';

test("hyprctl uses host libraries without losing the compositor environment", () => {
  const parentEnvironment = {
    APPIMAGE: "/tmp/Persona.AppImage",
    HYPRLAND_INSTANCE_SIGNATURE: "hyprland-instance",
    LD_LIBRARY_PATH: "/app/lib:/inherited/electron/lib",
    LD_PRELOAD: "/app/lib/injected.so",
    PATH: "/app/bin:/run/current-system/sw/bin",
    WAYLAND_DISPLAY: "wayland-1",
  };

  const childEnvironment = hyprctlEnvironment(parentEnvironment);

  assert.equal(childEnvironment.LD_LIBRARY_PATH, undefined);
  assert.equal(childEnvironment.LD_PRELOAD, undefined);
  assert.equal(childEnvironment.PATH, parentEnvironment.PATH);
  assert.equal(
    childEnvironment.HYPRLAND_INSTANCE_SIGNATURE,
    parentEnvironment.HYPRLAND_INSTANCE_SIGNATURE,
  );
  assert.equal(childEnvironment.WAYLAND_DISPLAY, parentEnvironment.WAYLAND_DISPLAY);
  assert.equal(
    parentEnvironment.LD_LIBRARY_PATH,
    "/app/lib:/inherited/electron/lib",
  );
});

test("findHyprlandClient matches the app class and process", () => {
  const clients = [
    {
      class: "persona",
      pid: 42,
      address: "0xabc",
      title: "Persona Settings",
      initialTitle: "Persona",
    },
    { class: "persona", pid: 42, address: "0xavatar", title: "Persona" },
    { class: "persona", pid: 77, address: "0xdef", title: "Persona" },
  ];

  assert.equal(findHyprlandClient(clients, 77)?.address, "0xdef");
  assert.equal(findHyprlandClient(clients, 42)?.address, "0xavatar");
  assert.equal(findHyprlandClient(clients, 99), undefined);
});

test("calculateWindowPosition uses the monitor work area", () => {
  const monitor = {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    reserved: [0, 34, 0, 0],
  };

  assert.deepEqual(calculateWindowPosition(monitor, 430, 680, 24), {
    x: 1466,
    y: 376,
  });
});

test("buildLuaCommands enables stable floating and pinned properties", () => {
  const commands = buildLuaCommands(
    {
      address: "0xabc",
      floating: false,
      pinned: false,
      size: [1904, 1030],
    },
    { x: 0, y: 0, width: 1920, height: 1080, reserved: [0, 34, 0, 0] },
    430,
    680,
  ).join("\n");

  assert.match(commands, /float\(\{ action = "on"/);
  assert.match(commands, /resize\(\{ x = 430, y = 680/);
  assert.match(commands, /move\(\{ x = 1466, y = 376/);
  assert.match(commands, /pin\(\{ action = "on"/);
  assert.match(commands, /alter_zorder/);
  assert.match(commands, /prop = "no_blur"/);
  assert.match(commands, /prop = "decorate"/);
  assert.match(commands, /prop = "opacity", value = "1"/);
  assert.match(commands, /prop = "opacity_inactive_override", value = "1"/);
  assert.match(commands, /prop = "opacity_fullscreen_override", value = "1"/);
});

test("buildLuaCommands can refresh compositor properties without moving the window", () => {
  const commands = buildLuaCommands(
    {
      address: "0xabc",
      floating: true,
      pinned: true,
      size: [430, 680],
    },
    { x: 0, y: 0, width: 1920, height: 1080, reserved: [0, 34, 0, 0] },
    430,
    680,
    24,
    { reposition: false },
  ).join("\n");

  assert.doesNotMatch(commands, /window\.move/);
  assert.doesNotMatch(commands, /window\.pin/);
  assert.match(commands, /alter_zorder/);
  assert.match(commands, /prop = "no_blur"/);
  assert.match(commands, /prop = "opacity_override", value = "1"/);
});

test("buildLuaCommands restores an explicitly saved position", () => {
  const commands = buildLuaCommands(
    {
      address: "0xabc",
      floating: true,
      pinned: true,
      size: [430, 680],
    },
    { x: 0, y: 0, width: 1920, height: 1080, reserved: [0, 34, 0, 0] },
    430,
    680,
    24,
    { position: { x: 321, y: 234 }, reposition: true },
  ).join("\n");

  assert.match(commands, /window\.move\(\{ x = 321, y = 234/);
});
