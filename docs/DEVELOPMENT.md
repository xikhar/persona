# Developing Persona

## Architecture

Persona has four intentionally narrow layers:

1. Native listeners discover a supported voice process and calculate a
   normalized output level.
2. The Electron main process owns lifecycle, window behavior, tray commands,
   URL handling, the local adapter, and Persona's MCP controls.
3. The sandboxed preload exposes only normalized Persona events and narrow
   settings operations, the privileged ones gated to the Settings window.
4. React and Three.js render the model, blend VRMA motion, and drive VRM
   expressions.

No renderer code has filesystem, process, or raw-audio access.

All renderer, Electron, Node tooling, and JavaScript-side test source is
TypeScript, and every part of it compiles under the same strict option set —
`strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, and
the unused-binding checks. `tsconfig.app.json` and `tsconfig.runtime.json`
deliberately agree on these: an indexed read is `T | undefined` on both sides
of the preload, and an optional property that is genuinely assigned
`undefined` has to say so in its type rather than being widened by default.

Electron and Node entry points use `.cts` so their generated
CommonJS retains Electron's packaged runtime contract. `npm run build:runtime`
removes stale generated output, then compiles production sources to ignored
`.cjs` files beside them; edit the TypeScript sources, never generated files.
Tests use the dedicated `tsconfig.runtime.test.json` compilation, which also
includes test sources. Normal development, test, build, asset, native, and
packaging commands run the appropriate compilation automatically.

`npm run dev` watches the renderer and runtime TypeScript independently and
restarts Electron after generated runtime modules change. Electron runtime
code is checked against Node 22 declarations to match Electron 39's embedded
Node version; repository tools deliberately use that same compatible subset
even though contributors run them with the Node 24 version required below.
The preload and renderer share their complete cross-process API contract from
`shared/persona-api.d.ts`; update that contract and the typed preload object
together whenever an exposed event or method changes.

### Desktop click-through

`setIgnoreMouseEvents` works on every platform, but its `forward` option is
macOS and Windows only, and forwarding is the only reason an ignoring window
still receives mouse moves. That single constraint produces the two modes in
`electron/click-through.cts`. `silhouette` ignores the mouse, then lets the
renderer carve the character back out of it. `whole-window` is what remains
without forwarding: on or off for the entire window, with the tray toggle the
only way back. Both start off, so an install that never touches the toggle
behaves exactly as it did before the mode existed.

Only the character's shape can say where the window should take input, and only
the renderer knows that shape, so `PointerFocusController` in
`src/components/Scene.tsx` samples it and reports the result over
`persona:set-mouse-passthrough`. The main process treats that as advice it may
drop: results arriving in `whole-window` mode, while the mode is off, or in any
type but a boolean never reach the window. `src/click-through.ts` keeps the
coordinate and threshold arithmetic apart from the Three.js wiring so both
halves are testable without a window.

The sample is one pixel of alpha from the frame just drawn, not a raycast. The
packaged rig is roughly 29k triangles across three skinned meshes, and three.js
casts against a skinned mesh by transforming every vertex by its bones on the
CPU, which costs far more than a frame's budget however rarely it is called.
Reading a pixel costs the same whatever the model, and matches what the user
sees: alpha-cut hair passes clicks through the gaps it appears to have rather
than catching them on the quads it is drawn on. The read has to happen inside
`scene.onAfterRender`, because the drawing buffer holds the frame only until it
reaches the compositor; sampling from the mouse event instead would need
`preserveDrawingBuffer`, which every user would pay for whether or not they ever
turn the mode on. Renders into an offscreen target are skipped, since those are
not the frame the user sees.

Every presented frame is sampled rather than only the frames a pointer event
asks for, because the character keeps moving under a cursor that is standing
still: a decision taken from a frame the idle animation has walked away from
sends the click to the wrong window in both directions. Measured on Windows at
60Hz, the read waits 1.6-4.5ms on the GPU without shifting frame times off
16.7ms or producing a single long frame, in two configurations that differ by
window size and lighting. That wait replaces the one the frame would otherwise
spend at vsync rather than adding to it, which is why sampling every frame is
affordable and a throttle would buy nothing. A display with a shorter frame
budget has not been measured; the read is a wait rather than work, but that is
the case to check first if the mode ever reads as janky.

The mode reaches the renderer both ways on purpose. It is pushed on change so a
tray toggle takes effect at once, and pulled through `persona:get-click-through`
on mount because the push is not the `get-snapshot` "last event" and would
otherwise be lost to a reload, or to a renderer that had not yet subscribed. A
renderer that has heard neither reports nothing rather than guessing, so it can
never talk the window out of flags the main process already applied.

Changing the mouse-ignore flags drops the window out of the always-on-top band,
which is invisible until a click passes through and the app behind it rises over
the avatar. Every change therefore re-asserts the level, and the flags are only
ever set in one place so that cannot be missed.

Whether click-through is on persists as `click_through_enabled` in the settings
snapshot, and is seeded into the click-through state before the avatar window
exists so the window's first flags already match. The mode beside it is not
stored: it follows the running platform, so Settings reads it through
`persona:settings-get-click-through-mode` rather than from the snapshot, and the
rule stays in `clickThroughModeFor` alone. Both the tray toggle and the Settings
control run through the same `setClickThroughEnabled`, which applies the flags,
tells the renderer, and writes the store together, so neither entry point can
leave the other stale. Applying the flags there rather than waiting for a
hit-test that may never come is what makes the tray toggle a dependable way back
to an interactive window.

### Cursor interaction

`PointerFocusController` also feeds the two things that make the window read as
something to reach for: the cursor shape, and the character's gaze. Neither
adds a pixel read. With click-through off the whole window takes the click, so
the canvas is grabbable everywhere and the cursor is set from
`cursorAffordanceFor` in `src/cursor-affordance.ts` without asking what was
drawn; only the `silhouette` mode narrows the grab to the character, and that
mode is already reading the alpha to route clicks. `grab` and `grabbing` rather
than `pointer`, because a drag orbits and Alt+drag moves the window, and neither
is a click.

The gaze needs the cursor's position and nothing else. `src/gaze.ts` holds the
whole of the attention, excitement, and glance arithmetic as plain functions
over plain state so it can be tested without a rig; `src/components/Avatar.tsx`
holds only the Three.js half. Three decisions there are worth knowing before
changing it. Attention is measured in world units, because the avatar window is
resizable and a radius in pixels would be a different distance at every size.
The angles come from `VRMLookAt.lookAt` rather than being computed locally,
since a VRM 0.x rig faces -Z in its own frame while a 1.0 rig faces +Z and
`VRMUtils.rotateVRM0` corrects that above the rig rather than in it — only the
conversion back to a bone rotation is local, and the pitch flips with the
facing. And the head turn is written to the normalized humanoid rig after the
animation has been advanced, committed with `updateMatrixWorld` so spring bones
answer it, then taken back off, exactly as the drag-inertia torso lean is:
three-vrm never resets the normalized rig, so a rotation left in place is
layered on again every frame.

The eyes always track; the head only sometimes joins in, drawn fresh for each
look and mostly staying out of it. That is what keeps it from reading as a
mechanism. The gaze is suppressed while a gesture is under way so it does not
fight the lean the same drag is producing, and it persists as
`look_at_cursor` — absent means on, unlike every other stored flag, since it
shipped enabled. The rest of its tuning is fixed in `DEFAULT_GAZE` rather than
offered in Settings: it is a coherent set that does not come apart by hand.

Both features see the pointer only through renderer pointer events, so the
character notices it once it is inside the avatar window and no sooner. On Linux
under `whole-window` click-through the renderer receives no mouse moves at all,
so both are inert there until the toggle comes back off. Noticing an approach
from further out would need the main process to poll
`screen.getCursorScreenPoint()`, which would also cover that case.

## Settings and local media

`public/assets/library.json` declares the immutable library shipped with the
application. It contains packaged models plus animation action names,
descriptions, trigger scenarios, runtime types, and media paths. The release asset validator
derives its expected media from this catalog instead of a second hard-coded
list.

The active catalog publishes the default model plus the permanent Idle and
Speaking action slots and their bundled motion files. Users can replace that
model or extend the animation library from Settings.
`library.json.example` and `manifest.json.example` are complete, directly
copyable examples for the ignored local test media. Packaged models live under
`public/assets/models/` and animations under `public/assets/animations/`. When
a non-empty catalog omits an explicit default, its first model becomes active.

`electron/settings-store.cts` owns the mutable per-user library and merges it
with the packaged catalog. Animation actions and their VRMA clips are separate
records: an action owns MCP metadata and can contain multiple numbered clips.
The renderer sends metadata through the sandboxed preload, the main process
opens the native multi-file picker, validates every selected glTF 2 binary, and
copies it under Electron's per-user application-data directory.

User media is exposed to renderers through the locked `persona-asset:`
protocol. Requests resolve only IDs already present in the settings store; a
renderer cannot turn the protocol into an arbitrary local-file reader.

Packaged files are never mutated. Editing packaged action metadata creates a
copy-on-write override, and removing one creates a user-level visibility
tombstone. Resetting packaged actions clears only those overrides and
tombstones; user-created actions and uploaded clips remain unchanged. Idle and
Speaking cannot be edited or removed, but users can add or remove their local
clips.

The store returns one active snapshot containing the default model, character
size, merged model records, merged action records with clip collections, and the
configured voice source. Only actions with at least one playable clip appear in
the MCP tool description and animation listing. Catalog changes refresh
connected MCP sessions immediately, while every animation request is validated
against the current store snapshot. Keep the catalog, store, MCP, and
asset-contract tests in sync when adding fields or changing validation.

An empty packaged catalog is a supported first-run state. The application opens
Settings and does not create the avatar window or start the audio listener until
the merged snapshot has a valid `default_model_id`. Importing the first user
model selects it automatically. Empty Idle or Speaking actions use an empty
animation URL list, which leaves the VRM in its normal pose.

### Settings window

`src/components/SettingsPage.tsx` owns the window's state, the operations that
write it back through the preload, and the shell: sidebar, header, notice bar,
confirmation dialog, and live preview. It renders nothing section-specific
itself. Each of the six sections is a component under
`src/components/settings/` with an explicit props interface, so what a section
depends on is written down rather than inherited from an enclosing scope.

Logic that is not presentation lives outside the components and is tested
directly: `settings-sections.ts` (nav descriptors and headings),
`settings-errors.ts` (unwrapping Electron's IPC rejection prefix),
`range-slider.ts` (handle constraints and track fills), `vroid-characters.ts`
(owned/hearted grouping), `vroid-portraits.ts` (the portrait cache and its
in-flight deduplication), `mcp-tool-catalog.ts`, and `voice-pattern-risk.ts`.
Prefer adding to one of those over adding a helper inside a component: a
section component should read as markup plus its props.

### Animation scheduler

The renderer treats every configured Speaking clip as a conversational motion
chunk. Even a single clip is recycled through a fresh action and a scheduled
crossfade instead of relying on a potentially discontinuous hard loop.
`src/animation-scheduler.ts` is the sole owner of action
lifetimes, clip sequencing, transition weights, silence targets, and one-shot
completion. Each clip activation receives its own Three.js action, so an
outgoing clip can never be reset while it still contributes to the current
pose.

Clip loading is epoch-based: obsolete asynchronous results are discarded. If
speaking activity changes while the current request is loading, target
selection is retried against the latest activity revision before any action is
committed. Once a model is ready, its configured animation library is warmed in
the background. A speaking onset can use any ready compatible clip immediately
instead of blocking on the slowest file in the library.

Every transition starts from the exact current action weights. MCP actions can
replace an in-progress blend without resetting its contributing actions.
Automatic speaking transitions never overlap one another. The next action is
preloaded, and its authored clip duration determines when its transition
becomes eligible. Clips retain their authored playback speed; a slow blend
never time-warps the incoming motion to force it into the transition window.

`src/animation-motion.ts` caches track interpolants and compares weighted
humanoid pose and velocity at candidate boundaries. Idle is sampled across its
loop and starts at the phase closest to the outgoing pose. Speaking selects
uniformly from chunks not used in the last six activations, then uses the
compatibility ranking to choose the best phase inside that chunk's small
opening window. This keeps selection genuinely varied without forcing every
chunk to begin at a more distant first keyframe.
Compatibility work is lazy. Short output gaps remain inside Speaking and never
rank or instantiate an unused Idle action.

`src/drag-inertia.ts` gives the character secondary motion while the user is
handling it. Orbiting moves the camera and Alt+drag moves the window, so
neither displaces the character and its spring bones see no acceleration. The
module turns both gestures into a transient lag that the existing three-vrm
spring simulation answers, and both settle to exact rest, so a gesture never
leaves the character moved or turned.

The lag is a lean of the torso rather than a move of the model root, because a
VRM spring may declare a `center` node and is then blind to any motion of that
node. Both conventions in the wild cancel a root move outright, a center on
the scene root and a center on the hips, while a rotation below them registers
on any rig. The lean is written to the normalized humanoid rig on top of the
animated pose, and is shared top heavy so that rigid props mounted on the chest
are not flung about. It is taken back off once `vrm.update` has copied it onto
the render skeleton, because three-vrm never resets the normalized rig and a
lean left in place is layered on again every frame a clip is not driving that
joint. A rotation cannot reproduce a vertical lag, so a purely up-and-down
gesture leans less than a sideways one.

An orbit sweep answers with a sideways swing as well as a twist. The twist
turns the body about a vertical axis through the spine, and the head the hair
hangs off sits on that axis, so on its own it barely moves the spring roots at
all however far it is turned up.

Offsets are relative to the screen and mapped onto the camera basis. Azimuth
is read against the orbit target rather than the model, so panning does not
register as a rotation, and a sweep too large to be a hand gesture is
discarded as a camera reposition.

The persisted
`speaking_transition.entry_ms` and `speaking_transition.exit_ms`
settings hold inclusive `[minimum, maximum]` millisecond ranges for the
incoming and outgoing halves independently. A new duration is sampled from
each range for every chunk transition. The packaged entry range defaults to
`[810, 945]` ms and the exit range defaults to `[630, 855]` ms. The scheduler
fits that request to the available authored motion when a short clip cannot
contain two long transitions. Each chunk receives a full-weight interval
rather than spending its entire lifetime morphing between neighbors. Explicit
clip weights sum to one during clip-to-clip retargets; the model's rest pose
participates only when it is the intentional source or target.
The sampled entry and exit ranges also control MCP-action blends.
One-shot actions hold their authored first frame while that entry blend runs,
then advance at normal clip speed. This keeps the blend smooth without
consuming or hiding the beginning of the action. Speaking chunks are different:
they keep advancing during their overlap so conversational motion remains
continuous.
`body_transition_ms` is the global duration for transitions between Idle
and Speaking. A Speaking action starts on the first active signal and blends
from Idle over that duration; Speaking-to-Speaking transitions use the sampled
ranges above.
Blend weights use a near-linear transfer with lightly softened endpoints. This
spreads visible pose change across the transition instead of hiding it near the
ends and producing a fast morph through the middle.

Lip sync follows every live output level independently. Once an integration has
provided level data, the raw level is authoritative and can start the body and
face before the coarser speaking-state event arrives; state-only integrations
fall back to their speaking state. A raw gap starts the scheduler's
`speaking_debounce_ms` timer, which defaults to 350 ms. Speaking chunks continue
normally if output returns before it expires. Once it expires, the scheduler
transitions to Idle immediately. If output returns after that Idle transition
has begun, the transition is allowed to finish; Idle then plays for
`idle_interim_ms` (350 ms by default) before the next Speaking chunk begins. An
empty Idle action targets the model's normal rest pose.
Host listening or inactive state events never request Idle directly, so they
cannot discard a Speaking successor while the debounce is still active.

Run Persona with `PERSONA_DEBUG=1` to emit `[persona:animation]` records for
requests, loads, scheduled boundaries, activity changes, transition starts,
retargets, completions, and discarded stale work.

The values are stored in Persona's per-user `settings.json` as:

```json
"speaking_transition": {
  "entry_ms": [810, 945],
  "exit_ms": [630, 855]
},
"speaking_debounce_ms": 350,
"idle_interim_ms": 350,
"body_transition_ms": 700
```

They can also be changed from the gated Developer tab in the Settings window.
The warning must be acknowledged once before its controls are available. Valid
entry and exit durations range from `45` to `3600` ms. Their two-handle sliders
select the complete random range; Reset developer settings restores the
packaged ranges while leaving developer access enabled. The same Developer tab
also exposes a Linux-only VRoid Hub plaintext override for machines that do
not have a secure credential store available during development.

## MCP contract

`electron/mcp-server.cts` owns the Codex-facing tool schemas and translates
validated tool calls into narrow main-process callbacks. It does not receive
the Electron application object, renderer access, arbitrary animation paths, or
shell execution.

The loopback server creates a stateful Streamable HTTP transport when a client
initializes an MCP session, then routes subsequent `POST`, `GET`, and `DELETE`
requests by session ID. Sessions are only released when a client sends `DELETE`
or drops its stream, and the endpoint is reachable by anything on the machine,
so the handler holds its own ceiling: a new session first reaps anything idle
past `MCP_SESSION_IDLE_TIMEOUT_MS`, then evicts least-recently-used sessions
until it is back under `MAX_MCP_SESSIONS`. Evicting the oldest rather than
refusing the newest keeps a live client working while abandoned sessions are
the ones reaped. Active sessions receive tool-list change notifications
when the playable action catalog changes. New sessions always discover the
latest catalog, and `play_animation` checks the live store again when invoked.
MCP shares the existing local integration port rather than opening another
listener.

When extending the server:

- prefer a small product action over exposing an internal Electron primitive;
- validate every argument with a bounded schema and, where applicable, the
  current settings catalog;
- mark read-only and side-effecting tools accurately;
- keep the server instructions self-contained; and
- add a protocol-level client test for discovery, valid calls, and rejected
  input.

## Listener contract

All operating systems implement:

- `onSession(active)` for coarse lifecycle;
- `onActivity("listening" | "speaking")`;
- `onLevel(0..1)` for lip movement; and
- `onStatus(...)` for diagnostics.

`AudioActivityGate` keeps the coarse speaking state stable for integrations and
holds it for 250 ms of silence. Lips and the renderer scheduler also receive
every level immediately. The scheduler owns body behavior for those raw gaps:
Speaking remains active until `speaking_debounce_ms` expires, so its normal
chunk sequence continues across shorter gaps. A longer gap starts the Idle
transition. If output resumes after that transition has begun, the scheduler
finishes the Idle route and its configured interim before returning to a new
Speaking chunk.

Voice-source validation and stable identities are shared through
`electron/voice-source.cts`; discovery lives in
`electron/voice-source-discovery.cts`. Settings supports automatic detection,
an exact application or PipeWire stream, an advanced regex, and external event
mode. `PERSONA_TARGET_PROCESS_PATTERN` overrides automatic and advanced
matching when set. Every source change recreates the listener immediately.

Linux persists a composite PipeWire stream identity so generic application
names such as `Electron` cannot collapse unrelated playback streams. macOS and
Windows persist executable identity and resolve the current process tree before
starting the native helper. PIDs and PipeWire object serials are never stored.

Linux implements the contract directly with PipeWire commands. macOS and
Windows helpers write newline-delimited JSON to stdout:

```json
{"type":"ready","source":"Windows process audio"}
{"type":"level","level":0.21}
```

## Commands

```bash
npm run lint
npm test
npm run assets:check
npm run build
npm run native:build
npm run native:test
```

`npm run check` runs the platform-neutral checks together.

The native build command:

- does nothing on Linux because the runtime uses installed PipeWire commands;
- compiles Objective-C++ against Core Audio on macOS; and
- locates Visual Studio Build Tools and compiles C++ against WASAPI on Windows.

Linux packaging detects NixOS and runs `fpm` from `nixpkgs#fpm`, avoiding the
upstream bundled FPM wrapper's `/bin/bash` assumption. Other distributions use
electron-builder's bundled packaging tool.

## Test coverage

The Node suite covers settings persistence and imported-media boundaries, MCP
discovery, tool calls and session lifetime, the bridge boundary, URL protocol,
Hyprland rules, PipeWire selection and PCM normalization, process discovery on
macOS and Windows, native NDJSON parsing, shared pause smoothing, listener
lifecycle, asset safety, release checksums, click-through platform support and
hit-test gating, and VRoid Hub OAuth — including which refresh failures are
allowed to discard the saved session and which must preserve it, the forced
refresh that tells a revoked authorization apart from an outage, and which
callbacks are allowed to consume a pending sign-in.

Vitest covers animation priority and configured animation selection, speech
signal gating, motion compatibility and variety, transition timing, async
request replacement, pause debounce, Idle interim handling, one-shot actions,
scheduler cleanup, drawing-buffer sampling, silhouette alpha thresholds and
the per-mode Settings copy for click-through, drag inertia including
camera-jump rejection, the lean cap,
the direction each channel lags in and return-to-rest, the cursor affordance
each hit test allows, gaze attention and its return to rest, the excitement a
cursor's speed is worth, and how often the head joins a look, plus the Settings
window's own logic: IPC error unwrapping, slider handle constraints, lighting
field ranges, section descriptors, VRoid character grouping, the MCP tool
table, and voice-pattern risk detection. Its `include` covers `.tsx` as well as
`.ts`, so logic that lives beside a component is testable where it is.
GitHub Actions then compiles and self-tests the native helper on its real
operating system and builds the renderer on all three platforms.

Headless CI cannot create a real Codex voice call or approve operating-system
audio permissions. Before a release, manually run the checklist in
[RELEASING.md](RELEASING.md) on each platform.

## Native API references

- Apple: [Capturing system audio with Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)
- Microsoft: [Application loopback audio capture](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
