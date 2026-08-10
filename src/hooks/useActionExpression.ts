import { useCallback, useEffect, useRef } from 'react';
import type { VRM } from '@pixiv/three-vrm';
import { ActionExpressionController } from '../action-expression';

export function useActionExpression(
  vrm: VRM | null,
  expressionName?: PersonaExpressionName | null,
  expressionWeight = 1,
) {
  const controller = useRef<ActionExpressionController | null>(null);

  useEffect(() => {
    const expressionManager = vrm?.expressionManager;

    if (!expressionManager) {
      controller.current = null;
      return;
    }

    const nextController = new ActionExpressionController(expressionManager);
    controller.current = nextController;

    return () => {
      nextController.clear();

      if (controller.current === nextController) {
        controller.current = null;
      }
    };
  }, [vrm]);

  useEffect(() => {
    if (!expressionName) {
      controller.current?.clear();
      return;
    }

    controller.current?.activate(expressionName);

    return () => {
      controller.current?.clear();
    };
  }, [expressionName]);

  return useCallback(() => {
    if (!expressionName) {
      return;
    }

    controller.current?.apply(expressionName, expressionWeight);
  }, [expressionName, expressionWeight]);
}