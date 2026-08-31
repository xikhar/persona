import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAnimationGenerator } from './animation-generator.cjs';
import { SOMA30_OFFSETS, SOMA30_PARENTS } from './kimodo-vrma.cjs';
import type { SettingsSnapshot } from './settings-store.cjs';
import type { PersonaAnimationGenerationJob } from '../shared/persona-api.js';

function emptySnapshot(): SettingsSnapshot {
  return {
    schema_version: 10,
    default_model_id: null,
    character_size: 1,
    avatar_window: { width: 430, height: 680 },
    click_through_enabled: false,
    look_at_cursor: true,
    developer_settings_enabled: false,
    vroid_hub_allow_plaintext_storage: false,
    body_transition_ms: 700,
    speaking_debounce_ms: 350,
    idle_interim_ms: 350,
    speaking_transition: { entry_ms: [810, 945], exit_ms: [630, 855] },
    packaged_animation_change_count: 0,
    models: [],
    animations: [],
    animation_clips: [],
    model_lighting: {},
    voice_source: { mode: 'default', process_pattern: null, source_id: null, source_name: null },
  };
}

function compatibleModel() {
  return {
    id: 'soma-rp-v1.1',
    label: 'SOMA',
    skeleton_key: 'soma30',
    available: true,
    license: 'NVIDIA Open Model License',
    license_url: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/',
    commercial: true,
    parents: SOMA30_PARENTS,
    offsets: SOMA30_OFFSETS,
  };
}

test('runs a Kimodo HTTP job asynchronously, installs one clip, and persists private status', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-kimodo-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let galleryReads = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/api/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([compatibleModel()]));
      return;
    }
    if (request.url === '/api/generate' && request.method === 'POST') {
      response.statusCode = 202;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'remote-1', status: 'queued' }));
      return;
    }
    if (request.url === '/api/animations') {
      galleryReads += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([{ id: 'remote-1', status: galleryReads > 1 ? 'ready' : 'running' }]));
      return;
    }
    if (request.url === '/api/animations/remote-1/animation.glb') {
      response.setHeader('content-type', 'model/gltf-binary');
      response.end('kimodo-source');
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no port.');

  let snapshot = emptySnapshot();
  let installedText = '';
  let coreValidated = false;
  let resolveTerminal: (job: PersonaAnimationGenerationJob) => void = () => {};
  const terminal = new Promise<PersonaAnimationGenerationJob>((resolve) => {
    resolveTerminal = resolve;
  });
  const service = createAnimationGenerator(directory, {
    assertCanAddGeneratedClip() {},
    addGeneratedClip(
      filePath: string,
      metadata: { clip_name: string; prompt: string; generation_job_id: string },
    ) {
      assert.equal(coreValidated, true);
      installedText = fs.readFileSync(filePath, 'utf8');
      snapshot = {
        ...snapshot,
        animation_clips: [{
          id: 'clip-1',
          clip_name: metadata.clip_name,
          source: 'kimodo',
          asset_url: 'persona-asset://animation/clip-1.vrma',
          created_at: '2026-08-31T00:00:00.000Z',
          prompt: metadata.prompt,
          generation_job_id: metadata.generation_job_id,
          linked_action_ids: [],
        }],
      };
      return snapshot;
    },
    findGeneratedClip(jobId: string) {
      const clip = snapshot.animation_clips.find(
        (candidate) => candidate.generation_job_id === jobId,
      );
      return clip ? { id: clip.id, clip_name: clip.clip_name } : null;
    },
    publishSettings(next: SettingsSnapshot) { snapshot = next; },
    onJobUpdated(job: PersonaAnimationGenerationJob) {
      if (job.phase === 'ready' || job.phase === 'failed') resolveTerminal(job);
    },
    sleep: async () => {},
    convert(source: Buffer) {
      assert.equal(source.toString(), 'kimodo-source');
      return Buffer.from('valid-vrma');
    },
    validate(vrma) { assert.equal(vrma.toString(), 'valid-vrma'); },
    async validateCore(vrma) {
      assert.equal(vrma.toString(), 'valid-vrma');
      coreValidated = true;
    },
  });
  context.after(() => service.close());
  void service.setConfig({ enabled: true, server_url: `http://127.0.0.1:${address.port}`, model: 'soma-rp-v1.1', mcp_enabled: false }).then(() => {
    const started = service.start({ prompt: 'A cheerful two-handed wave' }, 'settings');
    assert.equal(started.phase, 'queued');
    assert.equal(started.steps, 50);
    assert.equal(started.frames, 150);
  });

  const finished = await terminal;
  assert.equal(finished.phase, 'ready');
  assert.equal(finished.clip_id, 'clip-1');
  assert.equal(installedText, 'valid-vrma');
  assert.equal(snapshot.animation_clips[0]?.clip_name, 'a-cheerful-two-handed-wave');
  assert.deepEqual(snapshot.animations, []);
  const statePath = path.join(directory, 'animation-generator.json');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  }
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { jobs: PersonaAnimationGenerationJob[] };
  assert.equal(persisted.jobs[0]?.phase, 'ready');

  assert.deepEqual(service.clearJobs(), []);
  assert.equal(snapshot.animation_clips[0]?.id, 'clip-1');
  const cleared = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    jobs: PersonaAnimationGenerationJob[];
  };
  assert.deepEqual(cleared.jobs, []);
});

test('requires explicit MCP generation opt-in and loopback-only configuration', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-kimodo-policy-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshot = emptySnapshot();
  const service = createAnimationGenerator(directory, {
    assertCanAddGeneratedClip() {},
    addGeneratedClip: () => snapshot,
    findGeneratedClip: () => null,
    publishSettings: () => {},
    onJobUpdated: () => {},
  });
  context.after(() => service.close());
  await assert.rejects(
    service.setConfig({ enabled: true, server_url: 'https://example.com', model: 'soma-rp-v1.1', mcp_enabled: true }),
    /loopback URL/,
  );
  await service.setConfig({ enabled: true, server_url: 'http://127.0.0.1:1', model: 'soma-rp-v1.1', mcp_enabled: false });
  assert.throws(
    () => service.start({ prompt: 'Wave' }, 'mcp'),
    /Agent animation generation is disabled/,
  );
});

test('rejects an unexpected successful submission status as incompatible', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-kimodo-status-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshot = emptySnapshot();
  let resolveTerminal: (job: PersonaAnimationGenerationJob) => void = () => {};
  const terminal = new Promise<PersonaAnimationGenerationJob>((resolve) => {
    resolveTerminal = resolve;
  });
  const service = createAnimationGenerator(directory, {
    assertCanAddGeneratedClip() {},
    addGeneratedClip: () => snapshot,
    findGeneratedClip: () => null,
    publishSettings: () => {},
    onJobUpdated(job) {
      if (job.phase === 'failed') resolveTerminal(job);
    },
    fetch: async (input) => String(input).endsWith('/api/models')
      ? new Response(JSON.stringify([compatibleModel()]))
      : new Response(JSON.stringify({ id: 'unexpected-status' }), { status: 200 }),
  });
  context.after(() => service.close());
  await service.setConfig({
    enabled: true,
    server_url: 'http://127.0.0.1:8090',
    model: 'soma-rp-v1.1',
    mcp_enabled: false,
  });

  service.start({ prompt: 'Do not accept a changed protocol' }, 'settings');
  const failed = await terminal;
  assert.equal(failed.error_code, 'GENERATOR_INCOMPATIBLE');
  assert.match(failed.error ?? '', /HTTP 200 where 202 was required/u);
});

test('optional generator startup survives state-write failure and cleans orphan artifacts', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-kimodo-startup-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const orphanId = '123e4567-e89b-42d3-a456-426614174099';
  const orphanDirectory = path.join(directory, 'animation-generation', orphanId);
  fs.mkdirSync(orphanDirectory, { recursive: true });
  fs.writeFileSync(path.join(orphanDirectory, 'source.glb'), 'orphan');

  const originalRenameSync = fs.renameSync;
  fs.renameSync = ((oldPath, newPath) => {
    if (path.resolve(String(newPath)) === path.join(directory, 'animation-generator.json')) {
      throw new Error(`simulated failure at ${newPath}`);
    }
    return originalRenameSync(oldPath, newPath);
  }) as typeof fs.renameSync;
  let service: ReturnType<typeof createAnimationGenerator> | null = null;
  try {
    service = createAnimationGenerator(directory, {
      assertCanAddGeneratedClip() {},
      addGeneratedClip: () => emptySnapshot(),
      findGeneratedClip: () => null,
      publishSettings: () => {},
      onJobUpdated: () => {},
    });
  } finally {
    fs.renameSync = originalRenameSync;
  }
  context.after(() => service?.close());
  assert.deepEqual(service?.listJobs(), []);
  assert.equal(fs.existsSync(orphanDirectory), false);
});

test('changing providers clears recoverable remote ids but keeps local artifacts', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-kimodo-provider-change-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const jobId = '123e4567-e89b-42d3-a456-426614174088';
  const sourcePath = path.join(directory, 'animation-generation', jobId, 'source.glb');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, 'retained-source');
  fs.writeFileSync(path.join(directory, 'animation-generator.json'), JSON.stringify({
    schema_version: 3,
    config: {
      enabled: true,
      server_url: 'http://127.0.0.1:8090',
      model: 'soma-rp-v1.1',
      mcp_enabled: false,
    },
    jobs: [{
      id: jobId,
      action_id: null,
      action_name: null,
      clip_id: null,
      clip_name: 'provider-change',
      prompt: 'Keep the local source',
      phase: 'failed',
      error: 'old provider error',
      error_code: 'GENERATOR_OFFLINE',
      failure_phase: 'generating',
      attempt: 1,
      provider_animation_id: 'old-provider-id',
      frames: 90,
      steps: 25,
      seed: 2,
      model: 'soma-rp-v1.1',
      model_license: 'NVIDIA Open Model License',
      source_sha256: null,
      vrma_sha256: null,
      converter_version: 'persona-soma30-v2',
      created_at: '2026-09-02T00:00:00.000Z',
      updated_at: '2026-09-02T00:00:01.000Z',
    }],
  }));
  const service = createAnimationGenerator(directory, {
    assertCanAddGeneratedClip() {},
    addGeneratedClip: () => emptySnapshot(),
    findGeneratedClip: () => null,
    publishSettings: () => {},
    onJobUpdated: () => {},
    fetch: async () => new Response(JSON.stringify([compatibleModel()])),
  });
  context.after(() => service.close());

  await service.setConfig({
    enabled: true,
    server_url: 'http://127.0.0.1:8091',
    model: 'soma-rp-v1.1',
    mcp_enabled: false,
  });
  assert.equal(service.getJob(jobId)?.provider_animation_id, null);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'retained-source');
});

test('retains a downloaded source after conversion failure and retries without regenerating', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-kimodo-retry-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let generationPosts = 0;
  let downloads = 0;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/models') {
      response.end(JSON.stringify([compatibleModel()]));
      return;
    }
    if (request.url === '/api/generate' && request.method === 'POST') {
      generationPosts += 1;
      response.statusCode = 202;
      response.end(JSON.stringify({ id: 'retry-source-1', status: 'queued' }));
      return;
    }
    if (request.url === '/api/animations') {
      response.end(JSON.stringify([{ id: 'retry-source-1', status: 'ready' }]));
      return;
    }
    if (request.url === '/api/animations/retry-source-1/animation.glb') {
      downloads += 1;
      response.setHeader('content-type', 'model/gltf-binary');
      response.end('retained-kimodo-source');
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no port.');

  let shouldFailConversion = true;
  let snapshot = emptySnapshot();
  const terminalWaiters: Array<(job: PersonaAnimationGenerationJob) => void> = [];
  const nextTerminal = () => new Promise<PersonaAnimationGenerationJob>((resolve) => terminalWaiters.push(resolve));
  const generatorDependencies = {
    assertCanAddGeneratedClip() {},
    addGeneratedClip(
      filePath: string,
      metadata: { clip_name: string; prompt: string; generation_job_id: string },
    ) {
      assert.equal(fs.readFileSync(filePath, 'utf8'), 'recovered-vrma');
      snapshot = {
        ...snapshot,
        animation_clips: [{
          id: 'recovered-clip',
          clip_name: metadata.clip_name,
          source: 'kimodo',
          asset_url: 'persona-asset://animation/recovered-clip.vrma',
          created_at: '2026-09-02T00:00:00.000Z',
          prompt: metadata.prompt,
          generation_job_id: metadata.generation_job_id,
          linked_action_ids: [],
        }],
      };
      return snapshot;
    },
    findGeneratedClip(jobId: string) {
      const clip = snapshot.animation_clips.find((candidate) => candidate.generation_job_id === jobId);
      return clip ? { id: clip.id, clip_name: clip.clip_name } : null;
    },
    publishSettings(next: SettingsSnapshot) { snapshot = next; },
    onJobUpdated(job: PersonaAnimationGenerationJob) {
      if (job.phase === 'ready' || job.phase === 'failed' || job.phase === 'interrupted') {
        terminalWaiters.shift()?.(job);
      }
    },
    sleep: async () => {},
    convert(source: Buffer) {
      assert.equal(source.toString(), 'retained-kimodo-source');
      if (shouldFailConversion) throw new Error('converter leaked /home/alice/private-output.glb');
      return Buffer.from('recovered-vrma');
    },
    validate: () => {},
    validateCore: async () => {},
    random: () => 0.5,
  };
  let service = createAnimationGenerator(directory, generatorDependencies);
  context.after(() => service.close());
  await service.setConfig({
    enabled: true,
    server_url: `http://127.0.0.1:${address.port}`,
    model: 'soma-rp-v1.1',
    mcp_enabled: false,
  });

  const firstTerminal = nextTerminal();
  const started = service.start({ prompt: 'Recover this motion' }, 'settings');
  const failed = await firstTerminal;
  assert.equal(failed.id, started.id);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.failure_phase, 'converting');
  assert.equal(failed.error_code, 'CONVERTER_FAILED');
  assert.equal(failed.error, 'The generated motion could not be converted to VRMA.');
  assert.doesNotMatch(failed.error ?? '', /alice|private-output/u);
  const jobDirectory = path.join(directory, 'animation-generation', started.id);
  assert.equal(fs.readFileSync(path.join(jobDirectory, 'source.glb'), 'utf8'), 'retained-kimodo-source');
  assert.equal(fs.existsSync(path.join(jobDirectory, 'animation.vrma')), false);

  service.close();
  service = createAnimationGenerator(directory, generatorDependencies);
  shouldFailConversion = false;
  const secondTerminal = nextTerminal();
  const retried = service.retry(started.id);
  assert.equal(retried.attempt, 2);
  const ready = await secondTerminal;
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.clip_id, 'recovered-clip');
  assert.equal(generationPosts, 1);
  assert.equal(downloads, 1);
  assert.equal(fs.existsSync(jobDirectory), false);
  assert.deepEqual(service.discard(started.id), []);
  assert.equal(snapshot.animation_clips[0]?.id, 'recovered-clip');
});

test('marks an in-flight persisted job interrupted and reconciles its provider id on retry', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-kimodo-restart-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const jobId = '123e4567-e89b-42d3-a456-426614174090';
  fs.writeFileSync(path.join(directory, 'animation-generator.json'), JSON.stringify({
    schema_version: 3,
    config: {
      enabled: true,
      server_url: 'http://127.0.0.1:8090',
      model: 'soma-rp-v1.1',
      mcp_enabled: false,
    },
    jobs: [{
      id: jobId,
      action_id: null,
      action_name: null,
      clip_id: null,
      clip_name: 'restart-recovery',
      prompt: 'Recover after restart',
      phase: 'generating',
      error: null,
      error_code: null,
      failure_phase: null,
      attempt: 1,
      provider_animation_id: 'existing-provider-job',
      frames: 90,
      steps: 25,
      seed: 4,
      model: 'soma-rp-v1.1',
      model_license: 'NVIDIA Open Model License',
      source_sha256: null,
      vrma_sha256: null,
      converter_version: 'persona-soma30-v2',
      created_at: '2026-09-02T00:00:00.000Z',
      updated_at: '2026-09-02T00:00:01.000Z',
    }],
  }));
  let generationPosts = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/api/generate') generationPosts += 1;
    if (request.url === '/api/animations') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([{ id: 'existing-provider-job', status: 'ready' }]));
      return;
    }
    if (request.url === '/api/animations/existing-provider-job/animation.glb') {
      response.end('restart-source');
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no port.');
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'animation-generator.json'), 'utf8')) as {
    config: { server_url: string };
  };
  persisted.config.server_url = `http://127.0.0.1:${address.port}`;
  fs.writeFileSync(path.join(directory, 'animation-generator.json'), JSON.stringify(persisted));

  let snapshot = emptySnapshot();
  let resolveReady: (job: PersonaAnimationGenerationJob) => void = () => {};
  const readyPromise = new Promise<PersonaAnimationGenerationJob>((resolve) => { resolveReady = resolve; });
  const service = createAnimationGenerator(directory, {
    assertCanAddGeneratedClip() {},
    addGeneratedClip(_filePath, metadata) {
      snapshot = {
        ...snapshot,
        animation_clips: [{
          id: 'restart-clip',
          clip_name: metadata.clip_name,
          source: 'kimodo',
          asset_url: 'persona-asset://animation/restart-clip.vrma',
          created_at: '2026-09-02T00:00:02.000Z',
          prompt: metadata.prompt,
          generation_job_id: metadata.generation_job_id,
          linked_action_ids: [],
        }],
      };
      return snapshot;
    },
    findGeneratedClip: () => null,
    publishSettings(next) { snapshot = next; },
    onJobUpdated(job) { if (job.phase === 'ready') resolveReady(job); },
    sleep: async () => {},
    convert(source) {
      assert.equal(source.toString(), 'restart-source');
      return Buffer.from('restart-vrma');
    },
    validate: () => {},
    validateCore: async () => {},
  });
  context.after(() => service.close());
  const interrupted = service.getJob(jobId);
  assert.equal(interrupted?.phase, 'interrupted');
  assert.equal(interrupted?.failure_phase, 'generating');
  assert.equal(interrupted?.error_code, 'GENERATOR_INTERRUPTED');

  const retried = service.retry(jobId);
  assert.equal(retried.provider_animation_id, 'existing-provider-job');
  const ready = await readyPromise;
  assert.equal(ready.clip_id, 'restart-clip');
  assert.equal(generationPosts, 0);
});

test('retries installation from a retained validated VRMA without reconversion', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-kimodo-install-retry-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let snapshot = emptySnapshot();
  let failInstall = true;
  let generationPosts = 0;
  let downloads = 0;
  let conversions = 0;
  const terminalWaiters: Array<(job: PersonaAnimationGenerationJob) => void> = [];
  const nextTerminal = () => new Promise<PersonaAnimationGenerationJob>((resolve) => terminalWaiters.push(resolve));
  const service = createAnimationGenerator(directory, {
    assertCanAddGeneratedClip() {},
    addGeneratedClip(filePath, metadata) {
      assert.equal(fs.readFileSync(filePath, 'utf8'), 'install-retry-vrma');
      if (failInstall) throw new Error('simulated install failure /home/alice');
      snapshot = {
        ...snapshot,
        animation_clips: [{
          id: 'installed-after-retry',
          clip_name: metadata.clip_name,
          source: 'kimodo',
          asset_url: 'persona-asset://animation/installed-after-retry.vrma',
          created_at: '2026-09-02T00:00:03.000Z',
          prompt: metadata.prompt,
          generation_job_id: metadata.generation_job_id,
          linked_action_ids: [],
        }],
      };
      return snapshot;
    },
    findGeneratedClip: () => null,
    publishSettings(next) { snapshot = next; },
    onJobUpdated(job) {
      if (job.phase === 'ready' || job.phase === 'failed') terminalWaiters.shift()?.(job);
    },
    sleep: async () => {},
    convert(source) {
      assert.equal(source.toString(), 'install-retry-source');
      conversions += 1;
      return Buffer.from('install-retry-vrma');
    },
    validate: () => {},
    validateCore: async () => {},
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/models')) return new Response(JSON.stringify([compatibleModel()]));
      if (url.endsWith('/api/generate') && init?.method === 'POST') {
        generationPosts += 1;
        return new Response(JSON.stringify({ id: 'install-retry-provider' }), { status: 202 });
      }
      if (url.endsWith('/api/animations')) {
        return new Response(JSON.stringify([{ id: 'install-retry-provider', status: 'ready' }]));
      }
      if (url.endsWith('/api/animations/install-retry-provider/animation.glb')) {
        downloads += 1;
        return new Response('install-retry-source');
      }
      return new Response('{}', { status: 404 });
    },
  });
  context.after(() => service.close());
  await service.setConfig({
    enabled: true,
    server_url: 'http://127.0.0.1:8090',
    model: 'soma-rp-v1.1',
    mcp_enabled: false,
  });

  const failedPromise = nextTerminal();
  const started = service.start({ prompt: 'Retry only installation' }, 'settings');
  const failed = await failedPromise;
  assert.equal(failed.failure_phase, 'installing');
  assert.equal(failed.error_code, 'ASSET_INSTALL_FAILED');
  assert.doesNotMatch(failed.error ?? '', /alice/u);
  const outputPath = path.join(directory, 'animation-generation', started.id, 'animation.vrma');
  assert.equal(fs.existsSync(outputPath), true);

  failInstall = false;
  const readyPromise = nextTerminal();
  service.retry(started.id);
  const ready = await readyPromise;
  assert.equal(ready.clip_id, 'installed-after-retry');
  assert.equal(generationPosts, 1);
  assert.equal(downloads, 1);
  assert.equal(conversions, 1);
  assert.equal(fs.existsSync(outputPath), false);
});

test('never reflects a provider response body into a failed job', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-kimodo-safe-error-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const server = http.createServer((request, response) => {
    if (request.url === '/api/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([compatibleModel()]));
      return;
    }
    response.statusCode = 500;
    response.end('secret token and /home/alice/private/model.gguf');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no port.');
  const snapshot = emptySnapshot();
  let resolveTerminal: (job: PersonaAnimationGenerationJob) => void = () => {};
  const terminal = new Promise<PersonaAnimationGenerationJob>((resolve) => { resolveTerminal = resolve; });
  const service = createAnimationGenerator(directory, {
    assertCanAddGeneratedClip() {},
    addGeneratedClip: () => snapshot,
    findGeneratedClip: () => null,
    publishSettings: () => {},
    onJobUpdated(job) { if (job.phase === 'failed') resolveTerminal(job); },
  });
  context.after(() => service.close());
  await service.setConfig({
    enabled: true,
    server_url: `http://127.0.0.1:${address.port}`,
    model: 'soma-rp-v1.1',
    mcp_enabled: false,
  });
  service.start({ prompt: 'A safe failure' }, 'settings');
  const failed = await terminal;
  assert.equal(failed.error_code, 'GENERATOR_QUEUE_REJECTED');
  assert.equal(failed.error, 'Kimodo rejected the request with HTTP 500.');
  assert.doesNotMatch(JSON.stringify(failed), /secret token|alice|model\.gguf/u);

  const statePath = path.join(directory, 'animation-generator.json');
  const legacy = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    schema_version: number;
    jobs: Array<Record<string, unknown>>;
  };
  legacy.schema_version = 2;
  if (legacy.jobs[0]) {
    legacy.jobs[0].error = 'legacy secret /home/alice/model.gguf';
    delete legacy.jobs[0].error_code;
  }
  fs.writeFileSync(statePath, JSON.stringify(legacy));
  const reloaded = createAnimationGenerator(directory, {
    assertCanAddGeneratedClip() {},
    addGeneratedClip: () => snapshot,
    findGeneratedClip: () => null,
    publishSettings: () => {},
    onJobUpdated: () => {},
  });
  context.after(() => reloaded.close());
  const sanitized = reloaded.getJob(failed.id);
  assert.match(sanitized?.error ?? '', /previous animation generation/u);
  assert.doesNotMatch(JSON.stringify(sanitized), /legacy secret|alice|model\.gguf/u);
});

test('preflights clip capacity and free storage before creating or submitting a job', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-kimodo-preflight-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const snapshot = emptySnapshot();
  let fetches = 0;
  let capacityAvailable = true;
  let freeBytes = 1024 * 1024 * 1024;
  const service = createAnimationGenerator(directory, {
    assertCanAddGeneratedClip() {
      if (!capacityAvailable) throw new Error('full');
    },
    addGeneratedClip: () => snapshot,
    findGeneratedClip: () => null,
    publishSettings: () => {},
    onJobUpdated: () => {},
    availableStorageBytes: () => freeBytes,
    fetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify([compatibleModel()]), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  context.after(() => service.close());
  await service.setConfig({
    enabled: true,
    server_url: 'http://127.0.0.1:8090',
    model: 'soma-rp-v1.1',
    mcp_enabled: false,
  });
  const baselineFetches = fetches;

  capacityAvailable = false;
  assert.throws(
    () => service.start({ prompt: 'Should not be submitted' }, 'settings'),
    /clip library is full/u,
  );
  assert.equal(service.listJobs().length, 0);
  assert.equal(fetches, baselineFetches);

  capacityAvailable = true;
  freeBytes = 1;
  assert.throws(
    () => service.start({ prompt: 'Still should not be submitted' }, 'settings'),
    /not enough free storage/u,
  );
  assert.equal(service.listJobs().length, 0);
  assert.equal(fetches, baselineFetches);

  freeBytes = 1024 * 1024 * 1024;
  const statePath = path.join(directory, 'animation-generator.json');
  const originalRenameSync = fs.renameSync;
  fs.renameSync = ((oldPath, newPath) => {
    if (path.resolve(String(newPath)) === statePath) throw new Error('simulated job commit failure');
    return originalRenameSync(oldPath, newPath);
  }) as typeof fs.renameSync;
  try {
    assert.throws(
      () => service.start({ prompt: 'Job state must be atomic' }, 'settings'),
      /could not save the animation generation job/u,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(service.listJobs().length, 0);
  assert.equal(fetches, baselineFetches);
});
