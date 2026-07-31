"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  DEFAULT_VOICE_APP_PATTERN,
  configuredPattern,
} = require("./voice-source.cjs");

const execFileAsync = promisify(execFile);

function parseMacProcessList(output) {
  return output
    .split(/\r?\n/)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parentId: Number(match[2]),
      name: match[3],
      command: match[4] ?? "",
    }));
}

function parseWindowsProcessList(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return (Array.isArray(parsed) ? parsed : [parsed])
    .map((process) => ({
      pid: Number(process.ProcessId),
      parentId: Number(process.ParentProcessId),
      name: String(process.Name ?? ""),
      command: String(process.CommandLine ?? ""),
    }))
    .filter((process) => Number.isInteger(process.pid) && process.pid > 0);
}

function identityMatches(process, pattern = DEFAULT_VOICE_APP_PATTERN) {
  pattern.lastIndex = 0;
  return pattern.test(`${process.name} ${process.command}`);
}

function selectVoiceProcessTree(processes, {
  ownProcessId = process.pid,
  pattern = DEFAULT_VOICE_APP_PATTERN,
} = {}) {
  const byId = new Map(processes.map((entry) => [entry.pid, entry]));
  const directlyMatched = new Set(
    processes
      .filter((entry) => entry.pid !== ownProcessId && identityMatches(entry, pattern))
      .map((entry) => entry.pid),
  );
  const matched = new Set();

  for (const entry of processes) {
    let current = entry;
    const visited = new Set();
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
    .filter((pid) => !directlyMatched.has(byId.get(pid)?.parentId))
    .sort((left, right) => left - right);
  return {
    pids: [...matched].sort((left, right) => left - right),
    rootPids: roots,
  };
}

async function discoverVoiceProcesses({
  platform = process.platform,
  run = execFileAsync,
  environment = process.env,
  ownProcessId = process.pid,
  pattern = null,
} = {}) {
  let processes;
  if (platform === "darwin") {
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,comm=,args="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 3_000,
    });
    processes = parseMacProcessList(stdout);
  } else if (platform === "win32") {
    const command =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const { stdout } = await run(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
    );
    processes = parseWindowsProcessList(stdout);
  } else {
    return { pids: [], rootPids: [] };
  }

  return selectVoiceProcessTree(processes, {
    ownProcessId,
    pattern: pattern ?? configuredPattern(environment),
  });
}

module.exports = {
  DEFAULT_VOICE_APP_PATTERN,
  configuredPattern,
  discoverVoiceProcesses,
  identityMatches,
  parseMacProcessList,
  parseWindowsProcessList,
  selectVoiceProcessTree,
};
