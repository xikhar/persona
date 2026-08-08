import { useEffect, useRef, useState } from 'react';

// RMS below this is treated as noise and clamped to silence; the span above it
// maps onto 0..1. Tuned for ordinary speech through a laptop mic or loopback.
const NOISE_FLOOR = 0.01;
const LEVEL_SPAN = 0.2;

async function acquireStream(
  source: Exclude<LipSyncSource, 'off'>,
): Promise<MediaStream | null> {
  const media = navigator.mediaDevices;
  try {
    if (source === 'microphone') {
      if (!media?.getUserMedia) return null;
      return await media.getUserMedia({ audio: true, video: false });
    }
    if (!media?.getDisplayMedia) return null;
    // The capture API still requires a video source; the main process supplies
    // a screen source for loopback audio and we keep only the audio track.
    const stream = await media.getDisplayMedia({ audio: true, video: true });
    stream.getVideoTracks().forEach((track) => track.stop());
    return stream;
  } catch {
    // Permission denied, no device, or capture blocked: stay silent.
    return null;
  }
}

/**
 * In-renderer lip-sync level meter. Runs entirely inside Chromium's Web Audio
 * API, so it needs no native helper process — a way to animate the avatar on
 * machines where the packaged audio listener cannot be spawned. "microphone"
 * reacts to your voice; "system" reacts to desktop/app output (for example a
 * voice assistant's speech). Returns a normalized 0..1 level, or a steady 0
 * while off or when capture is unavailable.
 */
export function useCaptureLevel(source: LipSyncSource): number {
  const [level, setLevel] = useState(0);
  // Read inside the animation frame without re-subscribing the effect.
  const levelRef = useRef(0);

  useEffect(() => {
    if (source === 'off') {
      setLevel(0);
      levelRef.current = 0;
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let frame = 0;

    const start = async () => {
      const captured = await acquireStream(source);
      if (!captured) return;
      if (cancelled || captured.getAudioTracks().length === 0) {
        captured.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = captured;
      audioContext = new AudioContext();
      const analyserSource = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      analyserSource.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);

      const tick = () => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
        const rms = Math.sqrt(sum / samples.length);
        const normalized = Math.min(1, Math.max(0, (rms - NOISE_FLOOR) / LEVEL_SPAN));
        // Only re-render on a meaningful change to avoid a 60fps setState storm.
        if (Math.abs(normalized - levelRef.current) > 0.01) {
          levelRef.current = normalized;
          setLevel(normalized);
        }
        frame = requestAnimationFrame(tick);
      };
      tick();
    };
    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (audioContext) void audioContext.close();
      setLevel(0);
      levelRef.current = 0;
    };
  }, [source]);

  return level;
}
