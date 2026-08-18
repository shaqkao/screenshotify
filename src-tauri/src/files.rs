use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Extensions Screenshotify treats as screenshots. Deliberately images only — v1 does
/// not touch PDFs or documents.
pub const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"];

/// Scanning stops here so that pointing at a huge picture library cannot lock
/// the UI up or fire thousands of paid API calls by accident.
const MAX_SCAN: usize = 2000;
const MAX_DEPTH: usize = 4;

pub fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[derive(Serialize, Clone, Debug)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub stem: String,
    pub ext: String,
    pub size: u64,
    /// Milliseconds since the Unix epoch; falls back to modified time.
    pub created: u64,
    pub modified: u64,
    /// 0 when the header could not be read (corrupt file, unsupported
    /// variant) — the frontend just omits dimensions in that case.
    pub width: u32,
    pub height: u32,
}

fn to_ms(time: Option<SystemTime>) -> u64 {
    time.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn entry_for(path: &Path) -> Result<FileEntry, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }

    let modified = to_ms(meta.modified().ok());
    let created = {
        let c = to_ms(meta.created().ok());
        if c == 0 {
            modified
        } else {
            c
        }
    };

    // Header-only read (no full decode), so this stays cheap even scanning a
    // folder of thousands of screenshots.
    let (width, height) = image::image_dimensions(path).unwrap_or((0, 0));

    Ok(FileEntry {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        stem: path
            .file_stem()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        ext: path
            .extension()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        size: meta.len(),
        created,
        modified,
        width,
        height,
    })
}

fn walk(dir: &Path, recursive: bool, depth: usize, out: &mut Vec<FileEntry>) {
    if out.len() >= MAX_SCAN || depth > MAX_DEPTH {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };

    let mut subdirs: Vec<PathBuf> = Vec::new();
    for item in read.flatten() {
        if out.len() >= MAX_SCAN {
            return;
        }
        let path = item.path();
        let Ok(ft) = item.file_type() else { continue };

        if ft.is_dir() {
            if recursive {
                subdirs.push(path);
            }
        } else if ft.is_file() && is_image(&path) {
            if let Ok(entry) = entry_for(&path) {
                out.push(entry);
            }
        }
    }

    for sub in subdirs {
        walk(&sub, recursive, depth + 1, out);
    }
}

/// Batch mode: everything already sitting in a folder, newest first.
pub fn scan(folder: &str, recursive: bool) -> Result<Vec<FileEntry>, String> {
    let dir = PathBuf::from(folder);
    if !dir.is_dir() {
        return Err(format!("{folder} is not a folder"));
    }
    let mut out = Vec::new();
    walk(&dir, recursive, 0, &mut out);
    out.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(out)
}

/// Explicit-selection mode: entries for exactly the files the user picked.
/// Non-images and files that vanished between picking and reading are
/// dropped rather than failing the whole selection.
pub fn entries_for_paths(paths: &[String]) -> Vec<FileEntry> {
    paths
        .iter()
        .map(Path::new)
        .filter(|p| is_image(p))
        .filter_map(|p| entry_for(p).ok())
        .collect()
}

/// Renames `path` to `stem` + its original extension, in the same folder.
/// Never overwrites: an existing name gets `-2`, `-3`, … appended.
/// Returns the path the file ended up at.
pub fn rename_to_stem(path: &str, stem: &str) -> Result<String, String> {
    let src = PathBuf::from(path);
    if !src.is_file() {
        return Err("That file no longer exists — it may have been moved or renamed.".into());
    }

    let stem = stem.trim();
    if stem.is_empty() {
        return Err("The new name is empty.".into());
    }

    let dir = src
        .parent()
        .ok_or_else(|| "Could not determine the containing folder.".to_string())?;
    let ext = src.extension().map(|e| e.to_string_lossy().to_string());

    let build = |s: &str| -> PathBuf {
        match &ext {
            Some(e) => dir.join(format!("{s}.{e}")),
            None => dir.join(s),
        }
    };

    let mut target = build(stem);

    // Renaming a file to the name it already has is a no-op, not a collision.
    if target == src {
        return Ok(src.to_string_lossy().to_string());
    }

    let mut n = 2;
    while target.exists() {
        target = build(&format!("{stem}-{n}"));
        n += 1;
        if n > 999 {
            return Err("Too many files with a similar name already exist.".into());
        }
    }

    std::fs::rename(&src, &target).map_err(|e| format!("Rename failed: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

/// Undo: put a renamed file back under its original name.
pub fn revert(current: &str, original: &str) -> Result<(), String> {
    let from = PathBuf::from(current);
    let to = PathBuf::from(original);

    if !from.is_file() {
        return Err(format!(
            "{} is not there any more — it was moved or renamed outside Screenshotify.",
            from.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    if to.exists() {
        return Err(format!(
            "A file called {} already exists, so the original name cannot be restored.",
            to.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    std::fs::rename(&from, &to).map_err(|e| format!("Undo failed: {e}"))
}

/// The folders the OS saves screenshots to, when present.
pub fn default_screenshot_folders() -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for path in screenshot_candidates() {
        if !path.is_dir() {
            continue;
        }
        let s = path.to_string_lossy().to_string();
        if !seen.contains(&s) {
            seen.push(s);
        }
    }
    seen
}

/// Windows: the Pictures\Screenshots folder, its OneDrive-redirected twin, and
/// the Xbox Game Bar's capture folder.
#[cfg(windows)]
fn screenshot_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(pics) = dirs::picture_dir() {
        candidates.push(pics.join("Screenshots"));
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join("OneDrive").join("Pictures").join("Screenshots"));
        candidates.push(home.join("Pictures").join("Screenshots"));
    }
    if let Some(videos) = dirs::video_dir() {
        candidates.push(videos.join("Captures"));
    }
    candidates
}

/// macOS: whatever `com.apple.screencapture location` says first — that setting
/// is the only place the real answer lives, and moving screenshots off the
/// Desktop is a common enough thing to do — then the Desktop it defaults to,
/// then `~/Pictures/Screenshots` for anyone who keeps them there by hand.
#[cfg(target_os = "macos")]
fn screenshot_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(configured) = screencapture_location() {
        candidates.push(configured);
    }
    if let Some(desktop) = dirs::desktop_dir() {
        candidates.push(desktop);
    }
    if let Some(pics) = dirs::picture_dir() {
        candidates.push(pics.join("Screenshots"));
    }
    candidates
}

/// Reads the screenshot destination out of the screencapture preference domain.
/// `defaults` is used rather than parsing the plist directly because the value
/// may live in a managed or per-host domain that only `defaults` resolves — and
/// an unset key is the normal case, not an error.
#[cfg(target_os = "macos")]
fn screencapture_location() -> Option<PathBuf> {
    let out = std::process::Command::new("defaults")
        .args(["read", "com.apple.screencapture", "location"])
        .output()
        .ok()?;
    if !out.status.success() {
        // The usual case: the key has never been set, so the Desktop it is.
        return None;
    }
    expand_home(&String::from_utf8_lossy(&out.stdout))
}

/// `defaults` hands the value back exactly as it was typed, and typing a path
/// with a tilde in it is the normal way to set this one — nothing else in the
/// chain expands it.
#[cfg(target_os = "macos")]
fn expand_home(raw: &str) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if raw == "~" {
        return dirs::home_dir();
    }
    match raw.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().map(|home| home.join(rest)),
        None => Some(PathBuf::from(raw)),
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn screenshot_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(pics) = dirs::picture_dir() {
        candidates.push(pics.join("Screenshots"));
        candidates.push(pics);
    }
    candidates
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::expand_home;
    use std::path::PathBuf;

    #[test]
    fn expands_the_tilde_defaults_hands_back() {
        let home = dirs::home_dir().expect("a home directory");
        assert_eq!(expand_home("~/Desktop"), Some(home.join("Desktop")));
        assert_eq!(expand_home("~"), Some(home.clone()));
        // Trailing newline: `defaults read` always adds one.
        assert_eq!(expand_home("~/Pictures\n"), Some(home.join("Pictures")));
    }

    #[test]
    fn leaves_an_absolute_path_alone() {
        assert_eq!(
            expand_home("/Volumes/Shots"),
            Some(PathBuf::from("/Volumes/Shots"))
        );
    }

    #[test]
    fn treats_an_unset_value_as_no_answer() {
        assert_eq!(expand_home(""), None);
        assert_eq!(expand_home("  \n"), None);
    }
}
