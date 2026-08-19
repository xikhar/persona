import { useCallback, useRef } from 'react';
import type { VRM } from '@pixiv/three-vrm';

const VISEMES = ['aa', 'ee', 'ih', 'oh', 'ou'] as const;

export function useAmplitudeLipSync(vrm: VRM | null) {
  const smoothed = useRef(0);
  const phase = useRef(0);

  return useCallback(
    (delta: number, level: number, speaking: boolean) => {
      if (!vrm?.expressionManager) return;
      const audible = speaking && level > 0.008;
      const normalized = audible ? Math.min(1, Math.max(0, level) * 2.8) : 0;
      const smoothing = 1 - Math.exp(-delta / (normalized > smoothed.current ? 0.055 : 0.1));
      smoothed.current += (normalized - smoothed.current) * smoothing;
      phase.current += delta * (8 + smoothed.current * 9);
      const active = Math.floor(phase.current) % VISEMES.length;

      for (const [index, viseme] of VISEMES.entries()) {
        const shape = Math.max(0, 1 - Math.abs(index - active) * 0.72);
        const flutter = 0.74 + Math.sin(phase.current * 5.7 + index) * 0.18;
        vrm.expressionManager.setValue(
          viseme,
          Math.min(0.62, smoothed.current * shape * flutter),
        );
      }
    },
    [vrm],
  );
}
