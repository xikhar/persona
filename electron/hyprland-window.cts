import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { errorMessage, isRecord } from './types.cjs';

const execFileAsync = promisify(execFile);
export const WINDOW_CLASS = 'persona';

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowPlacement extends WindowPosition {
  width: number;
  height: number;
}

export interface HyprlandClient {
  address: string;
  at?: readonly unknown[];
  class?: unknown;
  floating?: unknown;
  initialClass?: unknown;
  monitor?: unknown;
  pid?: unknown;
  pinned?: unknown;
  size?: readonly unknown[];
  title?: unknown;
}

export interface HyprlandMonitor {
  height: number;
  id?: unknown;
  reserved?: readonly number[];
  width: number;
  x: number;
  y: number;
}

export interface BuildLuaCommandOptions {
  position?: WindowPosition | null;
  reposition?: boolean;
}

export interface ConfigureHyprlandWindowOptions {
  pid: number;
  title?: string;
  width?: number;
  height?: number;
  margin?: number;
  onDebug?: ((message: string, detail?: unknown) => void) | null;
  position?: WindowPosition | null;
  reposition?: boolean;
}

function isHyprlandClient(value: unknown): value is HyprlandClient {
  return isRecord(value) && typeof value.address === 'string';
}

function isHyprlandMonitor(value: unknown): value is HyprlandMonitor {
  return (
    isRecord(value) &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number'
  );
}

export function findHyprlandClient(
  clients: readonly HyprlandClient[],
  pid: number,
  title = 'Persona',
): HyprlandClient | undefined {
  return clients.find(
    (client) =>
      Number(client.pid) === Number(pid) &&
      (client.class === WINDOW_CLASS || client.initialClass === WINDOW_CLASS) &&
      client.title === title,
  );
}

export function calculateWindowPosition(
  monitor: HyprlandMonitor,
  width: number,
  height: number,
  margin = 24,
): WindowPosition {
  const [
    reservedLeft = 0,
    reservedTop = 0,
    reservedRight = 0,
    reservedBottom = 0,
  ] = monitor.reserved ?? [];
  const workLeft = monitor.x + reservedLeft;
  const workTop = monitor.y + reservedTop;
  const workWidth = monitor.width - reservedLeft - reservedRight;
  const workHeight = monitor.height - reservedTop - reservedBottom;

  return {
    x: Math.round(Math.max(workLeft, workLeft + workWidth - width - margin)),
    y: Math.round(Math.max(workTop, workTop + workHeight - height - margin)),
  };
}

export function buildLuaCommands(
  client: HyprlandClient,
  monitor: HyprlandMonitor,
  width: number,
  height: number,
  margin = 24,
  { position = null, reposition = true }: BuildLuaCommandOptions = {},
): string[] {
  const window = `address:${client.address}`;
  const targetPosition =
    position ?? calculateWindowPosition(monitor, width, height, margin);
  const commands: string[] = [];

  if (!client.floating) {
    commands.push(`hl.dsp.window.float({ action = "on", window = "${window}" })`);
  }
  if (client.size?.[0] !== width || client.size?.[1] !== height) {
    commands.push(
      `hl.dsp.window.resize({ x = ${width}, y = ${height}, relative = false, window = "${window}" })`,
    );
  }
  if (reposition) {
    commands.push(
      `hl.dsp.window.move({ x = ${targetPosition.x}, y = ${targetPosition.y}, relative = false, window = "${window}" })`,
    );
  }
  if (!client.pinned) {
    commands.push(`hl.dsp.window.pin({ action = "on", window = "${window}" })`);
  }
  commands.push(
    `hl.dsp.window.alter_zorder({ mode = "top", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "no_blur", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "no_shadow", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "no_dim", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "decorate", value = "0", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "border_size", value = "0", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "rounding", value = "0", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "opacity", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "opacity_inactive", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "opacity_fullscreen", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "opacity_override", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "opacity_inactive_override", value = "1", window = "${window}" })`,
    `hl.dsp.window.set_prop({ prop = "opacity_fullscreen_override", value = "1", window = "${window}" })`,
  );
  return commands;
}

async function runHyprctlJson(command: string): Promise<unknown> {
  const { stdout } = await execFileAsync('hyprctl', ['-j', command], {
    timeout: 2000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function runLegacyCommands(
  client: HyprlandClient,
  monitor: HyprlandMonitor,
  width: number,
  height: number,
  margin: number,
  reposition: boolean,
  position: WindowPosition | null,
): Promise<void> {
  const window = `address:${client.address}`;
  const targetPosition =
    position ?? calculateWindowPosition(monitor, width, height, margin);
  const commands: string[][] = [
    ['dispatch', 'setfloating', window],
    ['dispatch', 'resizewindowpixel', `exact ${width} ${height},${window}`],
  ];
  if (reposition) {
    commands.push([
      'dispatch',
      'movewindowpixel',
      `exact ${targetPosition.x} ${targetPosition.y},${window}`,
    ]);
  }
  if (!client.pinned) commands.push(['dispatch', 'pin', window]);
  commands.push(
    ['dispatch', 'alterzorder', `top,${window}`],
    ['setprop', window, 'no_blur', '1', 'lock'],
    ['setprop', window, 'no_shadow', '1', 'lock'],
    ['setprop', window, 'no_dim', '1', 'lock'],
    ['setprop', window, 'decorate', '0', 'lock'],
    ['setprop', window, 'border_size', '0', 'lock'],
    ['setprop', window, 'rounding', '0', 'lock'],
    ['setprop', window, 'opacity', '1', 'lock'],
    ['setprop', window, 'opacity_inactive', '1', 'lock'],
    ['setprop', window, 'opacity_fullscreen', '1', 'lock'],
    ['setprop', window, 'opacity_override', '1', 'lock'],
    ['setprop', window, 'opacity_inactive_override', '1', 'lock'],
    ['setprop', window, 'opacity_fullscreen_override', '1', 'lock'],
  );
  for (const args of commands) {
    await execFileAsync('hyprctl', args, { timeout: 2000 });
  }
}

export async function configureHyprlandWindow({
  pid,
  title = 'Persona',
  width = 430,
  height = 680,
  margin = 24,
  onDebug = null,
  position = null,
  reposition = true,
}: ConfigureHyprlandWindowOptions): Promise<boolean> {
  if (process.platform !== 'linux') return false;

  try {
    const [clientData, monitorData] = await Promise.all([
      runHyprctlJson('clients'),
      runHyprctlJson('monitors'),
    ]);
    const clients = Array.isArray(clientData)
      ? clientData.filter(isHyprlandClient)
      : [];
    const monitors = Array.isArray(monitorData)
      ? monitorData.filter(isHyprlandMonitor)
      : [];
    const client = findHyprlandClient(clients, pid, title);
    if (!client) return false;
    const monitor =
      monitors.find(
        (candidate) => Number(candidate.id) === Number(client.monitor),
      ) ?? monitors[0];
    if (!monitor) return false;

    const luaCommands = buildLuaCommands(client, monitor, width, height, margin, {
      position,
      reposition,
    });
    try {
      for (const command of luaCommands) {
        await execFileAsync('hyprctl', ['dispatch', command], { timeout: 2000 });
      }
    } catch (error) {
      onDebug?.(
        'Lua dispatcher unavailable; trying legacy Hyprland commands',
        errorMessage(error),
      );
      await runLegacyCommands(
        client,
        monitor,
        width,
        height,
        margin,
        reposition,
        position,
      );
    }

    onDebug?.('Hyprland window configured', {
      address: client.address,
      pinned: true,
      floating: true,
      size: [width, height],
    });
    return true;
  } catch (error) {
    onDebug?.('Hyprland window configuration deferred', errorMessage(error));
    return false;
  }
}

export async function getHyprlandWindowPlacement(
  pid: number,
  title = 'Persona',
): Promise<WindowPlacement | null> {
  if (process.platform !== 'linux') return null;
  try {
    const data = await runHyprctlJson('clients');
    const clients = Array.isArray(data) ? data.filter(isHyprlandClient) : [];
    const client = findHyprlandClient(clients, pid, title);
    if (!client || !Array.isArray(client.at) || !Array.isArray(client.size)) {
      return null;
    }
    return {
      x: Number(client.at[0]),
      y: Number(client.at[1]),
      width: Number(client.size[0]),
      height: Number(client.size[1]),
    };
  } catch {
    return null;
  }
}
