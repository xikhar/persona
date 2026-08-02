"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AudioActivityGate, DEFAULT_SPEECH_RELEASE_MS } = require("./audio-activity-gate.cjs");
const { discoverVoiceProcesses } = require("./process-discovery.cjs");
const { normalizeVoiceSource } = require("./voice-source.cjs");

const SESSION_IDLE_MS = 8_000;

function helperExecutableName(platform) {
  return platform === "win32" ? "persona-audio-listener.exe" : "persona-audio-listener";
}

function resolveNativeHelperPath({
  platform = process.platform,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  projectRoot = path.join(__dirname, ".."),
} = {}) {
  const executable = helperExecutableName(platform);
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return isPackaged
    ? platformPath.join(resourcesPath, "native", platform, executable)
    : platformPath.join(projectRoot, "native", "bin", platform, executable);
}

function createNdjsonParser(onMessage, onInvalid = () => {}) {
  let pending = "";
  return (chunk) => {
    pending += chunk.toString("utf8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        onInvalid(line);
      }
    }
  };
}

class NativeProcessAudioListener {
  constructor({
    platform = process.platform,
    isPackaged = false,
    resourcesPath = process.resourcesPath,
    helperPath = null,
    processDiscovery = discoverVoiceProcesses,
    spawnProcess = spawn,
    onActivity = () => {},
    onDebug = null,
    onLevel = () => {},
    onSession = () => {},
    onStatus = () => {},
    pollIntervalMs = 1_500,
    sessionIdleMs = SESSION_IDLE_MS,
    speechReleaseMs = DEFAULT_SPEECH_RELEASE_MS,
    processPattern = null,
    voiceSource = null,
  } = {}) {
    this.platform = platform;
    this.helperPath =
      helperPath ?? resolveNativeHelperPath({ platform, isPackaged, resourcesPath });
    this.processDiscovery = processDiscovery;
    this.processPattern = processPattern;
    this.voiceSource = normalizeVoiceSource(voiceSource);
    this.spawnProcess = spawnProcess;
    this.onActivity = onActivity;
    this.onDebug = onDebug;
    this.onSession = onSession;
    this.onStatus = onStatus;
    this.pollIntervalMs = pollIntervalMs;
    this.sessionIdleMs = sessionIdleMs;
    this.capture = null;
    this.captureKey = null;
    this.captureRootPids = new Set();
    this.resolvedPids = new Set();
    this.pollTimer = null;
    this.sessionTimer = null;
    this.sessionActive = false;
    this.stopped = true;
    this.pollInFlight = false;
    this.lastStatusKey = null;
    this.gate = new AudioActivityGate({
      onActivity,
      onLevel,
      shouldReturnToListening: () => this.sessionActive,
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
    if (!["darwin", "win32"].includes(this.platform) || !this.stopped) return;
    this.stopped = false;
    if (!fs.existsSync(this.helperPath)) {
      this.reportStatus({
        available: false,
        capturing: false,
        monitoring: false,
        source: null,
        error: `Native listener is missing: ${this.helperPath}`,
      });
      return;
    }
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
      const processes = await this.processDiscovery({
        platform: this.platform,
        voiceSource: this.voiceSource,
        ...(this.processPattern ? { pattern: this.processPattern } : {}),
      });
      if (this.stopped) return;
      const spawnPids =
        this.platform === "win32"
          ? processes.rootPids.slice(0, 1)
          : processes.pids;
      if (spawnPids.length === 0) {
        this.detach();
        return;
      }
      // Key the tap lifecycle on matched roots + the PIDs the native tap
      // resolved to audio objects, not the full tree — worker churn (#13).
      const stablePids = this.stableCapturePids(processes);
      const key = stablePids.join(",");
      if (this.capture && this.captureKey === key) return;
      this.detach({ sessionEnded: false });
      this.startCapture(spawnPids, key, processes.rootPids);
    } catch (error) {
      this.reportStatus({
        available: true,
        capturing: false,
        monitoring: true,
        source: null,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.pollInFlight = false;
    }
  }

  stableCapturePids(processes) {
    if (this.platform === "win32") {
      return processes.rootPids.slice(0, 1);
    }
    const matched = new Set(processes.pids ?? []);
    const stable = new Set(processes.rootPids ?? []);
    for (const pid of this.resolvedPids) {
      if (matched.has(pid)) stable.add(pid);
    }
    return [...stable].sort((left, right) => left - right);
  }

  startCapture(processIds, key, rootPids = []) {
    const args = processIds.flatMap((processId) => ["--pid", String(processId)]);
    const child = this.spawnProcess(this.helperPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.capture = child;
    this.captureKey = key;
    this.captureRootPids = new Set(rootPids);
    const parse = createNdjsonParser(
      (message) => this.handleHelperMessage(child, message),
      (line) => this.onDebug?.("native listener emitted invalid JSON", line),
    );
    child.stdout.on("data", parse);
    child.stderr.on("data", (chunk) => this.onDebug?.("native listener stderr", chunk.toString()));
    child.once("error", (error) => {
      if (this.capture !== child) return;
      this.capture = null;
      this.captureKey = null;
      this.captureRootPids = new Set();
      this.resolvedPids = new Set();
      this.reportStatus({
        available: false,
        capturing: false,
        monitoring: true,
        source: null,
        error: error.message,
      });
    });
    child.once("exit", (code, signal) => {
      if (this.capture !== child) return;
      this.capture = null;
      this.captureKey = null;
      this.captureRootPids = new Set();
      this.resolvedPids = new Set();
      this.gate.reset();
      this.reportStatus({
        available: true,
        capturing: false,
        monitoring: !this.stopped,
        source: null,
        ...(code && !this.stopped
          ? { error: `Native listener exited with code ${code}${signal ? ` (${signal})` : ""}.` }
          : {}),
      });
    });
  }

  handleHelperMessage(child, message) {
    if (this.capture !== child || message == null || typeof message !== "object") return;
    if (message.type === "ready") {
      const resolved = Array.isArray(message.pids)
        ? message.pids.filter((pid) => Number.isInteger(pid) && pid > 0)
        : [];
      this.resolvedPids = new Set(resolved);
      if (this.platform === "darwin") {
        this.captureKey = [...new Set([...this.captureRootPids, ...resolved])]
          .sort((left, right) => left - right)
          .join(",");
      }
      this.reportStatus({
        available: true,
        capturing: true,
        monitoring: true,
        source: message.source || "Supported voice app",
      });
      return;
    }
    if (message.type === "error") {
      this.reportStatus({
        available: false,
        capturing: false,
        monitoring: true,
        source: null,
        error: String(message.message || "Native listener failed."),
      });
      return;
    }
    if (message.type !== "level" || !Number.isFinite(message.level)) return;

    const level = Math.max(0, Math.min(1, Number(message.level)));
    if (level > 0.008) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = setTimeout(() => this.endSession(), this.sessionIdleMs);
      this.sessionTimer.unref?.();
      if (!this.sessionActive) {
        this.sessionActive = true;
        this.onSession(true);
        this.onActivity("listening");
      }
    }
    this.gate.handleLevel(level);
  }

  endSession() {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    if (!this.sessionActive) return;
    this.sessionActive = false;
    this.gate.reset();
    this.onSession(false);
  }

  detach({ sessionEnded = true } = {}) {
    if (this.capture) {
      const child = this.capture;
      this.capture = null;
      this.captureKey = null;
      this.captureRootPids = new Set();
      child.kill();
    }
    if (sessionEnded) this.resolvedPids = new Set();
    this.gate.reset();
    if (sessionEnded) this.endSession();
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
  NativeProcessAudioListener,
  SESSION_IDLE_MS,
  createNdjsonParser,
  helperExecutableName,
  resolveNativeHelperPath,
};
