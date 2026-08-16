import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";

import {
  initSettings,
  getSettings,
  updateSettings,
  onSettingsChange,
  saveApiKey,
  clearApiKey,
  hasApiKey,
} from "./settings.js";
import { initStats, getModelUsage, onStatsChange, resetStats } from "./stats.js";
import * as queue from "./queue.js";
import * as history from "./history.js";
import { initReview, applyAll, skipAll, refreshChrome, formatFileInfo, openLightbox, setColumns } from "./review.js";
import { toast } from "./toast.js";

const REPO_URL = "https://github.com/shaqkao/screenshotify";
const PROVIDER_GUIDE_URL = "https://github.com/shaqkao/screenshotify/blob/master/provider.md";
/** Above this many files, a folder scan asks for confirmation first. */
const BULK_CONFIRM_AT = 50;
/** Mirrors files::IMAGE_EXTS on the Rust side; only used for the file-picker filter. */
const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"];
const $ = (id) => document.getElementById(id);

let notifyAllowed = false;
let notifyTimer = null;
let pendingNotifyNames = [];
const notifiedIds = new Set();

// WebView2's default context menu (Back, Reload, Save As, Print, Inspect…)
// is browser chrome that has no place in a packaged app.
document.addEventListener("contextmenu", (e) => e.preventDefault());

/* ══════════════════════════ Bootstrap ══════════════════════════ */

async function main() {
  await initSettings();
  await initStats();
  await history.initHistory();

  initReview();
  applyListColumns();
  initTitlebar();
  initSidebarToggle();
  initTabs();
  initReviewToolbar();
  initHistoryView();
  await initSettingsForm();
  await initNotifications();
  initBackendEvents();

  history.onHistoryChange(applyHistoryFilter);
  applyHistoryFilter();

  await applyWatchState();
  await showWindowIfWanted();

  $("app-version").textContent = `v${await getVersion()}`;

  if (getSettings().autoUpdate) {
    // Never block startup on the network.
    setTimeout(() => checkForUpdates({ silent: true }), 4000);
  }
}

/**
 * The window is created hidden so a tray-only launch never flashes on screen.
 * Whether it should actually appear is decided here, once settings are loaded.
 */
async function showWindowIfWanted() {
  const win = getCurrentWindow();
  try {
    const fromStartup = await invoke("launched_minimized");
    if (fromStartup || getSettings().startMinimized) return;
  } catch (err) {
    console.error("could not read the launch mode", err);
  }
  try {
    await win.setSkipTaskbar(false);
    await win.show();
    await win.setFocus();
  } catch (err) {
    console.error("could not show the window", err);
  }
}

/* ══════════════════════════ Titlebar ══════════════════════════ */

/**
 * Custom titlebar controls, needed because decorations:false in
 * tauri.conf.json hands us the whole window frame (the dragging itself is
 * handled declaratively by the data-tauri-drag-region attribute in
 * index.html — this just wires the three buttons).
 */
const MAXIMIZE_PATH =
  "M86-86v-260h126v134h134v126H86Zm529 0v-126h133v-134h126v260H615ZM86-615v-259h260v126H212v133H86Zm662 0v-133H615v-126h259v259H748Z";
const RESTORE_PATH =
  "M220-86v-134H86v-126h260v260H220Zm395 0v-260h259v126H741v134H615ZM86-615v-126h134v-133h126v259H86Zm529 0v-259h126v133h133v126H615Z";

function initTitlebar() {
  const win = getCurrentWindow();
  const maximizeBtn = $("titlebar-maximize");
  const maximizeIconPath = document.querySelector("#titlebar-maximize-icon path");

  // win.isMaximized() reads the OS-level "maximized" window style, which on
  // Windows doesn't reliably get set for a decorations:false window — never
  // once reported true here despite the window visibly filling the screen.
  // Comparing the window's actual outer size against its monitor sidesteps
  // that flag entirely. The two don't land on an exact match even while
  // genuinely maximized (measured ~1936x1048 outer size on a 1920x1080
  // screen — Windows' usual sizing slop for a borderless resizable window),
  // hence the tolerance rather than requiring one.
  const FILL_TOLERANCE = 60;
  const isFilling = async () => {
    const monitor = await currentMonitor();
    if (!monitor) return false;
    const size = await win.outerSize();
    return (
      Math.abs(size.width - monitor.size.width) <= FILL_TOLERANCE &&
      Math.abs(size.height - monitor.size.height) <= FILL_TOLERANCE
    );
  };

  const syncMaximized = async () => {
    const maximized = await isFilling();
    // Swap the path data on one icon rather than toggling `hidden` between
    // two — the latter visibly failed to repaint here despite the DOM state
    // itself being correct (confirmed via logging), a WebView2 quirk with
    // display toggling on flex-item SVGs. Changing what's actually painted
    // sidesteps that entirely.
    maximizeIconPath.setAttribute("d", maximized ? RESTORE_PATH : MAXIMIZE_PATH);
    maximizeBtn.title = maximized ? "Restore Down" : "Maximize";
    maximizeBtn.setAttribute("aria-label", maximizeBtn.title);
  };

  $("titlebar-minimize").addEventListener("click", () => win.minimize());
  maximizeBtn.addEventListener("click", async () => {
    // Don't rely solely on onResized below: it fires off the OS resize
    // event, which on Windows can arrive a tick before isMaximized() itself
    // reports the new state, so a check made only there can read stale.
    // toggleMaximize()'s own promise, by contrast, only resolves after the
    // platform call it wraps has already happened.
    await win.toggleMaximize();
    syncMaximized();
  });
  $("titlebar-close").addEventListener("click", () => win.close());

  win.onResized(syncMaximized);
  syncMaximized();
}

/* ══════════════════════════ Sidebar ══════════════════════════ */

function initSidebarToggle() {
  const sidebar = document.querySelector(".sidebar");
  const toggle = $("sidebar-toggle");

  const apply = (collapsed) => {
    sidebar.classList.toggle("is-collapsed", collapsed);
    toggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    toggle.setAttribute("aria-expanded", String(!collapsed));
  };

  apply(!!getSettings().sidebarCollapsed);

  toggle.addEventListener("click", async () => {
    const collapsed = !sidebar.classList.contains("is-collapsed");
    apply(collapsed);
    await updateSettings({ sidebarCollapsed: collapsed });
  });
}

/* ══════════════════════════ Tabs ══════════════════════════ */

/** Set by initTabPill; a no-op until the tab bar exists. */
let movePill = () => {};

function initTabs() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  }
  initTabPill();
}

/**
 * Slides the active-tab highlight to whichever tab is selected. Measured live
 * rather than driven by fixed offsets, because the Review tab changes width
 * whenever its badge appears or disappears.
 */
function initTabPill() {
  const nav = document.querySelector(".tabs");
  const pill = nav?.querySelector(".tab-pill");
  if (!nav || !pill) return;

  movePill = () => {
    const tab = nav.querySelector(".tab.is-active");
    if (!tab) return;
    const navBox = nav.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    // The pill's left/top: 0 is the bar's padding box, whose edge sits just
    // inside the border — so only the border width comes out, not the padding.
    const x = tabBox.left - navBox.left - nav.clientLeft;
    const y = tabBox.top - navBox.top - nav.clientTop;
    pill.style.width = `${tabBox.width}px`;
    pill.style.height = `${tabBox.height}px`;
    pill.style.transform = `translate(${x}px, ${y}px)`;
  };

  movePill();
  requestAnimationFrame(() => pill.classList.add("is-ready"));

  const observer = new ResizeObserver(() => movePill());
  observer.observe(nav);
  for (const tab of nav.querySelectorAll(".tab")) observer.observe(tab);
}

function showView(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("is-active", tab.dataset.view === name);
  }
  for (const view of document.querySelectorAll(".view")) {
    view.classList.toggle("is-active", view.id === `view-${name}`);
  }
  movePill();
}

/* ══════════════════════════ Backend events ══════════════════════════ */

function initBackendEvents() {
  // A new screenshot finished being written to a watched folder.
  listen("screenshotify://file-detected", async (event) => {
    const entry = event.payload;
    queue.addFile(entry, { source: "watch" });
  });

  listen("screenshotify://watch-error", async (event) => {
    const { fatal, message } = event.payload;
    toast(fatal ? `Folder watching stopped: ${message}` : message, {
      kind: "err",
      timeout: 12000,
    });
    // A skipped folder is not a reason to claim nothing is being watched.
    if (fatal) {
      await updateSettings({ watchEnabled: false });
      $("set-watch-enabled").checked = false;
      renderWatchPill();
    }
  });

  // Tray menu items are handled in Rust and forwarded here.
  listen("screenshotify://tray", (event) => {
    if (event.payload === "scan") {
      showView("review");
      scanFolder();
    } else if (event.payload === "toggle-watch") {
      toggleWatch();
    }
  });

  listen("screenshotify://show-review", () => showView("review"));

  // Our own Windows toast (src-tauri/src/toast.rs) reports which button, if
  // any, the user clicked.
  listen("screenshotify://toast-action", async (event) => {
    if (event.payload === "accept") {
      await applyAll();
    } else if (event.payload === "ignore") {
      skipAll();
    } else {
      await invoke("show_main_window").catch(() => {});
      showView("review");
    }
  });

  queue.onQueueChange((type, item) => {
    if (type === "update" || type === "add") updateTrayTooltip();
    if (
      type === "update" &&
      item &&
      item.status === "ready" &&
      item.source === "watch" &&
      !notifiedIds.has(item.id)
    ) {
      notifiedIds.add(item.id);
      scheduleNotification(item);
    }
  });
}

/* ══════════════════════════ Notifications ══════════════════════════ */

async function initNotifications() {
  try {
    notifyAllowed = await isPermissionGranted();
    if (!notifyAllowed) notifyAllowed = (await requestPermission()) === "granted";
  } catch {
    notifyAllowed = false;
  }
}

/**
 * Screenshots often arrive in bursts. Collapsing them into one notification a
 * couple of seconds later is far less annoying than one toast per file. Fired
 * once a suggestion is actually ready, so the toast can show the name itself
 * instead of a generic count.
 */
function scheduleNotification(item) {
  if (!getSettings().notifications || !notifyAllowed) return;
  pendingNotifyNames.push(`${item.suggestion}.${item.ext}`);
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(async () => {
    const names = pendingNotifyNames;
    pendingNotifyNames = [];
    notifyTimer = null;

    // Don't interrupt someone who is already looking at the list.
    const win = getCurrentWindow();
    if ((await win.isVisible()) && (await win.isFocused())) return;

    await invoke("notify_review_ready", { names }).catch((err) =>
      console.error("failed to show notification", err)
    );
  }, 2500);
}

async function updateTrayTooltip() {
  const ready = queue.readyCount();
  try {
    await invoke("set_tray_state", {
      pending: ready,
      watching: !!getSettings().watchEnabled,
    });
  } catch {
    /* tray may not exist yet during startup */
  }
}

/* ══════════════════════════ Watching ══════════════════════════ */

async function applyWatchState() {
  const s = getSettings();
  renderWatchPill();
  try {
    if (s.watchEnabled && s.watchFolders.length) {
      await invoke("start_watching", { folders: s.watchFolders });
    } else {
      await invoke("stop_watching");
    }
  } catch (err) {
    toast(`Could not start watching: ${err}`, { kind: "err" });
  }
  updateTrayTooltip();
}

function renderWatchPill() {
  const s = getSettings();
  const on = s.watchEnabled && s.watchFolders.length > 0;
  const pill = $("watch-toggle");
  pill.classList.toggle("is-on", on);
  $("watch-label").textContent = !s.watchFolders.length
    ? "No folders"
    : on
      ? "Watching"
      : "Paused";
  pill.title = on
    ? `Watching ${s.watchFolders.length} folder${s.watchFolders.length === 1 ? "" : "s"} — click to pause`
    : "Click to resume watching";

  const hint = $("empty-hint");
  if (hint) {
    hint.textContent = !s.watchFolders.length
      ? "No folders are being watched yet. Add one in Settings, or scan an existing folder below."
      : on
        ? "Screenshotify is watching your screenshot folders. Take a screenshot and a suggested name will show up here."
        : "Watching is paused. Resume it from the button in the top-right, or scan a folder below.";
  }
}

async function toggleWatch() {
  const s = getSettings();
  if (!s.watchFolders.length) {
    showView("settings");
    toast("Add a folder to watch first.", { kind: "info" });
    return;
  }
  await updateSettings({ watchEnabled: !s.watchEnabled });
  $("set-watch-enabled").checked = getSettings().watchEnabled;
  await applyWatchState();
}

/* ══════════════════════════ Review toolbar ══════════════════════════ */

function initReviewToolbar() {
  $("watch-toggle").addEventListener("click", toggleWatch);
  $("btn-scan").addEventListener("click", scanFolder);
  $("btn-pick-files").addEventListener("click", pickFiles);
  $("btn-apply-all").addEventListener("click", applyAll);
  $("btn-retry-failed").addEventListener("click", () => queue.retryFailed());
  $("btn-cancel-scan").addEventListener("click", () => queue.cancelPending());
  $("btn-clear").addEventListener("click", () => {
    queue.clearAll();
    refreshChrome();
  });

  queue.onQueueChange((type) => {
    if (type === "progress" || type === "update") renderAiProgress();
  });
}

/** Shown only while an AI suggestion request is running or queued to run. */
function renderAiProgress() {
  const pill = $("ai-progress");
  const left = queue.remaining();
  if (left === 0) {
    pill.hidden = true;
    return;
  }
  const total = queue.allItems().length;
  const done = total - left;
  pill.hidden = false;
  $("ai-progress-text").textContent = `Asking the model… ${done} of ${total}`;
}

/**
 * Shared tail end of both batch-entry points: confirm before a large paid
 * scan, queue what is new, and report what happened.
 */
async function queueEntries(entries, emptyMessage) {
  if (!entries.length) {
    toast(emptyMessage, { kind: "info" });
    return;
  }

  // One image is one request. On a metered API a careless scan of a big
  // picture library is real money, so make the size explicit first.
  if (entries.length > BULK_CONFIRM_AT) {
    const proceed = await ask(
      `${entries.length} images found.\n\nScreenshotify sends one request per image to ${getSettings().baseUrl}. ` +
        `On a paid endpoint that is ${entries.length} billable requests.\n\nQueue them all?`,
      { title: "That is a lot of images", kind: "warning", okLabel: "Queue them", cancelLabel: "Cancel" }
    );
    if (!proceed) return;
  }

  const added = queue.addMany(entries, { source: "scan" });
  showView("review");
  refreshChrome();
  toast(
    added.length === entries.length
      ? `Queued ${added.length} image${added.length === 1 ? "" : "s"}.`
      : `Queued ${added.length} new image${added.length === 1 ? "" : "s"} (${entries.length - added.length} already in the list).`,
    { kind: "ok" }
  );
}

/** Batch mode: pick any folder and queue every screenshot already in it. */
async function scanFolder() {
  const dir = await openDialog({
    directory: true,
    multiple: false,
    title: "Choose a folder of screenshots to rename",
  });
  if (!dir) return;

  let entries;
  try {
    entries = await invoke("scan_folder", { folder: dir, recursive: false });
  } catch (err) {
    toast(`Could not read that folder: ${err}`, { kind: "err" });
    return;
  }

  await queueEntries(entries, "No images found in that folder.");
}

/** Pick individual files and queue only those, instead of a whole folder. */
async function pickFiles() {
  const picked = await openDialog({
    directory: false,
    multiple: true,
    title: "Choose screenshots to rename",
    filters: [{ name: "Images", extensions: IMAGE_EXTS }],
  });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];

  let entries;
  try {
    entries = await invoke("scan_files", { paths });
  } catch (err) {
    toast(`Could not read those files: ${err}`, { kind: "err" });
    return;
  }

  await queueEntries(entries, "None of the selected files are images.");
}

/* ══════════════════════════ History view ══════════════════════════ */

const historyFilter = { query: "", status: "all" };

function matchesHistoryFilter(entry) {
  if (historyFilter.status === "active" && entry.undone) return false;
  if (historyFilter.status === "undone" && !entry.undone) return false;
  if (historyFilter.query) {
    const toName = basename(entry.to).toLowerCase();
    const fromName = basename(entry.from).toLowerCase();
    if (!toName.includes(historyFilter.query) && !fromName.includes(historyFilter.query)) return false;
  }
  return true;
}

/**
 * Filters history.listEntries() by the search box + status dropdown, then
 * hands the result to renderHistory. Kept separate from renderHistory (which
 * just patches whatever list it's given) so history.onHistoryChange can call
 * this directly and always re-apply the current filter to fresh data.
 */
function applyHistoryFilter() {
  const all = history.listEntries();
  const filtered = all.filter(matchesHistoryFilter);

  const hasFilter = historyFilter.query || historyFilter.status !== "all";
  $("history-empty-title").textContent =
    all.length === 0 ? "Nothing renamed yet" : "No matching renames";
  $("history-empty-hint").textContent =
    all.length === 0
      ? "Once you apply a suggestion it will be listed here so you can undo it."
      : hasFilter
      ? "Try a different search or filter."
      : "";

  renderHistory(filtered);
}

function initHistoryView() {
  $("history-search").addEventListener("input", (ev) => {
    historyFilter.query = ev.target.value.trim().toLowerCase();
    applyHistoryFilter();
  });

  $("history-status-filter").addEventListener("change", (ev) => {
    historyFilter.status = ev.target.value;
    $("history-filter-trigger").classList.toggle("is-filtered", historyFilter.status !== "all");
    applyHistoryFilter();
  });
  enhanceSelect($("history-status-filter"));

  $("btn-undo-last").addEventListener("click", async () => {
    const res = await history.undoLastBatch();
    if (!res.count && !res.failed) {
      toast("Nothing left to undo.", { kind: "info" });
      return;
    }
    toast(
      res.failed
        ? `Restored ${res.count}, ${res.failed} could not be restored.`
        : `Restored ${res.count} original name${res.count === 1 ? "" : "s"}.`,
      { kind: res.failed ? "err" : "ok" }
    );
  });

  $("btn-clear-history").addEventListener("click", async () => {
    await history.clearHistory();
    toast("History cleared. Files themselves are untouched.", { kind: "info" });
  });
}

let historyThumbObserver = null;

function historyObserver() {
  if (!historyThumbObserver) {
    historyThumbObserver = new IntersectionObserver(
      (records) => {
        for (const rec of records) {
          if (!rec.isIntersecting) continue;
          const el = rec.target;
          historyThumbObserver.unobserve(el);
          loadHistoryThumb(el);
        }
      },
      { root: $("history-list"), rootMargin: "300px" }
    );
  }
  return historyThumbObserver;
}

async function loadHistoryThumb(el) {
  const path = el.dataset.path;
  try {
    const src = await invoke("thumbnail", { path, maxEdge: 320 });
    // Cache by path (a rename doesn't touch file bytes) so toggling a row
    // between undone/redone re-shows an already-fetched thumbnail instantly
    // instead of asking the backend to re-read and re-encode the file.
    const row = historyRows.get(el.dataset.entryId);
    if (row) row.thumbCache.set(path, src);
    // A later undo/redo may have pointed this element at a different path
    // by the time this resolves — don't clobber that newer request.
    if (el.dataset.path === path) setThumbSrc(el, src);
  } catch {
    if (el.dataset.path === path) el.classList.add("thumb-failed");
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

/**
 * Applies the "Photos per row" setting to both lists. Review owns its own
 * list element (review.js:setColumns); History's is simple enough to do
 * inline. The container itself is never torn down by renderHistory (only
 * its rows are patched in place), so this only needs to run on startup and
 * on change, not on every render.
 */
function applyListColumns() {
  const n = getSettings().listColumns;
  setColumns(n);
  const list = $("history-list");
  const cols = Math.min(3, Math.max(1, Number(n) || 1));
  list.classList.toggle("is-grid", cols > 1);
  list.style.setProperty("--list-cols", cols);
  list.dataset.cols = cols;
}

// Material Symbols "undo"/"redo" glyphs (960x960 viewBox), inlined so the
// row's Undo/Redo button can swap its icon by just changing this <path>'s
// `d`, matching how its label already swaps between "Undo" and "Redo".
const UNDO_ICON_PATH =
  "M288-192v-72h288q50 0 85-35t35-85q0-50-35-85t-85-35H330l93 93-51 51-180-180 180-180 51 51-93 93h246q80 0 136 56t56 136q0 80-56 136t-136 56H288Z";
const REDO_ICON_PATH =
  "M384-192q-80 0-136-56t-56-136q0-80 56-136t136-56h246l-93-93 51-51 180 180-180 180-51-51 93-93H384q-50 0-85 35t-35 85q0 50 35 85t85 35h288v72H384Z";

const historyRows = new Map(); // id -> { el, refs }

/**
 * Rebuilding every row from scratch on each render (the old approach) tore
 * down and recreated every <img>, so a rename anywhere in History made every
 * thumbnail in the list flash as it reloaded — not just the one that
 * changed. Rows are now kept and patched in place; only a row whose own
 * path actually changed touches its thumbnail.
 */
function renderHistory(entries) {
  const list = $("history-list");
  const empty = $("history-empty");
  empty.hidden = entries.length > 0;
  list.style.display = entries.length ? "" : "none";

  const seen = new Set();
  let ref = list.firstChild;
  for (const entry of entries) {
    seen.add(entry.id);
    let row = historyRows.get(entry.id);
    if (row) {
      updateHistoryRow(row, entry);
    } else {
      row = buildHistoryRow(entry);
      historyRows.set(entry.id, row);
    }
    if (row.el === ref) {
      ref = ref.nextSibling;
    } else {
      list.insertBefore(row.el, ref);
    }
  }

  for (const [id, row] of historyRows) {
    if (seen.has(id)) continue;
    row.el.remove();
    historyRows.delete(id);
  }
}

function buildHistoryRow(entry) {
  const el = document.createElement("div");

  const thumbWrap = document.createElement("div");
  thumbWrap.className = "thumb-wrap";

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  thumb.dataset.entryId = entry.id;
  // Read the path fresh at click time (not a value captured at row-build
  // time) since undo/redo can change which file this row currently points
  // to without rebuilding the row.
  thumb.addEventListener("click", () =>
    openLightbox({ path: entry.undone ? entry.from : entry.to })
  );

  const spinner = document.createElement("div");
  spinner.className = "chaotic-orbit";
  thumbWrap.append(thumb, spinner);

  const main = document.createElement("div");
  main.className = "hrow-main";

  const to = document.createElement("div");
  to.className = "hrow-to";

  const from = document.createElement("div");
  from.className = "hrow-from";
  from.innerHTML = "was <s></s>";
  const fromName = from.querySelector("s");

  const info = document.createElement("div");
  info.className = "hrow-info";
  info.textContent = formatFileInfo(entry);

  main.append(to, from, info);

  const time = document.createElement("div");
  time.className = "hrow-time";
  time.textContent = relativeTime(entry.at);
  time.title = new Date(entry.at).toLocaleString();

  const btn = document.createElement("button");
  btn.className = "btn btn-sm hrow-undo-btn";
  btn.innerHTML =
    `<svg class="btn-icon" viewBox="0 -960 960 960" aria-hidden="true"><path/></svg>` +
    `<span></span>`;
  const btnIcon = btn.querySelector("path");
  const btnLabel = btn.querySelector("span");
  btn.addEventListener("click", async () => {
    try {
      if (entry.undone) {
        await history.redo(entry.id);
        toast("Renamed back to the suggested name.", { kind: "ok" });
      } else {
        await history.undo(entry.id);
        toast("Original name restored.", { kind: "ok" });
      }
    } catch (err) {
      toast(`Could not ${entry.undone ? "redo" : "undo"}: ${err}`, { kind: "err" });
    }
  });

  // Wrapped so the grid layout (styles.css: .list.is-grid .hrow-foot) can
  // put time and the button on one line without changing the flat list's
  // appearance — .hrow-foot is `display: contents` there, i.e. invisible.
  const foot = document.createElement("div");
  foot.className = "hrow-foot";
  foot.append(time, btn);

  el.append(thumbWrap, main, foot);

  const row = {
    el,
    refs: { thumb, to, fromName, btn, btnIcon, btnLabel },
    thumbCache: new Map(),
  };
  updateHistoryRow(row, entry);
  return row;
}

function updateHistoryRow(row, entry) {
  const { el, refs } = row;
  el.className = "hrow" + (entry.undone ? " is-undone" : "");

  // Undone renames live at their original path again; still-applied ones
  // live at the new name — that is what a thumbnail/preview must read, and
  // what the bold "current name" line should show (with "was" showing
  // whichever name is now the inactive one).
  const currentPath = entry.undone ? entry.from : entry.to;
  const previousPath = entry.undone ? entry.to : entry.from;

  if (refs.thumb.dataset.path !== currentPath) {
    refs.thumb.dataset.path = currentPath;
    const cached = row.thumbCache.get(currentPath);
    if (cached) {
      // Renaming doesn't change the file's bytes, so a path already fetched
      // once (the common undo/redo toggle between two known paths) can be
      // shown immediately instead of reloading from the backend.
      setThumbSrc(refs.thumb, cached);
    } else {
      refs.thumb.style.backgroundImage = "";
      refs.thumb.classList.remove("is-loaded", "thumb-failed");
      delete refs.thumb.dataset.pendingSrc;
      historyObserver().observe(refs.thumb);
    }
  }

  refs.to.textContent = basename(currentPath);
  refs.to.title = currentPath;
  refs.fromName.textContent = basename(previousPath);

  refs.btnIcon.setAttribute("d", entry.undone ? REDO_ICON_PATH : UNDO_ICON_PATH);
  refs.btnLabel.textContent = entry.undone ? "Redo" : "Undo";
}

function basename(p) {
  return String(p || "").split(/[\\/]/).pop();
}

function relativeTime(ms) {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  return new Date(ms).toLocaleDateString();
}

/* ══════════════════════════ Settings form ══════════════════════════ */

async function initSettingsForm() {
  const s = getSettings();

  // — provider —
  bindText("set-base-url", "baseUrl");
  bindText("set-model", "model");

  const keyInput = $("set-api-key");

  keyInput.value = "";
  await renderKeyStatus();

  keyInput.addEventListener("change", async (ev) => {
    const value = ev.target.value.trim();
    if (!value) return;
    try {
      await saveApiKey(value);
      ev.target.value = "";
      await renderKeyStatus();
      toast("API key saved to Windows Credential Manager.", { kind: "ok" });
    } catch (err) {
      toast(`Could not save the key: ${err}`, { kind: "err" });
    }
  });

  $("btn-key-clear").addEventListener("click", async () => {
    try {
      await clearApiKey();
      keyInput.value = "";
      await renderKeyStatus();
      toast("API key removed.", { kind: "ok" });
    } catch (err) {
      toast(`Could not remove the key: ${err}`, { kind: "err" });
    }
  });

  $("btn-load-models").addEventListener("click", loadModels);
  $("btn-test").addEventListener("click", testConnection);

  // — usage —
  renderUsage();
  onStatsChange(renderUsage);
  onSettingsChange(renderUsage); // re-highlight the current model when it changes
  $("btn-reset-stats").addEventListener("click", async () => {
    await resetStats();
    toast("Usage stats reset.", { kind: "info" });
  });

  // — folders —
  $("btn-add-folder").addEventListener("click", addFolder);
  $("btn-add-default").addEventListener("click", addDefaultFolders);
  renderFolders();

  // — naming —
  bindSelect("set-case-style", "caseStyle", () => queue.restyleAll());
  bindSelect("set-date-prefix", "datePrefix", () => queue.restyleAll());
  enhanceSelect($("set-case-style"));
  enhanceSelect($("set-date-prefix"));
  bindNumberInput("set-max-words", "maxWords", { min: 1, max: 20 }, () => queue.restyleAll());
  bindText("set-language", "language");
  bindText("set-prompt-extra", "promptExtra");

  // — behaviour —
  bindSelect("set-list-columns", "listColumns", applyListColumns);
  enhanceSelect($("set-list-columns"));
  bindCheck("set-watch-enabled", "watchEnabled", applyWatchState);
  bindCheck("set-notifications", "notifications");
  bindCheck("set-start-minimized", "startMinimized");
  bindCheck("set-close-to-tray", "closeToTray", async () => {
    await invoke("set_close_to_tray", { enabled: getSettings().closeToTray });
  });
  bindNumberInput("set-concurrency", "concurrency", { min: 1, max: 6 });
  bindNumberInput("set-max-edge", "maxEdge", { min: 256, max: 4096 });

  // Autostart is owned by the OS, so read the real state rather than ours.
  const autostartInput = $("set-autostart");
  try {
    autostartInput.checked = await autostartEnabled();
  } catch {
    autostartInput.checked = !!s.autostart;
  }
  autostartInput.addEventListener("change", async () => {
    try {
      if (autostartInput.checked) await enableAutostart();
      else await disableAutostart();
      await updateSettings({ autostart: autostartInput.checked });
    } catch (err) {
      autostartInput.checked = !autostartInput.checked;
      toast(`Could not change the startup setting: ${err}`, { kind: "err" });
    }
  });

  // — updates —
  bindCheck("set-auto-update", "autoUpdate");
  $("btn-check-update").addEventListener("click", () => checkForUpdates({ silent: false }));
  $("link-repo").addEventListener("click", (ev) => {
    ev.preventDefault();
    openUrl(REPO_URL);
  });
  $("link-provider-guide").addEventListener("click", (ev) => {
    ev.preventDefault();
    openUrl(PROVIDER_GUIDE_URL);
  });

  await invoke("set_close_to_tray", { enabled: !!s.closeToTray }).catch(() => {});
}

function bindText(id, key) {
  const el = $(id);
  el.value = getSettings()[key] ?? "";
  el.addEventListener("change", () => updateSettings({ [key]: el.value.trim() }));
}

function bindSelect(id, key, after) {
  const el = $(id);
  el.value = getSettings()[key];
  el.addEventListener("change", async () => {
    await updateSettings({ [key]: el.value });
    if (after) after();
  });
}

// Builds the custom .csel dropdown UI around a hidden native <select>. The
// select stays the single source of truth for value/events (bindSelect keeps
// working unchanged) — this just mirrors it visually and writes back through
// select.value + a dispatched "change" so nothing downstream has to know the
// UI isn't a native <select> anymore.
function enhanceSelect(select) {
  const wrap = select.closest(".csel");
  const toggle = wrap.querySelector(".csel-toggle");
  const trigger = wrap.querySelector(".csel-trigger");
  const valueEl = wrap.querySelector(".csel-value");
  const panel = wrap.querySelector(".csel-panel");

  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  trigger.tabIndex = 0;
  trigger.setAttribute("role", "button");
  trigger.setAttribute("aria-haspopup", "listbox");

  const options = Array.from(select.options).map((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "csel-option";
    btn.dataset.value = opt.value;
    btn.textContent = opt.textContent;
    btn.addEventListener("click", () => {
      select.value = opt.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      toggle.checked = false;
    });
    panel.append(btn);
    return btn;
  });

  const sync = () => {
    const current = select.options[select.selectedIndex];
    valueEl.textContent = current ? current.textContent : "";
    for (const btn of options) {
      btn.setAttribute("aria-selected", btn.dataset.value === select.value ? "true" : "false");
    }
  };

  select.addEventListener("change", sync);
  sync();

  trigger.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      toggle.checked = !toggle.checked;
    } else if (ev.key === "Escape" && toggle.checked) {
      toggle.checked = false;
    }
  });
}

function bindCheck(id, key, after) {
  const el = $(id);
  el.checked = !!getSettings()[key];
  el.addEventListener("change", async () => {
    await updateSettings({ [key]: el.checked });
    if (after) await after();
    renderWatchPill();
  });
}

// A free-typed numeric setting (e.g. Parallel requests). Non-digit keystrokes
// are stripped as they're typed rather than rejected after the fact, and the
// value is clamped into range once the field loses focus.
function bindNumberInput(id, key, { min, max }, after) {
  const el = $(id);
  el.value = String(getSettings()[key]);
  el.addEventListener("input", () => {
    const digits = el.value.replace(/[^0-9]/g, "");
    if (digits !== el.value) el.value = digits;
  });
  el.addEventListener("change", async () => {
    const n = Math.min(max, Math.max(min, Number(el.value) || min));
    el.value = String(n);
    await updateSettings({ [key]: n });
    if (after) after();
  });
}

async function renderKeyStatus() {
  const stored = await hasApiKey().catch(() => false);
  const el = $("key-status");
  el.textContent = stored
    ? "A key is stored in the Windows Credential Manager. Type a new one to replace it."
    : "No key stored. Local endpoints such as Ollama usually do not need one.";
}

/* ── Folders ──────────────────────────────────────────────────────────── */

function renderUsage() {
  const host = $("usage-list");
  const totalsEl = $("usage-totals");
  const emptyEl = $("usage-empty");
  host.textContent = "";

  const usage = getModelUsage();
  const modelIds = Object.keys(usage).sort((a, b) => (usage[b].lastUsed || 0) - (usage[a].lastUsed || 0));

  if (!modelIds.length) {
    totalsEl.hidden = true;
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  totalsEl.hidden = false;

  const currentModel = getSettings().model?.trim();
  let totalRequests = 0;
  let totalInput = 0;
  let totalOutput = 0;

  for (const id of modelIds) {
    const entry = usage[id];
    totalRequests += entry.requests;
    totalInput += entry.promptTokens;
    totalOutput += entry.completionTokens;

    const row = document.createElement("div");
    row.className = "usage-item" + (id === currentModel ? " is-current" : "");

    const name = document.createElement("span");
    name.className = "usage-model";
    name.textContent = id;
    name.title = id;
    row.append(name);

    if (id === currentModel) {
      const badge = document.createElement("span");
      badge.className = "usage-current-badge";
      badge.textContent = "Current";
      row.append(badge);
    }

    const requests = document.createElement("span");
    requests.className = "usage-stat";
    requests.textContent = `${entry.requests.toLocaleString()} req${entry.requests === 1 ? "" : "s"}`;
    row.append(requests);

    const input = document.createElement("span");
    input.className = "usage-stat";
    input.textContent = `${entry.promptTokens.toLocaleString()} in`;
    row.append(input);

    const output = document.createElement("span");
    output.className = "usage-stat";
    output.textContent = `${entry.completionTokens.toLocaleString()} out`;
    row.append(output);

    host.append(row);
  }

  $("usage-total-requests").textContent = totalRequests.toLocaleString();
  $("usage-total-input").textContent = totalInput.toLocaleString();
  $("usage-total-output").textContent = totalOutput.toLocaleString();
}

function renderFolders() {
  const host = $("folder-list");
  host.textContent = "";
  const folders = getSettings().watchFolders;

  if (!folders.length) {
    const empty = document.createElement("div");
    empty.className = "folder-empty";
    empty.textContent = "No folders yet — nothing is being watched.";
    host.append(empty);
    return;
  }

  for (const folder of folders) {
    const row = document.createElement("div");
    row.className = "folder-item";

    const path = document.createElement("span");
    path.className = "folder-path";
    path.textContent = folder;
    path.title = folder;

    const openBtn = document.createElement("button");
    openBtn.className = "btn btn-ghost btn-sm";
    openBtn.textContent = "Open";
    openBtn.addEventListener("click", async () => {
      try {
        await invoke("open_folder", { path: folder });
      } catch (err) {
        toast(String(err), { kind: "err" });
      }
    });

    const del = document.createElement("button");
    del.className = "btn btn-ghost btn-sm btn-danger";
    del.textContent = "Remove";
    del.addEventListener("click", async () => {
      const next = getSettings().watchFolders.filter((f) => f !== folder);
      await updateSettings({ watchFolders: next });
      renderFolders();
      renderWatchPill();
      await applyWatchState();
    });

    row.append(path, openBtn, del);
    host.append(row);
  }
}

async function addFolder() {
  const dir = await openDialog({
    directory: true,
    multiple: false,
    title: "Choose a folder to watch",
  });
  if (!dir) return;
  const folders = getSettings().watchFolders;
  if (folders.includes(dir)) {
    toast("That folder is already being watched.", { kind: "info" });
    return;
  }
  await updateSettings({ watchFolders: [...folders, dir] });
  renderFolders();
  renderWatchPill();
  await applyWatchState();
}

async function addDefaultFolders() {
  const guessed = await invoke("default_screenshot_folders").catch(() => []);
  if (!guessed.length) {
    toast("No standard screenshot folder was found on this PC.", { kind: "info" });
    return;
  }
  const folders = getSettings().watchFolders;
  const merged = [...new Set([...folders, ...guessed])];
  if (merged.length === folders.length) {
    toast("Those folders are already in the list.", { kind: "info" });
    return;
  }
  await updateSettings({ watchFolders: merged });
  renderFolders();
  renderWatchPill();
  await applyWatchState();
}

/* ── Provider tools ───────────────────────────────────────────────────── */

async function loadModels() {
  const btn = $("btn-load-models");
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    const models = await invoke("list_models", { baseUrl: getSettings().baseUrl });
    const list = $("model-list");
    list.textContent = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m;
      list.append(opt);
    }
    toast(
      models.length
        ? `${models.length} models available — click the model box to pick one.`
        : "The endpoint returned no model list. Type the name yourself.",
      { kind: models.length ? "ok" : "info" }
    );
  } catch (err) {
    toast(`Could not list models: ${err}`, { kind: "err", timeout: 9000 });
  } finally {
    btn.disabled = false;
    btn.textContent = "Load models";
  }
}

/**
 * Sends a real (tiny) image, because "OpenAI-compatible" says nothing about
 * whether the endpoint or model accepts image input at all.
 */
async function testConnection() {
  const box = $("test-result");
  const btn = $("btn-test");
  const s = getSettings();

  box.hidden = false;
  box.className = "test-result busy";
  box.textContent = "Sending a small test image…";
  btn.disabled = true;

  try {
    const reply = await invoke("test_connection", {
      baseUrl: s.baseUrl,
      model: s.model,
    });
    box.className = "test-result ok";
    box.textContent = `Working. ${s.model} accepted an image and replied: "${reply}"`;
  } catch (err) {
    box.className = "test-result err";
    box.textContent = String(err);
  } finally {
    btn.disabled = false;
  }
}

/* ══════════════════════════ Updates ══════════════════════════ */

async function checkForUpdates({ silent }) {
  const status = $("update-status");
  const setStatus = (t) => {
    if (status) status.textContent = t;
  };

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    setStatus("Checking…");
    const update = await check();

    if (!update) {
      setStatus("You are on the latest version.");
      if (!silent) toast("Screenshotify is up to date.", { kind: "ok" });
      return;
    }

    setStatus(`Version ${update.version} available.`);
    toast(`Screenshotify ${update.version} is available.`, {
      kind: "info",
      timeout: 20000,
      action: {
        label: "Install and restart",
        onClick: async () => {
          let total = 0;
          let downloaded = 0;
          try {
            setStatus("Downloading…");
            await update.downloadAndInstall((event) => {
              switch (event.event) {
                case "Started":
                  total = event.data.contentLength || 0;
                  downloaded = 0;
                  break;
                case "Progress":
                  downloaded += event.data.chunkLength;
                  setStatus(
                    total
                      ? `Downloading… ${Math.min(100, Math.round((downloaded / total) * 100))}%`
                      : "Downloading…",
                  );
                  break;
                case "Finished":
                  // download_and_install runs the installer itself before its
                  // promise resolves — this is the only signal we get that
                  // the download half is done and the silent install (plus
                  // whatever the OS does to an unsigned exe, e.g. a Defender
                  // reputation check) is what's actually still running.
                  setStatus("Installing…");
                  break;
              }
            });
            const { relaunch } = await import("@tauri-apps/plugin-process");
            await relaunch();
          } catch (err) {
            setStatus(`Update failed: ${err}`);
            toast(`Update failed: ${err}`, { kind: "err" });
          }
        },
      },
    });
  } catch (err) {
    // Unsigned local builds have no updater key configured; that is expected.
    setStatus(silent ? "" : `Update check failed: ${err}`);
    if (!silent) toast(`Update check failed: ${err}`, { kind: "err", timeout: 9000 });
  }
}

/* ══════════════════════════ Go ══════════════════════════ */

main().catch((err) => {
  console.error(err);
  document.body.innerHTML =
    `<div style="padding:40px;font:14px system-ui">Screenshotify failed to start.<br><br><pre>${String(err)}</pre></div>`;
});
