#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::todo,
    clippy::unimplemented,
    clippy::dbg_macro,
    unsafe_code
)]

fn main() {
    if let Err(err) = studyhub_desktop_lib::run() {
        eprintln!("StudyHub Desktop failed to start: {err}");
        std::process::exit(1);
    }
}
