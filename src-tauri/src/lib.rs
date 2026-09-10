mod ai;
mod files;
mod github;
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

#[cfg(windows)]
const STARTUP_TASK_ID: &str = "ScreenshotifyStartup";

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

/// True when running with MSIX package identity (Microsoft Store or a
/// sideloaded MSIX install) — used to hide the self-updater UI, since Store
/// installs are serviced by Windows itself rather than `tauri-plugin-updater`.
#[cfg(windows)]
#[tauri::command]
fn is_packaged() -> bool {
    windows::ApplicationModel::Package::Current().is_ok()
}

#[cfg(not(windows))]
#[tauri::command]
fn is_packaged() -> bool {
    false
}

/// Packaged desktop apps are activated through the startup-task extension,
/// so Windows does not need (or pass) our `--minimized` registry argument.
/// Read the activation kind instead to preserve the tray-only login launch.
#[cfg(windows)]
fn is_startup_activation() -> bool {
    use windows::ApplicationModel::Activation::ActivationKind;
    use windows::ApplicationModel::AppInstance;

    is_packaged()
        && AppInstance::GetActivatedEventArgs()
            .and_then(|args| args.Kind())
            .map(|kind| kind == ActivationKind::StartupTask)
            .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_startup_activation() -> bool {
    false
}

#[cfg(windows)]
fn startup_task() -> Result<windows::ApplicationModel::StartupTask, String> {
    use windows::core::HSTRING;
    use windows::ApplicationModel::StartupTask;

    StartupTask::GetAsync(&HSTRING::from(STARTUP_TASK_ID))
        .and_then(|operation| operation.get())
        .map_err(|error| format!("Could not access the Windows startup task: {error}"))
}

#[cfg(windows)]
fn startup_task_is_enabled(state: windows::ApplicationModel::StartupTaskState) -> bool {
    use windows::ApplicationModel::StartupTaskState;

    state == StartupTaskState::Enabled || state == StartupTaskState::EnabledByPolicy
}

#[cfg(windows)]
fn packaged_autostart_enabled() -> Result<bool, String> {
    startup_task()?
        .State()
        .map(startup_task_is_enabled)
        .map_err(|error| format!("Could not read the Windows startup task: {error}"))
}

#[cfg(windows)]
fn set_packaged_autostart(enabled: bool) -> Result<bool, String> {
    use windows::ApplicationModel::StartupTaskState;

    let task = startup_task()?;
    if !enabled {
        task.Disable()
            .map_err(|error| format!("Could not disable the Windows startup task: {error}"))?;
        return Ok(false);
    }

    let state = task
        .RequestEnableAsync()
        .and_then(|operation| operation.get())
        .map_err(|error| format!("Could not enable the Windows startup task: {error}"))?;

    if startup_task_is_enabled(state) {
        Ok(true)
    } else if state == StartupTaskState::DisabledByUser {
        Err(
            "Windows disabled Screenshotify in Task Manager. Re-enable it under Startup apps, then try again."
                .into(),
        )
    } else if state == StartupTaskState::DisabledByPolicy {
        Err("A Windows policy prevents Screenshotify from starting at sign-in.".into())
    } else {
        Err("Windows did not enable Screenshotify as a startup app.".into())
    }
}

#[cfg(windows)]
fn windows_startup_command(executable: &Path) -> String {
    format!("\"{}\" {MINIMIZED_FLAG}", executable.display())
}

#[cfg(windows)]
fn unpackaged_autostart_enabled(app_name: &str) -> Result<bool, String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    const RUN_KEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
    const APPROVED_KEY: &str =
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

    let user = RegKey::predef(HKEY_CURRENT_USER);
    let run = user
        .open_subkey_with_flags(RUN_KEY, KEY_READ)
        .map_err(|error| format!("Could not open the Windows startup registry key: {error}"))?;
    if run.get_value::<String, _>(app_name).is_err() {
        return Ok(false);
    }

    let disabled_by_task_manager = user
        .open_subkey_with_flags(APPROVED_KEY, KEY_READ)
        .ok()
        .and_then(|key| key.get_raw_value(app_name).ok())
        .and_then(|value| {
            (value.bytes.len() >= 8)
                .then(|| !value.bytes.iter().rev().take(8).all(|byte| *byte == 0))
        })
        .unwrap_or(false);

    Ok(!disabled_by_task_manager)
}

#[cfg(windows)]
fn set_unpackaged_autostart(app_name: &str, enabled: bool) -> Result<bool, String> {
    use std::io::ErrorKind;
    use winreg::enums::RegType::REG_BINARY;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::{RegKey, RegValue};

    const RUN_KEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";
    const APPROVED_KEY: &str =
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
    const APPROVED: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    let user = RegKey::predef(HKEY_CURRENT_USER);
    let run = user
        .open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)
        .map_err(|error| format!("Could not open the Windows startup registry key: {error}"))?;

    if enabled {
        let executable = std::env::current_exe()
            .map_err(|error| format!("Could not find Screenshotify's executable: {error}"))?;
        run.set_value(app_name, &windows_startup_command(&executable))
            .map_err(|error| format!("Could not register Screenshotify for startup: {error}"))?;

        if let Ok(approved) = user.open_subkey_with_flags(APPROVED_KEY, KEY_SET_VALUE) {
            approved
                .set_raw_value(
                    app_name,
                    &RegValue {
                        vtype: REG_BINARY,
                        bytes: APPROVED.to_vec(),
                    },
                )
                .map_err(|error| {
                    format!("Could not enable Screenshotify in Startup apps: {error}")
                })?;
        }
        Ok(true)
    } else {
        if let Err(error) = run.delete_value(app_name) {
            if error.kind() != ErrorKind::NotFound {
                return Err(format!(
                    "Could not remove Screenshotify from startup: {error}"
                ));
            }
        }
        Ok(false)
    }
}

#[cfg(all(test, windows))]
mod autostart_tests {
    use super::*;
    use windows::ApplicationModel::StartupTaskState;

    #[test]
    fn windows_command_quotes_paths_with_spaces() {
        let executable = Path::new(r"C:\Program Files\Screenshotify\screenshotify.exe");
        assert_eq!(
            windows_startup_command(executable),
            r#""C:\Program Files\Screenshotify\screenshotify.exe" --minimized"#
        );
    }

    #[test]
    fn enabled_by_user_or_policy_counts_as_enabled() {
        assert!(startup_task_is_enabled(StartupTaskState::Enabled));
        assert!(startup_task_is_enabled(StartupTaskState::EnabledByPolicy));
        assert!(!startup_task_is_enabled(StartupTaskState::Disabled));
        assert!(!startup_task_is_enabled(StartupTaskState::DisabledByUser));
    }
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> Result<bool, String> {
    #[cfg(windows)]
    {
        if is_packaged() {
            packaged_autostart_enabled()
        } else {
            unpackaged_autostart_enabled(&app.package_info().name)
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch()
            .is_enabled()
            .map_err(|error| error.to_string())
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = app;
        Err("Autostart is not supported on this platform.".into())
    }
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        if is_packaged() {
            set_packaged_autostart(enabled)
        } else {
            set_unpackaged_autostart(&app.package_info().name, enabled)
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = app.autolaunch();
        if enabled {
            manager.enable().map_err(|error| error.to_string())?;
        } else {
            manager.disable().map_err(|error| error.to_string())?;
        }
        Ok(enabled)
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (app, enabled);
        Err("Autostart is not supported on this platform.".into())
    }
}

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

/// Copies the full-resolution image at `path` to the OS clipboard, so it can
/// be pasted elsewhere — the thumbnail shown in the list is a downscaled
/// preview and is never what gets copied.
#[tauri::command]
async fn copy_image_to_clipboard(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let (rgba, width, height) =
        tauri::async_runtime::spawn_blocking(move || imaging::decode_rgba(Path::new(&path)))
            .await
            .map_err(|e| format!("Copy failed: {e}"))??;

    let image = tauri::image::Image::new(&rgba, width, height);
    app.clipboard()
        .write_image(&image)
        .map_err(|e| format!("Could not copy to the clipboard: {e}"))
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

/* ══════════════════════════ GitHub ══════════════════════════ */

#[tauri::command]
async fn repo_stars(owner: String, repo: String) -> Result<u64, String> {
    github::repo_stars(&owner, &repo).await
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
    let minimized_launch =
        std::env::args().any(|a| a == MINIMIZED_FLAG) || is_startup_activation();

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
        .plugin(tauri_plugin_clipboard_manager::init())
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
            autostart_enabled,
            set_autostart,
            is_packaged,
            platform_info,
            set_dock_icon,
            default_screenshot_folders,
            scan_folder,
            scan_files,
            thumbnail,
            copy_image_to_clipboard,
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
            repo_stars,
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
