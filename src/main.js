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
import { initPlatform, platform, isMac } from "./platform.js";
import { initStats, getModelUsage, onStatsChange, resetStats } from "./stats.js";
import * as queue from "./queue.js";
import * as history from "./history.js";
import {
  initReview,
  applyAll,
  skipAll,
  refreshChrome,
  formatFileInfo,
  openLightbox,
  setColumns,
  refreshLocale as refreshReviewLocale,
} from "./review.js";
import { toast } from "./toast.js";
import { initI18n, t, onLocaleChange, localeTag } from "./i18n.js";
import { showImageContextMenu } from "./contextmenu.js";
import { initDateRangeFilter } from "./datefilter.js";

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

// The webview's default context menu (Back, Reload, Save As, Print, Inspect…)
// is browser chrome that has no place in a packaged app. Text fields keep
// theirs: on macOS that menu is the only pointer-driven way to paste, and
// pasting an API key is the single most common thing anyone does here.
document.addEventListener("contextmenu", (e) => {
  if (e.target.closest("input, textarea")) return;
  e.preventDefault();
});

/* ══════════════════════════ Bootstrap ══════════════════════════ */

async function main() {
  // First: everything below words itself according to what this returns.
  await initPlatform();
  await initSettings();
  initI18n();
  await initStats();
  await history.initHistory();

  initReview();
  applyListColumns();
  applyPlatformCopy();
  initTitlebar();
  initSidebarToggle();
  initTabs();
  initReviewToolbar();
  initHistoryView();
  await initSettingsForm();
  await initNotifications();
  initBackendEvents();
  initLocaleSync();

  history.onHistoryChange(applyHistoryFilter);
  applyHistoryFilter();

  await applyWatchState();
  await showWindowIfWanted();

  const appVersion = await getVersion();
  $("app-version").textContent = `v${appVersion}`;
  $("titlebar-version").textContent = `v${appVersion}`;

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
  let stayHidden = false;
  try {
    const fromStartup = await invoke("launched_minimized");
    stayHidden = fromStartup || getSettings().startMinimized;
  } catch (err) {
    console.error("could not read the launch mode", err);
  }

  if (stayHidden) {
    // Nothing is going to appear on screen, so on macOS drop out of the Dock
    // as well — a launch that leaves a bouncing Dock icon and no window is
    // exactly the thing "start minimised" is supposed to avoid.
    await invoke("set_dock_icon", { visible: false }).catch(() => {});
    return;
  }

  // Showing goes through Rust rather than window.show() so the Dock icon,
  // focus and taskbar handling stay in one place (show_main in lib.rs).
  try {
    await invoke("show_main_window");
  } catch (err) {
    console.error("could not show the window", err);
  }
}

/**
 * Rewrites the labels that name something only one platform has: a credential
 * store, a tray, a login. Done here rather than in index.html so the markup
 * carries no platform assumption at all.
 */
function applyPlatformCopy() {
  const { keyStore, trayName, loginPhrase } = platform();
  const set = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };
  set("provider-hint", t("settings.provider.hint", { keyStore }));
  set("copy-autostart", t("settings.behaviour.autostart", { loginPhrase }));
  set("copy-start-minimized", t("settings.behaviour.startMinimized", { trayName }));
  set("copy-close-to-tray", t("settings.behaviour.closeToTray", { trayName }));
}

/* ══════════════════════════ Titlebar ══════════════════════════ */

const MAXIMIZE_PATH =
  "M86-86v-260h126v134h134v126H86Zm529 0v-126h133v-134h126v260H615ZM86-615v-259h260v126H212v133H86Zm662 0v-133H615v-126h259v259H748Z";
const RESTORE_PATH =
  "M220-86v-134H86v-126h260v260H220Zm395 0v-260h259v126H741v134H615ZM86-615v-126h134v-133h126v259H86Zm529 0v-259h126v133h133v126H615Z";

/**
 * Custom titlebar controls, needed because decorations:false in
 * tauri.conf.json hands us the whole window frame (the dragging itself is
 * handled declaratively by the data-tauri-drag-region attribute in
 * index.html — this just wires the three buttons).
 */
function initTitlebar() {
  // macOS draws its own controls over the top-left of the window
  // (titleBarStyle: "Overlay" in tauri.macos.conf.json), so the bar stays as a
  // drag region and a place for the app name, while the three buttons below —
  // which would be both duplicated and on the wrong side — are taken out by
  // styles.css, along with reserving the space the real ones sit in.
  if (isMac()) return;

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
    maximizeBtn.title = maximized ? t("titlebar.restore") : t("titlebar.maximize");
    maximizeBtn.setAttribute("aria-label", maximizeBtn.title);
  };

  $("titlebar-minimize").addEventListener("click", () => win.minimize());
  maximizeBtn.addEventListener("click", async () => {
    // Don't rely solely on onResized below: it fires off the OS resize
    // event, which can arrive before the window's new outer size is
    // queryable, so a check made only there can read stale. toggleMaximize()'s
    // own promise, by contrast, only resolves after the platform call it
    // wraps has already happened.
    await win.toggleMaximize();
    syncMaximized();
  });
  $("titlebar-close").addEventListener("click", () => win.close());

  win.onResized(syncMaximized);
  syncMaximized();
}

/* ══════════════════════════ Sidebar ══════════════════════════ */

/** Set by initSidebarToggle; re-run on a language change to re-word the tooltip/label. */
let refreshSidebarLabels = () => {};

function initSidebarToggle() {
  const sidebar = document.querySelector(".sidebar");
  const toggle = $("sidebar-toggle");
  // A second, always-visible control for the exact same action — the badge
  // above only hints at it on hover, easy to miss.
  const menuToggle = $("sidebar-collapse-toggle");
  const menuIcon = $("sidebar-collapse-icon");
  const menuLabel = $("sidebar-collapse-label");

  const apply = (collapsed) => {
    sidebar.classList.toggle("is-collapsed", collapsed);
    const title = collapsed ? t("sidebar.expand") : t("sidebar.collapse");
    toggle.title = title;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    menuIcon.classList.toggle("is-mirrored", collapsed);
    menuLabel.textContent = title;
    menuToggle.title = title;
    menuToggle.setAttribute("aria-expanded", String(!collapsed));
  };

  apply(!!getSettings().sidebarCollapsed);
  refreshSidebarLabels = () => apply(sidebar.classList.contains("is-collapsed"));

  const toggleCollapsed = async () => {
    const collapsed = !sidebar.classList.contains("is-collapsed");
    apply(collapsed);
    await updateSettings({ sidebarCollapsed: collapsed });
  };

  toggle.addEventListener("click", toggleCollapsed);
  menuToggle.addEventListener("click", toggleCollapsed);
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
    toast(fatal ? t("watch.stoppedFatal", { message }) : message, {
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
    toast(t("watch.startFailed", { error: err }), { kind: "err" });
  }
  updateTrayTooltip();
}

function renderWatchPill() {
  const s = getSettings();
  const on = s.watchEnabled && s.watchFolders.length > 0;
  const pill = $("watch-toggle");
  pill.classList.toggle("is-on", on);
  $("watch-label").textContent = !s.watchFolders.length
    ? t("watch.noFolders")
    : on
      ? t("watch.watching")
      : t("watch.paused");
  pill.title = on
    ? t("watch.tooltipOn", { count: s.watchFolders.length })
    : t("watch.tooltipOff");

  const hint = $("empty-hint");
  if (hint) {
    hint.textContent = !s.watchFolders.length
      ? t("watch.hintNoFolders")
      : on
        ? t("watch.hintOn")
        : t("watch.hintOff");
  }
}

async function toggleWatch() {
  const s = getSettings();
  if (!s.watchFolders.length) {
    showView("settings");
    toast(t("watch.needFolder"), { kind: "info" });
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
  $("ai-progress-text").textContent = t("review.askingModel", { done, total });
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
      t("dialog.bulkMessage", { count: entries.length, baseUrl: getSettings().baseUrl }),
      { title: t("dialog.bulkTitle"), kind: "warning", okLabel: t("dialog.bulkOk"), cancelLabel: t("dialog.bulkCancel") }
    );
    if (!proceed) return;
  }

  const added = queue.addMany(entries, { source: "scan" });
  showView("review");
  refreshChrome();
  toast(
    added.length === entries.length
      ? t("queue.queuedAll", { count: added.length })
      : t("queue.queuedSome", { count: added.length, already: entries.length - added.length }),
    { kind: "ok" }
  );
}

/** Batch mode: pick any folder and queue every screenshot already in it. */
async function scanFolder() {
  const dir = await openDialog({
    directory: true,
    multiple: false,
    title: t("dialog.scanFolderTitle"),
  });
  if (!dir) return;

  let entries;
  try {
    entries = await invoke("scan_folder", { folder: dir, recursive: false });
  } catch (err) {
    toast(t("queue.scanFailed", { error: err }), { kind: "err" });
    return;
  }

  await queueEntries(entries, t("queue.emptyFolder"));
}

/** Pick individual files and queue only those, instead of a whole folder. */
async function pickFiles() {
  const picked = await openDialog({
    directory: false,
    multiple: true,
    title: t("dialog.pickFilesTitle"),
    filters: [{ name: t("dialog.imagesFilter"), extensions: IMAGE_EXTS }],
  });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];

  let entries;
  try {
    entries = await invoke("scan_files", { paths });
  } catch (err) {
    toast(t("queue.pickFailed", { error: err }), { kind: "err" });
    return;
  }

  await queueEntries(entries, t("queue.emptyFiles"));
}

/* ══════════════════════════ History view ══════════════════════════ */

const historyFilter = { query: "", from: null, to: null };

/** Set by initHistoryView() so initLocaleSync() can refresh the calendar's month/weekday names. */
let historyDateFilter = null;

function matchesHistoryFilter(entry) {
  if (historyFilter.query) {
    const toName = basename(entry.to).toLowerCase();
    const fromName = basename(entry.from).toLowerCase();
    if (!toName.includes(historyFilter.query) && !fromName.includes(historyFilter.query)) return false;
  }
  if (historyFilter.from != null && entry.at < historyFilter.from) return false;
  if (historyFilter.to != null && entry.at > historyFilter.to) return false;
  return true;
}

/**
 * Filters history.listEntries() by the search box and date range, then hands
 * the result to renderHistory. Kept separate from renderHistory (which just
 * patches whatever list it's given) so history.onHistoryChange can call this
 * directly and always re-apply the current filter to fresh data.
 */
function applyHistoryFilter() {
  const all = history.listEntries();
  const filtered = all.filter(matchesHistoryFilter);

  const hasFilter = historyFilter.query || historyFilter.from != null || historyFilter.to != null;
  $("history-empty-title").textContent =
    all.length === 0 ? t("history.emptyTitleNone") : t("history.emptyTitleFiltered");
  $("history-empty-hint").textContent =
    all.length === 0
      ? t("history.emptyHintNone")
      : hasFilter
      ? t("history.emptyHintFiltered")
      : "";

  renderHistory(filtered);
  renderHistoryRangeSummary(filtered.length);
}

/**
 * Shows the visible-entry count next to the search bar: just "{count} images"
 * normally, or "{range} · {count} images" once a bounded date range is active.
 * `count` already reflects both the search query and the date range, so it
 * always matches what's actually listed below.
 */
function renderHistoryRangeSummary(count) {
  const el = $("history-range-summary");
  const text = $("history-range-summary-text");
  const { from, to } = historyFilter;
  if (from == null && to == null) {
    text.textContent = t("history.countSummary", { count });
    el.hidden = false;
    return;
  }
  const fmt = new Intl.DateTimeFormat(localeTag(), { month: "short", day: "numeric" });
  const fromLabel = from != null ? fmt.format(from) : null;
  const toLabel = to != null ? fmt.format(to) : null;
  const range =
    fromLabel && toLabel ? (fromLabel === toLabel ? fromLabel : `${fromLabel} – ${toLabel}`) : fromLabel || toLabel;
  text.textContent = t("history.rangeSummary", { range, count });
  el.hidden = false;
}

/**
 * Sends the count badge to its own full-width row (via the .is-wrapped class
 * from styles.css) once there's no longer room for it next to the search
 * box, instead of letting it crowd the search box or overlap
 * Undo/Clear — see the .toolbar-wrap comment in styles.css for why this
 * needs measuring in JS rather than plain CSS flex-wrap. Reacts to both the
 * toolbar resizing and the badge's own text changing width (locale switch,
 * "N images" vs. "range · N images").
 */
function initHistoryToolbarWrap() {
  const toolbar = $("history-toolbar");
  const badge = $("history-range-summary");
  const right = toolbar?.querySelector(".toolbar-right");
  if (!toolbar || !badge || !right || typeof ResizeObserver === "undefined") return;

  // Mirrors styles.css: .history-search's min-width, .toolbar's horizontal
  // padding (12px 16px) and gap (10px).
  const SEARCH_MIN = 330;
  const PADDING_X = 32;
  const GAP = 10;

  const update = () => {
    // Drop .is-wrapped first so badge.offsetWidth reads its natural pill
    // size rather than the flex-basis: 100% that class forces onto it —
    // otherwise a previously-wrapped badge would measure as "the whole
    // toolbar's width" and the toolbar could never un-wrap again.
    toolbar.classList.remove("is-wrapped");
    const available = toolbar.clientWidth - PADDING_X;
    const needed = SEARCH_MIN + GAP + badge.offsetWidth + GAP + right.offsetWidth;
    toolbar.classList.toggle("is-wrapped", available < needed);
  };

  const ro = new ResizeObserver(update);
  ro.observe(toolbar);
  ro.observe(badge);
  update();
}

function initHistoryView() {
  initHistoryToolbarWrap();
  $("history-search").addEventListener("input", (ev) => {
    historyFilter.query = ev.target.value.trim().toLowerCase();
    applyHistoryFilter();
  });

  historyDateFilter = initDateRangeFilter({
    toggle: $("csel-toggle-history-time"),
    trigger: $("history-time-filter-trigger"),
    panel: document.querySelector(".date-filter-panel"),
    onChange: ({ from, to }) => {
      historyFilter.from = from;
      historyFilter.to = to;
      applyHistoryFilter();
    },
  });

  $("btn-undo-last").addEventListener("click", async () => {
    const res = await history.undoLastBatch();
    if (!res.count && !res.failed) {
      toast(t("history.nothingToUndo"), { kind: "info" });
      return;
    }
    toast(
      res.failed
        ? t("history.restoredPartial", { count: res.count, failed: res.failed })
        : t("history.restoredAll", { count: res.count }),
      { kind: res.failed ? "err" : "ok" }
    );
  });

  $("btn-clear-history").addEventListener("click", async () => {
    await history.clearHistory();
    toast(t("history.cleared"), { kind: "info" });
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

// Same closed/open folder glyphs as the "Scan a folder…" toolbar button
// (index.html #btn-scan) and review.js's per-row reveal button.
const FOLDER_CLOSED_PATH =
  "M168-192q-29 0-50.5-21.5T96-264v-432q0-30 21.5-51t50.5-21h216l96 96h312q30 0 51 21t21 51v336q0 29-21 50.5T792-192H168Z";
const FOLDER_OPEN_PATH =
  "M168-192q-32 0-52-21t-20-51v-432q0-30 20-51t52-21h216l96 96h313q31 0 50.5 21t21.5 51H168v336l78-264h690l-85 285q-8 23-21 37t-38 14H168Z";

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
  thumb.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (thumb.dataset.path) showImageContextMenu(ev.clientX, ev.clientY, thumb.dataset.path);
  });

  const spinner = document.createElement("div");
  spinner.className = "chaotic-orbit";
  thumbWrap.append(thumb, spinner);

  const main = document.createElement("div");
  main.className = "hrow-main";

  const to = document.createElement("div");
  to.className = "hrow-to";

  const from = document.createElement("div");
  from.className = "hrow-from";
  const fromLabel = document.createElement("span");
  const fromName = document.createElement("s");
  from.append(fromLabel, fromName);

  const info = document.createElement("div");
  info.className = "hrow-info";
  info.textContent = formatFileInfo(entry);

  main.append(to, from, info);

  const time = document.createElement("div");
  time.className = "hrow-time";
  time.textContent = relativeTime(entry.at);
  time.title = new Date(entry.at).toLocaleString(localeTag());

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
        toast(t("history.redone"), { kind: "ok" });
      } else {
        await history.undo(entry.id);
        toast(t("history.undone"), { kind: "ok" });
      }
    } catch (err) {
      toast(entry.undone ? t("history.redoFailed", { error: err }) : t("history.undoFailed", { error: err }), { kind: "err" });
    }
  });

  const revealBtn = document.createElement("button");
  revealBtn.className = "btn btn-ghost btn-icon-only btn-folder-reveal";
  revealBtn.title = t("review.openFolder");
  revealBtn.innerHTML =
    `<svg class="btn-icon" viewBox="0 -960 960 960" aria-hidden="true">` +
    `<path class="icon-folder-closed" d="${FOLDER_CLOSED_PATH}"></path>` +
    `<path class="icon-folder-open" d="${FOLDER_OPEN_PATH}"></path>` +
    `</svg>`;
  // Same "read the path fresh at click time" reasoning as the thumb's own
  // click/contextmenu handlers above — undo/redo can repoint this row at a
  // different file without rebuilding it.
  revealBtn.addEventListener("click", async () => {
    const path = thumb.dataset.path;
    if (!path) return;
    try {
      await invoke("reveal_file", { path });
    } catch (err) {
      toast(t("review.openFolderFailed", { error: err }), { kind: "err" });
    }
  });

  // Grouped with Undo/Redo so .hrow-foot (styles.css) only ever has to treat
  // the footer as two things — time, and this actions pair — in both the
  // flat list and the grid layout (.list.is-grid .hrow-foot: time vs.
  // actions pushed to opposite edges of the full-width footer line).
  const actions = document.createElement("div");
  actions.className = "hrow-actions";
  actions.append(revealBtn, btn);

  const foot = document.createElement("div");
  foot.className = "hrow-foot";
  foot.append(time, actions);

  el.append(thumbWrap, main, foot);

  const row = {
    el,
    refs: { thumb, to, fromLabel, fromName, time, revealBtn, btn, btnIcon, btnLabel },
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
  refs.fromLabel.textContent = t("history.wasLabel");
  refs.fromName.textContent = basename(previousPath);

  refs.btnIcon.setAttribute("d", entry.undone ? REDO_ICON_PATH : UNDO_ICON_PATH);
  refs.btnLabel.textContent = entry.undone ? t("history.redoBtn") : t("history.undoBtn");
}

function basename(p) {
  return String(p || "").split(/[\\/]/).pop();
}

function relativeTime(ms) {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return t("history.justNow");
  if (min < 60) return t("history.minAgo", { n: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t("history.hourAgo", { n: hr });
  return new Date(ms).toLocaleDateString(localeTag());
}

/**
 * Re-labels every history row already rendered after the interface language
 * changes, without touching thumbnails (same reasoning as review.js's
 * refreshLocale — rebuilding the thumb element would restart its load).
 */
function refreshHistoryLocale() {
  for (const [id, row] of historyRows) {
    const entry = history.listEntries().find((e) => e.id === id);
    if (!entry) continue;
    row.refs.time.textContent = relativeTime(entry.at);
    row.refs.time.title = new Date(entry.at).toLocaleString(localeTag());
    row.refs.fromLabel.textContent = t("history.wasLabel");
    row.refs.btnLabel.textContent = entry.undone ? t("history.redoBtn") : t("history.undoBtn");
    row.refs.revealBtn.title = t("review.openFolder");
  }
  applyHistoryFilter();
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
      toast(t("settings.provider.keySaved", { keyStore: platform().keyStore }), { kind: "ok" });
    } catch (err) {
      toast(t("settings.provider.keySaveFailed", { error: err }), { kind: "err" });
    }
  });

  $("btn-key-clear").addEventListener("click", async () => {
    try {
      await clearApiKey();
      keyInput.value = "";
      await renderKeyStatus();
      toast(t("settings.provider.keyRemoved"), { kind: "ok" });
    } catch (err) {
      toast(t("settings.provider.keyRemoveFailed", { error: err }), { kind: "err" });
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
    toast(t("settings.usage.resetDone"), { kind: "info" });
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
  bindSelect("set-ui-language", "uiLanguage");
  enhanceSelect($("set-ui-language"));
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
      toastSettingsSaved();
    } catch (err) {
      autostartInput.checked = !autostartInput.checked;
      toast(t("settings.behaviour.startupFailed", { error: err }), { kind: "err" });
    }
  });

  // — updates —
  bindCheck("set-auto-update", "autoUpdate");
  $("btn-check-update").addEventListener("click", () => checkForUpdates({ silent: false }));
  $("btn-star-github").addEventListener("click", () => openUrl(REPO_URL));
  loadRepoStars();
  $("link-provider-guide").addEventListener("click", (ev) => {
    ev.preventDefault();
    openUrl(PROVIDER_GUIDE_URL);
  });

  await invoke("set_close_to_tray", { enabled: !!s.closeToTray }).catch(() => {});
}

/** Confirms a settings-store write the user just made from the Settings form. */
function toastSettingsSaved() {
  toast(t("settings.saved"), { kind: "ok", timeout: 2000 });
}

/**
 * Fills in the "Star on GitHub" button's live count. Failures (offline, rate
 * limited) are silent — the button still works as a plain link either way,
 * so there's nothing worth interrupting the user over.
 */
async function loadRepoStars() {
  try {
    const count = await invoke("repo_stars", { owner: "shaqkao", repo: "screenshotify" });
    $("repo-star-count").textContent = count.toLocaleString(localeTag());
  } catch {
    $("repo-star-count").closest(".star-github-count").hidden = true;
  }
}

function bindText(id, key) {
  const el = $(id);
  el.value = getSettings()[key] ?? "";
  el.addEventListener("change", async () => {
    await updateSettings({ [key]: el.value.trim() });
    toastSettingsSaved();
  });
}

function bindSelect(id, key, after) {
  const el = $(id);
  el.value = getSettings()[key];
  el.addEventListener("change", async () => {
    await updateSettings({ [key]: el.value });
    toastSettingsSaved();
    if (after) after();
  });
}

// Re-sync functions for every enhanceSelect below, run after a language
// change: i18n.js's applyStaticDom() already retranslated the underlying
// <option> elements (via their own data-i18n), but the custom dropdown's
// button labels and closed-state display were copied from them once at
// build time and don't pick that up on their own.
const enhancedSelectRefreshers = [];

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

  enhancedSelectRefreshers.push(() => {
    Array.from(select.options).forEach((opt, i) => {
      options[i].textContent = opt.textContent;
    });
    sync();
  });

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
    toastSettingsSaved();
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
    toastSettingsSaved();
    if (after) after();
  });
}

async function renderKeyStatus() {
  const stored = await hasApiKey().catch(() => false);
  const el = $("key-status");
  el.textContent = stored
    ? t("settings.provider.keyStatusStored", { keyStore: platform().keyStore })
    : t("settings.provider.keyStatusEmpty");
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
      badge.textContent = t("settings.usage.current");
      row.append(badge);
    }

    const requests = document.createElement("span");
    requests.className = "usage-stat";
    requests.textContent = t("settings.usage.req", { n: entry.requests.toLocaleString(localeTag()), count: entry.requests });
    row.append(requests);

    const input = document.createElement("span");
    input.className = "usage-stat";
    input.textContent = t("settings.usage.in", { n: entry.promptTokens.toLocaleString(localeTag()) });
    row.append(input);

    const output = document.createElement("span");
    output.className = "usage-stat";
    output.textContent = t("settings.usage.out", { n: entry.completionTokens.toLocaleString(localeTag()) });
    row.append(output);

    host.append(row);
  }

  $("usage-total-requests").textContent = totalRequests.toLocaleString(localeTag());
  $("usage-total-input").textContent = totalInput.toLocaleString(localeTag());
  $("usage-total-output").textContent = totalOutput.toLocaleString(localeTag());
}

function renderFolders() {
  const host = $("folder-list");
  host.textContent = "";
  const folders = getSettings().watchFolders;

  if (!folders.length) {
    const empty = document.createElement("div");
    empty.className = "folder-empty";
    empty.textContent = t("settings.folders.empty");
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
    openBtn.textContent = t("settings.folders.open");
    openBtn.addEventListener("click", async () => {
      try {
        await invoke("open_folder", { path: folder });
      } catch (err) {
        toast(String(err), { kind: "err" });
      }
    });

    const del = document.createElement("button");
    del.className = "btn btn-ghost btn-sm btn-danger";
    del.textContent = t("settings.folders.remove");
    del.addEventListener("click", async () => {
      const next = getSettings().watchFolders.filter((f) => f !== folder);
      await updateSettings({ watchFolders: next });
      toastSettingsSaved();
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
    title: t("dialog.addFolderTitle"),
  });
  if (!dir) return;
  const folders = getSettings().watchFolders;
  if (folders.includes(dir)) {
    toast(t("settings.folders.alreadyWatching"), { kind: "info" });
    return;
  }
  await updateSettings({ watchFolders: [...folders, dir] });
  toastSettingsSaved();
  renderFolders();
  renderWatchPill();
  await applyWatchState();
}

async function addDefaultFolders() {
  const guessed = await invoke("default_screenshot_folders").catch(() => []);
  if (!guessed.length) {
    toast(t("settings.folders.noDefault"), { kind: "info" });
    return;
  }
  const folders = getSettings().watchFolders;
  const merged = [...new Set([...folders, ...guessed])];
  if (merged.length === folders.length) {
    toast(t("settings.folders.alreadyListed"), { kind: "info" });
    return;
  }
  await updateSettings({ watchFolders: merged });
  toastSettingsSaved();
  renderFolders();
  renderWatchPill();
  await applyWatchState();
}

/* ── Provider tools ───────────────────────────────────────────────────── */

async function loadModels() {
  const btn = $("btn-load-models");
  btn.disabled = true;
  btn.textContent = t("settings.provider.loading");
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
        ? t("settings.provider.modelsFound", { count: models.length })
        : t("settings.provider.modelsEmpty"),
      { kind: models.length ? "ok" : "info" }
    );
  } catch (err) {
    toast(t("settings.provider.modelsFailed", { error: err }), { kind: "err", timeout: 9000 });
  } finally {
    btn.disabled = false;
    btn.textContent = t("settings.provider.loadModels");
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
  box.textContent = t("settings.provider.testing");
  btn.disabled = true;

  try {
    const reply = await invoke("test_connection", {
      baseUrl: s.baseUrl,
      model: s.model,
    });
    box.className = "test-result ok";
    box.textContent = t("settings.provider.testOk", { model: s.model, reply });
  } catch (err) {
    box.className = "test-result err";
    box.textContent = String(err);
  } finally {
    btn.disabled = false;
  }
}

/* ══════════════════════════ Updates ══════════════════════════ */

async function checkForUpdates({ silent }) {
  const setStatus = (render) => {
    renderUpdateStatus = render;
    const status = $("update-status");
    if (status) status.textContent = render();
  };

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    setStatus(() => t("settings.updates.checking"));
    const update = await check();

    if (!update) {
      setStatus(() => t("settings.updates.upToDate"));
      if (!silent) toast(t("settings.updates.upToDateToast"), { kind: "ok" });
      return;
    }

    setStatus(() => t("settings.updates.available", { version: update.version }));
    toast(t("settings.updates.availableToast", { version: update.version }), {
      kind: "info",
      timeout: 20000,
      action: {
        label: t("settings.updates.install"),
        onClick: async () => {
          let total = 0;
          let downloaded = 0;
          try {
            setStatus(() => t("settings.updates.downloading"));
            await update.downloadAndInstall((event) => {
              switch (event.event) {
                case "Started":
                  total = event.data.contentLength || 0;
                  downloaded = 0;
                  break;
                case "Progress":
                  downloaded += event.data.chunkLength;
                  setStatus(() =>
                    total
                      ? t("settings.updates.downloadingPct", {
                          pct: Math.min(100, Math.round((downloaded / total) * 100)),
                        })
                      : t("settings.updates.downloading"),
                  );
                  break;
                case "Finished":
                  // download_and_install runs the installer itself before its
                  // promise resolves — this is the only signal we get that
                  // the download half is done and the silent install (plus
                  // whatever the OS does to an unsigned exe, e.g. a Defender
                  // reputation check) is what's actually still running.
                  setStatus(() => t("settings.updates.installing"));
                  break;
              }
            });
            const { relaunch } = await import("@tauri-apps/plugin-process");
            await relaunch();
          } catch (err) {
            setStatus(() => t("settings.updates.failed", { error: err }));
            toast(t("settings.updates.failed", { error: err }), { kind: "err" });
          }
        },
      },
    });
  } catch (err) {
    // Unsigned local builds have no updater key configured; that is expected.
    setStatus(() => (silent ? "" : t("settings.updates.checkFailed", { error: err })));
    if (!silent) toast(t("settings.updates.checkFailed", { error: err }), { kind: "err", timeout: 9000 });
  }
}

/* ══════════════════════════ Locale ══════════════════════════ */

/**
 * Re-renders whatever #update-status last showed (checking/up to date/failed/
 * …), set by checkForUpdates each time it changes the text. checkForUpdates
 * itself isn't re-run on a language change — only its already-known result is
 * re-worded — so switching languages never fires an update check as a side
 * effect.
 */
let renderUpdateStatus = () => "";

/**
 * Everything that isn't covered by i18n.js's own data-i18n DOM walk: list
 * rows built at runtime, the custom .csel dropdowns whose option labels were
 * copied out of the native <select> once at build time, and one-shot status
 * text set by an async action (API key check, update check) that isn't
 * re-run just because the language changed.
 */
function initLocaleSync() {
  onLocaleChange(() => {
    applyPlatformCopy();
    renderWatchPill();
    refreshSidebarLabels();
    for (const refresh of enhancedSelectRefreshers) refresh();
    renderUsage();
    renderFolders();
    refreshReviewLocale();
    refreshHistoryLocale();
    historyDateFilter?.refreshLocale();
    applyHistoryFilter();
    renderKeyStatus();
    const updateStatusEl = $("update-status");
    if (updateStatusEl) updateStatusEl.textContent = renderUpdateStatus();
  });
}

/* ══════════════════════════ Go ══════════════════════════ */

main().catch((err) => {
  console.error(err);
  document.body.innerHTML =
    `<div style="padding:40px;font:14px system-ui">${t("app.startFailed")}<br><br><pre>${String(err)}</pre></div>`;
});
