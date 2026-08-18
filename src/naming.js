/**
 * Turns whatever the model replied with into a safe filename stem.
 * Models are chatty and inconsistent, so this stage is deliberately strict:
 * everything the user sees in the review list has already been through it.
 *
 * The rules below are the union of every platform's, not just the running
 * one's: macOS accepts a name with a backslash or a question mark in it quite
 * happily, and then that screenshot is unusable the moment it is sent to
 * someone on Windows. Screenshots get shared, so the strictest rule wins.
 */

// Characters Windows refuses in a filename. "/" and ":" are the two macOS
// rejects as well, so this set covers both.
const ILLEGAL = /[<>:"/\\|?*]/g;
// Control characters (\p{Cc}) are equally illegal and invisible in the UI.
const CONTROL = /\p{Cc}/gu;
// Device names Windows reserves regardless of extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// Wrappers models like to add: quotes, backticks, markdown fences, asterisks.
const WRAPPERS = /^[\s"'`*_[\](){}]+|[\s"'`*_[\](){}.]+$/g;
// Words worth dropping only when they open the name. Kept narrow on purpose:
// "screen", "shot", "grab" and "capture" are all real subjects in their own
// right ("capture card settings"), so they stay.
const LEADING_FILLER = /^(screenshot|screengrab|image|picture|photo|untitled|of|a|an|the)$/i;

const MAX_STEM = 80;

const STOP_PREFIXES = [
  "filename:",
  "file name:",
  "suggested filename:",
  "suggested name:",
  "name:",
  "here is the filename",
  "here's the filename",
  "the filename is",
];

/** Strips the chatter models wrap around a one-line answer. */
export function cleanModelOutput(raw) {
  if (!raw) return "";

  // Line breaks are control characters too, and they carry meaning here — the
  // filename is usually on its own line. Clean each line, keep the breaks.
  let s = String(raw)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(CONTROL, " ").trim())
    .filter(Boolean)
    .join("\n");

  // Fenced block — keep the contents.
  const fence = s.match(/```[a-z]*\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // Multi-line answers: prefer the line that actually looks like a filename
  // rather than the model's explanation of it.
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    s =
      lines.find((l) => l.length <= 90 && !l.endsWith(".") && !/\s(is|the|a)\s/i.test(l)) ||
      lines[0];
  }

  s = s.replace(WRAPPERS, "");

  const lower = s.toLowerCase();
  for (const p of STOP_PREFIXES) {
    if (lower.startsWith(p)) {
      s = s.slice(p.length).trim().replace(WRAPPERS, "");
      break;
    }
  }

  // The model was told not to add an extension, but they often do anyway.
  s = s.replace(/\.(png|jpe?g|webp|bmp|gif|tiff?)$/i, "");

  return s.trim();
}

/** Splits an arbitrary string into words. */
export function toWords(s) {
  return String(s)
    // Split camelCase / PascalCase runs the model may have produced.
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function capitalize(w) {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Joins words using the user's chosen filename style. */
export function applyCase(words, style) {
  if (!words.length) return "";
  switch (style) {
    case "snake":
      return words.map((w) => w.toLowerCase()).join("_");
    case "space":
      return words.map((w) => w.toLowerCase()).join(" ");
    case "title":
      return words.map((w) => capitalize(w.toLowerCase())).join(" ");
    case "camel":
      return words
        .map((w, i) => (i === 0 ? w.toLowerCase() : capitalize(w.toLowerCase())))
        .join("");
    case "kebab":
    default:
      return words.map((w) => w.toLowerCase()).join("-");
  }
}

const pad = (n) => String(n).padStart(2, "0");

/** Date prefix derived from the file's own timestamp, never from "now". */
export function datePrefix(mode, epochMs) {
  if (!mode || mode === "none") return "";
  const d = new Date(epochMs || Date.now());
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  switch (mode) {
    case "compact":
      return `${y}${m}${day}`;
    case "datetime":
      return `${y}-${m}-${day}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    case "dash":
      return `${y}-${m}-${day}`;
    default:
      return "";
  }
}

function separatorFor(style) {
  if (style === "snake") return "_";
  if (style === "space" || style === "title") return " ";
  return "-";
}

/**
 * Full pipeline: raw model text -> final filename stem (no extension).
 * Returns "" when there is nothing usable left, so callers can flag an error
 * rather than silently renaming a file to something meaningless.
 */
export function buildStem({
  raw,
  style = "kebab",
  prefixMode = "none",
  maxWords = 6,
  createdMs = 0,
}) {
  const cleaned = cleanModelOutput(raw);
  const words = toWords(cleaned);

  // Models keep opening with "screenshot of …" despite being told not to.
  // Only the leading run is dropped: "login screen error" must keep its
  // "screen", and a name that is nothing but filler is left alone.
  while (words.length > 1 && LEADING_FILLER.test(words[0])) {
    words.shift();
  }

  words.splice(Math.max(1, maxWords));
  let stem = applyCase(words, style);
  if (!stem) return "";

  const prefix = datePrefix(prefixMode, createdMs);
  if (prefix) stem = prefix + separatorFor(style) + stem;

  if (stem.length > MAX_STEM) {
    stem = stem.slice(0, MAX_STEM).replace(/[-_ ]+$/, "");
  }

  if (RESERVED.test(stem)) stem = `${stem}-file`;

  // Windows silently trims trailing dots and spaces; do it ourselves so the
  // name we show is the name that lands on disk.
  return stem.replace(/[. ]+$/, "");
}

/** Sanitising for a name the user typed by hand in the review list. */
export function sanitizeUserStem(input) {
  let s = String(input || "")
    .replace(CONTROL, "")
    .replace(ILLEGAL, "")
    .trim()
    // A leading dot makes the file invisible in Finder and in `ls` — never
    // what someone renaming a screenshot meant, and hard to recover from
    // once the file has vanished from the folder they were looking at.
    .replace(/^\.+/, "")
    .trim()
    .replace(/[. ]+$/, "");
  if (s.length > MAX_STEM * 2) s = s.slice(0, MAX_STEM * 2);
  if (RESERVED.test(s)) s = `${s}-file`;
  return s;
}
