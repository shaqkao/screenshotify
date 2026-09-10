# Microsoft Store submission

Everything here is about packaging Screenshotify as MSIX and the Partner
Center submission that feeds. For the regular release process (GitHub
Releases, direct download), see [RELEASING.md](RELEASING.md) — that path is
unaffected by anything on this page and still needs its own code-signing
certificate to stop showing a SmartScreen warning.

**Status:** the MSIX build itself is ready. Nothing has been submitted to
Partner Center yet — the rest is portal work, tracked in the checklist below.

## Why MSIX, and why it doesn't need SignPath

Tauri doesn't produce MSIX itself — it only builds NSIS/MSI installers. For
Microsoft Store there are two submission types: a plain signed `.exe`/`.msi`
via a versioned download URL (which needs a certificate chaining to the
Microsoft Trusted Root Program — the same SignPath certificate direct
distribution is waiting on), or MSIX, where **Microsoft signs the package
for you at certification**. Going the MSIX route means the Store listing
doesn't have to wait on SignPath at all — only direct GitHub-Releases
downloads do.

Screenshotify uses Microsoft's own `winapp` CLI to turn the regular Tauri
build into an MSIX. See the official guide this setup follows:
[Using winapp CLI with Tauri](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/guides/tauri).

## One-off setup

1. Install the CLI: `winget install microsoft.winappcli`
2. From the repo root, run `winapp init` and choose **not** to set up SDKs
   (Tauri/Rust use the `windows` crate via Cargo, not winapp-managed C++/WinRT
   packages). This creates `Package.appxmanifest` and an `Assets/` icon
   folder **at the repo root** — `winapp` finds `src-tauri/tauri.conf.json`
   by looking one level below wherever it's run, so this only auto-detects
   correctly from the root. There's no supported way to tuck these into a
   subfolder without losing that detection, so they live next to
   `package.json` rather than under `src-tauri/`.
3. Fill in `Assets/` from the MSIX-shaped icons Tauri's icon generator
   already produced but never wired into `tauri.conf.json` —
   `src-tauri/icons/Square*Logo.png` and `StoreLogo.png` — instead of
   drawing new ones.
4. Generate a local dev-signing certificate: `winapp cert generate`. This
   writes `devcert.pfx` to the repo root — **never commit it** (it's
   gitignored, same as the updater signing key under `.tauri/`). It's only
   used to sign the package for local sideload testing and for the file you
   upload to Partner Center; Microsoft re-signs with their own certificate
   during certification, so this dev cert never needs to be a "real",
   trust-chained certificate.
5. `winapp cert install .\devcert.pfx` (elevated, one-time) to trust it on
   your own machine so a sideloaded install doesn't get rejected.

## Updating a published submission

`winapp` has no flag and no command to bump the package version for you, and
it doesn't read `package.json` — `Package.appxmanifest`'s
`<Identity Version="X.X.X.X" .../>` (MSIX's own 4-part major.minor.build.revision
format, unrelated to npm semver) is a plain, hand-maintained field. **Before
re-packaging for an update, edit that `Version` attribute up by hand.**
Partner Center hard-rejects a resubmission whose version isn't strictly
higher than the last one it has for this app ("must be uniquely identified by
their full names") — this is the one step in the whole MSIX flow that's easy
to forget and will fail the upload if skipped.

## Building it

```bash
npm run package:msix
```

This runs `tauri build --config src-tauri/tauri.msix.conf.json`, stages the
compiled `screenshotify.exe` into a throwaway `msix-stage/` folder (via
`scripts/stage-msix.js` — not `dist/`, which is Vite's own frontend build
output), then calls `winapp pack ./msix-stage --cert ./devcert.pfx` to
produce a `.msix` file.

`tauri.msix.conf.json` sets `bundle.createUpdaterArtifacts` to `false`.
Without it, `tauri build` tries to sign an updater `.sig` artifact for
`tauri-plugin-updater` and fails locally with "A public key has been found,
but no private key" — that signing key only exists as a GitHub Actions
secret (see [RELEASING.md](RELEASING.md)), for GitHub-Releases builds that
actually go through the in-app updater. MSIX never uses that updater at all
(see "Why this isn't wired into CI" below and `is_packaged()`), so this
build has no reason to need the key.

Tauri's `webviewInstallMode` setting (`downloadBootstrapper` /
`offlineInstaller` / `fixedVersion`) has **no effect here** — `winapp pack`
takes the raw compiled exe straight out of `target/release/`, bypassing
Tauri's own installer logic entirely, and MSIX has no install-time scripting
to run a WebView2 bootstrapper with anyway. This build currently assumes
WebView2 is already present on the target machine (true for Windows 11 out
of the box, and true for the large majority of Windows 10 machines via
Edge). If that ever turns out to be a real problem for users, the fix is
building with `fixedVersion` instead and staging the resulting WebView2
runtime folder alongside the exe — bigger package, fully self-contained.

## Testing it locally

```powershell
Add-AppxPackage .\Screenshotify_<version>_x64.msix
```

Confirm: the app installs and runs normally, and **Settings → Updates** hides
only the self-update controls. The version/license footer and **Star on
GitHub** button remain visible. `is_packaged()` (`src-tauri/src/lib.rs`)
detects the MSIX package identity because Windows services MSIX updates
itself rather than through `tauri-plugin-updater`. Also enable **Start
Screenshotify when I sign in to Windows**, sign out and back in, and confirm
the app starts in the system tray without opening its window.

## Why this isn't wired into CI

Unlike the GitHub-Releases build, Partner Center submission is a manual file
upload through its web UI, not something that pulls from a URL — pre-building
in CI wouldn't remove any manual step, and it would mean handling a signing
credential inside a CI job for no real benefit at this stage. `npm run
package:msix` stays a local, on-demand command, run only when actually
preparing a submission.

## Partner Center checklist

The rest of this is portal work with no code involved — do it directly in
[Partner Center](https://partner.microsoft.com/dashboard), not here:

- [ ] Register a free Individual developer account
- [ ] Reserve the app name ("Screenshotify") in Partner Center
- [ ] Complete the IARC age-rating questionnaire
- [ ] Enter the privacy policy URL:
      `https://github.com/shaqkao/screenshotify/blob/master/docs/PRIVACY.md`
- [ ] Upload the `.msix` produced by `npm run package:msix`
- [ ] Submit for certification — Microsoft signs the package as part of this

### Where the Store-specific pieces live

```
Package.appxmanifest                       MSIX identity manifest (repo root — see "One-off setup")
Assets/                                    MSIX tile/logo icons (repo root)
src-tauri/tauri.msix.conf.json             disables updater-artifact signing for this build only
scripts/stage-msix.js                      copies the built exe into msix-stage/ for winapp pack
src-tauri/src/lib.rs                       package detection, startup-task control and activation handling
docs/PRIVACY.md                            privacy policy Partner Center links to
```
