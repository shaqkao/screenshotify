import { load } from "@tauri-apps/plugin-store";

/**
 * Tracks which model IDs Screenshotify has actually sent requests to, and
 * how many tokens each one has used — purely local, purely informational,
 * shown in Settings so switching models over time doesn't erase the record
 * of what ran up usage.
 */

const STORE_FILE = "stats.json";
const KEY = "models";

let store = null;
let models = {}; // model id -> { requests, promptTokens, completionTokens, lastUsed }
const listeners = new Set();

export async function initStats() {
  store = await load(STORE_FILE, { autoSave: false });
  models = (await store.get(KEY)) || {};
  return models;
}

export function getModelUsage() {
  return models;
}

export function onStatsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try {
      fn(models);
    } catch (err) {
      console.error("stats listener failed", err);
    }
  }
}

async function persist() {
  if (store) {
    await store.set(KEY, models);
    await store.save();
  }
  emit();
}

export async function recordUsage(model, promptTokens, completionTokens) {
  const id = (model || "").trim();
  if (!id) return;

  const entry = models[id] || { requests: 0, promptTokens: 0, completionTokens: 0 };
  entry.requests += 1;
  entry.promptTokens += promptTokens || 0;
  entry.completionTokens += completionTokens || 0;
  entry.lastUsed = Date.now();
  models = { ...models, [id]: entry };
  await persist();
}

export async function resetStats() {
  models = {};
  await persist();
}
