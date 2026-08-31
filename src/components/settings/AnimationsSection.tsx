import { useState } from 'react';
import { ActionFormDialog } from './ActionFormDialog';
import { ClipPickerDialog } from './ClipPickerDialog';
import { PencilIcon, PlayIcon, PlusIcon, TrashIcon } from './icons';

interface AnimationsSectionProps {
  attachAnimationClips: (
    animationId: string,
    clipIds: readonly string[],
  ) => Promise<boolean>;
  deleteLibraryClip: (clip: PersonaAnimationLibraryClip) => void;
  animationMetadata: CustomAnimationMetadata;
  availableExpressions: readonly string[];
  beginEditingAnimation: (animation: PersonaAnimationSettings) => void;
  bridge: Window['personaSettings'];
  busy: boolean;
  createAnimation: () => Promise<boolean>;
  deleteAnimation: (animation: PersonaAnimationSettings) => void;
  detachAnimationClip: (
    animation: PersonaAnimationSettings,
    clip: PersonaAnimationClipSettings,
  ) => void;
  importAnimationClips: () => Promise<readonly PersonaAnimationLibraryClip[]>;
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
  attachAnimationClips,
  animationMetadata,
  availableExpressions,
  beginEditingAnimation,
  bridge,
  busy,
  createAnimation,
  deleteAnimation,
  deleteLibraryClip,
  detachAnimationClip,
  importAnimationClips,
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
  const [creatingAction, setCreatingAction] = useState(false);
  const [clipPickerActionId, setClipPickerActionId] = useState<string | null>(null);
  const editingAnimation = settings.animations.find(
    (animation) => animation.id === editingAnimationId,
  );
  const clipPickerAction = settings.animations.find(
    (animation) => animation.id === clipPickerActionId,
  );

  return (
    <>
      {creatingAction && (
        <ActionFormDialog
          availableExpressions={availableExpressions}
          busy={busy}
          metadata={animationMetadata}
          mode="create"
          onCancel={() => setCreatingAction(false)}
          onChange={setAnimationMetadata}
          onSubmit={() => {
            void createAnimation().then((created) => {
              if (created) setCreatingAction(false);
            });
          }}
        />
      )}

      {editingAnimation && (
        <ActionFormDialog
          availableExpressions={availableExpressions}
          busy={busy}
          metadata={editingAnimationMetadata}
          mode="edit"
          onCancel={() => setEditingAnimationId(null)}
          onChange={setEditingAnimationMetadata}
          onSubmit={() => void saveAnimation()}
        />
      )}

      {clipPickerAction && (
        <ClipPickerDialog
          action={clipPickerAction}
          available={Boolean(bridge)}
          busy={busy}
          clips={settings.animation_clips}
          onAdd={(clipIds) => attachAnimationClips(clipPickerAction.id, clipIds)}
          onClose={() => setClipPickerActionId(null)}
          onDelete={deleteLibraryClip}
          onImport={importAnimationClips}
        />
      )}

      <section className="settings-panel">
        <div className="panel-heading">
          <div>
            <h2>Animation actions</h2>
            <p>
              Click a VRMA clip to preview that exact animation. Persona
              chooses randomly between them when the action runs.
            </p>
          </div>
          <div className="panel-actions">
            <button
              className="btn btn-ghost"
              disabled={
                busy ||
                !bridge ||
                settings.packaged_animation_change_count === 0
              }
              onClick={() => void resetPackagedAnimations()}
              type="button"
            >
              Reset packaged
            </button>
            <button
              className="btn btn-secondary"
              disabled={busy || !bridge}
              onClick={() => setCreatingAction(true)}
              type="button"
            >
              <PlusIcon />
              New action
            </button>
          </div>
        </div>
        <div className="animation-list">
          {settings.animations.map((animation) => {
            return (
            <article className="action-card" key={animation.id}>
              <div className="action-head">
                <div className="action-title">
                  <strong>
                    {animation.system
                      ? animation.animation_type === 'IDLE'
                        ? 'Idle'
                        : 'Speaking'
                      : animation.animation_name}
                  </strong>
                  <span
                    className={`chip ${animation.system ? 'chip-accent' : ''}`}
                  >
                    {animation.system
                      ? 'System'
                      : animation.origin === 'packaged'
                        ? animation.modified
                          ? 'Packaged · modified'
                          : 'Packaged'
                        : 'Custom'}
                  </span>
                </div>
                <div className="action-head-actions">
                  {animation.editable && (
                    <button
                      aria-label={`Edit ${animation.animation_name}`}
                      className="btn btn-ghost btn-icon"
                      disabled={busy || !bridge}
                      onClick={() => beginEditingAnimation(animation)}
                      title="Edit details"
                      type="button"
                    >
                      <PencilIcon />
                    </button>
                  )}
                  {animation.removable && (
                    <button
                      aria-label={`Delete ${animation.animation_name}`}
                      className="btn btn-danger btn-icon"
                      disabled={busy || !bridge}
                      onClick={() => void deleteAnimation(animation)}
                      title="Delete action"
                      type="button"
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              </div>

              <p className="action-desc">{animation.animation_description}</p>

              <dl className="meta-list">
                <div>
                  <dt>Trigger</dt>
                  <dd>{animation.animation_trigger_scenario}</dd>
                </div>
                <div>
                  <dt>Expression</dt>
                  <dd>
                    {animation.expression_name ? (
                      <>
                        {animation.expression_name}
                        <span className="chip">
                          {animation.expression_weight.toFixed(2)}
                        </span>
                      </>
                    ) : (
                      'None'
                    )}
                  </dd>
                </div>
              </dl>

              <div className="subhead">
                <span>
                  Clips
                  <span className="chip">{animation.clips.length}</span>
                </span>
                <div className="action-clip-controls">
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={busy || !bridge}
                    onClick={() => setClipPickerActionId(animation.id)}
                    type="button"
                  >
                    <PlusIcon /> Add clip
                  </button>
                </div>
              </div>

              {animation.clips.length === 0 ? (
                <p className="empty-clips">
                  {animation.system
                    ? `Add one or more clips for the ${
                        animation.animation_type === 'IDLE'
                          ? 'idle'
                          : 'speaking'
                      } state. Persona holds the model's own pose until then.`
                    : 'Add one or more clips to make this action available to MCP.'}
                </p>
              ) : (
                <div className="rows rows-grid">
                  {animation.clips.map((clip) => {
                    const playing = previewClipId === clip.id;
                    return (
                      <div
                        className={`row-wrap ${clip.removable ? 'row-wrap-actionable' : ''}`}
                        key={clip.id}
                      >
                        <button
                          aria-label={`Preview ${clip.animation_name}`}
                          aria-pressed={playing}
                          className={`row row-selectable ${playing ? 'is-selected' : ''}`}
                          onClick={() => playAnimationClip(animation, clip)}
                          title={`Preview ${clip.animation_name}`}
                          type="button"
                        >
                          <span className="row-mark row-mark-play">
                            <PlayIcon />
                          </span>
                          <span className="row-copy">
                            <strong>{clip.animation_name}</strong>
                            <small>
                              {clip.origin === 'packaged'
                                ? 'Packaged'
                                : clip.source === 'kimodo'
                                  ? 'Kimodo library'
                                  : 'Imported library'}
                            </small>
                          </span>
                          <span className="row-trailing">
                            {playing && (
                              <span className="chip chip-accent">Playing</span>
                            )}
                          </span>
                        </button>
                        {clip.removable && (
                          <div className="row-actions row-actions-overlay">
                            <button
                              aria-label={`Detach ${clip.animation_name}`}
                              className="btn btn-ghost btn-sm"
                              disabled={busy || !bridge}
                              onClick={() =>
                                void detachAnimationClip(animation, clip)
                              }
                              title={`Detach ${clip.animation_name} from this action`}
                              type="button"
                            >
                              Detach
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </article>
            );
          })}
        </div>
      </section>

    </>
  );
}
