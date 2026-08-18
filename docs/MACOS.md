# Screenshotify on macOS

Everything here is macOS-specific. For what the app does, see the
[README](../README.md).

## Installing

1. Download `Screenshotify_universal.dmg` from the
   [latest release](https://github.com/shaqkao/screenshotify/releases/latest).
   One file covers both Apple Silicon and Intel.
2. Open it and drag **Screenshotify** to **Applications**.
3. **Right-click the app → Open**, then confirm.

Step 3 matters. Screenshotify is signed, but only ad-hoc — the project has no
paid Apple Developer ID and therefore cannot notarise builds. Double-clicking an
un-notarised app gets you a refusal with no way forward; right-click → Open gets
you the same warning *with* an Open button. You only need it once.

If macOS instead claims the app **"is damaged and can't be opened"**, that is
the quarantine flag on the download rather than anything wrong with the file.
Clear it once:

```bash
xattr -dr com.apple.quarantine /Applications/Screenshotify.app
```

## The permission prompt on first run

The first time Screenshotify reads your screenshot folder, macOS asks whether
to allow it. Say yes — without it the folder is watched but every file in it is
unreadable, which looks exactly like the app doing nothing.

If it was dismissed by accident: **System Settings → Privacy & Security → Files
and Folders → Screenshotify**, and turn the folder back on. Watching a folder
outside your home directory (an external disk, say) may need **Full Disk
Access** in the same place.

## Where it looks for screenshots

`Settings → Watched folders → Use default screenshot folder` resolves, in
order:

1. Whatever `com.apple.screencapture location` is set to — the setting behind
   the **Options → Save to** menu in the screenshot toolbar (⇧⌘5). This is
   checked first because someone who moved their screenshots did so on purpose.
2. `~/Desktop`, where macOS puts them out of the box.
3. `~/Pictures/Screenshots`.

Only folders that exist are added, so you normally end up with exactly one.

## How it behaves as a Mac app

- **Menu bar, not the Dock.** Closing the window (⌘W or the red button) hides
  it and drops Screenshotify out of the Dock and ⌘-Tab, leaving the menu bar
  icon. Turn that off with *Closing the window hides it to the menu bar instead
  of quitting* in Settings.
- **Clicking the menu bar icon opens its menu**, the way every other menu bar
  app works. **Open Screenshotify** is the first item.
- **Quit** is on that menu, and ⌘Q works when the window has focus.
- **Window controls** are the standard traffic lights, drawn over the app's own
  titlebar.
- **Start at login** installs a Launch Agent, and starts Screenshotify straight
  into the menu bar with no window and no Dock icon.
- **Your API key lives in the login Keychain**, under `Screenshotify` /
  `api-key`. You can inspect or delete it in Keychain Access.
- **Notifications** are plain macOS notifications. The Accept / Ignore buttons
  the Windows build puts on its toasts are not there: those need an app whose
  notification actions the system already trusts, which in practice means a
  notarised bundle.

## Building from source

```bash
xcode-select --install     # Command Line Tools, if you do not have them
brew install node          # or nodejs.org — 20 or newer
curl https://sh.rustup.rs -sSf | sh

npm install
npm run start              # dev build with hot reload
npm test                   # frontend unit tests
cargo test --manifest-path src-tauri/Cargo.toml
npm run release            # src-tauri/target/release/bundle/dmg/*.dmg
```

`npm run release` fails on a fresh checkout if `bundle.createUpdaterArtifacts`
is on and no updater signing key is available. Build without them:

```bash
npm run release -- --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

For a bundle that runs on Intel Macs too:

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
npm run release -- --target universal-apple-darwin
```

### Where the macOS-specific pieces live

```
src-tauri/tauri.macos.conf.json   window style, dmg layout, ad-hoc signing
src-tauri/Info.plist              the folder-access usage descriptions
src-tauri/icons/tray-macos-template.png
                                  menu bar icon, generated from the app icon's
                                  alpha channel so macOS can invert it
src-tauri/src/lib.rs              Dock visibility, Finder, menu bar behaviour
src-tauri/src/files.rs            screencapture location lookup
src-tauri/src/toast.rs            the non-Windows notification path
src/platform.js                   the platform facts the UI words itself from
```

`tauri.macos.conf.json` is merged over `tauri.conf.json` automatically when
building for macOS. The merge replaces arrays wholesale rather than merging
them, which is why `app.windows` is repeated there in full — a change to the
window size or minimums has to be made in both files.
