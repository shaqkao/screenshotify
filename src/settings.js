import { load } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";

/**
 * Settings live in a JSON store next to the app data; the API key is the one
 * thing that never touches it — that goes to the Windows Credential Manager
 * through the Rust side and is never sent back to the frontend.
 */

export const DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  watchFolders: [],
  watchEnabled: true,
  notifications: true,
  autostart: false,
  startMinimized: true,
  closeToTray: true,
  caseStyle: "kebab",
  datePrefix: "none",
  maxWords: 6,
  language: "English",
  promptExtra: "",
  concurrency: 2,
  maxEdge: 1024,
  listColumns: 1,
  autoUpdate: true,
};

const STORE_FILE = "settings.json";
const KEY = "settings";

let store = null;
let cache = { ...DEFAULTS };
const listeners = new Set();

export async function initSettings() {
  store = await load(STORE_FILE, { autoSave: false });
  const saved = (await store.get(KEY)) || {};
  cache = { ...DEFAULTS, ...saved };

  // A fresh install with no folder configured is useless, so seed the
  // standard Windows screenshot location when it exists.
  if (!saved.watchFolders) {
    const guessed = await invoke("default_screenshot_folders").catch(() => []);
    if (guessed.length) {
      cache.watchFolders = guessed;
      // Persist the seed so the choice is visible and editable rather than
      // silently re-derived on every launch.
      await store.set(KEY, cache);
      await store.save();
    }
  }
  return cache;
}

export function getSettings() {
  return cache;
}

export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function updateSettings(patch) {
  const before = cache;
  cache = { ...cache, ...patch };
  if (store) {
    await store.set(KEY, cache);
    await store.save();
  }
  for (const fn of listeners) {
    try {
      fn(cache, before, patch);
    } catch (err) {
      console.error("settings listener failed", err);
    }
  }
  return cache;
}

/* ── API key (Windows Credential Manager, via Rust) ───────────────────── */

export async function saveApiKey(key) {
  await invoke("set_api_key", { key });
}

export async function clearApiKey() {
  await invoke("delete_api_key");
}

export async function hasApiKey() {
  return invoke("has_api_key");
}
