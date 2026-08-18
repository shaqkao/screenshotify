//! API key storage.
//!
//! The key goes to the platform's own credential store through the `keyring`
//! crate — the Windows Credential Manager on Windows, the login Keychain on
//! macOS. It is never written to the settings file, and it is never handed back
//! to the frontend — requests that need it are made here in Rust.

const SERVICE: &str = "Screenshotify";
const ACCOUNT: &str = "api-key";

/// What to call the credential store in messages the user reads. The UI asks
/// for this too (see `platform_info` in lib.rs) so its copy matches.
#[cfg(windows)]
pub const STORE_NAME: &str = "Windows Credential Manager";
#[cfg(target_os = "macos")]
pub const STORE_NAME: &str = "macOS Keychain";
#[cfg(not(any(windows, target_os = "macos")))]
pub const STORE_NAME: &str = "system keyring";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| format!("Could not reach the {STORE_NAME}: {e}"))
}

pub fn set(key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return delete();
    }
    entry()?
        .set_password(key)
        .map_err(|e| format!("Could not save the API key: {e}"))
}

pub fn get() -> Option<String> {
    let entry = entry().ok()?;
    match entry.get_password() {
        Ok(v) if !v.trim().is_empty() => Some(v),
        _ => None,
    }
}

pub fn has() -> bool {
    get().is_some()
}

pub fn delete() -> Result<(), String> {
    let entry = entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Deleting a key that was never stored is a success from the user's
        // point of view.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not remove the API key: {e}")),
    }
}

