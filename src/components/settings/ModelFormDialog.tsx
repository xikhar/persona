import { SettingsDialog } from './SettingsDialog';

/**
 * Naming a model and picking its file, in the same dialog shape actions use.
 *
 * The file picker is the submit action rather than a separate step: the native
 * dialog is where the choice is actually made, and cancelling it leaves this
 * one open with the name still typed.
 */
export function ModelFormDialog({
  busy,
  canImport,
  name,
  onCancel,
  onChooseFile,
  onNameChange,
}: {
  busy: boolean;
  /** False outside the desktop app, where there is no native file picker. */
  canImport: boolean;
  name: string;
  onCancel: () => void;
  onChooseFile: () => void;
  onNameChange: (name: string) => void;
}) {
  const named = name.trim() !== '';

  return (
    <SettingsDialog
      busy={busy}
      eyebrow="Character library"
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
            disabled={busy || !canImport || !named}
            onClick={onChooseFile}
            type="button"
          >
            Choose VRM file…
          </button>
        </>
      }
      onClose={onCancel}
      title="Add a model"
    >
      <p className="dialog-lede">
        Persona copies the VRM you choose into your local library. The original
        file stays where it is.
      </p>

      <div className="fields">
        <div className="field">
          <label className="field-label" htmlFor="model-name">
            Model name
            <code>model_name</code>
          </label>
          <input
            id="model-name"
            maxLength={80}
            onChange={(event) => onNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && named && canImport) onChooseFile();
            }}
            placeholder="e.g. Studio Assistant"
            value={name}
          />
          <p className="field-hint">
            How the model is listed in your library and in the preview.
          </p>
        </div>
      </div>

      {!canImport && (
        <p className="desktop-note">
          Adding a model is available in the Persona desktop app.
        </p>
      )}
    </SettingsDialog>
  );
}
