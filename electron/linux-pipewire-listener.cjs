"use strict";

const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const { promisify } = require("node:util");
const { AudioActivityGate, DEFAULT_SPEECH_RELEASE_MS } = require("./audio-activity-gate.cjs");
const { DEFAULT_VOICE_APP_PATTERN } = require("./voice-source.cjs");

const execFileAsync = promisify(execFile);
const SPEECH_RELEASE_MS = DEFAULT_SPEECH_RELEASE_MS;
const CODEX_IDENTITY = DEFAULT_VOICE_APP_PATTERN;

function nodeProperties(node) {
  return node?.info?.props ?? {};
}

function enrichPipeWireNodes(objects) {
  const clients = new Map(
    objects
      .filter((object) => object?.type === "PipeWire:Interface:Client")
      .map((client) => [String(client.id), nodeProperties(client)]),
  );
  return objects.map((object) => {
    if (object?.type !== "PipeWire:Interface:Node") return object;
    const properties = nodeProperties(object);
    const client = clients.get(String(properties["client.id"]));
    if (!client) return object;
    return {
      ...object,
      info: {
        ...object.info,
        props: {
          ...client,
          ...properties,
        },
      },
    };
  });
}

function readProcessInfo(processId) {
  const root = `/proc/${processId}`;
  let cmdline = "";
  let comm = "";
  let executable = "";
  let status = "";
  try {
    cmdline = fs.readFileSync(`${root}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    // Some AppImage sandboxes expose only part of another process's metadata.
  }
  try {
    comm = fs.readFileSync(`${root}/comm`, "utf8").trim();
  } catch {
    // Keep any other readable identity fields.
  }
  try {
    executable = fs.readlinkSync(`${root}/exe`);
  } catch {
    // Executable symlinks can be restricted even when cmdline is readable.
  }
  try {
    status = fs.readFileSync(`${root}/status`, "utf8");
  } catch {
    // Parent traversal is optional when the current process already matches.
  }
  if (!cmdline && !comm && !executable) {
    throw new Error(`Process ${processId} is not readable`);
  }
  const parentMatch = /^PPid:\s+(\d+)$/m.exec(status);
  return {
    identity: `${comm} ${executable} ${cmdline}`,
    parentId: parentMatch ? Number(parentMatch[1]) : 0,
  };
}

function identityMatchesPattern(identity, pattern = DEFAULT_VOICE_APP_PATTERN) {
  pattern.lastIndex = 0;
  return pattern.test(identity);
}

function isCodexProcessTree(
  processId,
  processReader = readProcessInfo,
  pattern = DEFAULT_VOICE_APP_PATTERN,
) {
  let currentId = Number(processId);
  const visited = new Set();
  for (let depth = 0; depth < 10; depth += 1) {
    if (!Number.isInteger(currentId) || currentId <= 1 || visited.has(currentId)) return false;
    visited.add(currentId);
    try {
      const process = processReader(currentId);
      if (identityMatchesPattern(process.identity, pattern)) return true;
      currentId = Number(process.parentId);
    } catch {
      return false;
    }
  }
  return false;
}

function isCodexOutputNode(
  node,
  processMatcher = null,
  pattern = DEFAULT_VOICE_APP_PATTERN,
) {
  if (node?.type !== "PipeWire:Interface:Node") return false;
  const properties = nodeProperties(node);
  if (properties["media.class"] !== "Stream/Output/Audio") return false;
  const identity = [
    properties["application.name"],
    properties["application.process.binary"],
    properties["application.process.id"],
    properties["node.name"],
    properties["node.description"],
  ]
    .filter((value) => value != null)
    .join(" ");
  if (identityMatchesPattern(identity, pattern)) return true;

  const processId = properties["application.process.id"];
  const matcher =
    processMatcher ??
    ((candidateId) => isCodexProcessTree(candidateId, readProcessInfo, pattern));
  return processId != null && matcher(processId);
}

function findCodexOutputNode(
  nodes,
  processMatcher = null,
  pattern = DEFAULT_VOICE_APP_PATTERN,
) {
  const processCache = new Map();
  const matcher =
    processMatcher ??
    ((processId) => isCodexProcessTree(processId, readProcessInfo, pattern));
  const cachedMatcher = (processId) => {
    const key = String(processId);
    if (!processCache.has(key)) processCache.set(key, matcher(processId));
    return processCache.get(key);
  };
  const matches = nodes.filter((node) =>
    isCodexOutputNode(node, cachedMatcher, pattern),
  );
  return (
    matches.find((node) => node.info?.state === "running") ??
    matches.find((node) => node.info?.state === "idle") ??
    matches[0] ??
    null
  );
}

function pcm16Rms(buffer) {
  const sampleCount = Math.floor(buffer.length / 2);
  if (sampleCount === 0) return 0;
  let squareSum = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset) / 32768;
    squareSum += sample * sample;
  }
  return Math.sqrt(squareSum / sampleCount);
}

function normalizeRms(rms) {
  const noiseFloor = 0.0025;
  if (!Number.isFinite(rms) || rms <= noiseFloor) return 0;
  return Math.min(1, (rms - noiseFloor) * 7.5);
}

function displayName(node) {
  const properties = nodeProperties(node);
  return (
    properties["application.name"] ??
    properties["node.description"] ??
    properties["node.name"] ??
    "Voice app"
  );
}

class LinuxPipeWireListener {
  constructor({
    onActivity = () => {},
    onDebug = null,
    onLevel = () => {},
    onSession = () => {},
    onStatus = () => {},
    pollIntervalMs = 750,
    speechReleaseMs = SPEECH_RELEASE_MS,
    processPattern = DEFAULT_VOICE_APP_PATTERN,
  } = {}) {
    this.onActivity = onActivity;
    this.onDebug = onDebug;
    this.onLevel = onLevel;
    this.onSession = onSession;
    this.onStatus = onStatus;
    this.pollIntervalMs = pollIntervalMs;
    this.speechReleaseMs = speechReleaseMs;
    this.processPattern = processPattern ?? DEFAULT_VOICE_APP_PATTERN;
    this.capture = null;
    this.captureSerial = null;
    this.currentNode = null;
    this.pollTimer = null;
    this.sessionActive = false;
    this.stopped = true;
    this.pollInFlight = false;
    this.lastStatusKey = null;
    this.lastDebugKey = null;
    this.gate = new AudioActivityGate({
      onActivity,
      onLevel,
      shouldReturnToListening: () => this.currentNode != null,
      speechReleaseMs,
    });
  }

  reportStatus(status) {
    const key = JSON.stringify(status);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.onStatus(status);
  }

  async start() {
    if (process.platform !== "linux" || !this.stopped) return;
    this.stopped = false;
    this.reportStatus({
      available: true,
      capturing: false,
      monitoring: true,
      source: null,
    });
    await this.poll();
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async poll() {
    if (this.stopped || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const { stdout } = await execFileAsync("pw-dump", {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 2_500,
      });
      if (this.stopped) return;
      const nodes = enrichPipeWireNodes(JSON.parse(stdout));
      if (this.onDebug) {
        const outputNodes = nodes
          .filter((candidate) => nodeProperties(candidate)["media.class"] === "Stream/Output/Audio")
          .map((candidate) => {
            const properties = nodeProperties(candidate);
            const processId = properties["application.process.id"] ?? null;
            return {
              application: properties["application.name"] ?? null,
              binary: properties["application.process.binary"] ?? null,
              node: properties["node.name"] ?? null,
              processId,
              processTreeMatches:
                processId != null &&
                isCodexProcessTree(processId, readProcessInfo, this.processPattern),
              state: candidate.info?.state ?? null,
            };
          });
        const debugKey = JSON.stringify(outputNodes);
        if (debugKey !== this.lastDebugKey) {
          this.lastDebugKey = debugKey;
          this.onDebug(outputNodes);
        }
      }
      const node = findCodexOutputNode(nodes, null, this.processPattern);
      if (node == null) {
        this.detach();
        return;
      }

      const serial = String(nodeProperties(node)["object.serial"] ?? node.id);
      if (this.capture && this.captureSerial === serial) return;
      this.detach({ sessionEnded: false });
      this.currentNode = node;
      this.captureSerial = serial;
      if (!this.sessionActive) {
        this.sessionActive = true;
        this.onSession(true);
      }
      this.onActivity("listening");
      this.startCapture(node, serial);
    } catch (error) {
      this.reportStatus({
        available: false,
        capturing: false,
        monitoring: false,
        source: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.pollInFlight = false;
    }
  }

  startCapture(node, serial) {
    const child = spawn(
      "pw-record",
      [
        "--target",
        serial,
        "--raw",
        "--rate",
        "16000",
        "--channels",
        "2",
        "--format",
        "s16",
        "-",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    this.capture = child;
    this.reportStatus({
      available: true,
      capturing: true,
      monitoring: true,
      source: displayName(node),
    });

    child.stdout.on("data", (chunk) => {
      // PipeWire may flush one final chunk after the stream disappears. Ignore
      // data from a detached recorder so it cannot reopen a hidden overlay.
      if (this.capture === child) this.handleAudio(chunk);
    });
    child.once("error", (error) => {
      if (this.capture !== child) return;
      this.capture = null;
      this.reportStatus({
        available: false,
        capturing: false,
        monitoring: true,
        source: displayName(node),
        error: error.message,
      });
    });
    child.once("exit", () => {
      if (this.capture !== child) return;
      this.capture = null;
      this.reportStatus({
        available: true,
        capturing: false,
        monitoring: true,
        source: displayName(node),
      });
    });
  }

  handleAudio(chunk) {
    const level = normalizeRms(pcm16Rms(chunk));
    this.gate.handleLevel(level);
  }

  detach({ sessionEnded = true } = {}) {
    this.currentNode = null;
    this.captureSerial = null;
    if (this.capture) {
      const child = this.capture;
      this.capture = null;
      child.kill("SIGTERM");
    }
    this.gate.reset();
    if (sessionEnded && this.sessionActive) {
      this.sessionActive = false;
      this.onSession(false);
    }
    this.reportStatus({
      available: true,
      capturing: false,
      monitoring: !this.stopped,
      source: null,
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.detach();
  }
}

module.exports = {
  CODEX_IDENTITY,
  LinuxPipeWireListener,
  SPEECH_RELEASE_MS,
  enrichPipeWireNodes,
  findCodexOutputNode,
  isCodexOutputNode,
  isCodexProcessTree,
  normalizeRms,
  pcm16Rms,
  readProcessInfo,
};
