import { load } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";

/**
 * Every rename Screenshotify performs is recorded so it can be undone later —
 * including after a restart, which is why this is persisted rather than
 * kept in memory.
 */

const STORE_FILE = "history.json";
const KEY = "entries";
const LIMIT = 500;

let store = null;
let entries = [];
const listeners = new Set();

export async function initHistory() {
  store = await load(STORE_FILE, { autoSave: false });
  entries = (await store.get(KEY)) || [];
  return entries;
}

export function listEntries() {
  return entries;
}

export function onHistoryChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try {
      fn(entries);
    } catch (err) {
      console.error("history listener failed", err);
    }
  }
}

async function persist() {
  if (entries.length > LIMIT) entries = entries.slice(0, LIMIT);
  if (store) {
    await store.set(KEY, entries);
    await store.save();
  }
  emit();
}

export function newBatchId() {
  return `b${Date.now()}${Math.random().toString(16).slice(2, 6)}`;
}

export async function record({ from, to, batch, ext, size, width, height }) {
  const entry = {
    id: `h${Date.now()}${Math.random().toString(16).slice(2, 6)}`,
    batch: batch || newBatchId(),
    from,
    to,
    at: Date.now(),
    undone: false,
    // Captured at rename time so the info line still works after the file
    // has since moved, been undone, or the entry has aged out of view.
    ext,
    size,
    width,
    height,
  };
  entries.unshift(entry);
  await persist();
  return entry;
}

/** Moves the file back to its original name. Throws with a readable message. */
export async function undo(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry || entry.undone) return null;
  await invoke("revert_rename", { current: entry.to, original: entry.from });
  entry.undone = true;
  await persist();
  return entry;
}

/** Re-applies a previously-undone rename, back to the AI-suggested name. */
export async function redo(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry || !entry.undone) return null;
  const stem = basename(entry.to).replace(/\.[^./\\]+$/, "");
  // rename_to_stem avoids collisions by suffixing a number, so the file may
  // not land back at the exact original `to` path — capture what it returns.
  entry.to = await invoke("rename_file", { path: entry.from, stem });
  entry.undone = false;
  await persist();
  return entry;
}

function basename(p) {
  return String(p || "").split(/[\\/]/).pop();
}

/** Undoes every still-applied rename from the most recent batch. */
export async function undoLastBatch() {
  const latest = entries.find((e) => !e.undone);
  if (!latest) return { count: 0, failed: 0 };

  const targets = entries.filter((e) => e.batch === latest.batch && !e.undone);
  let count = 0;
  let failed = 0;
  for (const entry of targets) {
    try {
      await invoke("revert_rename", { current: entry.to, original: entry.from });
      entry.undone = true;
      count += 1;
    } catch (err) {
      console.error("undo failed", entry, err);
      failed += 1;
    }
  }
  await persist();
  return { count, failed };
}

export async function clearHistory() {
  entries = [];
  await persist();
}
