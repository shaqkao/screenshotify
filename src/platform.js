import { invoke } from "@tauri-apps/api/core";

/**
 * The handful of things the UI has to word — or lay out — differently per
 * platform. Read from Rust (see `platform_info` in src-tauri/src/lib.rs) rather
 * than sniffed from the user agent, so there is exactly one source of truth for
 * which platform this is.
 *
 * The values below are only ever used if that call fails; Windows was the first
 * platform, so it is the one to fall back to.
 */
let info = {
  os: "windows",
  keyStore: "Windows Credential Manager",
  trayName: "system tray",
  fileManager: "File Explorer",
  loginPhrase: "sign in to Windows",
};

export async function initPlatform() {
  try {
    info = { ...info, ...(await invoke("platform_info")) };
  } catch (err) {
    console.error("could not read the platform info", err);
  }
  // Drives the platform-specific rules in styles.css — chiefly the titlebar,
  // which is ours to draw on Windows but belongs to macOS on macOS.
  document.documentElement.dataset.os = info.os;
  return info;
}

export function platform() {
  return info;
}

export function isMac() {
  return info.os === "macos";
}
