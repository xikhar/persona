import { useEffect, useRef, useState } from 'react';

// RMS below this is treated as room noise and clamped to silence; the span above
// it maps onto 0..1. Tuned for ordinary speech into a laptop microphone.
const NOISE_FLOOR = 0.01;
const LEVEL_SPAN = 0.2;

/**
 * In-renderer microphone lip-sync source. Runs entirely inside Chromium's Web
 * Audio API, so it needs no native helper process — a way to animate the avatar
 * on machines where the packaged audio listener cannot be spawned. Returns a
 * normalized 0..1 level, or a steady 0 while disabled or permission is denied.
 */
export function useMicrophoneLevel(enabled: boolean): number {
  const [level, setLevel] = useState(0);
  // Read inside the animation frame without re-subscribing the effect.
  const levelRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setLevel(0);
      levelRef.current = 0;
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let frame = 0;

    const start = async () => {
      let captured: MediaStream;
      try {
        captured = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
      } catch {
        // Permission denied or no input device: stay silent rather than throw.
        return;
      }
      if (cancelled) {
        captured.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = captured;
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
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
  }, [enabled]);

  return level;
}
