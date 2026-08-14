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

#[tauri::command]
pub fn notify_review_ready(app: AppHandle, count: u32) -> Result<(), String> {
    let title = if count == 1 {
        "Screenshot ready to rename".to_string()
    } else {
        format!("{count} screenshots ready to rename")
    };

    let open_handle = app.clone();
    let accept_handle = app.clone();
    let ignore_handle = app.clone();

    Toast::new(&app_id(&app))
        .title(&title)
        .text1("Click to review the suggested names.")
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
