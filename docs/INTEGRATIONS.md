# Persona integrations

Persona accepts small state and level messages from local voice experiences.
The character renderer never needs raw audio, transcripts, prompts, credentials,
or host-application internals.

The bundled Codex and ChatGPT integration uses native process-scoped output
listeners because those applications do not currently expose a supported
cross-process realtime voice event stream. If an official event stream becomes
available, it can map to the same contract without changing Persona's window or
animation system.

## Codex MCP server

Persona serves a Streamable HTTP MCP endpoint while the app is running. Add it
to Codex once:

```bash
codex mcp add persona --url http://127.0.0.1:47831/mcp
```

Start a new Codex session after registering the server. You can inspect the
saved connection with:

```bash
codex mcp get persona
```

Persona exposes these tools:

| Tool | Input | Effect |
| --- | --- | --- |
| `play_animation` | `animation`: a playable configured action name | Shows Persona and plays one randomly selected clip from that action |
| `list_animations` | None | Reads the latest playable action names, descriptions, and trigger scenarios |
| `list_animation_clips` | None | Reads reusable clip IDs, source prompts, and current action links |
| `create_animation_action` | Action metadata plus one or more `clip_ids` | Atomically creates an action linked to reusable clips |
| `attach_animation_clip` | Action name and `clip_id` | Links a reusable clip to an existing action without copying the file |
| `control_window` | `action`: `show`, `hide`, or `toggle` | Controls the Persona window without quitting the app |
| `get_status` | None | Reads model readiness, window visibility, voice state, and listener status |
| `generate_animation` | Prompt plus optional clip title, frames, steps, and seed | Starts one asynchronous reusable-clip job through the configured local Kimodo provider |
| `get_animation_generation` | `job_id` returned by `generate_animation` | Reads durable generation progress and the installed `clip_id` when ready |

Animation generation and agent-driven action changes are disabled for MCP by default. Configure and verify the
loopback Kimodo endpoint in **Settings → Kimodo**, then
explicitly enable agent generation there. `generate_animation` returns before
inference finishes; poll `get_animation_generation`, then link the ready clip
with `create_animation_action` or `attach_animation_clip` before calling
`play_animation`. Failed jobs return an authored error message and stable error
code without provider response bodies or local paths. Retry and history cleanup
remain user-facing controls in Settings. Kimodo remains
a separate, user-managed installation. Persona accepts the pinned SOMA RP
model's skeleton GLB as source, converts it to a validated VRM Animation, and
installs the result in the same reusable clip library used by manual uploads.

The animation descriptions are generated from Persona's playable actions.
Empty actions are omitted until a VRMA clip is added. User uploads, user edits
to packaged metadata, removals, and packaged-action resets are reflected
immediately through an MCP tool-list change notification. The action catalog is
listed once, in the `play_animation` description; the `animation` argument only
names what it takes. No media paths or filesystem access are exposed.

The `play_animation` input remains open to valid action names and checks the
live library when invoked, so a client that does not refresh tool descriptions
can still run an action added during the current session. This matters because
the catalog changes while a session is live: `list_animations` always answers
from the current library, while a cached tool list — and the copy of it already
in a model's context — can be a revision behind. Leaving the argument open lets
the fresher of the two win, and nothing unplayable reaches the app regardless: a
malformed name fails schema validation, and a well-formed one the library does
not hold is turned away by the handler, which names `list_animations` as the
next step. Both arrive as `isError` results rather than protocol errors, so the
text is written for the model to read and act on. Honour the
tool-list change notification if you can, but treat it as an optimization:
`list_animations` is the source of truth, and a client that ignores the
notification entirely still behaves correctly.

With no configured model, window and animation commands remain inactive.
Persona can still report status while its Settings window is used for initial
setup.

An MCP-triggered action randomly selects one of its clips and temporarily takes
priority over voice-driven body motion. Lip sync continues while the clip
plays. A newer MCP action replaces the current one; when the one-shot clip
finishes, Persona returns to the current idle, listening, or speaking state.

The MCP endpoint uses the same port as the local HTTP API. If
`PERSONA_BRIDGE_PORT` changes it, update the URL registered with Codex to match.

## Automatic listeners

Listeners attach to the configured voice source: automatic ChatGPT/Codex
detection, one selected application, or an advanced process pattern.

### Linux

Persona polls the PipeWire graph for either the selected playback stream or a
node matching the configured process pattern. It attaches `pw-record` to that
one stream, calculates RMS amplitude in memory, and discards every sample after
calculation. The stream remains connected to its normal output device.

### Windows

The native helper uses WASAPI application loopback with
`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`. Audio from other
applications is excluded. Persona supports Windows 10 build 20348 and newer.
Application mode resolves the saved executable identity to its current process
tree before starting the helper.

### macOS

The native helper creates a private, unmuted Core Audio process tap and private
aggregate device for the selected voice process. Persona supports macOS 14.2
and newer and declares why it requests System Audio Recording permission.
Application mode resolves the saved executable identity to its current process
tree before creating the tap.

Set `PERSONA_TARGET_PROCESS_PATTERN` to a case-insensitive regular expression
to target another desktop voice application. This environment variable
overrides automatic and advanced-pattern matching, but not an explicitly
selected application or external mode:

```bash
PERSONA_TARGET_PROCESS_PATTERN='my-voice-app' persona
```

## Voice source settings

Open **Settings → Voice** to choose which application Persona watches for
automatic lip sync:

- **Automatic** keeps the built-in ChatGPT/Codex matcher.
- **Application** lists current playback streams on Linux and running
  applications on macOS and Windows, then persists a stable identity rather
  than a temporary PID or PipeWire serial.
- **Advanced** accepts a case-insensitive regular expression matched
  against process names and command lines on macOS and Windows, and against
  PipeWire application identity (plus process ancestry) on Linux.
- **External** disables automatic capture and waits for normalized state and
  level events through the loopback API.

Persona still calculates only an in-memory output level. It does not capture the
microphone, run language models, transcribe speech, or send audio over the
network.

Keep an advanced pattern simple. Persona runs it against process identity on
its main thread every time it looks for the voice source, so a pattern that
backtracks catastrophically — nested quantifiers over overlapping character
classes, such as `(a+)+b` — will freeze the application rather than fail to
match. Prefer a plain substring or alternation like `my-voice-app|my-tts`.
Persona rejects a pattern that does not compile and caps its length, but it
cannot bound how long a valid pattern takes to run. The same caution applies to
`PERSONA_TARGET_PROCESS_PATTERN`.

## Local models and voice pipelines

Persona is a visual companion for voice experiences. Local models such as Qwen
or GPT-OSS run in your own agent or inference stack; Persona animates beside
them. Three supported shapes:

1. **Process listen.** Point Settings → Voice at the desktop app that plays
   assistant audio (for example a local TTS player or voice UI). Persona
   attaches to that process the same way it attaches to ChatGPT or Codex.
2. **Loopback events.** Have your pipeline POST normalized state and levels to
   `http://127.0.0.1:47831/events`, or open `persona://speaking?level=…` URLs,
   when speech starts and ends.
3. **MCP actions.** Register any compatible MCP client against
   `http://127.0.0.1:47831/mcp` so the agent can trigger configured animations
   and window controls while audio still comes from (1) or (2).

## URL protocol

Installed packages register `persona://`.

| URL | Effect |
| --- | --- |
| `persona://show` | Show and focus Persona |
| `persona://hide` | Hide Persona without quitting |
| `persona://toggle` | Toggle visibility |
| `persona://listening` | Begin a listening state |
| `persona://thinking` | Settle the character while a response is prepared |
| `persona://speaking?level=0.3` | Begin speaking and optionally set a level |
| `persona://inactive` | End the voice state without hiding Persona |
| `persona://animation?name=<animation-name>` | Play an active configured animation once |

Open these URLs with `xdg-open` on Linux, `open` on macOS, or `start` on
Windows.

## Loopback HTTP API

Persona listens on `127.0.0.1:47831` by default. Override the port with
`PERSONA_BRIDGE_PORT`. Native clients may omit `Origin`; browser clients are
restricted to trusted local and supported app origins. Requests with a
non-loopback `Host` are rejected.

Voice state:

```json
{
  "type": "state",
  "state": {
    "phase": "active",
    "activity": "speaking",
    "microphoneMuted": false,
    "outputMuted": false
  }
}
```

Allowed phases are `inactive`, `starting`, `active`, and `stopping`. Allowed
activities are `idle`, `listening`, and `speaking`.

Normalized level:

```json
{
  "type": "audio-level",
  "level": 0.31
}
```

Configured animation action:

```json
{
  "type": "animation",
  "animation_name": "example-animation"
}
```

The name must match a playable action in Persona's merged library.

Expression hold and release:

```json
{
  "type": "expression-hold",
  "animation_name": "example-animation"
}
```

```json
{
  "type": "expression-release"
}
```

An action's configured expression normally follows its animation and is
restored when the animation finishes. `expression-hold` resolves an action
through the same library and keeps that action's configured expression active
independently of it, for integrations whose speech outlasts the motion — a
reply that goes on talking long after a two-second embarrassed clip has ended
can hold the expression until playback finishes and release it then. The
animation itself is neither played nor extended; only its expression is held.
Short-lived reactions need neither event and can keep using the default
lifecycle.

A held expression takes precedence over the expression carried by an action
that starts later, so an action playing during a hold moves the body without
changing the face. A second hold replaces the first rather than stacking, and
`expression-release` is accepted whether or not anything is currently held.

Persona answers `202` once an event is accepted and `422` when it is not. A
hold is rejected when no model is configured, when the name does not resolve to
an installed action, or when that action has no configured expression. Unlike
an animation command, a hold does not require the action to have a playable
clip. A rejected hold changes nothing, and that action keeps its ordinary
animation-bound expression lifecycle.

Persona ends a hold on its own if the integration does not: after five minutes,
when the selected model changes, when the held action is removed, or when its
configured expression or weight changes. These are failsafes for an integration
that exits or loses its connection rather than a substitute for sending
`expression-release`.

Send events:

```bash
curl -H 'Content-Type: application/json' \
  --data '{"type":"state","state":{"phase":"active","activity":"speaking","microphoneMuted":false,"outputMuted":false}}' \
  http://127.0.0.1:47831/events
```

`GET /health` reports whether Persona is running and returns the last state. It
does not expose user content.

## VRoid Hub connection

Persona can sign in to [VRoid Hub](https://hub.vroid.com) and use a character
that its owner marked usable only through linked applications (no direct
`.vrm` download). This is entirely opt-in, off by default, and advanced:
each user brings their own registered OAuth app rather than sharing one
built into Persona.

Register an application at
[`hub.vroid.com/oauth/applications`](https://hub.vroid.com/oauth/applications),
then open Settings → VRoid Hub. It shows the exact redirect URI to register
for the app — `http://127.0.0.1:47831/vroid-oauth-callback` by default (or
the equivalent for a custom `PERSONA_BRIDGE_PORT`), served by the same local
loopback bridge as the MCP endpoint and `/events`, not the `persona://` URL
scheme, so sign-in works the same way from `npm run dev`/`demo` and from an
installed build. Paste the app's client ID and secret into Settings and save
— they're encrypted at rest with Electron's `safeStorage` (OS
keychain-backed) in `vroid-hub-credentials.json`, the same mechanism used for
the resulting session tokens (`vroid-hub-auth.json`). On Linux, a packaged
build also confirms the OS keyring backend is actually selected rather than
`safeStorage`'s insecure `basic_text` fallback (used when no GNOME Secret
Service or KWallet is running). If you intentionally want to bypass that gate
while developing, enable the VRoid Hub Linux override in Developer settings.
Otherwise the feature stays disabled rather than storing either in plaintext.

With no credentials configured, "Connect VRoid Hub account" in Settings stays
disabled. When configured, Settings opens the VRoid Hub authorization page in
your system browser (PKCE + confidential client), then lists characters the
signed-in account owns, plus the ones it has hearted whose creator marked
them available to other users, under separate "Your models" and "Hearted
models" headings.
Selecting one fetches its VRM bytes through VRoid Hub's licensed
`download_licenses` flow and holds them in memory for the running session —
Persona does not write a hub-sourced model to disk as an ordinary, freely
reusable local file, and it disappears on the next launch until reselected.

The connection then stays signed in on its own. VRoid Hub's access tokens last
about an hour, so Persona trades its stored refresh token for a new one
whenever you use the picker with a stale one — there is no background activity
between launches, and closing Persona changes nothing. You are only asked to
reconnect when the authorization itself is gone: you revoked Persona from your
VRoid Hub account, or you replaced the OAuth app credentials in Settings.
VRoid Hub being unreachable — an outage, rate limiting — fails the action you
were taking and says so, but leaves the connection intact, so retrying once
it recovers costs nothing. Revoking from
[`hub.vroid.com`](https://hub.vroid.com) takes effect on the next action rather
than immediately, since Persona only learns about it by being turned away.
