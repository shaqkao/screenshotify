// Release builds are a tray app: no console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    screenshotify_lib::run()
}
