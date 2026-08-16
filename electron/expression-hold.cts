/**
 * A hold resolved through one action, on one model. Kept whole rather than as
 * a bare expression name so a settings change can be reconciled against what
 * the hold was actually derived from.
 */
export interface HeldExpressionRecord {
  animationName: string;
  modelId: string | null;
  expressionName: string;
  expressionWeight: number;
}

/** The parts of a settings snapshot a hold depends on. */
export interface HeldExpressionConfiguration {
  default_model_id: string | null;
  animations: readonly {
    animation_name: string;
    expression_name: string | null;
    expression_weight: number;
  }[];
}

export type HeldExpressionOutcome =
  | 'keep'
  | 'model-changed'
  | 'action-removed'
  | 'expression-changed';

/**
 * Decides whether a hold still describes what the configuration says.
 *
 * Anything other than `keep` means the hold should be released rather than
 * re-resolved: the integration asked for one specific expression, and quietly
 * substituting a different one is not something it can observe or correct.
 * Leaving it in place is worse still — a model switch can leave the renderer
 * showing an expression the new VRM does not even define, with no way for the
 * user to clear it short of the hold timeout.
 */
export function reconcileHeldExpression(
  held: HeldExpressionRecord,
  configuration: HeldExpressionConfiguration,
): HeldExpressionOutcome {
  if ((configuration.default_model_id ?? null) !== held.modelId) {
    return 'model-changed';
  }

  const animation = configuration.animations.find(
    (candidate) => candidate.animation_name === held.animationName,
  );
  if (animation == null) return 'action-removed';

  if (
    animation.expression_name !== held.expressionName ||
    animation.expression_weight !== held.expressionWeight
  ) {
    return 'expression-changed';
  }

  return 'keep';
}
