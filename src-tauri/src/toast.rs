//! "Screenshots ready to rename" notifications.
//!
//! Windows gets a real WinRT toast with Accept / Ignore buttons and a clickable
//! body, through the vendored `tauri-winrt-notification` crate. macOS has no
//! equivalent that works from an unsigned, un-notarised bundle — the User
//! Notifications framework only delivers actions to an app whose bundle
//! identifier it already trusts — so it gets a plain notification through
//! `tauri-plugin-notification` instead. Both paths take the same input, so the
//! frontend does not need to know which one it is talking to.

use tauri::AppHandle;

/// Title and body shared by both backends, so the two platforms word the same
/// notification identically.
fn compose(names: &[String]) -> (String, String) {
    if names.len() == 1 {
        return ("Screenshot ready to rename".to_string(), names[0].clone());
    }
    let title = format!("{} screenshots ready to rename", names.len());
    let preview: Vec<&str> = names.iter().take(3).map(String::as_str).collect();
    let mut body = preview.join(", ");
    if names.len() > preview.len() {
        body.push_str(&format!(", +{} more", names.len() - preview.len()));
    }
    (title, body)
}

#[tauri::command]
pub fn notify_review_ready(app: AppHandle, names: Vec<String>) -> Result<(), String> {
    if names.is_empty() {
        return Ok(());
    }
    let (title, body) = compose(&names);
    show(&app, &title, &body)
}

/* ══════════════════════════ Windows ══════════════════════════ */

#[cfg(windows)]
mod imp {
    use tauri::{AppHandle, Emitter};
    use tauri_winrt_notification::Toast;

    fn app_id(app: &AppHandle) -> String {
        // Same dev/release split tauri-plugin-notification's desktop backend uses:
        // an unpackaged dev build has no Start Menu shortcut to register a custom
        // AUMID against, so a real identifier here would make the toast silently
        // fail to show. Borrow the pre-registered PowerShell id in dev; use our
        // own identifier once installed, where the NSIS shortcut registers it.
        if let Ok(exe) = tauri::utils::platform::current_exe() {
            if let Some(dir) = exe.parent() {
                let dir = dir.display().to_string();
                if dir.ends_with(r"\target\debug") || dir.ends_with(r"\target\release") {
                    return Toast::POWERSHELL_APP_ID.to_string();
                }
            }
        }
        app.config().identifier.clone()
    }

    pub fn show(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
        let open_handle = app.clone();
        let accept_handle = app.clone();
        let ignore_handle = app.clone();

        Toast::new(&app_id(app))
            .title(title)
            .text1(body)
            .launch("open")
            .add_button("Accept", "accept")
            .add_button("Ignore", "ignore")
            .on_activated(move |action| {
                let (handle, payload) = match action.as_deref() {
                    Some("accept") => (&accept_handle, "accept"),
                    Some("ignore") => (&ignore_handle, "ignore"),
                    _ => (&open_handle, "open"),
                };
                let _ = handle.emit("screenshotify://toast-action", payload);
                Ok(())
            })
            .show()
            .map_err(|e| format!("{e:?}"))
    }
}

/* ══════════════════════ macOS and everywhere else ══════════════════════ */

#[cfg(not(windows))]
mod imp {
    use tauri::AppHandle;
    use tauri_plugin_notification::NotificationExt;

    pub fn show(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| format!("Could not show the notification: {e}"))
    }
}

use imp::show;
