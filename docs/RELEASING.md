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
`windows-latest` and creates a **draft** release with the NSIS installer
attached. Review it, then publish.

## Code signing

v1 ships unsigned; the README explains the SmartScreen warning to users.

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

- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] `npm run release` produces an installer that launches
- [ ] Test connection works against at least one cloud and one local endpoint
- [ ] A new screenshot in a watched folder produces a suggestion
- [ ] Apply, then Undo, restores the original filename
- [ ] Scan a folder queues existing screenshots
- [ ] Tray menu, close-to-tray and autostart behave
- [ ] Version bumped via `npm version`
