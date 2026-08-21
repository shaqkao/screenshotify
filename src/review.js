import { invoke } from "@tauri-apps/api/core";
import * as queue from "./queue.js";
import * as history from "./history.js";
import { sanitizeUserStem } from "./naming.js";
import { toast } from "./toast.js";
import { t } from "./i18n.js";
import { showImageContextMenu } from "./contextmenu.js";

/**
 * The review list. Rows are created once per queued file and mutated in place
 * so that typing in a name field is never interrupted by a re-render.
 */

const rows = new Map(); // id -> { el, refs }
let listEl;
let emptyEl;
let thumbObserver;

// Same closed/open folder glyphs as the "Scan a folder…" toolbar button
// (index.html #btn-scan) — kept in sync with it so every folder-reveal
// control in the app shares one icon.
const FOLDER_CLOSED_PATH =
  "M168-192q-29 0-50.5-21.5T96-264v-432q0-30 21.5-51t50.5-21h216l96 96h312q30 0 51 21t21 51v336q0 29-21 50.5T792-192H168Z";
const FOLDER_OPEN_PATH =
  "M168-192q-32 0-52-21t-20-51v-432q0-30 20-51t52-21h216l96 96h313q31 0 50.5 21t21.5 51H168v336l78-264h690l-85 285q-8 23-21 37t-38 14H168Z";

function statusText(status) {
  return {
    pending: t("review.statusPending"),
    working: t("review.statusWorking"),
    ready: t("review.statusReady"),
    error: t("review.statusError"),
  }[status] || status;
}

/** Applies the "photos per row" setting; 1 keeps the plain single-column list. */
export function setColumns(n) {
  const cols = Math.min(3, Math.max(1, Number(n) || 1));
  listEl.classList.toggle("is-grid", cols > 1);
  listEl.style.setProperty("--list-cols", cols);
  listEl.dataset.cols = cols;
}

export function initReview() {
  listEl = document.getElementById("review-list");
  emptyEl = document.getElementById("review-empty");

  thumbObserver = new IntersectionObserver(
    (records) => {
      for (const rec of records) {
        if (!rec.isIntersecting) continue;
        const el = rec.target;
        thumbObserver.unobserve(el);
        loadThumb(el);
      }
    },
    { root: listEl, rootMargin: "300px" }
  );

  queue.onQueueChange((type, item) => {
    if (type === "add") addRow(item);
    else if (type === "update") updateRow(item);
    else if (type === "remove") dropRow(item);
    else if (type === "clear") syncAll();
    refreshChrome();
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeLightbox();
  });

  syncAll();
}

async function loadThumb(el) {
  const path = el.dataset.path;
  try {
    const src = await invoke("thumbnail", { path, maxEdge: 320 });
    setThumbSrc(el, src);
  } catch {
    el.classList.add("thumb-failed");
  }
}

/**
 * Renders the thumbnail as a CSS background-image on a <div> rather than an
 * <img src>. An <img> kept intermittently flashing the browser's native
 * broken-image glyph in the real WebView2 runtime during the instant between
 * a new src being assigned and it actually being paintable, no matter how
 * that instant was timed around (opacity, `load`, `decode()` — all tried and
 * all still let it through). A background-image has no such native fallback
 * glyph at all, so preloading off-DOM and only then applying it removes the
 * failure mode entirely instead of continuing to race it.
 */
function setThumbSrc(el, src) {
  el.classList.remove("is-loaded", "thumb-failed");
  el.dataset.pendingSrc = src;
  const preload = new Image();
  preload.onload = () => {
    if (el.dataset.pendingSrc !== src) return; // superseded by a newer request
    el.style.backgroundImage = `url("${src}")`;
    el.classList.add("is-loaded");
  };
  preload.onerror = () => {
    if (el.dataset.pendingSrc === src) el.classList.add("thumb-failed");
  };
  preload.src = src;
}

/* ── Row construction ─────────────────────────────────────────────────── */

function addRow(item) {
  const el = document.createElement("div");
  el.className = "row";
  el.dataset.id = item.id;

  const thumbWrap = document.createElement("div");
  thumbWrap.className = "thumb-wrap";

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.dataset.path = item.path;
  thumb.addEventListener("click", () => openLightbox(item));
  thumb.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const it = queue.getItem(item.id);
    if (it) showImageContextMenu(ev.clientX, ev.clientY, it.path);
  });

  const spinner = document.createElement("div");
  spinner.className = "chaotic-orbit";
  thumbWrap.append(thumb, spinner);

  const main = document.createElement("div");
  main.className = "row-main";

  const original = document.createElement("div");
  original.className = "row-original";
  original.title = item.path;
  original.innerHTML = "<b></b>";
  original.querySelector("b").textContent = item.name;

  const info = document.createElement("div");
  info.className = "row-info";
  info.textContent = formatFileInfo(item);

  const input = document.createElement("input");
  input.className = "name-input";
  input.type = "text";
  input.spellcheck = false;
  input.placeholder = t("review.namePlaceholder");
  input.disabled = true;
  input.addEventListener("input", () => {
    const it = queue.getItem(item.id);
    if (it) {
      it.edited = true;
      it.suggestion = input.value;
    }
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") applyOne(item.id);
  });

  const meta = document.createElement("div");
  meta.className = "row-meta";
  const status = document.createElement("span");
  status.className = "status status-pending";
  const detail = document.createElement("span");
  meta.append(status, detail);

  main.append(original, input, info, meta);

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn-primary btn-sm";
  applyBtn.textContent = t("review.apply");
  applyBtn.disabled = true;
  applyBtn.addEventListener("click", () => applyOne(item.id));

  const skipBtn = document.createElement("button");
  skipBtn.className = "btn btn-ghost btn-sm";
  skipBtn.textContent = t("review.skip");
  skipBtn.title = t("review.skipTitle");
  skipBtn.addEventListener("click", () => queue.removeItem(item.id));

  const retryBtn = document.createElement("button");
  retryBtn.className = "btn btn-sm";
  retryBtn.textContent = t("review.retry");
  retryBtn.hidden = true;
  retryBtn.addEventListener("click", () => queue.retryOne(item.id));

  const revealBtn = document.createElement("button");
  revealBtn.className = "btn btn-ghost btn-icon-only btn-folder-reveal";
  revealBtn.title = t("review.openFolder");
  revealBtn.innerHTML =
    `<svg class="btn-icon" viewBox="0 -960 960 960" aria-hidden="true">` +
    `<path class="icon-folder-closed" d="${FOLDER_CLOSED_PATH}"></path>` +
    `<path class="icon-folder-open" d="${FOLDER_OPEN_PATH}"></path>` +
    `</svg>`;
  revealBtn.addEventListener("click", async () => {
    const it = queue.getItem(item.id);
    try {
      await invoke("reveal_file", { path: it.path });
    } catch (err) {
      toast(t("review.openFolderFailed", { error: err }), { kind: "err" });
    }
  });

  actions.append(retryBtn, revealBtn, skipBtn, applyBtn);
  el.append(thumbWrap, main, actions);

  rows.set(item.id, {
    el,
    refs: { thumb, input, status, detail, applyBtn, skipBtn, retryBtn, revealBtn, original },
  });
  listEl.append(el);
  thumbObserver.observe(thumb);
  updateRow(item);
}

function dropRow(item) {
  const row = rows.get(item.id);
  if (!row) return;
  row.el.remove();
  rows.delete(item.id);
}

function updateRow(item) {
  const row = rows.get(item.id);
  if (!row) return;
  const { el, refs } = row;

  el.classList.toggle("is-error", item.status === "error");

  refs.status.className = `status status-${item.status}`;
  refs.status.textContent = "";
  if (item.status === "working") {
    const sp = document.createElement("i");
    sp.className = "spinner";
    refs.status.append(sp);
  }
  refs.status.append(document.createTextNode(statusText(item.status)));

  if (item.status === "error") {
    refs.detail.textContent = item.error;
    refs.detail.title = item.error;
  } else {
    refs.detail.textContent = item.edited ? t("review.edited") : "";
  }

  const editable = item.status === "ready";
  refs.input.disabled = !editable;
  if (document.activeElement !== refs.input) {
    refs.input.value = item.suggestion;
  }

  refs.applyBtn.disabled = !editable;
  refs.retryBtn.hidden = item.status !== "error";
}

/**
 * Re-labels every row already in the list after the interface language
 * changes. Only text content moves — the thumbnail elements are left alone,
 * same reasoning as renderHistory in main.js: touching them would restart
 * their image loading and cause every visible thumbnail to flash.
 */
export function refreshLocale() {
  for (const [id, row] of rows) {
    const item = queue.getItem(id);
    const { refs } = row;
    refs.input.placeholder = t("review.namePlaceholder");
    refs.applyBtn.textContent = t("review.apply");
    refs.skipBtn.textContent = t("review.skip");
    refs.skipBtn.title = t("review.skipTitle");
    refs.retryBtn.textContent = t("review.retry");
    refs.revealBtn.title = t("review.openFolder");
    if (item) updateRow(item);
  }
  refreshChrome();
}

/** Human-readable file size, e.g. 924 B / 245 KB / 3.1 MB. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Builds the "PNG · 1920×1080 · 245 KB" line shown under a thumbnail. */
export function formatFileInfo({ ext, width, height, size }) {
  const parts = [];
  if (ext) parts.push(String(ext).toUpperCase());
  if (width && height) parts.push(`${width}×${height}`);
  if (Number.isFinite(size)) parts.push(formatBytes(size));
  return parts.join(" · ");
}

function syncAll() {
  for (const [, row] of rows) row.el.remove();
  rows.clear();
  for (const item of queue.allItems()) addRow(item);
  refreshChrome();
}

/* ── Applying ─────────────────────────────────────────────────────────── */

async function apply(id, batch) {
  const item = queue.getItem(id);
  if (!item || item.status !== "ready") return null;

  const stem = sanitizeUserStem(item.suggestion);
  if (!stem) {
    toast(t("review.emptyName"), { kind: "err" });
    return null;
  }

  try {
    const newPath = await invoke("rename_file", { path: item.path, stem });
    const entry = await history.record({
      from: item.path,
      to: newPath,
      batch,
      ext: item.ext,
      size: item.size,
      width: item.width,
      height: item.height,
    });
    // Renamed files move to History and no longer belong in Review.
    queue.removeItem(item.id);
    return entry;
  } catch (err) {
    item.status = "error";
    item.error = String(err);
    updateRow(item);
    refreshChrome();
    return null;
  }
}

export async function applyOne(id) {
  const entry = await apply(id);
  if (entry) {
    toast(t("review.renamed"), {
      kind: "ok",
      action: { label: t("review.undo"), onClick: () => history.undo(entry.id) },
    });
  }
}

export function skipAll() {
  for (const item of queue.allItems()) {
    if (item.status === "ready") queue.removeItem(item.id);
  }
  refreshChrome();
}

export async function applyAll() {
  const ready = queue.allItems().filter((i) => i.status === "ready");
  if (!ready.length) return;

  const batch = history.newBatchId();
  let done = 0;
  let failed = 0;
  for (const item of ready) {
    // eslint-disable-next-line no-await-in-loop
    const entry = await apply(item.id, batch);
    if (entry) done += 1;
    else failed += 1;
  }

  const msg = failed
    ? t("review.appliedSome", { count: done, failed })
    : t("review.appliedAll", { count: done });
  toast(msg, {
    kind: failed ? "err" : "ok",
    timeout: 9000,
    action: {
      label: t("review.undoAll"),
      onClick: async () => {
        const res = await history.undoLastBatch();
        toast(t("review.restoredCount", { count: res.count }), { kind: "ok" });
      },
    },
  });
}

/* ── Chrome (empty state, counters, buttons) ──────────────────────────── */

export function refreshChrome() {
  const items = queue.allItems();
  const ready = queue.readyCount();
  const failed = queue.errorCount();

  emptyEl.hidden = items.length > 0;
  listEl.style.display = items.length ? "" : "none";

  document.getElementById("btn-apply-all").disabled = ready === 0;
  document.getElementById("btn-retry-failed").hidden = failed === 0;

  const badge = document.getElementById("tab-badge");
  badge.hidden = ready === 0;
  badge.textContent = String(ready);

  const status = document.getElementById("queue-status");
  const busy = queue.remaining();
  if (busy > 0) status.textContent = t("review.busy", { count: busy });
  else if (items.length) status.textContent = t("review.listStatus", { count: items.length, ready });
  else status.textContent = "";
}

/* ── Lightbox ─────────────────────────────────────────────────────────── */

let lightbox = null;

export async function openLightbox(item) {
  closeLightbox();
  lightbox = document.createElement("div");
  lightbox.className = "lightbox";
  const img = document.createElement("img");
  lightbox.append(img);
  lightbox.addEventListener("click", closeLightbox);
  // The image itself, not the dimmed backdrop — copies the original
  // full-resolution file at item.path, same as right-clicking its thumbnail.
  img.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    showImageContextMenu(ev.clientX, ev.clientY, item.path);
  });
  document.body.append(lightbox);
  try {
    img.src = await invoke("thumbnail", { path: item.path, maxEdge: 1600 });
  } catch (err) {
    closeLightbox();
    toast(t("review.previewFailed", { error: err }), { kind: "err" });
  }
}

function closeLightbox() {
  if (lightbox) {
    lightbox.remove();
    lightbox = null;
  }
}
