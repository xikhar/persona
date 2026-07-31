"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("personaBridge", {
  getSnapshot: () => ipcRenderer.invoke("persona:get-snapshot"),
  hide: () => ipcRenderer.send("persona:hide"),
  subscribe: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("persona:event", handler);
    return () => ipcRenderer.off("persona:event", handler);
  },
});

contextBridge.exposeInMainWorld("personaSettings", {
  get: () => ipcRenderer.invoke("persona:settings-get"),
  importModel: (metadata) =>
    ipcRenderer.invoke("persona:settings-import-model", metadata),
  createAnimation: (metadata) =>
    ipcRenderer.invoke("persona:settings-create-animation", metadata),
  addAnimationClips: (animationId) =>
    ipcRenderer.invoke("persona:settings-add-animation-clips", animationId),
  updateAnimation: (animationId, metadata) =>
    ipcRenderer.invoke(
      "persona:settings-update-animation",
      animationId,
      metadata,
    ),
  deleteAnimation: (animationId) =>
    ipcRenderer.invoke("persona:settings-delete-animation", animationId),
  deleteAnimationClip: (animationId, clipId) =>
    ipcRenderer.invoke(
      "persona:settings-delete-animation-clip",
      animationId,
      clipId,
    ),
  resetPackagedAnimations: () =>
    ipcRenderer.invoke("persona:settings-reset-packaged-animations"),
  deleteModel: (modelId) =>
    ipcRenderer.invoke("persona:settings-delete-model", modelId),
  setDefaultModel: (modelId) =>
    ipcRenderer.invoke("persona:settings-set-default-model", modelId),
  setCharacterSize: (size) =>
    ipcRenderer.invoke("persona:settings-set-character-size", size),
  setVoiceSource: (voiceSource) =>
    ipcRenderer.invoke("persona:settings-set-voice-source", voiceSource),
  setModelLighting: (modelId, lighting) =>
    ipcRenderer.invoke(
      "persona:settings-set-model-lighting",
      modelId,
      lighting,
    ),
  resetModelLighting: (modelId) =>
    ipcRenderer.invoke("persona:settings-reset-model-lighting", modelId),
  getMcpStatus: () =>
    ipcRenderer.invoke("persona:settings-get-mcp-status"),
  setWindowTheme: (theme) =>
    ipcRenderer.send("persona:settings-set-window-theme", theme),
  subscribe: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("persona:settings-updated", handler);
    return () => ipcRenderer.off("persona:settings-updated", handler);
  },
});
