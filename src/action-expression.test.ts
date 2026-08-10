import { describe, expect, it } from 'vitest';
import { ActionExpressionController } from './action-expression';

function createManager(initial: Record<string, number> = {}) {
  const values = new Map(Object.entries(initial));

  return {
    getValue(name: string) {
      return values.get(name) ?? 0;
    },

    setValue(name: string, weight: number) {
      values.set(name, weight);
    },

    value(name: string) {
      return values.get(name) ?? 0;
    },
  };
}

describe('ActionExpressionController', () => {
  it('applies the configured expression', () => {
    const manager = createManager();
    const controller = new ActionExpressionController(manager);

    controller.apply('sad', 0.8);

    expect(manager.value('sad')).toBe(0.8);
  });

  it('restores the previous expression when replaced', () => {
    const manager = createManager({
      sad: 0.25,
      happy: 0.1,
    });
    const controller = new ActionExpressionController(manager);

    controller.apply('sad', 0.8);
    controller.apply('happy', 1);

    expect(manager.value('sad')).toBe(0.25);
    expect(manager.value('happy')).toBe(1);
  });

  it('restores the previous expression on completion cleanup', () => {
    const manager = createManager({
      sad: 0,
    });
    const controller = new ActionExpressionController(manager);

    controller.apply('sad', 1);
    controller.clear();

    expect(manager.value('sad')).toBe(0);
  });

  it('restores a non-zero previous expression value', () => {
    const manager = createManager({
      sad: 0.35,
    });
    const controller = new ActionExpressionController(manager);

    controller.apply('sad', 1);

    expect(manager.value('sad')).toBe(1);

    controller.clear();

    expect(manager.value('sad')).toBe(0.35);
  });
});