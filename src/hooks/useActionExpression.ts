import { useEffect } from 'react';
import type { VRM } from '@pixiv/three-vrm';

export function useActionExpression(
  vrm: VRM | null,
  expressionName?: PersonaExpressionName | null,
  expressionWeight = 1,
) {
  useEffect(() => {
    if (!vrm?.expressionManager || !expressionName) {
      return;
    }
    vrm.expressionManager.setValue(expressionName, expressionWeight);
    return () => {
      vrm.expressionManager?.setValue(expressionName, 0);
    };
  }, [expressionName, expressionWeight, vrm]);
}