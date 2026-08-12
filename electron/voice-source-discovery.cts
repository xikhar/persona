import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PipeWireObject, ProcessInfo, VoiceSource } from './types.cjs';
import { isRecord } from './types.cjs';
import {
  enrichPipeWireNodes,
  nodeProperties,
} from './linux-pipewire-listener.cjs';
import {
  listPlatformProcesses,
  type ProcessCommandRunner,
} from './process-discovery.cjs';
import {
  pipeWireSourceFromProperties,
  sourceFromProcess,
} from './voice-source.cjs';

const execFileAsync = promisify(execFile);
const runProcessCommand: ProcessCommandRunner = async (
  executable,
  args,
  options,
) => {
  const { stdout } = await execFileAsync(executable, args, options);
  return { stdout };
};

export interface VoiceSourceCatalogResult {
  platform: NodeJS.Platform;
  sources: VoiceSource[];
}

export interface ListVoiceSourcesOptions {
  platform?: NodeJS.Platform;
  run?: ProcessCommandRunner;
  ownProcessId?: number;
}

function isPipeWireObject(value: unknown): value is PipeWireObject {
  return isRecord(value) && (typeof value.id === 'number' || typeof value.id === 'string');
}

export function uniqueSortedSources(
  sources: readonly (VoiceSource | null | undefined)[],
): VoiceSource[] {
  const byId = new Map<string, VoiceSource>();
  for (const source of sources) {
    if (!source || byId.has(source.id)) continue;
    byId.set(source.id, source);
  }
  return [...byId.values()]
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name, undefined, {
          sensitivity: 'base',
        }) ||
        left.detail.localeCompare(right.detail, undefined, {
          sensitivity: 'base',
        }),
    )
    .slice(0, 500);
}

export function pipeWireSources(objects: readonly PipeWireObject[]): VoiceSource[] {
  return uniqueSortedSources(
    enrichPipeWireNodes(objects)
      .filter(
        (object) =>
          object.type === 'PipeWire:Interface:Node' &&
          nodeProperties(object)['media.class'] === 'Stream/Output/Audio',
      )
      .map((node) => pipeWireSourceFromProperties(nodeProperties(node))),
  );
}

function processBelongsToPersona(
  processInfo: ProcessInfo,
  byId: ReadonlyMap<number, ProcessInfo>,
  ownProcessId: number,
): boolean {
  let current: ProcessInfo | undefined = processInfo;
  const visited = new Set<number>();
  for (let depth = 0; current && depth < 20; depth += 1) {
    if (current.pid === ownProcessId) return true;
    if (visited.has(current.pid)) break;
    visited.add(current.pid);
    current = byId.get(current.parentId);
  }
  return false;
}

export function processSources(
  platform: NodeJS.Platform,
  processes: readonly ProcessInfo[],
  ownProcessId = process.pid,
): VoiceSource[] {
  const byId = new Map(processes.map((entry) => [entry.pid, entry]));
  return uniqueSortedSources(
    processes
      .filter((entry) => !processBelongsToPersona(entry, byId, ownProcessId))
      .map((entry) => sourceFromProcess(platform, entry)),
  );
}

export async function listVoiceSources({
  platform = process.platform,
  run = runProcessCommand,
  ownProcessId = process.pid,
}: ListVoiceSourcesOptions = {}): Promise<VoiceSourceCatalogResult> {
  if (platform === 'linux') {
    const { stdout } = await run('pw-dump', [], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 2_500,
    });
    const parsed: unknown = JSON.parse(stdout);
    return {
      platform,
      sources: pipeWireSources(
        Array.isArray(parsed) ? parsed.filter(isPipeWireObject) : [],
      ),
    };
  }
  if (platform === 'darwin' || platform === 'win32') {
    const processes = await listPlatformProcesses({ platform, run });
    return {
      platform,
      sources: processSources(platform, processes, ownProcessId),
    };
  }
  return { platform, sources: [] };
}
