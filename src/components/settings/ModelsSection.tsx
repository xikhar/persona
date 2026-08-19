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
  importModel: () => Promise<void>;
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
  return (
    <>
      <section className="settings-panel">
        <div className="panel-heading">
          <div>
            <h2>Model library</h2>
            <p>Select a model to inspect it in the preview.</p>
          </div>
        </div>
        <div className="asset-grid">
          {settings.models.length === 0 && (
            <div className="empty-library">
              <strong>No model configured</strong>
              <p>
                Add a VRM file below. Persona stays inactive until a
                model is available and selected as the default.
              </p>
            </div>
          )}
          {settings.models.map((model) => {
            const selected = model.id === selectedModel?.id;
            const isDefault = model.id === settings.default_model_id;
            return (
              <article
                className={`asset-card ${selected ? 'selected' : ''}`}
                key={model.id}
              >
                <button
                  className="asset-card-main"
                  onClick={() => setSelectedModelId(model.id)}
                  type="button"
                >
                  <span className="asset-icon">VRM</span>
                  <span>
                    <strong>{model.model_name}</strong>
                    <small>
                      {model.origin === 'packaged'
                        ? 'Packaged model'
                        : model.origin === 'hub'
                          ? 'From VRoid Hub'
                          : 'User model'}
                    </small>
                  </span>
                </button>
                <div className="asset-card-footer">
                  {isDefault ? (
                    <span className="default-badge">Default</span>
                  ) : (
                    <button
                      disabled={busy || !bridge}
                      onClick={() => void setDefaultModel(model.id)}
                      type="button"
                    >
                      Make default
                    </button>
                  )}
                  <div className="asset-card-actions">
                    <button
                      onClick={() => setSelectedModelId(model.id)}
                      type="button"
                    >
                      Preview
                    </button>
                    {model.removable && (
                      <button
                        className="danger-text-button"
                        disabled={busy || !bridge}
                        onClick={() => void deleteModel(model)}
                        type="button"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="settings-panel import-panel">
        <div className="panel-heading">
          <div>
            <h2>Add a custom model</h2>
            <p>Persona copies the selected VRM into your local library.</p>
          </div>
          <span className="file-pill">.vrm</span>
        </div>
        <label>
          Model name <code>model_name</code>
          <input
            maxLength={80}
            onChange={(event) => setModelName(event.target.value)}
            placeholder="e.g. Studio Assistant"
            value={modelName}
          />
        </label>
        <button
          className="primary-button"
          disabled={busy || !bridge || !modelName.trim()}
          onClick={() => void importModel()}
          type="button"
        >
          Choose VRM file
        </button>
        {!bridge && (
          <p className="desktop-note">
            File import is available in the Persona desktop app.
          </p>
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
          {vroidStatus?.connected && (
            <span className="default-badge">Connected</span>
          )}
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
              <div className="mcp-copy-field">
                <div>
                  <span>Redirect URI to register</span>
                  <code>{vroidStatus?.redirect_uri ?? '—'}</code>
                </div>
                <button
                  className="secondary-button"
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
                  className="primary-button"
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
                    className="secondary-button danger-text-button"
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
        {vroidHubBridge && vroidStatus?.configured && !vroidStatus.connected && (
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void connectVroidHub()}
            type="button"
          >
            Connect VRoid Hub account
          </button>
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
            <div className="form-actions">
              <button
                className="secondary-button"
                disabled={busy || vroidLoading}
                onClick={() => void refreshVroidCharacters()}
                type="button"
              >
                Refresh list
              </button>
              <button
                className="secondary-button danger-text-button"
                disabled={busy}
                onClick={disconnectVroidHub}
                type="button"
              >
                Disconnect
              </button>
            </div>
          </>
        )}
      </section>
    </>
  );
}
