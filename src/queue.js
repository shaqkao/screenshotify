import { invoke } from "@tauri-apps/api/core";
import { getSettings } from "./settings.js";
import { buildStem } from "./naming.js";
import { recordUsage } from "./stats.js";
import { t } from "./i18n.js";

/**
 * Holds every screenshot awaiting review and runs the AI calls with a bounded
 * number of parallel requests. Nothing here touches the filesystem — applying
 * a suggestion is an explicit user action handled in review.js.
 */

let seq = 0;
const items = new Map(); // id -> item
const byPath = new Map(); // path -> id
const waiting = []; // ids queued for the model
let active = 0;
let cancelled = false;

const listeners = new Set();

export function onQueueChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(type, item) {
  for (const fn of listeners) {
    try {
      fn(type, item);
    } catch (err) {
      console.error("queue listener failed", err);
    }
  }
}

export function allItems() {
  return [...items.values()];
}

export function getItem(id) {
  return items.get(id);
}

export function pendingCount() {
  return allItems().filter((i) => i.status === "ready" || i.status === "working" || i.status === "pending").length;
}

export function readyCount() {
  return allItems().filter((i) => i.status === "ready").length;
}

export function errorCount() {
  return allItems().filter((i) => i.status === "error").length;
}

export function isBusy() {
  return active > 0 || waiting.length > 0;
}

export function remaining() {
  return active + waiting.length;
}

/* ── Adding work ──────────────────────────────────────────────────────── */

/**
 * `entry` comes from Rust (scan_folder / file_info) and already carries the
 * split name, size and creation time.
 */
export function addFile(entry, { source = "watch" } = {}) {
  if (byPath.has(entry.path)) return null;

  const item = {
    id: `i${++seq}`,
    path: entry.path,
    name: entry.name,
    stem: entry.stem,
    ext: entry.ext,
    size: entry.size,
    width: entry.width,
    height: entry.height,
    createdMs: entry.created,
    source,
    status: "pending",
    suggestion: "",
    raw: "",
    edited: false,
    error: "",
    thumb: null,
  };

  items.set(item.id, item);
  byPath.set(item.path, item.id);
  waiting.push(item.id);
  emit("add", item);
  pump();
  return item;
}

export function addMany(entries, opts) {
  const added = [];
  for (const e of entries) {
    const it = addFile(e, opts);
    if (it) added.push(it);
  }
  return added;
}

export function removeItem(id) {
  const item = items.get(id);
  if (!item) return;
  items.delete(id);
  byPath.delete(item.path);
  const idx = waiting.indexOf(id);
  if (idx >= 0) waiting.splice(idx, 1);
  emit("remove", item);
}

export function clearAll() {
  for (const item of allItems()) removeItem(item.id);
  emit("clear", null);
}

export function cancelPending() {
  cancelled = true;
  while (waiting.length) {
    const id = waiting.pop();
    const item = items.get(id);
    if (item && item.status === "pending") {
      item.status = "error";
      item.error = t("queue.cancelled");
      emit("update", item);
    }
  }
  cancelled = false;
  emit("progress", null);
}

export function retryFailed() {
  for (const item of allItems()) {
    if (item.status !== "error") continue;
    item.status = "pending";
    item.error = "";
    waiting.push(item.id);
    emit("update", item);
  }
  pump();
}

export function retryOne(id) {
  const item = items.get(id);
  if (!item || item.status === "working") return;
  item.status = "pending";
  item.error = "";
  item.edited = false;
  waiting.push(item.id);
  emit("update", item);
  pump();
}

/* ── Prompt ───────────────────────────────────────────────────────────── */

export function buildPrompt(settings) {
  const lang = (settings.language || "English").trim() || "English";
  const lines = [
    `Look at this screenshot and write a short, specific filename describing what it shows.`,
    `Answer in ${lang}, using at most ${settings.maxWords} words.`,
    `Name the application, website or document if it is identifiable, then the main subject or action on screen.`,
    `Do not include dates, times, resolutions, file extensions, quotes, or the word "screenshot".`,
    `Reply with the filename only — no explanation, no punctuation at the end.`,
  ];
  const extra = (settings.promptExtra || "").trim();
  if (extra) lines.push(extra);
  return lines.join("\n");
}

/* ── Running ──────────────────────────────────────────────────────────── */

function pump() {
  const settings = getSettings();
  const limit = Math.max(1, Math.min(6, settings.concurrency || 2));
  while (active < limit && waiting.length && !cancelled) {
    const id = waiting.shift();
    const item = items.get(id);
    if (!item || item.status !== "pending") continue;
    run(item);
  }
  emit("progress", null);
}

async function run(item) {
  active += 1;
  item.status = "working";
  emit("update", item);

  const settings = getSettings();
  try {
    const result = await invoke("suggest_filename", {
      path: item.path,
      baseUrl: settings.baseUrl,
      model: settings.model,
      prompt: buildPrompt(settings),
      maxEdge: settings.maxEdge,
    });
    const raw = result.text;
    recordUsage(result.model, result.prompt_tokens, result.completion_tokens).catch((err) =>
      console.error("failed to record usage stats", err)
    );

    const stem = buildStem({
      raw,
      style: settings.caseStyle,
      prefixMode: settings.datePrefix,
      maxWords: settings.maxWords,
      createdMs: item.createdMs,
    });

    item.raw = raw;
    if (!stem) {
      item.status = "error";
      item.error = t("queue.unusableName");
    } else {
      item.suggestion = stem;
      item.status = "ready";
      item.error = "";
    }
  } catch (err) {
    item.status = "error";
    item.error = String(err);
  } finally {
    active -= 1;
    emit("update", item);
    pump();
  }
}

/** Re-applies the current naming settings to suggestions already fetched. */
export function restyleAll() {
  const settings = getSettings();
  for (const item of allItems()) {
    if (item.status !== "ready" || item.edited || !item.raw) continue;
    const stem = buildStem({
      raw: item.raw,
      style: settings.caseStyle,
      prefixMode: settings.datePrefix,
      maxWords: settings.maxWords,
      createdMs: item.createdMs,
    });
    if (stem) {
      item.suggestion = stem;
      emit("update", item);
    }
  }
}
