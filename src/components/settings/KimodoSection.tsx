import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../settings-errors';
import { ActionFormDialog } from './ActionFormDialog';
import { AutomaticIcon, DownloadIcon, GitHubIcon, PlayIcon, PlusIcon, RefreshIcon, TrashIcon } from './icons';
import { SettingsDialog } from './SettingsDialog';

const DEFAULT_CONFIG: PersonaAnimationGeneratorConfig = {
  enabled: false,
  server_url: 'http://127.0.0.1:8090',
  model: 'soma-rp-v1.1',
  mcp_enabled: false,
};

const TERMINAL_PHASES = new Set(['ready', 'failed', 'interrupted']);

function phaseLabel(job: PersonaAnimationGenerationJob): string {
  switch (job.phase) {
    case 'queued': return 'Queued';
    case 'submitting': return 'Submitting to Kimodo';
    case 'generating': return 'Generating motion';
    case 'downloading': return 'Downloading GLB';
    case 'converting': return 'Converting to VRMA';
    case 'installing': return 'Saving to clip library';
    case 'ready': return 'Ready';
    case 'failed': return 'Generation failed';
    case 'interrupted': return 'Interrupted';
  }
}

function actionNameForClip(
  clip: PersonaAnimationLibraryClip,
  actions: readonly PersonaAnimationSettings[],
): string {
  const taken = new Set(actions.map((action) => action.animation_name));
  if (!taken.has(clip.clip_name)) return clip.clip_name;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${clip.clip_name.slice(0, 48 - suffix.length).replace(/-$/u, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return 'generated-motion';
}

export function KimodoSection({
  availableExpressions,
  bridge,
  busy,
  createActionWithClip,
  deleteClip,
  notify,
  previewClip,
  settings,
}: {
  availableExpressions: readonly string[];
  bridge: Window['personaSettings'];
  busy: boolean;
  createActionWithClip: (metadata: CustomAnimationMetadata, clipId: string) => Promise<boolean>;
  deleteClip: (clip: PersonaAnimationLibraryClip) => void;
  notify: (message: string) => void;
  previewClip: (clip: PersonaAnimationLibraryClip) => void;
  settings: PersonaSettingsSnapshot;
}) {
  const [status, setStatus] = useState<PersonaAnimationGeneratorStatus | null>(null);
  const [config, setConfig] = useState<PersonaAnimationGeneratorConfig>(DEFAULT_CONFIG);
  const [jobs, setJobs] = useState<PersonaAnimationGenerationJob[]>([]);
  const [prompt, setPrompt] = useState('');
  const [clipName, setClipName] = useState('');
  const [frames, setFrames] = useState('150');
  const [steps, setSteps] = useState('50');
  const [seed, setSeed] = useState('0');
  const [working, setWorking] = useState(false);
  const [clearingJobs, setClearingJobs] = useState(false);
  const [jobActionId, setJobActionId] = useState<string | null>(null);
  const [exportingClipId, setExportingClipId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [generationProblem, setGenerationProblem] = useState<string | null>(null);
  const [jobsProblem, setJobsProblem] = useState<string | null>(null);
  const [generationOpen, setGenerationOpen] = useState(false);
  const [actionClip, setActionClip] = useState<PersonaAnimationLibraryClip | null>(null);
  const [actionMetadata, setActionMetadata] = useState<CustomAnimationMetadata>({
    animation_name: '',
    animation_description: '',
    animation_trigger_scenario: '',
    expression_name: null,
    expression_weight: 1,
  });

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void Promise.all([
      bridge.getAnimationGeneratorStatus(),
      bridge.listAnimationGenerations(),
    ]).then(([nextStatus, nextJobs]) => {
      if (!active) return;
      setStatus(nextStatus);
      setConfig(nextStatus.config);
      setJobs(nextJobs);
      if (nextStatus.config.enabled) {
        void bridge.checkAnimationGenerator().then((checked) => {
          if (!active) return;
          setStatus(checked);
          if (checked.error) notify(`Kimodo connection failed: ${checked.error}`);
        }).catch((error: unknown) => {
          if (active) notify(`Kimodo connection failed: ${errorMessage(error)}`);
        });
      }
    }).catch((error: unknown) => {
      if (active) notify(`Kimodo connection failed: ${errorMessage(error)}`);
    });
    const unsubscribe = bridge.subscribeAnimationGenerations((job) => {
      setJobs((current) => [job, ...current.filter((candidate) => candidate.id !== job.id)]);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge, notify]);

  const generatedClips = useMemo(
    () => settings.animation_clips.filter((clip) => clip.source === 'kimodo'),
    [settings.animation_clips],
  );
  const activeJob = useMemo(
    () => jobs.find((job) => !TERMINAL_PHASES.has(job.phase)) ?? null,
    [jobs],
  );
  const configSaved = status != null &&
    status.config.enabled === config.enabled &&
    status.config.server_url === config.server_url &&
    status.config.model === config.model &&
    status.config.mcp_enabled === config.mcp_enabled;
  const numericOptionsValid = [
    [frames, 60, 150],
    [steps, 1, 1000],
    [seed, 0, Number.MAX_SAFE_INTEGER],
  ].every(([value, minimum, maximum]) => {
    const number = Number(value);
    return value !== '' && Number.isSafeInteger(number) && number >= Number(minimum) && number <= Number(maximum);
  });

  const saveConfig = async () => {
    if (!bridge) return;
    setChecking(true);
    try {
      const next = await bridge.setAnimationGeneratorConfig(config);
      setStatus(next);
      setConfig(next.config);
      if (next.error) notify(`Kimodo connection failed: ${next.error}`);
    } catch (error) {
      notify(`Kimodo connection failed: ${errorMessage(error)}`);
    } finally {
      setChecking(false);
    }
  };

  const checkServer = async () => {
    if (!bridge) return;
    setChecking(true);
    try {
      const next = await bridge.checkAnimationGenerator();
      setStatus(next);
      if (next.error) notify(`Kimodo connection failed: ${next.error}`);
    } catch (error) {
      notify(`Kimodo connection failed: ${errorMessage(error)}`);
    } finally {
      setChecking(false);
    }
  };

  const openRepository = () => {
    if (!bridge) return;
    void bridge.openKimodoRepository().catch((error: unknown) => {
      notify(`Could not open kimodo.cpp: ${errorMessage(error)}`);
    });
  };

  const downloadClip = async (clip: PersonaAnimationLibraryClip) => {
    if (!bridge || exportingClipId) return;
    setExportingClipId(clip.id);
    try {
      const saved = await bridge.exportAnimationLibraryClip(clip.id);
      if (saved) notify(`${clip.clip_name}.vrma saved.`);
    } catch (error) {
      notify(`Could not download ${clip.clip_name}: ${errorMessage(error)}`);
    } finally {
      setExportingClipId(null);
    }
  };

  const generate = async (): Promise<boolean> => {
    if (!bridge || !prompt.trim()) return false;
    setWorking(true);
    setGenerationProblem(null);
    try {
      const job = await bridge.generateAnimation({
        prompt,
        ...(clipName.trim() ? { clip_name: clipName.trim() } : {}),
        frames: Number(frames),
        steps: Number(steps),
        seed: Number(seed),
      });
      setJobs((current) => [job, ...current.filter((candidate) => candidate.id !== job.id)]);
      setPrompt('');
      setClipName('');
      return true;
    } catch (error) {
      setGenerationProblem(errorMessage(error));
      return false;
    } finally {
      setWorking(false);
    }
  };

  const clearJobs = async () => {
    if (!bridge || activeJob) return;
    setClearingJobs(true);
    setJobsProblem(null);
    try {
      setJobs(await bridge.clearAnimationGenerations());
    } catch (error) {
      setJobsProblem(errorMessage(error));
    } finally {
      setClearingJobs(false);
    }
  };

  const retryJob = async (job: PersonaAnimationGenerationJob) => {
    if (!bridge || activeJob || jobActionId) return;
    setJobActionId(job.id);
    setJobsProblem(null);
    try {
      const retried = await bridge.retryAnimationGeneration(job.id);
      setJobs((current) => [retried, ...current.filter((candidate) => candidate.id !== retried.id)]);
    } catch (error) {
      setJobsProblem(errorMessage(error));
    } finally {
      setJobActionId(null);
    }
  };

  const discardJob = async (job: PersonaAnimationGenerationJob) => {
    if (!bridge || activeJob || jobActionId) return;
    setJobActionId(job.id);
    setJobsProblem(null);
    try {
      setJobs(await bridge.discardAnimationGeneration(job.id));
    } catch (error) {
      setJobsProblem(errorMessage(error));
    } finally {
      setJobActionId(null);
    }
  };

  const beginAction = (clip: PersonaAnimationLibraryClip) => {
    const description = `AI-generated motion: ${clip.prompt ?? clip.clip_name}`.slice(0, 240);
    const trigger = `Use when the user asks for: ${clip.prompt ?? clip.clip_name}`.slice(0, 240);
    setActionMetadata({
      animation_name: actionNameForClip(clip, settings.animations),
      animation_description: description,
      animation_trigger_scenario: trigger,
      expression_name: null,
      expression_weight: 1,
    });
    setActionClip(clip);
  };

  return (
    <>
      {actionClip && (
        <ActionFormDialog
          availableExpressions={availableExpressions}
          busy={busy}
          metadata={actionMetadata}
          mode="create"
          onCancel={() => setActionClip(null)}
          onChange={setActionMetadata}
          onSubmit={() => {
            void createActionWithClip(actionMetadata, actionClip.id).then((created) => {
              if (created) setActionClip(null);
            });
          }}
        />
      )}

      {generationOpen && (
        <SettingsDialog
          busy={working}
          eyebrow="Kimodo"
          footer={
            <>
              <button
                className="btn btn-secondary"
                disabled={working}
                onClick={() => setGenerationOpen(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={!bridge || working || !configSaved || status?.health !== 'ready' || !prompt.trim() || !numericOptionsValid || activeJob != null}
                onClick={() => {
                  void generate().then((started) => {
                    if (started) setGenerationOpen(false);
                  });
                }}
                type="button"
              >
                {working ? 'Starting…' : activeJob ? 'Generation in progress' : 'Generate clip'}
              </button>
            </>
          }
          onClose={() => setGenerationOpen(false)}
          title="Generate a new clip"
          wide
        >
          <p className="dialog-lede">
            Describe only the body motion. The resulting VRMA is saved as a
            reusable clip and can be added to any action afterwards.
          </p>
        <div className="fields generator-prompt-fields">
          <div className="field">
            <label className="field-label" htmlFor="animation-generation-prompt">Motion prompt</label>
            <textarea data-dialog-autofocus id="animation-generation-prompt" maxLength={4096} onChange={(event) => setPrompt(event.target.value)} placeholder="A cheerful two-handed wave, facing forward, then return to a relaxed stance." rows={4} value={prompt} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="generated-clip-name">Clip title <span className="chip">Optional</span></label>
            <input id="generated-clip-name" maxLength={64} onChange={(event) => setClipName(event.target.value)} placeholder="Derived from the prompt" value={clipName} />
          </div>
          <details className="generator-details">
            <summary>Generation options</summary>
            <div className="field-row">
              <div className="field"><label className="field-label" htmlFor="generated-frames">Frames</label><input id="generated-frames" max={150} min={60} onChange={(event) => setFrames(event.target.value)} type="number" value={frames} /></div>
              <div className="field"><label className="field-label" htmlFor="generated-steps">Steps</label><input id="generated-steps" max={1000} min={1} onChange={(event) => setSteps(event.target.value)} type="number" value={steps} /></div>
              <div className="field"><label className="field-label" htmlFor="generated-seed">Seed</label><input id="generated-seed" min={0} onChange={(event) => setSeed(event.target.value)} type="number" value={seed} /></div>
            </div>
          </details>
          <p className="generator-dialog-status">
            {activeJob
              ? `${phaseLabel(activeJob)}…`
              : configSaved && status?.health === 'ready'
                ? 'Kimodo is ready. One local generation job runs at a time.'
                : 'Save and check the connection below before generating.'}
          </p>
          {generationProblem && <p className="generator-error" role="alert">{generationProblem}</p>}
        </div>
        </SettingsDialog>
      )}

      <section className="settings-panel kimodo-library">
        <div className="panel-heading">
          <div><h2>Kimodo clips</h2><p>Generated clips stay independent, ready to preview or reuse in any animation action.</p></div>
          <div className="panel-actions">
            <button
              aria-label="Open kimodo.cpp on GitHub"
              className="btn btn-ghost btn-icon"
              disabled={!bridge}
              onClick={openRepository}
              title="Open kimodo.cpp on GitHub"
              type="button"
            >
              <GitHubIcon />
            </button>
            <span className="chip">{generatedClips.length} saved</span>
            <button
              className="btn btn-primary"
              disabled={!bridge}
              onClick={() => {
                setGenerationProblem(null);
                setGenerationOpen(true);
              }}
              type="button"
            >
              <AutomaticIcon /> Generate clip
            </button>
          </div>
        </div>
        {generatedClips.length === 0 ? (
          <div className="empty-library"><strong>No Kimodo clips yet</strong><p>Generate your first motion clip. It will be saved here without creating an action automatically.</p></div>
        ) : (
          <div className="clip-library-grid">
            {generatedClips.map((clip) => (
              <article className="clip-library-card" key={clip.id}>
                <div className="clip-library-head">
                  <div className="clip-library-title"><strong>{clip.clip_name}</strong><small>{new Date(clip.created_at).toLocaleString()}</small></div>
                  <div className="clip-library-tools">
                    <button
                      aria-label={`Download ${clip.clip_name}`}
                      className="btn btn-ghost btn-icon clip-download-button"
                      disabled={busy || !bridge || exportingClipId != null}
                      onClick={() => void downloadClip(clip)}
                      title="Download VRMA"
                      type="button"
                    >
                      <DownloadIcon />
                    </button>
                    <button aria-label={`Delete ${clip.clip_name}`} className="btn btn-danger btn-icon" disabled={busy || !bridge} onClick={() => deleteClip(clip)} title="Delete clip file" type="button"><TrashIcon /></button>
                  </div>
                </div>
                {clip.prompt && <p>{clip.prompt}</p>}
                <div className="clip-link-status">
                  {clip.linked_action_ids.length === 0 ? 'Not used by an action' : `Used by ${clip.linked_action_ids.length} action${clip.linked_action_ids.length === 1 ? '' : 's'}`}
                </div>
                <div className="clip-library-actions">
                  <button className="btn btn-secondary btn-sm" onClick={() => previewClip(clip)} type="button"><PlayIcon /> Preview</button>
                  <button className="btn btn-ghost btn-sm" disabled={busy || !bridge} onClick={() => beginAction(clip)} type="button"><PlusIcon /> New action</button>
                </div>
              </article>
            ))}
          </div>
        )}

        {jobs.length > 0 && (
          <div className="generator-jobs" aria-live="polite">
            <div className="subhead">
              <span>Recent jobs <span className="chip">{jobs.length}</span></span>
              <button
                className="btn btn-ghost btn-sm"
                disabled={!bridge || clearingJobs || activeJob != null}
                onClick={() => void clearJobs()}
                title="Clear job history without deleting saved clips"
                type="button"
              >
                {clearingJobs ? 'Clearing…' : 'Clear recent jobs'}
              </button>
            </div>
            {jobs.slice(0, 5).map((job) => (
              <article className="generator-job" key={job.id}>
                <div><strong>{job.clip_name}</strong><small>{phaseLabel(job)}{job.attempt > 1 ? ` · Attempt ${job.attempt}` : ''} · {new Date(job.updated_at).toLocaleString()}</small>{job.error && <small className="generator-error">{job.error}</small>}</div>
                <div className="generator-job-actions">
                  {(job.phase === 'failed' || job.phase === 'interrupted') && (
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={!bridge || !configSaved || !config.enabled || activeJob != null || jobActionId != null}
                      onClick={() => void retryJob(job)}
                      title="Resume from the last safe stage when possible"
                      type="button"
                    >
                      <RefreshIcon /> {jobActionId === job.id ? 'Retrying…' : 'Retry'}
                    </button>
                  )}
                  {TERMINAL_PHASES.has(job.phase) && (
                    <button
                      aria-label={`Discard ${job.clip_name} job`}
                      className="btn btn-ghost btn-icon"
                      disabled={!bridge || activeJob != null || jobActionId != null}
                      onClick={() => void discardJob(job)}
                      title="Discard job history and retained recovery files"
                      type="button"
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              </article>
            ))}
            {jobsProblem && <p className="generator-error" role="alert">{jobsProblem}</p>}
          </div>
        )}
      </section>

      <section className="settings-panel kimodo-config">
        <div className="panel-heading">
          <div><h2>Connection</h2><p>Connect Persona to a compatible Kimodo endpoint on this device.</p></div>
          <span className={`chip ${configSaved && status?.health === 'ready' ? 'chip-success' : status?.health === 'unavailable' ? 'chip-danger' : ''}`}>
            {!configSaved ? 'Unsaved settings' : status?.health === 'ready' ? 'Ready' : status?.health === 'unavailable' ? 'Unavailable' : 'Disabled'}
          </span>
        </div>
        <div className="fields generator-config-body">
          <div className="field-row">
            <div className="field">
              <label className="field-label" htmlFor="kimodo-server-url">Server URL</label>
              <input id="kimodo-server-url" onChange={(event) => setConfig((current) => ({ ...current, server_url: event.target.value }))} value={config.server_url} />
            </div>
            <div className="field generator-model-field">
              <label className="field-label" htmlFor="kimodo-model">Model</label>
              <input id="kimodo-model" readOnly value={config.model} />
            </div>
          </div>
          <div className="generator-toggle-row">
            <span><strong>Enable local generation</strong><small>Allows this page to submit jobs to Kimodo.</small></span>
            <button aria-checked={config.enabled} className={`toggle-switch${config.enabled ? ' active' : ''}`} onClick={() => setConfig((current) => ({ ...current, enabled: !current.enabled }))} role="switch" type="button" />
          </div>
          <div className="generator-toggle-row">
            <span><strong>Allow MCP clip and action changes</strong><small>Lets connected agents generate clips and configure their action links when you ask.</small></span>
            <button aria-checked={config.mcp_enabled} className={`toggle-switch${config.mcp_enabled ? ' active' : ''}`} onClick={() => setConfig((current) => ({ ...current, mcp_enabled: !current.mcp_enabled }))} role="switch" type="button" />
          </div>
          <div className="generator-config-actions">
            <button className="btn btn-secondary btn-sm" disabled={!bridge || checking || working} onClick={() => void saveConfig()} type="button">{checking ? 'Checking…' : 'Save and check'}</button>
            <button className="btn btn-ghost btn-sm" disabled={!bridge || checking || working || !status?.config.enabled} onClick={() => void checkServer()} type="button">Check again</button>
          </div>
        </div>
      </section>
    </>
  );
}
