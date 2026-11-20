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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use url::Url;

use crate::sidecar::{
    resolve_runtime_paths, sidecar_startup_timeout, BootstrapInfo, SidecarHandle, SidecarManager,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateInfo {
    available: bool,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    pub_date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateProgress {
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
    percent: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInstallReceipt {
    status: &'static str,
    version: String,
}

fn progress_percent(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total_bytes = total.filter(|value| *value > 0)?;
    let clamped = downloaded.min(total_bytes);
    let pct = clamped.saturating_mul(100) / total_bytes;
    u8::try_from(pct.min(100)).ok()
}

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

#[tauri::command]
async fn desktop_check_update(app: AppHandle) -> Result<DesktopUpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    let updater = app
        .updater()
        .map_err(|err| format!("desktop updater unavailable: {err}"))?;
    let maybe_update = updater
        .check()
        .await
        .map_err(|err| format!("failed to check for desktop update: {err}"))?;
    match maybe_update {
        Some(update) => Ok(DesktopUpdateInfo {
            available: true,
            current_version,
            version: Some(update.version),
            notes: update.body,
            pub_date: update.date.map(|date| date.to_string()),
        }),
        None => Ok(DesktopUpdateInfo {
            available: false,
            current_version,
            version: None,
            notes: None,
            pub_date: None,
        }),
    }
}

static UPDATE_INSTALL_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

struct UpdateInstallGuard(&'static AtomicBool);

impl UpdateInstallGuard {
    fn try_acquire(flag: &'static AtomicBool) -> Result<Self, String> {
        flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self(flag))
            .map_err(|_| "desktop update installation is already in progress".to_string())
    }
}

impl Drop for UpdateInstallGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
async fn desktop_install_update(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<DesktopInstallReceipt, String> {
    let _install_guard = UpdateInstallGuard::try_acquire(&UPDATE_INSTALL_IN_PROGRESS)?;
    let current_version = app.package_info().version.to_string();
    let exit_app = app.clone();
    let updater = app
        .updater_builder()
        .on_before_exit(move || {
            shutdown_managed_sidecar(&exit_app);
        })
        .build()
        .map_err(|err| format!("desktop updater unavailable: {err}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|err| format!("failed to check for desktop update: {err}"))?
    else {
        return Ok(DesktopInstallReceipt {
            status: "up-to-date",
            version: current_version,
        });
    };

    let downloaded_bytes = Arc::new(AtomicU64::new(0));
    let progress_counter = Arc::clone(&downloaded_bytes);
    let progress_window = window.clone();
    let finish_window = window.clone();

    let _ = window.emit(
        "desktop-update-progress",
        DesktopUpdateProgress {
            phase: "downloading",
            downloaded: 0,
            total: None,
            percent: Some(0),
        },
    );

    let bytes = update
        .download(
            move |chunk_length, content_length| {
                let added = u64::try_from(chunk_length).unwrap_or(0);
                let total_so_far = progress_counter.fetch_add(added, Ordering::Relaxed) + added;
                let _ = progress_window.emit(
                    "desktop-update-progress",
                    DesktopUpdateProgress {
                        phase: "downloading",
                        downloaded: total_so_far,
                        total: content_length,
                        percent: progress_percent(total_so_far, content_length),
                    },
                );
            },
            move || {
                let final_bytes = downloaded_bytes.load(Ordering::Relaxed);
                let _ = finish_window.emit(
                    "desktop-update-progress",
                    DesktopUpdateProgress {
                        phase: "installing",
                        downloaded: final_bytes,
                        total: Some(final_bytes),
                        percent: Some(100),
                    },
                );
            },
        )
        .await
        .map_err(|err| format!("failed to download desktop update: {err}"))?;

    // On Windows, `install` invokes `on_before_exit` (stopping the sidecar), launches NSIS with `/P /UPDATE /R`, and exits.
    update
        .install(&bytes)
        .map_err(|err| format!("failed to install desktop update: {err}"))?;

    shutdown_managed_sidecar(&app);
    app.restart();
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
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            open_external,
            desktop_check_update,
            desktop_install_update
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
    fn progress_percent_clamps_and_handles_missing_total() {
        assert_eq!(progress_percent(0, None), None);
        assert_eq!(progress_percent(50, Some(0)), None);
        assert_eq!(progress_percent(25, Some(100)), Some(25));
        assert_eq!(progress_percent(150, Some(100)), Some(100));
    }

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

    #[test]
    fn update_install_guard_prevents_reentrancy_and_releases_on_drop() -> Result<(), String> {
        static TEST_FLAG: AtomicBool = AtomicBool::new(false);
        {
            let _first = UpdateInstallGuard::try_acquire(&TEST_FLAG)?;
            assert!(TEST_FLAG.load(Ordering::SeqCst));
            let second = UpdateInstallGuard::try_acquire(&TEST_FLAG);
            assert!(second.is_err());
        }
        assert!(!TEST_FLAG.load(Ordering::SeqCst));
        let _third = UpdateInstallGuard::try_acquire(&TEST_FLAG)?;
        Ok(())
    }
}
