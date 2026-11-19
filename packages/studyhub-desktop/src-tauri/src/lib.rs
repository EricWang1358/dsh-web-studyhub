#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::todo,
    clippy::unimplemented,
    clippy::dbg_macro,
    unsafe_code
)]

mod sidecar;

use std::path::Path;

use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::sidecar::{
    resolve_runtime_paths, sidecar_startup_timeout, BootstrapInfo, SidecarHandle, SidecarManager,
};

pub fn validate_external_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("external URL must not be empty".to_string());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("external URL must not contain control characters".to_string());
    }
    let parsed = Url::parse(trimmed).map_err(|err| format!("invalid external URL: {err}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "unsupported external URL scheme: {}",
            parsed.scheme()
        ));
    }
    if parsed.host_str().is_none() {
        return Err("external URL must include a host".to_string());
    }
    Ok(parsed)
}

fn file_path_to_string(path: FilePath) -> Result<String, String> {
    path.into_path()
        .map(|buf| buf.to_string_lossy().into_owned())
        .map_err(|err| format!("selected directory could not be converted to a path: {err}"))
}

#[tauri::command]
fn get_bootstrap_info(state: State<'_, SidecarManager>) -> Result<BootstrapInfo, String> {
    state.bootstrap_info()
}

#[tauri::command]
async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    let picked =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|err| format!("folder picker task failed: {err}"))?;

    picked.map(file_path_to_string).transpose()
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = validate_external_url(&url)?;
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|err| format!("failed to open external URL: {err}"))
}

fn shutdown_managed_sidecar(app_handle: &AppHandle) {
    if let Some(manager) = app_handle.try_state::<SidecarManager>() {
        manager.shutdown();
    }
}

pub fn run() -> Result<(), String> {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let resource_dir = app.path().resource_dir().ok();
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf));
            let dev_mode = std::env::var("STUDYHUB_DESKTOP_DEV").ok().as_deref() == Some("1");
            let paths =
                resolve_runtime_paths(resource_dir.as_deref(), exe_dir.as_deref(), dev_mode)
                    .map_err(std::io::Error::other)?;
            let handle = SidecarHandle::spawn(&paths, sidecar_startup_timeout())
                .map_err(std::io::Error::other)?;
            app.manage(SidecarManager::new(handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(
                    event,
                    WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                )
            {
                shutdown_managed_sidecar(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_bootstrap_info,
            pick_directory,
            open_external
        ])
        .build(tauri::generate_context!())
        .map_err(|err| format!("failed to build Tauri application: {err}"))?;

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            shutdown_managed_sidecar(app_handle);
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_external_url_allows_http_and_https() -> Result<(), String> {
        let https = validate_external_url("https://github.com/EricWang1358/dsh-web-studyhub")?;
        assert_eq!(https.scheme(), "https");
        assert_eq!(https.host_str(), Some("github.com"));

        let http = validate_external_url("  http://localhost:8080/docs?page=1#top  ")?;
        assert_eq!(http.scheme(), "http");
        assert_eq!(http.host_str(), Some("localhost"));
        Ok(())
    }

    #[test]
    fn validate_external_url_rejects_dangerous_schemes_and_malformed_urls() {
        let rejected = [
            "",
            "   ",
            "javascript:alert(1)",
            "file:///C:/Windows/System32/cmd.exe",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox(1)",
            "mailto:user@example.com",
            "tauri://localhost/index.html",
            "ftp://example.com/file.zip",
            "https://example.com/\nnewline",
            "https://",
            "not a url",
        ];
        for candidate in rejected {
            assert!(
                validate_external_url(candidate).is_err(),
                "expected URL to be rejected: {candidate}"
            );
        }
    }
}
