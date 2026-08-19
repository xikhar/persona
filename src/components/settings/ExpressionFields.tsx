import { expressionWeightFrom, singleRangeStyle } from '../../range-slider';

// Driven by lip sync, blinking, and look-at rather than chosen per action, so
// offering them here would only let a user fight the renderer for the face.
const SYSTEM_EXPRESSION_NAMES = new Set([
  'neutral',
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'blink',
  'blinkLeft',
  'blinkRight',
  'lookUp',
  'lookDown',
  'lookLeft',
  'lookRight',
]);

/** The expression overlay fields shared by the create and edit action forms. */
export function ExpressionFields({
  metadata,
  onChange,
  availableExpressions,
}: {
  metadata: CustomAnimationMetadata;
  onChange: (patch: Partial<CustomAnimationMetadata>) => void;
  availableExpressions: readonly string[];
}) {
  const expressionOptions = availableExpressions.filter(
    (expression) => !SYSTEM_EXPRESSION_NAMES.has(expression),
  );

  return (
    <>
      <label>
        Expression <code>expression_name</code>
        <select
          onChange={(event) =>
            onChange({
              expression_name: event.target.value || null,
            })
          }
          value={metadata.expression_name ?? ''}
        >
          <option value="">None</option>
          {expressionOptions.map((expression) => (
            <option key={expression} value={expression}>
              {expression}
            </option>
          ))}
        </select>
        <small>
          Blends a VRM expression over the face while the action plays.
        </small>
      </label>
      {metadata.expression_name && (
        <div className="expression-weight-field">
          <div className="expression-weight-row">
            <label>
              <span>
                Expression weight <code>expression_weight</code>
              </span>
              <input
                className="single-range-slider"
                max="1"
                min="0"
                onChange={(event) =>
                  onChange({ expression_weight: Number(event.target.value) })
                }
                step="0.05"
                style={singleRangeStyle(metadata.expression_weight, 0, 1)}
                type="range"
                value={metadata.expression_weight}
              />
              <div className="slider-labels">
                <span>0.00</span>
                <span>0.50</span>
                <span>1.00</span>
              </div>
            </label>
            {/* Out-of-range and half-typed values are ignored while editing,
                then the field snaps back to the stored weight on blur. */}
            <input
              aria-label="Expression weight value"
              className="expression-weight-value"
              max="1"
              min="0"
              onBlur={(event) => {
                const weight = expressionWeightFrom(
                  event.currentTarget.valueAsNumber,
                );
                if (weight == null) {
                  event.currentTarget.value = String(
                    metadata.expression_weight,
                  );
                }
              }}
              onChange={(event) => {
                const weight = expressionWeightFrom(
                  event.currentTarget.valueAsNumber,
                );
                if (weight != null) onChange({ expression_weight: weight });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              step="0.05"
              type="number"
              value={metadata.expression_weight}
            />
          </div>
          <small className="field-hint">
            Between 0.00 (expression off) and 1.00 (full strength).
          </small>
        </div>
      )}
    </>
  );
}
