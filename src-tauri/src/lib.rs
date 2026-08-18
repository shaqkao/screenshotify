mod ai;
mod files;
mod imaging;
mod secrets;
mod toast;
mod watcher;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

use watcher::Watch;

/// Flag the autostart plugin passes so a login launch stays in the tray, or in
/// the menu bar on macOS.
const MINIMIZED_FLAG: &str = "--minimized";

struct AppState {
    close_to_tray: AtomicBool,
    launched_minimized: bool,
}

/* ══════════════════════════ Platform ══════════════════════════ */

/// The handful of facts the UI has to word differently per platform. Sent over
/// once at startup rather than sniffed from the user agent, so the frontend and
/// the Rust side can never disagree about which platform they are on.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformInfo {
    /// `std::env::consts::OS` — "windows", "macos", …
    os: &'static str,
    /// What to call the credential store: "Windows Credential Manager",
    /// "macOS Keychain".
    key_store: &'static str,
    /// What to call the tray: "system tray" on Windows, "menu bar" on macOS.
    tray_name: &'static str,
    /// What to call the file manager: "File Explorer", "Finder".
    file_manager: &'static str,
    /// Where autostart puts the app: "sign in to Windows", "log in".
    login_phrase: &'static str,
}

#[cfg(target_os = "macos")]
const FILE_MANAGER: &str = "Finder";
#[cfg(windows)]
const FILE_MANAGER: &str = "File Explorer";
#[cfg(not(any(windows, target_os = "macos")))]
const FILE_MANAGER: &str = "the file manager";

#[tauri::command]
fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS,
        key_store: secrets::STORE_NAME,
        tray_name: if cfg!(target_os = "macos") {
            "menu bar"
        } else {
            "system tray"
        },
        file_manager: FILE_MANAGER,
        login_phrase: if cfg!(target_os = "macos") {
            "log in"
        } else {
            "sign in to Windows"
        },
    }
}

/* ══════════════════════════ Window helpers ══════════════════════════ */

/// macOS has no "hide from the taskbar" flag; the equivalent is dropping the
/// whole process out of the Dock and the ⌘-Tab switcher, which is what a
/// menu-bar app is expected to do while it has no window on screen.
#[cfg(target_os = "macos")]
fn set_dock_visible(app: &AppHandle, visible: bool) {
    let _ = app.set_dock_visibility(visible);
}

#[cfg(not(target_os = "macos"))]
fn set_dock_visible(_app: &AppHandle, _visible: bool) {}

/// Frontend counterpart of the above: `startMinimized` is a frontend setting,
/// so the decision to stay out of the Dock is made there.
#[tauri::command]
fn set_dock_icon(app: AppHandle, visible: bool) {
    set_dock_visible(&app, visible);
}

fn show_main(app: &AppHandle) {
    // Before the window: a process in Accessory mode cannot take focus, so the
    // Dock icon has to come back first or the window opens behind whatever the
    // user was looking at.
    set_dock_visible(app, true);

    if let Some(win) = app.get_webview_window("main") {
        #[cfg(not(target_os = "macos"))]
        let _ = win.set_skip_taskbar(false);
        let _ = win.show();
        let _ = win.unminimize();
        // Windows' foreground-lock heuristic silently drops set_focus() when
        // the request comes from a background process — which this one is,
        // from the OS's point of view, whenever it's reacting to a second
        // launch (single-instance) or a toast click rather than a click the
        // user just made on this window itself. Toggling always-on-top forces
        // the window to the front of the z-order regardless of that lock.
        // macOS has no such lock and does honour set_focus, and forcing
        // always-on-top there would fight Mission Control, so it stays out.
        #[cfg(not(target_os = "macos"))]
        {
            let _ = win.set_always_on_top(true);
            let _ = win.set_always_on_top(false);
        }
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
fn launched_minimized(state: State<'_, AppState>) -> bool {
    state.launched_minimized
}

#[tauri::command]
fn set_close_to_tray(state: State<'_, AppState>, enabled: bool) {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
}

/* ══════════════════════════ Files ══════════════════════════ */

#[tauri::command]
fn default_screenshot_folders() -> Vec<String> {
    files::default_screenshot_folders()
}

#[tauri::command]
async fn scan_folder(folder: String, recursive: bool) -> Result<Vec<files::FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || files::scan(&folder, recursive))
        .await
        .map_err(|e| format!("Scan failed: {e}"))?
}

#[tauri::command]
async fn scan_files(paths: Vec<String>) -> Result<Vec<files::FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || files::entries_for_paths(&paths))
        .await
        .map_err(|e| format!("Could not read the selected files: {e}"))
}

#[tauri::command]
async fn thumbnail(path: String, max_edge: u32) -> Result<String, String> {
    // Decoding a multi-megabyte PNG is CPU work; keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        imaging::encode_downscaled(Path::new(&path), max_edge, 78)
    })
    .await
    .map_err(|e| format!("Preview failed: {e}"))?
}

#[tauri::command]
fn rename_file(watch: State<'_, Watch>, path: String, stem: String) -> Result<String, String> {
    let result = files::rename_to_stem(&path, &stem)?;
    // Both sides of the rename are our own doing — don't let the watcher
    // queue the renamed file straight back up for review.
    watch.ignore_path(Path::new(&path));
    watch.ignore_path(Path::new(&result));
    Ok(result)
}

#[tauri::command]
fn revert_rename(watch: State<'_, Watch>, current: String, original: String) -> Result<(), String> {
    files::revert(&current, &original)?;
    watch.ignore_path(Path::new(&current));
    watch.ignore_path(Path::new(&original));
    Ok(())
}

/// Opens a folder in the platform's file manager.
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err("That folder no longer exists.".into());
    }
    spawn_file_manager(&path, false)
}

/// Opens the containing folder with the file selected.
#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("That file no longer exists.".into());
    }
    spawn_file_manager(&path, true)
}

#[cfg(windows)]
fn spawn_file_manager(path: &str, select: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let mut cmd = std::process::Command::new("explorer");
    if select {
        // explorer.exe wants the switch and the path as a single argument.
        cmd.raw_arg(format!("/select,\"{path}\""));
    } else {
        cmd.arg(path);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open {FILE_MANAGER}: {e}"))
}

#[cfg(target_os = "macos")]
fn spawn_file_manager(path: &str, select: bool) -> Result<(), String> {
    let mut cmd = std::process::Command::new("open");
    if select {
        cmd.arg("-R");
    }
    cmd.arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open {FILE_MANAGER}: {e}"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn spawn_file_manager(path: &str, select: bool) -> Result<(), String> {
    // xdg-open has no "select this file" mode, so the containing folder is the
    // best available answer.
    let target = if select {
        Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string())
    } else {
        path.to_string()
    };
    std::process::Command::new("xdg-open")
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open {FILE_MANAGER}: {e}"))
}

/* ══════════════════════════ Secrets ══════════════════════════ */

#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
    secrets::set(&key)
}

#[tauri::command]
fn has_api_key() -> bool {
    secrets::has()
}

#[tauri::command]
fn delete_api_key() -> Result<(), String> {
    secrets::delete()
}

/* ══════════════════════════ AI ══════════════════════════ */

#[tauri::command]
async fn suggest_filename(
    path: String,
    base_url: String,
    model: String,
    prompt: String,
    max_edge: u32,
) -> Result<ai::SuggestResult, String> {
    let image = {
        let p = PathBuf::from(&path);
        tauri::async_runtime::spawn_blocking(move || imaging::encode_downscaled(&p, max_edge, 85))
            .await
            .map_err(|e| format!("Image processing failed: {e}"))??
    };
    ai::suggest(&base_url, &model, &prompt, &image).await
}

#[tauri::command]
async fn test_connection(base_url: String, model: String) -> Result<String, String> {
    ai::test(&base_url, &model).await
}

#[tauri::command]
async fn list_models(base_url: String) -> Result<Vec<String>, String> {
    ai::list_models(&base_url).await
}

/* ══════════════════════════ Watching ══════════════════════════ */

#[tauri::command]
fn start_watching(
    app: AppHandle,
    watch: State<'_, Watch>,
    folders: Vec<String>,
) -> Result<(), String> {
    watch.start(&app, folders)
}

#[tauri::command]
fn stop_watching(watch: State<'_, Watch>) {
    watch.stop();
}

#[tauri::command]
fn watched_folders(watch: State<'_, Watch>) -> Vec<String> {
    watch.watched_folders()
}

/* ══════════════════════════ Tray ══════════════════════════ */

#[tauri::command]
fn set_tray_state(app: AppHandle, pending: u32, watching: bool) -> Result<(), String> {
    let Some(tray) = app.tray_by_id("main") else {
        return Ok(());
    };
    let tooltip = if !watching {
        "Screenshotify — watching paused".to_string()
    } else if pending == 0 {
        "Screenshotify — watching for screenshots".to_string()
    } else if pending == 1 {
        "Screenshotify — 1 screenshot ready to review".to_string()
    } else {
        format!("Screenshotify — {pending} screenshots ready to review")
    };
    tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())
}

/// A menu bar icon has to be a black-and-transparent template image so macOS
/// can invert it for a dark menu bar and tint it while the menu is open. The app
/// icon's own alpha channel already *is* that silhouette, so this file is that
/// alpha channel at 22pt @2x rather than a second drawing that could drift from
/// the first.
#[cfg(target_os = "macos")]
const TRAY_TEMPLATE_ICON: &[u8] = include_bytes!("../icons/tray-macos-template.png");

// The returned image borrows from `app` in the non-macOS case, so the lifetime
// has to be named rather than 'static — default_window_icon() hands back a
// reference tied to the handle, not to the program.
#[cfg(target_os = "macos")]
fn tray_icon<'a>(_app: &'a AppHandle) -> Option<tauri::image::Image<'a>> {
    match tauri::image::Image::from_bytes(TRAY_TEMPLATE_ICON) {
        Ok(icon) => Some(icon),
        Err(err) => {
            eprintln!("screenshotify: menu bar icon failed to load: {err}");
            None
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn tray_icon<'a>(app: &'a AppHandle) -> Option<tauri::image::Image<'a>> {
    app.default_window_icon().cloned()
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Screenshotify", true, None::<&str>)?;
    let scan = MenuItem::with_id(app, "scan", "Scan a folder…", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle-watch", "Pause / resume watching", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Screenshotify", true, None::<&str>)?;
    let sep_a = PredefinedMenuItem::separator(app)?;
    let sep_b = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&open, &scan, &sep_a, &toggle, &sep_b, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Screenshotify")
        .menu(&menu)
        // Windows: left click opens the window, the menu belongs on right
        // click. macOS: a status item opens its menu on either button, and
        // anything else reads as broken — "Open Screenshotify" is the first
        // item there for exactly that reason.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                show_main(app);
                let _ = app.emit("screenshotify://show-review", ());
            }
            "scan" => {
                show_main(app);
                let _ = app.emit("screenshotify://tray", "scan");
            }
            "toggle-watch" => {
                let _ = app.emit("screenshotify://tray", "toggle-watch");
            }
            "quit" => app.exit(0),
            _ => {}
        });

    #[cfg(not(target_os = "macos"))]
    {
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
        builder = builder.on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                show_main(app);
                let _ = app.emit("screenshotify://show-review", ());
            }
        });
    }

    if let Some(icon) = tray_icon(app) {
        builder = builder.icon(icon);
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder.icon_as_template(true);
    }

    builder.build(app)?;
    Ok(())
}

/* ══════════════════════════ Entry point ══════════════════════════ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Not named `launched_minimized`: that would shadow the command of the
    // same name inside `generate_handler!` below.
    let minimized_launch = std::env::args().any(|a| a == MINIMIZED_FLAG);

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // A second launch should surface the running instance, not start a
        // second tray icon and a second watcher over the same folders.
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                show_main(app);
                let _ = app.emit("screenshotify://show-review", ());
            }))
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec![MINIMIZED_FLAG]),
            ))
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(move |app| {
            let handle = app.handle().clone();

            // A login launch is never going to put a window on screen, and
            // deciding that here rather than waiting for the frontend to say so
            // is what keeps the Dock icon from appearing and vanishing again
            // every time the user logs in.
            if minimized_launch {
                set_dock_visible(&handle, false);
            }

            app.manage(AppState {
                close_to_tray: AtomicBool::new(true),
                launched_minimized: minimized_launch,
            });

            let watch = Watch::new();
            watch.spawn_settler(handle.clone());
            app.manage(watch);

            build_tray(&handle)?;

            if let Some(window) = app.get_webview_window("main") {
                let win_handle = handle.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let state = win_handle.state::<AppState>();
                        if state.close_to_tray.load(Ordering::Relaxed) {
                            api.prevent_close();
                            if let Some(win) = win_handle.get_webview_window("main") {
                                let _ = win.hide();
                                #[cfg(not(target_os = "macos"))]
                                let _ = win.set_skip_taskbar(true);
                            }
                            // Nothing left on screen, so stop occupying the
                            // Dock — this is what makes it a menu bar app
                            // rather than an app pretending to be one.
                            set_dock_visible(&win_handle, false);
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_main_window,
            launched_minimized,
            set_close_to_tray,
            platform_info,
            set_dock_icon,
            default_screenshot_folders,
            scan_folder,
            scan_files,
            thumbnail,
            rename_file,
            revert_rename,
            open_folder,
            reveal_file,
            set_api_key,
            has_api_key,
            delete_api_key,
            suggest_filename,
            test_connection,
            list_models,
            start_watching,
            stop_watching,
            watched_folders,
            set_tray_state,
            toast::notify_review_ready,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Screenshotify")
        .run(|_app, _event| {
            // Clicking the Dock icon of a running app with no open window is
            // how macOS users expect to get the window back.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main(_app);
                let _ = _app.emit("screenshotify://show-review", ());
            }
        });
}
