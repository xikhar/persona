# Contributing to Persona

Thank you for helping improve Persona. Contributions to code, tests,
documentation, accessibility, packaging, and platform support are welcome.

## Before you begin

- Read and follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Search existing [issues](https://github.com/xikhar/persona/issues) and pull
  requests before starting overlapping work.
- Discuss substantial product, integration, security, or architecture changes
  in an issue before implementing them. Small, well-scoped fixes can go
  directly to a pull request.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
  Do not disclose them in a public issue or pull request.

Persona is a visual desktop companion. Changes that record or transmit audio,
capture microphone input, transcribe conversations, inject into another
application, or expose general system access are outside the current product
boundary and require prior design discussion.

## Development setup

Requirements:

- Node.js 24 or newer
- npm
- A hardware-accelerated desktop session for interactive renderer testing
- Platform tools for native listener work:
  - Linux: `pw-dump` and `pw-record`
  - Windows: Visual Studio Build Tools with the C++ desktop workload
  - macOS: Xcode Command Line Tools and macOS 14.2+ SDK support

Clone your fork and install the locked dependency set:

```bash
git clone https://github.com/<your-account>/persona.git
cd persona
git remote add upstream https://github.com/xikhar/persona.git
npm ci
npm run native:build
```

`npm run native:build` compiles the voice-output listener on macOS and Windows.
It is a no-op on Linux. Run it after the initial installation and whenever the
native listener sources change.

Run Persona in development mode:

```bash
npm run dev
```

Or build and launch the production renderer locally:

```bash
npm run demo
```

The committed packaged catalog intentionally contains no character model.
Persona will open Settings so you can import local `.vrm` and `.vrma` files.

To exercise the packaged-library path with your own ignored test media, follow
the example catalog instructions in the [README](README.md#try-persona-locally).
Those files are local development inputs. Check `git status` carefully before
committing so copied catalog values or restricted media are not included by
accident.

## Project boundaries

Keep these architectural constraints intact:

- The Electron renderer remains sandboxed, with context isolation enabled and
  Node.js integration disabled.
- The preload exposes narrow product operations rather than filesystem,
  process, shell, or raw-audio access.
- Renderer navigation and imported media stay within Persona's validated local
  protocols.
- Settings mutations and VRoid Hub operations stay restricted to the Settings
  window; both windows share one preload, so new channels register through
  `electron/settings-ipc.cts`.
- The integration and MCP server remain loopback-only and accept bounded,
  validated inputs.
- MCP tools describe Persona actions, not arbitrary Electron or operating
  system primitives.
- Voice listeners calculate only an in-memory output level and must not retain
  or transmit audio.
- Linux, Windows, and macOS listeners continue to implement the shared session,
  activity, level, and status contract.

Read [Developing Persona](docs/DEVELOPMENT.md) and
[Integrations](docs/INTEGRATIONS.md) before changing these areas.

Electron and Node sources use `.cts` and compile to ignored `.cjs` runtime
files. Do not edit or commit generated `.cjs` files; `npm run build:runtime`
cleans stale output before compiling production sources and is already included
in the standard commands. `npm run dev` also watches runtime sources and
restarts Electron when their generated output changes.

## Making changes

Create a focused branch from the latest `main`:

```bash
git fetch upstream
git switch main
git merge --ff-only upstream/main
git switch -c fix/short-description
```

Use a clear branch name such as `fix/...`, `feat/...`, `docs/...`, or
`test/...`. Keep commits focused and write concise, imperative commit subjects.
Conventional prefixes are welcome but not required.

When changing behavior:

- Add or update tests at the layer that owns the behavior.
- Keep documentation and examples consistent with the code.
- Include screenshots or a short recording for visible Settings or avatar
  changes.
- Describe any manual platform verification that automated tests cannot cover.
- Avoid unrelated formatting, generated installers, `dist/`, `release/`, and
  dependency directories.

## Validation

Run the platform-neutral validation before opening a pull request:

```bash
npm run check
```

This runs linting, Node and renderer tests, the development asset contract,
the production dependency audit, and a renderer build.

For native listener changes, also run:

```bash
npm run native:build
npm run native:test
```

Native helpers must be compiled and self-tested on the operating system they
target. For packaging changes, build the relevant native package:

```bash
npm run dist:linux
npm run dist:windows
npm run dist:mac
```

GitHub Actions repeats the full suite on Linux, Windows, and macOS. Workflows
from first-time contributors may wait for maintainer approval before running.
Passing CI does not replace manual verification of real voice output,
operating-system permissions, transparent window behavior, or signed packages.

## Character assets and licensing

Do not commit a VRM, VRMA, texture, environment, or other media file unless its
redistribution rights have been verified for Persona.

For any proposed packaged asset:

1. Document its source and license.
2. Confirm that modification and redistribution in a desktop application are
   permitted.
3. Add the required attribution.
4. Update both the packaged library and asset manifest.
5. Run `npm run assets:release`.

The MIT license covers Persona's application source, not third-party character
media. See [`public/assets/LICENSES.md`](public/assets/LICENSES.md) for the
complete policy.

## Pull requests

A pull request should explain:

- what changed and why;
- the user-visible effect, if any;
- the tests and manual checks performed;
- the operating systems affected;
- related issues or prior design discussion; and
- asset provenance when media is involved.

Keep the pull request limited to one coherent change. Respond to review
feedback with new commits while review is active; maintainers may squash the
final pull request when merging.

By contributing source code or documentation, you agree that your contribution
is licensed under Persona's MIT License and confirm that you have the right to
submit it. Media remains subject to its own documented license.
