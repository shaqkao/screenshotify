// Run by `npm run package:msix` after `tauri build`. `winapp pack` wants a
// clean input folder containing only the files that belong in the MSIX —
// not `src-tauri/target/release/` itself, which is full of intermediate
// build artifacts. This copies out just the compiled exe (Tauri embeds the
// frontend into the binary at build time, so nothing else is needed).
import { copyFileSync, mkdirSync } from "node:fs";

const EXE = "src-tauri/target/release/screenshotify.exe";
const STAGE_DIR = "msix-stage";

mkdirSync(STAGE_DIR, { recursive: true });
copyFileSync(EXE, `${STAGE_DIR}/screenshotify.exe`);
