import { useState } from 'react';
import { RefreshIcon, TrashIcon } from './icons';
import { ModelFormDialog } from './ModelFormDialog';
import { VroidCharacterGroup } from './VroidCharacters';

interface ModelsSectionProps {
  bridge: Window['personaSettings'];
  busy: boolean;
  clearVroidCredentials: () => void;
  connectVroidHub: () => Promise<void>;
  copyText: (value: string, label: string) => Promise<void>;
  deleteModel: (model: PersonaModelSettings) => void;
  disconnectVroidHub: () => void;
  heartedVroidCharacters: PersonaVroidHubCharacter[];
  importModel: () => Promise<boolean>;
  modelName: string;
  ownVroidCharacters: PersonaVroidHubCharacter[];
  refreshVroidCharacters: () => Promise<void>;
  saveVroidCredentials: () => Promise<void>;
  selectVroidCharacter: (character: PersonaVroidHubCharacter) => void;
  selectedModel: PersonaModelSettings | undefined;
  setDefaultModel: (modelId: string) => Promise<void>;
  setModelName: (name: string) => void;
  setSelectedModelId: (modelId: string | null) => void;
  setVroidClientIdInput: (clientId: string) => void;
  setVroidClientSecretInput: (clientSecret: string) => void;
  settings: PersonaSettingsSnapshot;
  vroidCharacters: PersonaVroidHubCharacter[] | null;
  vroidClientIdInput: string;
  vroidClientSecretInput: string;
  vroidCredentials: PersonaVroidHubCredentials | null;
  vroidCredentialsSaving: boolean;
  vroidHubBridge: Window['personaVroidHub'];
  vroidLoading: boolean;
  vroidPortraitEpoch: number;
  vroidStatus: PersonaVroidHubStatus | null;
}

export function ModelsSection({
  bridge,
  busy,
  clearVroidCredentials,
  connectVroidHub,
  copyText,
  deleteModel,
  disconnectVroidHub,
  heartedVroidCharacters,
  importModel,
  modelName,
  ownVroidCharacters,
  refreshVroidCharacters,
  saveVroidCredentials,
  selectVroidCharacter,
  selectedModel,
  setDefaultModel,
  setModelName,
  setSelectedModelId,
  setVroidClientIdInput,
  setVroidClientSecretInput,
  settings,
  vroidCharacters,
  vroidClientIdInput,
  vroidClientSecretInput,
  vroidCredentials,
  vroidCredentialsSaving,
  vroidHubBridge,
  vroidLoading,
  vroidPortraitEpoch,
  vroidStatus,
}: ModelsSectionProps) {
  // Adding is a task, not a permanent part of the panel: an always-open form
  // pushes the library the user actually came to read down the page.
  const [addingModel, setAddingModel] = useState(false);

  const closeAddModel = () => {
    setAddingModel(false);
    setModelName('');
  };

  return (
    <>
      {addingModel && (
        <ModelFormDialog
          busy={busy}
          canImport={bridge != null}
          name={modelName}
          onCancel={closeAddModel}
          onChooseFile={() => {
            void importModel().then((imported) => {
              if (imported) closeAddModel();
            });
          }}
          onNameChange={setModelName}
        />
      )}

      <section className="settings-panel">
        <div className="panel-heading">
          <div>
            <h2>Character library</h2>
            <p>
              Pick a model to preview it. The default is the one Persona
              wears when it starts.
            </p>
          </div>
          <div className="panel-actions">
            <button
              className="btn btn-secondary"
              disabled={busy || !bridge}
              onClick={() => setAddingModel(true)}
              type="button"
            >
              Add model
            </button>
          </div>
        </div>

        {settings.models.length === 0 ? (
          <div className="empty-library">
            <strong>No model configured</strong>
            <p>
              Add a VRM file to get started. Persona stays inactive until a
              model is available and selected as the default.
            </p>
          </div>
        ) : (
          <div className="rows" role="radiogroup" aria-label="Character library">
            {settings.models.map((model) => {
              const selected = model.id === selectedModel?.id;
              const isDefault = model.id === settings.default_model_id;
              const actionable = !isDefault || model.removable;
              return (
                <div
                  className={`row-wrap ${actionable ? 'row-wrap-actionable' : ''}`}
                  key={model.id}
                >
                  <button
                    aria-checked={selected}
                    className="row row-selectable"
                    onClick={() => setSelectedModelId(model.id)}
                    role="radio"
                    type="button"
                  >
                    <span className="row-mark">VRM</span>
                    <span className="row-copy">
                      <strong>{model.model_name}</strong>
                      <small>
                        {model.origin === 'packaged'
                          ? 'Packaged with Persona'
                          : model.origin === 'hub'
                            ? 'From VRoid Hub'
                            : 'Added by you'}
                      </small>
                    </span>
                    <span className="row-trailing">
                      {isDefault && <span className="chip chip-accent">Default</span>}
                    </span>
                  </button>
                  {actionable && (
                  <div className="row-actions row-actions-overlay">
                    {!isDefault && (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy || !bridge}
                        onClick={() => void setDefaultModel(model.id)}
                        type="button"
                      >
                        Set default
                      </button>
                    )}
                    {model.removable && (
                      <button
                        aria-label={`Delete ${model.model_name}`}
                        className="btn btn-danger btn-icon"
                        disabled={busy || !bridge}
                        onClick={() => void deleteModel(model)}
                        title={`Delete ${model.model_name}`}
                        type="button"
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="settings-panel">
        <div className="panel-heading">
          <div>
            <h2>VRoid Hub</h2>
            <p>
              Use a character that&rsquo;s only available through
              your VRoid Hub account, without downloading it
              yourself.
            </p>
          </div>
          <div className="panel-actions">
            {vroidStatus?.connected && (
              <>
                <span className="chip chip-success">Connected</span>
                <button
                  className="btn btn-secondary"
                  disabled={busy || vroidLoading}
                  onClick={() => void refreshVroidCharacters()}
                  type="button"
                >
                  <RefreshIcon />
                  {vroidLoading ? 'Refreshing…' : 'Refresh'}
                </button>
                <button
                  className="btn btn-secondary btn-danger-text"
                  disabled={busy}
                  onClick={disconnectVroidHub}
                  type="button"
                >
                  Disconnect
                </button>
              </>
            )}
            {vroidHubBridge &&
              vroidStatus?.configured &&
              !vroidStatus.connected && (
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void connectVroidHub()}
                  type="button"
                >
                  Connect account
                </button>
              )}
          </div>
        </div>
        {!vroidHubBridge && (
          <p className="desktop-note">
            VRoid Hub sign-in is available in the Persona desktop
            app.
          </p>
        )}
        {vroidHubBridge && (
          <details
            className="settings-disclosure"
            open={vroidStatus != null && !vroidStatus.configured}
          >
            <summary>
              Advanced: connect your own VRoid Hub OAuth app
            </summary>
            <div className="settings-disclosure-body">
              <p className="desktop-note">
                Register your own OAuth app at{' '}
                <code>hub.vroid.com/oauth/applications</code>, set
                its redirect URI to the value below, then paste the
                app&rsquo;s client ID and secret here.
              </p>
              <div className="code-row">
                <div>
                  <span>Redirect URI to register</span>
                  <code>{vroidStatus?.redirect_uri ?? '—'}</code>
                </div>
                <button
                  className="btn btn-secondary"
                  disabled={!vroidStatus}
                  onClick={() =>
                    vroidStatus &&
                    void copyText(
                      vroidStatus.redirect_uri,
                      'Redirect URI',
                    )
                  }
                  type="button"
                >
                  Copy
                </button>
              </div>
              <div className="form-stack">
                <label>
                  Client ID
                  <input
                    onChange={(event) =>
                      setVroidClientIdInput(event.target.value)
                    }
                    placeholder="OAuth app client ID"
                    value={vroidClientIdInput}
                  />
                </label>
                <label>
                  Client secret
                  <input
                    onChange={(event) =>
                      setVroidClientSecretInput(event.target.value)
                    }
                    placeholder={
                      vroidCredentials?.hasClientSecret
                        ? 'Saved — enter a new value to replace it'
                        : 'OAuth app client secret'
                    }
                    type="password"
                    value={vroidClientSecretInput}
                  />
                </label>
              </div>
              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  disabled={
                    vroidCredentialsSaving ||
                    !vroidClientIdInput.trim() ||
                    !vroidClientSecretInput.trim()
                  }
                  onClick={() => void saveVroidCredentials()}
                  type="button"
                >
                  {vroidCredentialsSaving
                    ? 'Saving…'
                    : 'Save credentials'}
                </button>
                {vroidStatus?.configured && (
                  <button
                    className="btn btn-secondary btn-danger-text"
                    disabled={busy}
                    onClick={clearVroidCredentials}
                    type="button"
                  >
                    Remove credentials
                  </button>
                )}
              </div>
            </div>
          </details>
        )}
        {vroidHubBridge && vroidStatus?.connected && (
          <>
            {vroidLoading && <p>Loading your characters…</p>}
            {/* Neither branch below is gated on !vroidLoading: a
                refresh returns what's already on screen, so leaving it
                up avoids collapsing the panel under the user. */}
            {vroidCharacters?.length === 0 && (
              <div className="empty-library">
                <strong>No characters available yet</strong>
                <p>
                  Upload a model to VRoid Hub, or heart one that its
                  creator marked available to other users, then
                  refresh.
                </p>
              </div>
            )}
            {(vroidCharacters?.length ?? 0) > 0 && (
              <>
                <VroidCharacterGroup
                  busy={busy}
                  characters={ownVroidCharacters}
                  emptyNote="You haven’t uploaded any models to VRoid Hub yet."
                  onSelect={selectVroidCharacter}
                  portraitEpoch={vroidPortraitEpoch}
                  title="Your models"
                />
                <VroidCharacterGroup
                  busy={busy}
                  characters={heartedVroidCharacters}
                  emptyNote="Heart a model another creator marked available to other users and it shows up here."
                  note="These belong to other creators. Persona asks you to confirm a model’s conditions of use before it downloads one."
                  onSelect={selectVroidCharacter}
                  portraitEpoch={vroidPortraitEpoch}
                  title="Hearted models"
                />
              </>
            )}
          </>
        )}
      </section>
    </>
  );
}
