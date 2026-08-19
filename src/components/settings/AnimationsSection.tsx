import { ExpressionFields } from './ExpressionFields';

interface AnimationsSectionProps {
  addAnimationClips: (animation: PersonaAnimationSettings) => Promise<void>;
  animationMetadata: CustomAnimationMetadata;
  availableExpressions: readonly string[];
  beginEditingAnimation: (animation: PersonaAnimationSettings) => void;
  bridge: Window['personaSettings'];
  busy: boolean;
  createAnimation: () => Promise<void>;
  deleteAnimation: (animation: PersonaAnimationSettings) => void;
  deleteAnimationClip: (
    animation: PersonaAnimationSettings,
    clip: PersonaAnimationClipSettings,
  ) => void;
  editingAnimationId: string | null;
  editingAnimationMetadata: CustomAnimationMetadata;
  playAnimationClip: (
    animation: PersonaAnimationSettings,
    clip: PersonaAnimationClipSettings,
  ) => void;
  previewClipId: string | null;
  resetPackagedAnimations: () => void;
  saveAnimation: () => Promise<void>;
  setAnimationMetadata: React.Dispatch<
    React.SetStateAction<CustomAnimationMetadata>
  >;
  setEditingAnimationId: (animationId: string | null) => void;
  setEditingAnimationMetadata: React.Dispatch<
    React.SetStateAction<CustomAnimationMetadata>
  >;
  settings: PersonaSettingsSnapshot;
}

export function AnimationsSection({
  addAnimationClips,
  animationMetadata,
  availableExpressions,
  beginEditingAnimation,
  bridge,
  busy,
  createAnimation,
  deleteAnimation,
  deleteAnimationClip,
  editingAnimationId,
  editingAnimationMetadata,
  playAnimationClip,
  previewClipId,
  resetPackagedAnimations,
  saveAnimation,
  setAnimationMetadata,
  setEditingAnimationId,
  setEditingAnimationMetadata,
  settings,
}: AnimationsSectionProps) {
  return (
    <>
      <section className="settings-panel">
        <div className="panel-heading">
          <div>
            <h2>Animation actions</h2>
            <p>
              Click a VRMA clip to preview that exact animation. Persona
              chooses randomly between them when the action runs.
            </p>
          </div>
          <button
            className="secondary-button"
            disabled={
              busy ||
              !bridge ||
              settings.packaged_animation_change_count === 0
            }
            onClick={() => void resetPackagedAnimations()}
            type="button"
          >
            Reset packaged actions
          </button>
        </div>
        <div className="animation-list">
          {settings.animations.map((animation) => (
            <article
              className={`animation-card ${
                animation.system ? 'system-action-card' : ''
              }`}
              key={animation.id}
            >
              <div className="animation-card-header">
                <div className="animation-card-copy">
                  <div>
                    <strong>
                      {animation.system
                        ? animation.animation_type === 'IDLE'
                          ? 'Idle'
                          : 'Speaking'
                        : animation.animation_name}
                    </strong>
                    <span>
                      {animation.system
                        ? 'System action'
                        : animation.origin === 'packaged'
                          ? animation.modified
                            ? 'Packaged · modified'
                            : 'Packaged'
                          : 'Custom action'}
                    </span>
                  </div>
                  <p>{animation.animation_description}</p>
                  <small>
                    <b>Trigger:</b>{' '}
                    {animation.animation_trigger_scenario}
                  </small>
                  <small className="animation-card-expression">
                    <b>Expression:</b>{' '}
                    {animation.expression_name ? (
                      <>
                        {animation.expression_name}
                        <span className="expression-weight-tag">
                          {animation.expression_weight.toFixed(2)}
                        </span>
                      </>
                    ) : (
                      'None'
                    )}
                  </small>
                </div>
                <div className="animation-card-actions">
                  {animation.editable && (
                    <button
                      disabled={busy || !bridge}
                      onClick={() => beginEditingAnimation(animation)}
                      type="button"
                    >
                      Edit
                    </button>
                  )}
                  {animation.removable && (
                    <button
                      className="danger-text-button"
                      disabled={busy || !bridge}
                      onClick={() => void deleteAnimation(animation)}
                      type="button"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              <div className="animation-clips">
                <div className="animation-clips-heading">
                  <div>
                    <strong>VRMA clips</strong>
                    <span>
                      {animation.clips.length === 0
                        ? 'No clips added'
                        : `${animation.clips.length} ${
                            animation.clips.length === 1
                              ? 'clip'
                              : 'clips'
                          }`}
                    </span>
                  </div>
                  <button
                    className="secondary-button add-clips-button"
                    disabled={busy || !bridge}
                    onClick={() => void addAnimationClips(animation)}
                    type="button"
                  >
                    + Add VRMA files
                  </button>
                </div>
                {animation.clips.length === 0 ? (
                  <p className="empty-clips">
                    {animation.system
                      ? `Upload one or more clips for the ${
                          animation.animation_type === 'IDLE'
                            ? 'idle'
                            : 'speaking'
                        } state. Persona uses the model pose until then.`
                      : 'Upload one or more clips to make this action available to MCP.'}
                  </p>
                ) : (
                  <div className="clip-list">
                    {animation.clips.map((clip) => (
                      <div
                        aria-label={`Preview ${clip.animation_name}`}
                        className={`clip-chip ${
                          previewClipId === clip.id ? 'playing' : ''
                        }`}
                        key={clip.id}
                        onClick={(event) => {
                          if (
                            (event.target as Element).closest('button')
                          ) {
                            return;
                          }
                          playAnimationClip(animation, clip);
                        }}
                        onKeyDown={(event) => {
                          if (
                            event.target !== event.currentTarget ||
                            (event.key !== 'Enter' && event.key !== ' ')
                          ) {
                            return;
                          }
                          event.preventDefault();
                          playAnimationClip(animation, clip);
                        }}
                        tabIndex={0}
                        title={`Preview ${clip.animation_name}`}
                      >
                        <span className="clip-file-icon">VRMA</span>
                        <strong>{clip.animation_name}</strong>
                        <small>
                          {clip.origin === 'packaged'
                            ? 'Packaged'
                            : 'Uploaded'}
                        </small>
                        {clip.removable && (
                          <button
                            aria-label={`Delete ${clip.animation_name}`}
                            className="clip-delete"
                            disabled={busy || !bridge}
                            onClick={() =>
                              void deleteAnimationClip(animation, clip)
                            }
                            title={`Delete ${clip.animation_name}`}
                            type="button"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      {editingAnimationId && (
        <section className="settings-panel import-panel edit-panel">
          <div className="panel-heading">
            <div>
              <h2>Edit action details</h2>
              <p>
                These details describe the action to the Persona MCP
                tool. Clips remain grouped under the action if its name
                changes.
              </p>
            </div>
          </div>
          <div className="form-stack">
            <label>
              Action name <code>animation_name</code>
              <input
                maxLength={48}
                onChange={(event) =>
                  setEditingAnimationMetadata((current) => ({
                    ...current,
                    animation_name: event.target.value,
                  }))
                }
                value={editingAnimationMetadata.animation_name}
              />
            </label>
            <label>
              Description <code>animation_description</code>
              <textarea
                maxLength={240}
                onChange={(event) =>
                  setEditingAnimationMetadata((current) => ({
                    ...current,
                    animation_description: event.target.value,
                  }))
                }
                rows={3}
                value={
                  editingAnimationMetadata.animation_description
                }
              />
            </label>
            <label>
              Trigger scenario{' '}
              <code>animation_trigger_scenario</code>
              <textarea
                maxLength={240}
                onChange={(event) =>
                  setEditingAnimationMetadata((current) => ({
                    ...current,
                    animation_trigger_scenario: event.target.value,
                  }))
                }
                rows={3}
                value={
                  editingAnimationMetadata.animation_trigger_scenario
                }
              />
            </label>
            <ExpressionFields
              metadata={editingAnimationMetadata}
              onChange={(patch) =>
                setEditingAnimationMetadata((current) => ({
                  ...current,
                  ...patch,
                }))
              }
              availableExpressions={availableExpressions}
            />
          </div>
          <div className="form-actions">
            <button
              className="primary-button"
              disabled={
                busy ||
                !editingAnimationMetadata.animation_name.trim() ||
                !editingAnimationMetadata.animation_description.trim() ||
                !editingAnimationMetadata.animation_trigger_scenario.trim()
              }
              onClick={() => void saveAnimation()}
              type="button"
            >
              Save changes
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => setEditingAnimationId(null)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      <section className="settings-panel import-panel">
        <div className="panel-heading">
          <div>
            <h2>Create a custom action</h2>
            <p>
              Create the MCP-visible action first, then add any number
              of VRMA clips from its card above.
            </p>
          </div>
          <span className="file-pill">Action</span>
        </div>
        <div className="form-stack">
          <label>
            Action name <code>animation_name</code>
            <input
              maxLength={48}
              onChange={(event) =>
                setAnimationMetadata((current) => ({
                  ...current,
                  animation_name: event.target.value,
                }))
              }
              placeholder="e.g. wave-hello"
              value={animationMetadata.animation_name}
            />
            <small>
              Lowercase letters, numbers, and hyphens. Clips added to
              this action are named automatically, such as wave-hello1
              and wave-hello2.
            </small>
          </label>
          <label>
            Description <code>animation_description</code>
            <textarea
              maxLength={240}
              onChange={(event) =>
                setAnimationMetadata((current) => ({
                  ...current,
                  animation_description: event.target.value,
                }))
              }
              placeholder="Describe what the movement looks and feels like."
              rows={3}
              value={animationMetadata.animation_description}
            />
          </label>
          <label>
            Trigger scenario <code>animation_trigger_scenario</code>
            <textarea
              maxLength={240}
              onChange={(event) =>
                setAnimationMetadata((current) => ({
                  ...current,
                  animation_trigger_scenario: event.target.value,
                }))
              }
              placeholder="Explain when an agent should choose this action."
              rows={3}
              value={animationMetadata.animation_trigger_scenario}
            />
          </label>
          <ExpressionFields
            metadata={animationMetadata}
            onChange={(patch) =>
              setAnimationMetadata((current) => ({
                ...current,
                ...patch,
              }))
            }
            availableExpressions={availableExpressions}
          />
        </div>
        <button
          className="primary-button"
          disabled={
            busy ||
            !bridge ||
            !animationMetadata.animation_name.trim() ||
            !animationMetadata.animation_description.trim() ||
            !animationMetadata.animation_trigger_scenario.trim()
          }
          onClick={() => void createAnimation()}
          type="button"
        >
          Create action
        </button>
      </section>
    </>
  );
}
