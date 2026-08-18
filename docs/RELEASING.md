# Releasing Screenshotify

## One-off setup

### 1. Updater signing keys

The in-app updater refuses unsigned bundles, so it stays inert until a key pair
exists. `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` is empty on a
fresh checkout, which is why "Check for updates" reports a failure until this is
done.

```bash
npm run tauri signer generate -- -w .tauri/screenshotify.key
```

Then:

1. Copy the **public** key it prints into `plugins.updater.pubkey` in
   `src-tauri/tauri.conf.json`.
2. In the same file, set `bundle.createUpdaterArtifacts` to `true`. It ships as
   `false` so that `npm run release` works on a fresh checkout — with it on and
   no key available, the build fails instead.
3. Add the **private** key file's contents as the GitHub Actions secret
   `TAURI_SIGNING_PRIVATE_KEY`, and its password as
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Keep a backup somewhere safe. Losing it means existing installs can never be
   updated again — they would all have to reinstall by hand.

`.tauri/` is gitignored. Never commit the private key.

### 2. Update endpoint

`plugins.updater.endpoints` points at:

```
https://github.com/<owner>/<repo>/releases/latest/download/latest.json
```

`tauri-action` generates and attaches `latest.json` automatically once
`createUpdaterArtifacts` is true and the signing key is present.

Update the owner/repo there and in `README.md` when the repository moves.

## Cutting a release

```bash
npm version patch      # or minor / major — updates package.json
git push --follow-tags
```

`src-tauri/tauri.conf.json` reads its version from `package.json`, so there is
only one number to bump.

The tag push triggers `.github/workflows/release.yml`, which builds on
`windows-latest` and `macos-latest` in parallel and creates a **draft** release
with both installers attached:

| Platform | Artifact | Notes |
| --- | --- | --- |
| Windows | `Screenshotify_x64-setup.exe` | NSIS, current-user install |
| macOS | `Screenshotify_universal.dmg` | one bundle for Apple Silicon and Intel |

The matrix has `fail-fast: false` so one platform breaking does not discard the
installer the other one already produced. Review the draft, then publish.

Both jobs write to the same `latest.json`, each adding its own platform key.
Check the attached one lists **both** `windows-x86_64` and `darwin-universal`
before publishing — if only the second job's platform is there, the two jobs
raced and the release needs re-running.

## Code signing

v1 ships unsigned; the README explains the SmartScreen warning to users.

### macOS

`bundle.macOS.signingIdentity` is `"-"` in `src-tauri/tauri.macos.conf.json`,
which ad-hoc signs the bundle. That is not a substitute for a Developer ID —
Gatekeeper still requires right-click → Open on first launch — but it seals the
bundle's resources and binds its `Info.plist`, without which macOS tends to
report a downloaded copy as *damaged* rather than merely unsigned.

Notarisation needs a paid Apple Developer ID. Once one exists, set the
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` secrets; `tauri-action` picks
them up, and `APPLE_SIGNING_IDENTITY` overrides the `"-"` in the config, so
nothing in the repo needs changing.

### Windows

Once the first release is public, apply to the
[SignPath Foundation](https://signpath.org/) free certificate programme for open
source projects. Eligibility rests on the things this project already satisfies:
an OSI licence (MIT), public source, and ongoing maintenance — the public release
history is part of what they assess, which is why the application comes after the
first release rather than before it.

After approval, add SignPath's GitHub Action to the release workflow between the
build and the release upload so installers are signed automatically. The
SmartScreen warning disappears once the certificate has accumulated reputation.

## Release checklist

Per platform, on that platform:

- [ ] `npm test` passes
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] `npm run build` passes
- [ ] `npm run release` produces an installer that launches
- [ ] Test connection works against at least one cloud and one local endpoint
- [ ] A new screenshot in a watched folder produces a suggestion
- [ ] Apply, then Undo, restores the original filename
- [ ] Scan a folder queues existing screenshots
- [ ] Tray / menu bar menu, close-to-tray and autostart behave
- [ ] Version bumped via `npm version`

macOS only:

- [ ] The DMG opens with the app and the Applications shortcut side by side
- [ ] Right-click → Open works on a copy that has been through a download
      (`xattr -w com.apple.quarantine "0081;0;;" /Applications/Screenshotify.app`
      reproduces the flag)
- [ ] The folder-access prompt appears on first run and names the app
- [ ] Closing the window removes the Dock icon; the menu bar item reopens it
