import test from "node:test";
import assert from "node:assert/strict";

import { buildStem, cleanModelOutput, datePrefix, sanitizeUserStem, toWords } from "./naming.js";

/* ── cleanModelOutput: models are not well behaved ──────────────────── */

test("strips quotes, backticks and trailing punctuation", () => {
  assert.equal(cleanModelOutput('"login screen error"'), "login screen error");
  assert.equal(cleanModelOutput("`vscode-settings-panel`"), "vscode-settings-panel");
  assert.equal(cleanModelOutput("**stripe dashboard**"), "stripe dashboard");
});

test("strips the labels models prepend", () => {
  assert.equal(cleanModelOutput("Filename: github pull request"), "github pull request");
  assert.equal(cleanModelOutput("Suggested name: slack thread"), "slack thread");
});

test("unwraps markdown fences", () => {
  assert.equal(cleanModelOutput("```\nfigma-export-dialog\n```"), "figma-export-dialog");
});

test("drops an extension the model added anyway", () => {
  assert.equal(cleanModelOutput("aws-billing-page.png"), "aws-billing-page");
  assert.equal(cleanModelOutput('"terminal output.JPEG"'), "terminal output");
});

test("picks the filename line out of a chatty answer", () => {
  const reply = "Here is a good filename:\nnotion-roadmap-board";
  assert.equal(cleanModelOutput(reply), "notion-roadmap-board");
});

/* ── toWords ─────────────────────────────────────────────────────────── */

test("splits camelCase and separators", () => {
  assert.deepEqual(toWords("loginScreenError"), ["login", "Screen", "Error"]);
  assert.deepEqual(toWords("aws_billing-page"), ["aws", "billing", "page"]);
});

test("drops characters Windows would reject", () => {
  assert.deepEqual(toWords('report: q3/q4 <draft>'), ["report", "q3", "q4", "draft"]);
});

/* ── buildStem: the whole pipeline ───────────────────────────────────── */

const CREATED = Date.UTC(2026, 7, 12, 14, 35); // 2026-08-12 14:35 UTC

test("applies each filename style", () => {
  const base = { raw: "Login Screen Error", createdMs: CREATED };
  assert.equal(buildStem({ ...base, style: "kebab" }), "login-screen-error");
  assert.equal(buildStem({ ...base, style: "snake" }), "login_screen_error");
  assert.equal(buildStem({ ...base, style: "space" }), "login screen error");
  assert.equal(buildStem({ ...base, style: "title" }), "Login Screen Error");
  assert.equal(buildStem({ ...base, style: "camel" }), "loginScreenError");
});

test("honours the word limit", () => {
  assert.equal(
    buildStem({ raw: "one two three four five six seven", maxWords: 3 }),
    "one-two-three"
  );
});

test("drops the leading filler models keep adding", () => {
  assert.equal(buildStem({ raw: "screenshot of stripe dashboard" }), "stripe-dashboard");
  assert.equal(buildStem({ raw: "Image of the AWS billing page" }), "aws-billing-page");
});

test("only drops filler at the front, never mid-name", () => {
  assert.equal(buildStem({ raw: "login screen error" }), "login-screen-error");
});

test("keeps leading words that are genuinely part of the subject", () => {
  assert.equal(buildStem({ raw: "capture card settings" }), "capture-card-settings");
  assert.equal(buildStem({ raw: "screen brightness slider" }), "screen-brightness-slider");
});

test("keeps the answer when filler is all there is", () => {
  assert.equal(buildStem({ raw: "screenshot" }), "screenshot");
});

test("date prefix uses the file's own timestamp and the style separator", () => {
  const d = new Date(CREATED);
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;

  assert.equal(
    buildStem({ raw: "stripe dashboard", prefixMode: "dash", createdMs: CREATED }),
    `${expected}-stripe-dashboard`
  );
  // The separator between prefix and name follows the filename style.
  assert.equal(
    buildStem({ raw: "stripe dashboard", style: "snake", prefixMode: "dash", createdMs: CREATED }),
    `${expected}_stripe_dashboard`
  );
});

test("date prefix modes produce the documented shapes", () => {
  assert.match(datePrefix("dash", CREATED), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(datePrefix("compact", CREATED), /^\d{8}$/);
  assert.match(datePrefix("datetime", CREATED), /^\d{4}-\d{2}-\d{2}-\d{4}$/);
  assert.equal(datePrefix("none", CREATED), "");
});

test("never produces a name any platform would reject", () => {
  const stem = buildStem({ raw: 'C:\\Users\\report <final>? "v2"' });
  assert.doesNotMatch(stem, /[<>:"/\\|?*]/);
  assert.doesNotMatch(stem, /[. ]$/);
  // A leading dot would make the renamed screenshot invisible on macOS.
  assert.doesNotMatch(stem, /^\./);
});

test("escapes reserved device names", () => {
  assert.equal(buildStem({ raw: "con" }), "con-file");
  assert.equal(buildStem({ raw: "COM1" }), "com1-file");
});

test("caps the length", () => {
  const stem = buildStem({ raw: "word ".repeat(40), maxWords: 40 });
  assert.ok(stem.length <= 80, `expected <= 80 chars, got ${stem.length}`);
  assert.doesNotMatch(stem, /[-_ ]$/);
});

test("returns empty when there is nothing usable", () => {
  assert.equal(buildStem({ raw: "" }), "");
  assert.equal(buildStem({ raw: "***" }), "");
});

/* ── sanitizeUserStem: what the user typed by hand ───────────────────── */

test("keeps spaces and hyphens the user typed", () => {
  assert.equal(sanitizeUserStem("My Report - v2"), "My Report - v2");
});

test("removes illegal characters without mangling the rest", () => {
  assert.equal(sanitizeUserStem('report: q3/q4?'), "report q3q4");
  assert.equal(sanitizeUserStem("trailing dots..."), "trailing dots");
});

test("never leaves a leading dot, which would hide the file on macOS", () => {
  assert.equal(sanitizeUserStem(".hidden report"), "hidden report");
  assert.equal(sanitizeUserStem("..DS_Store"), "DS_Store");
  // Dots in the middle are a normal thing to want.
  assert.equal(sanitizeUserStem("v1.2 draft"), "v1.2 draft");
});

test("escapes reserved device names typed by hand", () => {
  assert.equal(sanitizeUserStem("nul"), "nul-file");
});
