# Releasing Persona

GitHub releases are produced only from version tags. The expected repository is
`https://github.com/xikhar/persona`; the workflow does not create or push to it.

## One-time repository setup

Add these GitHub Actions secrets when signed distribution is available:

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | Base64 Developer ID Application certificate |
| `MAC_CSC_KEY_PASSWORD` | Certificate password |
| `APPLE_ID` | Apple notarization account |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple app-specific password |
| `APPLE_TEAM_ID` | Apple Developer team |
| `WIN_CSC_LINK` | Base64 Windows code-signing certificate |
| `WIN_CSC_KEY_PASSWORD` | Certificate password |

Without certificates, electron-builder can create unsigned packages, but macOS
Gatekeeper and Windows SmartScreen will warn or block normal installation.
Treat signed and notarized artifacts as the production release path.

## Before tagging

1. Choose the packaged model and animation files.
2. Declare every packaged item and its product metadata in
   `public/assets/library.json`.
3. Mirror every media path in `public/assets/manifest.json`, complete the
   license records and `public/assets/LICENSES.md`, then set
   `distributionAllowed` to `true`.
4. Update `version` in `package.json` and `package-lock.json`.
5. Add release notes to `CHANGELOG.md`.
6. Run:

   ```bash
   npm ci
   npm run check
   npm run assets:release
   npm run native:build
   npm run native:test
   ```

7. Manually verify on Linux, Windows, macOS arm64, and macOS x64:

   - install and launch;
   - an empty catalog opens Settings without creating an avatar window or
     starting the listener;
   - selecting the first model activates the avatar and listener;
   - first-run system audio permission where applicable;
   - automatic, selected-application, advanced-pattern, and external voice modes;
   - selected Linux playback-stream and macOS/Windows process discovery;
   - idle, short pause, long pause, and resumed speech;
   - immediate lip response to output;
   - no microphone capture, duplicate sound, or saved audio;
   - close hides without quitting;
   - ending voice leaves the window open;
   - tray show, hide, recenter, preview, and quit;
   - packaged and user model selection;
   - user model and action creation plus reusable-library VRMA import, card
     preview, download, persistence, and deletion;
   - multi-select **Add clip**, linking one clip to multiple actions, detaching
     without deleting the file, and removing a library clip from every action;
   - permanent empty Idle and Speaking slots and packaged/user clip cards;
   - packaged action edit, removal, and reset without changing user uploads;
   - random clip selection for voice-driven and MCP-triggered actions;
   - Kimodo disabled, unavailable, ready, normal generation, restart while
     polling, conversion/install retry, per-job discard, and history clearing;
   - Kimodo clip capacity and low-storage preflight before provider submission;
   - generated-job errors never showing provider bodies, commands, credentials,
     or local filesystem paths;
   - Kimodo MCP opt-in off by default, asynchronous generation/status polling,
     explicit action creation/linking, and no duplicate clip after recovery;
   - immediate Settings preview and smooth scheduled playback both completing
     without a skipped first frame or root-position jump;
   - shortcut, URL protocol, zoom, orbit, and pan;
   - secondary motion on window drag and orbit, settling back to rest;
   - transparent background and always-on-top behavior;
   - click-through starting off, then on Windows and macOS passing clicks to the
     desktop around the character while the character itself still orbits and
     drags, on Linux passing the whole window through, the tray toggle and
     Settings → Appearance agreeing in both directions, the tray toggle
     restoring a fully interactive window on either platform, and the choice
     surviving a restart; and
   - uninstall.

## Tag and release

The tag must exactly match the package version:

```bash
git tag v0.1.0-beta.0
git push origin v0.1.0-beta.0
```

The release workflow:

1. validates license metadata and tag/version agreement;
2. reruns lint, tests, and builds;
3. compiles and self-tests native listeners;
4. creates AppImage, DEB, NSIS, DMG, and ZIP packages;
5. uploads both macOS architectures;
6. writes `SHA256SUMS.txt`; and
7. publishes one GitHub Release with generated notes.

The release asset gate expects the checkout's VRM/VRMA files to match the
manifest exactly. Ignored local development media deliberately make that gate
fail; run it from a clean release checkout.
