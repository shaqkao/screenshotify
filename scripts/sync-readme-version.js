// Run by `npm version` (see package.json's "version" script). GitHub release
// asset filenames bake in the version number, so there is no version-
// independent URL the README's Windows/macOS download buttons could link to
// instead — this keeps those two links pointed at the installer this exact
// version bump is about to tag and release.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const base = `https://github.com/shaqkao/screenshotify/releases/download/v${version}`;

const readme = readFileSync("README.md", "utf8");
const updated = readme
  .replace(
    /https:\/\/github\.com\/shaqkao\/screenshotify\/releases\/download\/v[\d.]+\/Screenshotify_[\d.]+_x64-setup\.exe/,
    `${base}/Screenshotify_${version}_x64-setup.exe`
  )
  .replace(
    /https:\/\/github\.com\/shaqkao\/screenshotify\/releases\/download\/v[\d.]+\/Screenshotify_[\d.]+_universal\.dmg/,
    `${base}/Screenshotify_${version}_universal.dmg`
  );

if (updated === readme) {
  throw new Error("sync-readme-version: no download link matched in README.md — check the URL pattern.");
}
writeFileSync("README.md", updated);
