# Maintaining the Kimodo integration

Status: runbook for the implemented experimental integration

The compatibility baseline is
[`localai-org/kimodo.cpp@f782a72`](https://github.com/localai-org/kimodo.cpp/commit/f782a7236706749d1ffeabeed140eb14032d19f3),
researched on 2026-08-30. Read
[Kimodo animation generation integration](KIMODO_INTEGRATION.md) first for the
product boundary and user workflow.

## Ownership rules

Persona treats Kimodo as an external, user-managed loopback provider.
Maintainers must not add executable discovery, shell commands, model paths,
environment editing, installation, process management or OS-specific Kimodo
launch behavior to Persona. Settings may open the expected
[`localai-org/kimodo.cpp`](https://github.com/localai-org/kimodo.cpp) repository
and test the configured endpoint; nothing more.

| Concern | Owner |
| --- | --- |
| Build, weights, inference process and provider history | Kimodo installation |
| Loopback configuration and compatibility checks | Persona main process |
| Request bounds, jobs, retry and local artifacts | Persona generation service |
| SOMA30 retargeting and VRMA construction | Versioned Persona converter |
| Semantic and core glTF validation | Persona and pinned Khronos validator |
| Reusable files, action links and transactional state | Persona settings store |
| Prompts and action metadata | User or explicitly opted-in Persona MCP |
| Model and generated-output license decisions | User and maintainers |

Kimodo must remain optional. Provider failure must not prevent Persona from
starting or affect already installed animation clips.

## Supported baseline

| Field | Required value |
| --- | --- |
| Upstream | `localai-org/kimodo.cpp` |
| Researched revision | `f782a7236706749d1ffeabeed140eb14032d19f3` |
| Adapter | Go localhost HTTP demo |
| Default endpoint | `http://127.0.0.1:8090` |
| Model | `soma-rp-v1.1` |
| Skeleton | Exact `soma30` hierarchy and offsets |
| Source sampling | 30 fps |
| Source maximum | 64 MiB |
| Output | Self-contained VRMA 1.0 GLB |
| Converter | `persona-soma30-v2` |
| Core validator | `gltf-validator@2.0.0-dev.3.10` |

The pinned upstream has no stable protocol version endpoint. Do not widen the
allowlist based only on a model name or successful HTTP status.

## Connection qualification

`GET /api/models` must continue to satisfy all of these conditions:

1. The configured URL is plain HTTP on literal `127.0.0.1` or `::1`, with no
   credentials, path, query or fragment.
2. Redirects are rejected and request/response sizes are bounded.
3. The response is a JSON array.
4. `soma-rp-v1.1` is present and available.
5. Its skeleton key, parent list, offsets and license descriptor match the
   pinned contract.

The Settings **Ready** badge means only that this check passed. It does not
prove that the external installation can complete inference.

Never return a provider-supplied `reason`, response body, local path or command
output through status, job history or MCP. Provider content is untrusted even
on loopback because any local process could occupy the configured port.

## Generation invariants

Before `POST /api/generate`, Persona must:

- validate prompt, clip title, frames, steps, seed and model;
- verify that the reusable library has capacity;
- reserve enough free space for the maximum bounded source, converted output
  and transaction overhead;
- reject a second concurrent Persona generation;
- persist the queued job before starting background work.

The adapter expects HTTP 202 and a provider ID matching
`[a-zA-Z0-9-]{1,128}`. Polling uses bounded jittered exponential backoff from
roughly 2.5 to 15 seconds, a four-hour overall deadline and a five-observation
limit for a provider job that disappears from `/api/animations`.

The download is streamed into the exact job directory rather than buffered as
one unbounded response. Source and output writes use a mode-`0600` temporary
file, file flush and rename. Conversion still reads the bounded source into
memory because the converter operates on a GLB buffer.

Keep these state transitions monotonic during an attempt:

```text
queued -> submitting -> generating -> downloading -> converting
       -> installing -> ready

any active phase -> failed
any active phase -> interrupted on shutdown/restart
failed or interrupted -> queued only after explicit Retry
```

Each job records:

- a UUID, clip title and prompt;
- frames, steps, safe-integer seed and model;
- provider job ID and reported model license when known;
- source and VRMA SHA-256 hashes when created;
- converter version, current phase and failed phase;
- stable error code, safe error message and attempt number;
- timestamps and the installed clip ID when ready.

Legacy `action_id` and `action_name` fields remain nullable only for compatible
state loading. Generation does not create or modify an action.

## Recovery and cleanup

Job artifacts are private and confined to:

```text
userData/animation-generation/<validated-job-uuid>/
├── source.glb
└── animation.vrma
```

Temporary `.tmp` files exist only while the corresponding file is being
written. A failed or interrupted job retains the furthest completed artifact.

| Failure stage | Retained state | Explicit Retry |
| --- | --- | --- |
| Submission before provider ID | Request only | Submit again |
| Provider explicitly failed | Request and failed provider ID | Clear the provider ID and submit again |
| Polling interrupted | Provider ID | Resume polling the same job |
| Download interrupted | Provider ID | Download again when ready |
| Conversion failed | Hashed source GLB | Convert again without inference |
| Validation failed | Hashed source GLB | Convert and validate again |
| Installation failed | Hashed source and validated VRMA | Revalidate and install again |
| Settings publication failed after install | Existing library record | Reconcile as ready without a duplicate |

On startup, any previously active job becomes `interrupted`; Persona never
silently resumes network or compute work. Retry is always a user action in
Settings. Retry checks capacity and free space again.
Changing the endpoint or model invalidates provider IDs on recoverable jobs so
they cannot be resumed against a different server. Valid local source and VRMA
artifacts remain usable.

A ready job removes its recovery directory. **Discard** removes that one job
record and its exact recovery directory. **Clear recent jobs** removes all
terminal job records and their exact directories. Neither operation deletes an
installed clip or attempts to modify Kimodo's provider-side history. The
100-record bound also cleans artifacts belonging to an evicted oldest record.
On startup, Persona removes only UUID-named recovery directories that no
retained non-ready job owns; this retries cleanup after an interrupted delete
without widening the filesystem scope.

The settings store independently protects owned VRM/VRMA files. A delete first
renames the exact asset to `<filename>.delete`, commits settings, and then
removes the staged file. Startup restores it if persisted state still references
the asset, otherwise it finishes the deletion. A failed import or generated
clip commit removes the copied file and restores the last persisted in-memory
state.

## Safe error codes

Jobs expose one of these stable families and a short, authored message:

- `GENERATOR_CAPACITY_REACHED`
- `GENERATOR_INCOMPATIBLE`
- `GENERATOR_INTERRUPTED`
- `GENERATOR_MODEL_UNAVAILABLE`
- `GENERATOR_OFFLINE`
- `GENERATOR_OUTPUT_INVALID`
- `GENERATOR_QUEUE_REJECTED`
- `GENERATOR_STORAGE_FULL`
- `GENERATOR_TIMED_OUT`
- `CONVERTER_FAILED`
- `VRMA_VALIDATION_FAILED`
- `ASSET_INSTALL_FAILED`

Do not replace these messages with `error.message` from `fetch`, Kimodo,
conversion, validation or filesystem calls. Detailed diagnostics can be added
later only through an explicit local export with prompt/path redaction.

## Converter qualification

The converter is allowlist-based. Any change in hierarchy, offsets, joint
names, animation channels, accessor layout, frame range, quaternion order or
source FPS must fail closed until deliberately supported.

Every accepted output must pass:

1. exact Persona VRMA semantic validation;
2. the pinned Khronos validator with zero errors and zero warnings;
3. production `VRMAnimationLoaderPlugin` parsing;
4. finite-track retargeting against representative VRM 0.x and 1.0 avatars;
5. manual visual review for facing, contacts, feet, root drift and transitions.

The integrated converter composes SOMA `Neck1` and `Neck2` into the VRM neck,
grounds hips translation from the source rest pose, canonicalizes quaternion
signs and preserves the optional jaw. A generic GLB converter, file-extension
rename, FBX converter or BVH converter is not a substitute for these checks.

## Automated verification

Run the repository gate:

```bash
npm run check
```

Relevant coverage includes:

- loopback/MCP opt-in policy and the normal asynchronous HTTP job;
- capacity and free-space preflight before job creation;
- safe HTTP error handling without provider-body reflection;
- retained-source retry without a second provider submission;
- restart interruption and provider-ID reconciliation;
- converter schema, hierarchy, quaternion, grounding and validation failures;
- Khronos validation and production-loader parsing;
- settings import rollback and staged-delete recovery after commit failure;
- sender-gated preload calls and MCP generation/status schemas.

The normal suite uses fixtures and never downloads weights or requires Kimodo.
Real local artifacts can opt into the otherwise skipped converter oracles after
`npm run build:runtime:test`:

```bash
PERSONA_KIMODO_REAL_FIXTURE=/absolute/path/to/animation.glb \
  node --test --test-name-pattern='opt-in real' electron/kimodo-vrma.test.cjs

PERSONA_KIMODO_REAL_FIXTURE=/absolute/path/to/animation.glb \
PERSONA_VRM_TARGETS=/absolute/vrm0.vrm:/absolute/vrm1.vrm \
  node --test --test-name-pattern='opt-in VRM' electron/kimodo-vrma.test.cjs
```

Use `;` rather than `:` between VRM paths on Windows.

## Manual release matrix

Record the Persona commit, Kimodo commit, model repository revision, converter
version, prompt, parameters, hashes, timings and visual observations.

| Area | Required cases |
| --- | --- |
| Connection | disabled, missing server, wrong port, incompatible schema, missing model, ready |
| Request | prompt limits, frame/step/seed bounds, full clip library, low disk space |
| Lifecycle | normal completion, app restart while polling, provider restart, retry, discard, clear history |
| Recovery | conversion failure from retained source, installation failure from retained VRMA, existing-clip reconciliation |
| Conversion | varied motions and proportions on VRM 0.x and 1.0 |
| Playback | Settings preview, action preview, MCP one-shot, speaking overlap and scheduler return |
| Platforms | packaged Linux, Windows and macOS builds on physical target systems |

Do not describe cross-compilation or a successful Linux provider run as native
Windows or macOS inference validation.

## Updating compatibility

When evaluating a newer Kimodo revision:

1. Record the exact upstream and model revisions.
2. Diff the model descriptor and all four HTTP responses consumed by Persona.
3. Generate short and normal-length fixtures with nonzero root motion.
4. Compare skeleton names, parents, offsets, rotations, channels and timeline.
5. Run semantic, Khronos, production-loader and real-VRM tests.
6. Complete the manual visual and platform matrix.
7. Review Kimodo, motion-model, text-model and generated-output terms.
8. Update the baseline table in both Kimodo documents in the same change.

Add another model only behind its own exact descriptor and converter fixture.
Never silently reinterpret old job artifacts with a new converter version.

## Deliberate gaps

- The pinned provider has no cancellation or deletion API.
- Persona supports no remote or authenticated Kimodo host.
- Progress is phase plus elapsed time, not a percentage or ETA.
- Provider-side jobs and prompts remain after Persona deletes local history.
- Automated structural validation does not prove artistic quality.
