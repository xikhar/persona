import type { Dispatch, SetStateAction } from 'react';
import { ExpressionFields } from './ExpressionFields';
import { SettingsDialog } from './SettingsDialog';

/**
 * Creating an action and editing one ask for exactly the same details, so they
 * are one dialog with a different title and submit label. Anything that
 * differs between them is a prop, not a second form to keep in sync.
 */
export function ActionFormDialog({
  availableExpressions,
  busy,
  metadata,
  mode,
  onCancel,
  onChange,
  onSubmit,
}: {
  availableExpressions: readonly string[];
  busy: boolean;
  metadata: CustomAnimationMetadata;
  mode: 'create' | 'edit';
  onCancel: () => void;
  onChange: Dispatch<SetStateAction<CustomAnimationMetadata>>;
  onSubmit: () => void;
}) {
  const creating = mode === 'create';
  const complete =
    metadata.animation_name.trim() !== '' &&
    metadata.animation_description.trim() !== '' &&
    metadata.animation_trigger_scenario.trim() !== '';

  const patch = (fields: Partial<CustomAnimationMetadata>) =>
    onChange((current) => ({ ...current, ...fields }));

  return (
    <SettingsDialog
      busy={busy}
      eyebrow={creating ? 'Motion library' : 'Edit action'}
      footer={
        <>
          <button
            className="btn btn-secondary"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !complete}
            onClick={onSubmit}
            type="button"
          >
            {creating ? 'Create action' : 'Save changes'}
          </button>
        </>
      }
      onClose={onCancel}
      title={creating ? 'New action' : 'Edit action details'}
      wide
    >
      <p className="dialog-lede">
        {creating
          ? 'These details are what a connected agent reads to decide when to play the action. Add its VRMA clips from the action’s card afterwards.'
          : 'These details describe the action to the Persona MCP tool. Clips stay grouped under the action if its name changes.'}
      </p>

      <div className="fields">
        <div className="field">
          <label className="field-label" htmlFor="action-name">
            Action name
            <code>animation_name</code>
          </label>
          <input
            id="action-name"
            maxLength={48}
            onChange={(event) => patch({ animation_name: event.target.value })}
            placeholder="e.g. wave-hello"
            value={metadata.animation_name}
          />
          <p className="field-hint">
            Lowercase letters, numbers, and hyphens. Clips are named from it
            automatically, such as wave-hello1 and wave-hello2.
          </p>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="action-description">
            Description
            <code>animation_description</code>
          </label>
          <textarea
            id="action-description"
            maxLength={240}
            onChange={(event) =>
              patch({ animation_description: event.target.value })
            }
            placeholder="Describe what the movement looks and feels like."
            rows={3}
            value={metadata.animation_description}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="action-trigger">
            Trigger scenario
            <code>animation_trigger_scenario</code>
          </label>
          <textarea
            id="action-trigger"
            maxLength={240}
            onChange={(event) =>
              patch({ animation_trigger_scenario: event.target.value })
            }
            placeholder="Explain when an agent should choose this action."
            rows={3}
            value={metadata.animation_trigger_scenario}
          />
        </div>

        <ExpressionFields
          availableExpressions={availableExpressions}
          metadata={metadata}
          onChange={patch}
        />
      </div>
    </SettingsDialog>
  );
}
