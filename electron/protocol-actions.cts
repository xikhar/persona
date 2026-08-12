import { ANIMATION_NAME_PATTERN } from './library-catalog.cjs';
import type {
  BridgeEvent,
  VoiceActivity,
  VoicePhase,
  VoiceStateEvent,
} from './types.cjs';

export function voiceState(
  activity: VoiceActivity,
  phase: VoicePhase = 'active',
): VoiceStateEvent {
  return {
    type: "state",
    state: {
      activity,
      microphoneMuted: false,
      outputMuted: false,
      phase,
    },
  };
}

export type ProtocolCommand =
  | { type: 'show' | 'hide' | 'toggle' }
  | { type: 'event'; event: BridgeEvent }
  | { type: 'animation-command'; animationName: string };

export function parseProtocolUrl(
  rawUrl: string,
  protocolScheme = 'persona',
): ProtocolCommand[] | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== `${protocolScheme}:`) return null;
    const action = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();
    if (action === "show" || action === "hide" || action === "toggle") {
      return [{ type: action }];
    }
    if (action === "listening") {
      return [{ type: "event", event: voiceState("listening") }];
    }
    if (action === "speaking") {
      const commands: ProtocolCommand[] = [
        { type: 'event', event: voiceState('speaking') },
      ];
      const level = Number(url.searchParams.get("level"));
      if (Number.isFinite(level)) {
        commands.push({
          type: "event",
          event: { type: "audio-level", level: Math.max(0, Math.min(1, level)) },
        });
      }
      return commands;
    }
    if (action === "thinking") {
      return [{ type: "event", event: voiceState("idle") }];
    }
    if (action === "inactive" || action === "stop") {
      return [{ type: "event", event: voiceState("idle", "inactive") }];
    }
    if (action === "animation") {
      const animationName = url.searchParams.get("name")?.trim() ?? "";
      if (!ANIMATION_NAME_PATTERN.test(animationName)) return null;
      return [
        {
          type: "animation-command",
          animationName,
        },
      ];
    }
    return null;
  } catch {
    return null;
  }
}
