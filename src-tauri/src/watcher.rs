//! Folder watching.
//!
//! Filesystem events fire while a screenshot is still being written, so a raw
//! Create event is not a usable signal. Detected paths go into a holding area
//! and are only announced once their size has stopped changing — otherwise the
//! model would be shown a half-written PNG.

use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::files;

/// How long a file's size must hold steady before it counts as finished.
const STABLE: Duration = Duration::from_millis(900);
const POLL: Duration = Duration::from_millis(350);
/// A file that never settles (a locked or streaming write) is dropped.
const GIVE_UP: Duration = Duration::from_secs(90);
/// Screenshotify's own renames land as filesystem events too; ignore them briefly.
const IGNORE_FOR: Duration = Duration::from_secs(15);

struct Settling {
    size: u64,
    steady_since: Instant,
    first_seen: Instant,
}

/// Sent to the frontend on `screenshotify://watch-error`. `fatal` separates "the
/// watcher is dead, stop claiming to watch" from "one folder of several was
/// skipped" — the frontend must not disable watching for the latter.
#[derive(Clone, serde::Serialize)]
struct WatchError {
    fatal: bool,
    message: String,
}

#[derive(Default)]
pub struct Watch {
    watcher: Mutex<Option<RecommendedWatcher>>,
    pending: Arc<Mutex<HashMap<PathBuf, Settling>>>,
    ignore: Arc<Mutex<HashMap<PathBuf, Instant>>>,
    folders: Mutex<Vec<String>>,
}

impl Watch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Marks a path as self-inflicted so the watcher does not queue it back up.
    pub fn ignore_path(&self, path: &Path) {
        if let Ok(mut map) = self.ignore.lock() {
            map.insert(path.to_path_buf(), Instant::now());
        }
        if let Ok(mut map) = self.pending.lock() {
            map.remove(path);
        }
    }

    pub fn watched_folders(&self) -> Vec<String> {
        self.folders.lock().map(|f| f.clone()).unwrap_or_default()
    }

    pub fn stop(&self) {
        if let Ok(mut slot) = self.watcher.lock() {
            *slot = None; // dropping the watcher unregisters every folder
        }
        if let Ok(mut map) = self.pending.lock() {
            map.clear();
        }
        if let Ok(mut folders) = self.folders.lock() {
            folders.clear();
        }
    }

    pub fn start(&self, app: &AppHandle, folders: Vec<String>) -> Result<(), String> {
        self.stop();
        if folders.is_empty() {
            return Ok(());
        }

        let pending = Arc::clone(&self.pending);
        let ignore = Arc::clone(&self.ignore);
        let app_for_errors = app.clone();

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let event = match res {
                Ok(ev) => ev,
                Err(err) => {
                    let _ = app_for_errors.emit(
                        "screenshotify://watch-error",
                        WatchError { fatal: true, message: err.to_string() },
                    );
                    return;
                }
            };

            let interesting = matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_))
            );
            if !interesting {
                return;
            }

            for path in event.paths {
                if !files::is_image(&path) {
                    continue;
                }
                if let Ok(map) = ignore.lock() {
                    if map.contains_key(&path) {
                        continue;
                    }
                }
                if let Ok(mut map) = pending.lock() {
                    let now = Instant::now();
                    map.entry(path).or_insert(Settling {
                        size: u64::MAX, // forces one comparison pass before settling
                        steady_since: now,
                        first_seen: now,
                    });
                }
            }
        })
        .map_err(|e| format!("Could not start the folder watcher: {e}"))?;

        let mut accepted = Vec::new();
        let mut failures = Vec::new();
        for folder in &folders {
            let path = PathBuf::from(folder);
            if !path.is_dir() {
                failures.push(format!("{folder} (not a folder)"));
                continue;
            }
            match watcher.watch(&path, RecursiveMode::Recursive) {
                Ok(()) => accepted.push(folder.clone()),
                Err(e) => failures.push(format!("{folder} ({e})")),
            }
        }

        if accepted.is_empty() {
            return Err(format!("None of the folders could be watched: {}", failures.join(", ")));
        }

        if let Ok(mut slot) = self.watcher.lock() {
            *slot = Some(watcher);
        }
        if let Ok(mut list) = self.folders.lock() {
            *list = accepted;
        }

        if !failures.is_empty() {
            let _ = app.emit(
                "screenshotify://watch-error",
                WatchError {
                    fatal: false,
                    message: format!("Some folders could not be watched: {}", failures.join(", ")),
                },
            );
        }

        Ok(())
    }

    /// Background loop that promotes settled files into frontend events.
    pub fn spawn_settler(&self, app: AppHandle) {
        let pending = Arc::clone(&self.pending);
        let ignore = Arc::clone(&self.ignore);

        std::thread::spawn(move || loop {
            std::thread::sleep(POLL);

            // Expire stale ignore entries so long-running sessions don't leak.
            if let Ok(mut map) = ignore.lock() {
                map.retain(|_, at| at.elapsed() < IGNORE_FOR);
            }

            let mut ready: Vec<PathBuf> = Vec::new();

            {
                let Ok(mut map) = pending.lock() else { continue };
                let now = Instant::now();

                map.retain(|path, state| {
                    if now.duration_since(state.first_seen) > GIVE_UP {
                        return false;
                    }
                    let Ok(meta) = std::fs::metadata(path) else {
                        // Gone again already — a temp file, or moved away.
                        return now.duration_since(state.first_seen) <= Duration::from_secs(5);
                    };
                    if !meta.is_file() {
                        return false;
                    }

                    let size = meta.len();
                    if size != state.size {
                        state.size = size;
                        state.steady_since = now;
                        return true;
                    }
                    if size > 0 && now.duration_since(state.steady_since) >= STABLE {
                        ready.push(path.clone());
                        return false;
                    }
                    true
                });
            }

            for path in ready {
                if let Ok(map) = ignore.lock() {
                    if map.contains_key(&path) {
                        continue;
                    }
                }
                match files::entry_for(&path) {
                    Ok(entry) => {
                        let _ = app.emit("screenshotify://file-detected", entry);
                    }
                    Err(err) => eprintln!("screenshotify: skipping {}: {err}", path.display()),
                }
            }
        });
    }
}
