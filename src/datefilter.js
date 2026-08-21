import { t, localeTag } from "./i18n.js";

const DAY_MS = 86400000;

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfDay(ms) {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

const PRESETS = [
  ["7d", "history.time7d", () => [startOfDay(Date.now() - 6 * DAY_MS), endOfDay(Date.now())]],
  ["30d", "history.time30d", () => [startOfDay(Date.now() - 29 * DAY_MS), endOfDay(Date.now())]],
  ["90d", "history.time90d", () => [startOfDay(Date.now() - 89 * DAY_MS), endOfDay(Date.now())]],
  ["180d", "history.time180d", () => [startOfDay(Date.now() - 179 * DAY_MS), endOfDay(Date.now())]],
  ["all", "history.timeAll", () => [null, null]],
];

/**
 * Wires up the History date-range popover: a row of presets (7d / 30d / 90d
 * / 180d / All) plus a single-month calendar for picking a custom range by
 * dragging from a start day to an end day (a plain click-release with no
 * drag selects just that one day).
 *
 * `toggle`/`trigger` are the existing .csel-toggle checkbox + .csel-trigger
 * label (reused for the open/close + click-outside-to-close mechanics);
 * `panel` is the empty .csel-panel to build this widget's markup into.
 * `onChange({ from, to })` fires with millisecond bounds (either may be
 * null, meaning unbounded) whenever the active range changes.
 */
export function initDateRangeFilter({ toggle, trigger, panel, onChange }) {
  let from = null;
  let to = null;
  let dragAnchor = null;
  let isDragging = false;
  const viewMonth = new Date();
  viewMonth.setDate(1);
  viewMonth.setHours(0, 0, 0, 0);

  trigger.tabIndex = 0;
  trigger.setAttribute("role", "button");
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      toggle.checked = !toggle.checked;
    } else if (ev.key === "Escape" && toggle.checked) {
      toggle.checked = false;
    }
  });

  const presetsEl = document.createElement("div");
  presetsEl.className = "date-filter-presets";
  const presetBtns = PRESETS.map(([key, i18nKey, range]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "date-preset-btn";
    btn.textContent = t(i18nKey);
    btn.addEventListener("click", () => {
      const [f, tt] = range();
      applyRange(f, tt, true);
    });
    presetsEl.append(btn);
    return { key, btn, i18nKey };
  });

  const calEl = document.createElement("div");
  calEl.className = "date-filter-calendar";

  const header = document.createElement("div");
  header.className = "cal-header";
  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "cal-nav cal-prev";
  prevBtn.textContent = "‹";
  const label = document.createElement("span");
  label.className = "cal-month-label";
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "cal-nav cal-next";
  nextBtn.textContent = "›";
  header.append(prevBtn, label, nextBtn);

  const weekdaysEl = document.createElement("div");
  weekdaysEl.className = "cal-weekdays";

  const gridEl = document.createElement("div");
  gridEl.className = "cal-grid";

  calEl.append(header, weekdaysEl, gridEl);
  panel.append(presetsEl, calEl);

  prevBtn.addEventListener("click", () => {
    viewMonth.setMonth(viewMonth.getMonth() - 1);
    renderCalendar();
  });
  nextBtn.addEventListener("click", () => {
    viewMonth.setMonth(viewMonth.getMonth() + 1);
    renderCalendar();
  });

  function applyRange(f, tt, close) {
    isDragging = false;
    dragAnchor = null;
    from = f;
    to = tt;
    trigger.classList.toggle("is-filtered", from != null || to != null);
    syncPresetHighlight();
    renderCalendar();
    onChange({ from, to });
    if (close) toggle.checked = false;
  }

  function startDrag(dayKey) {
    isDragging = true;
    dragAnchor = dayKey;
    from = dayKey;
    to = endOfDay(dayKey);
    trigger.classList.add("is-filtered");
    syncPresetHighlight();
    renderCalendar();
    onChange({ from, to });
  }

  function updateDrag(dayKey) {
    const a = Math.min(dragAnchor, dayKey);
    const b = Math.max(dragAnchor, dayKey);
    from = startOfDay(a);
    to = endOfDay(b);
    syncPresetHighlight();
    renderCalendar();
    onChange({ from, to });
  }

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    dragAnchor = null;
    toggle.checked = false;
  });

  function activePresetKey() {
    if (from == null && to == null) return "all";
    for (const [key, , range] of PRESETS) {
      if (key === "all") continue;
      const [f, tt] = range();
      if (f === from && tt === to) return key;
    }
    return null;
  }

  function syncPresetHighlight() {
    const active = activePresetKey();
    for (const { key, btn } of presetBtns) btn.classList.toggle("is-active", key === active);
  }

  function renderCalendar() {
    label.textContent = new Intl.DateTimeFormat(localeTag(), { month: "long", year: "numeric" }).format(viewMonth);
    gridEl.innerHTML = "";

    const startWeekday = viewMonth.getDay();
    const gridStart = new Date(viewMonth);
    gridStart.setDate(1 - startWeekday);
    const todayKey = startOfDay(Date.now());
    const rangeStart = from != null ? startOfDay(from) : null;
    const rangeEnd = to != null ? startOfDay(to) : null;

    for (let i = 0; i < 42; i++) {
      const day = new Date(gridStart);
      day.setDate(gridStart.getDate() + i);
      const dayKey = startOfDay(day.getTime());

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cal-day";
      btn.textContent = String(day.getDate());
      if (day.getMonth() !== viewMonth.getMonth()) btn.classList.add("is-outside");
      if (dayKey === todayKey) btn.classList.add("is-today");
      if (rangeStart != null && rangeEnd != null && dayKey >= rangeStart && dayKey <= rangeEnd) {
        btn.classList.add("is-in-range");
      }
      if (rangeStart != null && dayKey === rangeStart) btn.classList.add("is-range-start");
      if (rangeEnd != null && dayKey === rangeEnd) btn.classList.add("is-range-end");

      btn.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        startDrag(dayKey);
      });
      btn.addEventListener("mouseenter", () => {
        if (isDragging) updateDrag(dayKey);
      });

      gridEl.append(btn);
    }
  }

  function renderWeekdays() {
    weekdaysEl.innerHTML = "";
    const fmt = new Intl.DateTimeFormat(localeTag(), { weekday: "narrow" });
    // 1970-01-04 is a Sunday; the app's calendar always starts the week there.
    const ref = new Date(1970, 0, 4);
    for (let i = 0; i < 7; i++) {
      const d = new Date(ref);
      d.setDate(ref.getDate() + i);
      const el = document.createElement("span");
      el.textContent = fmt.format(d);
      weekdaysEl.append(el);
    }
  }

  function refreshLocale() {
    for (const { btn, i18nKey } of presetBtns) btn.textContent = t(i18nKey);
    prevBtn.setAttribute("aria-label", t("history.calPrevMonth"));
    nextBtn.setAttribute("aria-label", t("history.calNextMonth"));
    renderWeekdays();
    renderCalendar();
  }

  refreshLocale();
  syncPresetHighlight();

  return { refreshLocale };
}
