import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessInfo } from './types.cjs';
import { isRecord } from './types.cjs';
import {
  DEFAULT_VOICE_APP_PATTERN,
  configuredPattern,
  normalizeVoiceSource,
  processMatchesSource,
} from './voice-source.cjs';

const execFileAsync = promisify(execFile);

export interface CommandOptions {
  encoding: 'utf8';
  maxBuffer: number;
  timeout: number;
  windowsHide?: boolean;
}

export interface CommandResult {
  stdout: string;
}

export type ProcessCommandRunner = (
  executable: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

const runProcessCommand: ProcessCommandRunner = async (
  executable,
  args,
  options,
) => {
  const { stdout } = await execFileAsync(executable, args, options);
  return { stdout };
};

export function parseMacProcessList(output: string): ProcessInfo[] {
  return output
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parentId: Number(match[2]),
      name: match[3] ?? '',
      executable: match[3] ?? '',
      command: '',
    }));
}

export function parseMacCommandList(output: string): Map<number, string> {
  return new Map(
    output
      .split(/\r?\n/)
      .map((line) => /^\s*(\d+)\s+(.+?)\s*$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [Number(match[1]), match[2] ?? ''] as const),
  );
}

export function mergeMacProcessCommands(
  processes: readonly ProcessInfo[],
  commands: ReadonlyMap<number, string>,
): ProcessInfo[] {
  return processes.map((processInfo) => ({
    ...processInfo,
    command: commands.get(processInfo.pid) ?? '',
  }));
}

export function parseWindowsProcessList(output: string): ProcessInfo[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries
    .filter(isRecord)
    .map((processInfo) => ({
      pid: Number(processInfo.ProcessId),
      parentId: Number(processInfo.ParentProcessId),
      name: String(processInfo.Name ?? ''),
      executable: String(
        processInfo.ExecutablePath ?? processInfo.Name ?? '',
      ),
      command: String(processInfo.CommandLine ?? ''),
    }))
    .filter((processInfo) => Number.isInteger(processInfo.pid) && processInfo.pid > 0);
}

export function identityMatches(
  processInfo: ProcessInfo,
  pattern = DEFAULT_VOICE_APP_PATTERN,
): boolean {
  pattern.lastIndex = 0;
  return pattern.test(
    `${processInfo.name} ${processInfo.executable} ${processInfo.command}`,
  );
}

export interface SelectVoiceProcessTreeOptions {
  ownProcessId?: number;
  pattern?: RegExp;
  platform?: NodeJS.Platform;
  sourceId?: string | null;
}

export interface VoiceProcessTree {
  pids: number[];
  rootPids: number[];
}

export function selectVoiceProcessTree(
  processes: readonly ProcessInfo[],
  {
    ownProcessId = process.pid,
    pattern = DEFAULT_VOICE_APP_PATTERN,
    platform = process.platform,
    sourceId = null,
  }: SelectVoiceProcessTreeOptions = {},
): VoiceProcessTree {
  const byId = new Map(processes.map((entry) => [entry.pid, entry]));
  const directlyMatched = new Set(
    processes
      .filter(
        (entry) =>
          entry.pid !== ownProcessId &&
          (sourceId
            ? processMatchesSource(entry, platform, sourceId)
            : identityMatches(entry, pattern)),
      )
      .map((entry) => entry.pid),
  );
  const matched = new Set<number>();

  for (const entry of processes) {
    let current: ProcessInfo | undefined = entry;
    const visited = new Set<number>();
    for (let depth = 0; current && depth < 20; depth += 1) {
      if (visited.has(current.pid)) break;
      visited.add(current.pid);
      if (directlyMatched.has(current.pid)) {
        matched.add(entry.pid);
        break;
      }
      current = byId.get(current.parentId);
    }
  }

  const roots = [...directlyMatched]
    .filter((pid) => {
      const parentId = byId.get(pid)?.parentId;
      return parentId === undefined || !directlyMatched.has(parentId);
    })
    .sort((left, right) => left - right);
  return {
    pids: [...matched].sort((left, right) => left - right),
    rootPids: roots,
  };
}

export interface ListPlatformProcessesOptions {
  platform?: NodeJS.Platform;
  run?: ProcessCommandRunner;
}

export async function listPlatformProcesses({
  platform = process.platform,
  run = runProcessCommand,
}: ListPlatformProcessesOptions = {}): Promise<ProcessInfo[]> {
  if (platform === 'darwin') {
    const options: CommandOptions = {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 3_000,
    };
    const [identityResult, commandResult] = await Promise.all([
      run('ps', ['-axo', 'pid=,ppid=,comm='], options),
      run('ps', ['-axo', 'pid=,args='], options),
    ]);
    return mergeMacProcessCommands(
      parseMacProcessList(identityResult.stdout),
      parseMacCommandList(commandResult.stdout),
    );
  }
  if (platform === 'win32') {
    const command =
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
    const { stdout } = await run(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
    );
    return parseWindowsProcessList(stdout);
  }
  return [];
}

export interface DiscoverVoiceProcessesOptions extends ListPlatformProcessesOptions {
  environment?: NodeJS.ProcessEnv;
  ownProcessId?: number;
  pattern?: RegExp | null;
  voiceSource?: unknown;
}

export async function discoverVoiceProcesses({
  platform = process.platform,
  run = runProcessCommand,
  environment = process.env,
  ownProcessId = process.pid,
  pattern = null,
  voiceSource = null,
}: DiscoverVoiceProcessesOptions = {}): Promise<VoiceProcessTree> {
  const processes = await listPlatformProcesses({ platform, run });
  const selected = normalizeVoiceSource(voiceSource);
  return selectVoiceProcessTree(processes, {
    ownProcessId,
    platform,
    sourceId: selected.mode === 'application' ? selected.source_id : null,
    pattern: pattern ?? configuredPattern(environment),
  });
}

export { DEFAULT_VOICE_APP_PATTERN, configuredPattern };
