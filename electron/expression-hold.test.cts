import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcileHeldExpression,
  type HeldExpressionConfiguration,
  type HeldExpressionRecord,
} from './expression-hold.cjs';

const held: HeldExpressionRecord = {
  animationName: 'embarrassed',
  modelId: 'model-1',
  expressionName: 'embarrassed',
  expressionWeight: 1,
};

const configuration = (
  overrides: Partial<HeldExpressionConfiguration> = {},
): HeldExpressionConfiguration => ({
  default_model_id: 'model-1',
  animations: [
    {
      animation_name: 'embarrassed',
      expression_name: 'embarrassed',
      expression_weight: 1,
    },
    { animation_name: 'happy', expression_name: 'happy', expression_weight: 1 },
  ],
  ...overrides,
});

test('an unchanged configuration keeps the hold', () => {
  assert.equal(reconcileHeldExpression(held, configuration()), 'keep');
});

test('editing an unrelated action keeps the hold', () => {
  const edited = configuration({
    animations: [
      {
        animation_name: 'embarrassed',
        expression_name: 'embarrassed',
        expression_weight: 1,
      },
      {
        animation_name: 'happy',
        expression_name: 'relaxed',
        expression_weight: 0.4,
      },
    ],
  });

  assert.equal(reconcileHeldExpression(held, edited), 'keep');
});

test('switching models releases the hold', () => {
  // The new VRM may not define the expression at all, and nothing else would
  // clear it before the timeout.
  assert.equal(
    reconcileHeldExpression(held, configuration({ default_model_id: 'model-2' })),
    'model-changed',
  );
  assert.equal(
    reconcileHeldExpression(held, configuration({ default_model_id: null })),
    'model-changed',
  );
});

test('a hold taken with no configured model tracks that state', () => {
  const withoutModel = { ...held, modelId: null };

  assert.equal(
    reconcileHeldExpression(withoutModel, configuration({ default_model_id: null })),
    'keep',
  );
  assert.equal(
    reconcileHeldExpression(withoutModel, configuration()),
    'model-changed',
  );
});

test('deleting the held action releases the hold', () => {
  const removed = configuration({
    animations: [
      { animation_name: 'happy', expression_name: 'happy', expression_weight: 1 },
    ],
  });

  assert.equal(reconcileHeldExpression(held, removed), 'action-removed');
});

test('editing the held action\'s expression releases the hold', () => {
  const renamed = configuration({
    animations: [
      {
        animation_name: 'embarrassed',
        expression_name: 'surprised',
        expression_weight: 1,
      },
    ],
  });
  const cleared = configuration({
    animations: [
      {
        animation_name: 'embarrassed',
        expression_name: null,
        expression_weight: 1,
      },
    ],
  });
  const reweighted = configuration({
    animations: [
      {
        animation_name: 'embarrassed',
        expression_name: 'embarrassed',
        expression_weight: 0.5,
      },
    ],
  });

  assert.equal(reconcileHeldExpression(held, renamed), 'expression-changed');
  assert.equal(reconcileHeldExpression(held, cleared), 'expression-changed');
  assert.equal(reconcileHeldExpression(held, reweighted), 'expression-changed');
});
