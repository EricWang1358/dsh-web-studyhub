use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const TOKEN_BYTES: usize = 32;
const DEFAULT_STARTUP_TIMEOUT_SECS: u64 = 20;
const GRACEFUL_EXIT_POLLS: usize = 5;
const GRACEFUL_EXIT_POLL_MS: u64 = 30;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapInfo {
    pub base_url: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarPaths {
    pub node_bin: PathBuf,
    pub entry_script: PathBuf,
    pub working_dir: PathBuf,
}

#[derive(Debug, Serialize)]
struct HandshakeRequest<'a> {
    token: &'a str,
}

#[derive(Debug, Deserialize)]
struct HandshakeResponse {
    port: u16,
}

pub fn generate_token() -> Result<String, String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::getrandom(&mut bytes)
        .map_err(|err| format!("failed to generate cryptographic token: {err}"))?;
    let mut hex = String::with_capacity(TOKEN_BYTES * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{byte:02x}");
    }
    Ok(hex)
}

pub fn format_handshake_request(token: &str) -> Result<String, String> {
    if token.len() != TOKEN_BYTES * 2
        || !token
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err("handshake token must be a 64-character lowercase hex string".to_string());
    }
    let json = serde_json::to_string(&HandshakeRequest { token })
        .map_err(|err| format!("failed to serialize handshake request: {err}"))?;
    Ok(format!("{json}\n"))
}

pub fn parse_handshake_response(line: &str) -> Result<u16, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err("sidecar handshake response was empty".to_string());
    }
    let parsed: HandshakeResponse = serde_json::from_str(trimmed)
        .map_err(|err| format!("invalid sidecar handshake JSON: {err}"))?;
    if parsed.port == 0 {
        return Err("sidecar reported invalid port 0".to_string());
    }
    Ok(parsed.port)
}

pub fn sidecar_startup_timeout() -> Duration {
    let secs = std::env::var("STUDYHUB_SIDECAR_TIMEOUT_SECS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|value| *value > 0 && *value <= 120)
        .unwrap_or(DEFAULT_STARTUP_TIMEOUT_SECS);
    Duration::from_secs(secs)
}

fn node_binary_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn find_entry_in_runtime(runtime_dir: &Path) -> Option<PathBuf> {
    let nested = runtime_dir
        .join("packages")
        .join("studyhub-desktop")
        .join("entry")
        .join("sidecar.mjs");
    if nested.is_file() {
        return Some(nested);
    }
    let flat = runtime_dir.join("entry").join("sidecar.mjs");
    if flat.is_file() {
        return Some(flat);
    }
    None
}

fn resolve_dev_entry(start_dirs: &[PathBuf]) -> Option<(PathBuf, PathBuf)> {
    if let Ok(explicit) = std::env::var("STUDYHUB_SIDECAR_ENTRY") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            let entry = PathBuf::from(trimmed);
            if entry.is_file() {
                let working_dir = entry
                    .parent()
                    .and_then(Path::parent)
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| PathBuf::from("."));
                return Some((entry, working_dir));
            }
        }
    }
    for dir in start_dirs {
        for ancestor in dir.ancestors() {
            let repo_entry = ancestor
                .join("packages")
                .join("studyhub-desktop")
                .join("entry")
                .join("sidecar.mjs");
            if repo_entry.is_file() {
                return Some((repo_entry, ancestor.to_path_buf()));
            }
            let local_entry = ancestor.join("entry").join("sidecar.mjs");
            if local_entry.is_file() {
                return Some((local_entry, ancestor.to_path_buf()));
            }
        }
    }
    None
}

pub fn resolve_runtime_paths(
    resource_dir: Option<&Path>,
    exe_dir: Option<&Path>,
    dev_mode: bool,
) -> Result<SidecarPaths, String> {
    if dev_mode {
        let node_bin = std::env::var("STUDYHUB_NODE_PATH")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(node_binary_name()));
        let mut search_roots = Vec::new();
        if let Ok(cwd) = std::env::current_dir() {
            search_roots.push(cwd);
        }
        if let Some(dir) = exe_dir {
            search_roots.push(dir.to_path_buf());
        }
        #[cfg(debug_assertions)]
        {
            search_roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
        }
        let (entry_script, working_dir) = resolve_dev_entry(&search_roots).ok_or_else(|| {
            "STUDYHUB_DESKTOP_DEV=1 is set, but entry/sidecar.mjs could not be found".to_string()
        })?;
        return Ok(SidecarPaths {
            node_bin,
            entry_script,
            working_dir,
        });
    }

    let mut candidate_roots = Vec::new();
    if let Some(dir) = resource_dir {
        candidate_roots.push(dir.join("resources").join("runtime"));
        candidate_roots.push(dir.join("runtime"));
    }
    if let Some(dir) = exe_dir {
        candidate_roots.push(dir.join("resources").join("runtime"));
        candidate_roots.push(dir.join("runtime"));
    }

    for root in candidate_roots {
        let node_bin = root.join(node_binary_name());
        if node_bin.is_file() {
            if let Some(entry_script) = find_entry_in_runtime(&root) {
                return Ok(SidecarPaths {
                    node_bin,
                    entry_script,
                    working_dir: root,
                });
            }
        }
    }

    Err(
        "bundled StudyHub runtime was not found (expected resources/runtime/node and entry/sidecar.mjs)"
            .to_string(),
    )
}

fn configure_hidden_command(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_hidden_command(&mut cmd);
        let _ = cmd.status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("pkill")
            .args(["-TERM", "-P", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn terminate_child(child: &mut Child, stdin: &mut Option<ChildStdin>) {
    drop(stdin.take());
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    for _ in 0..GRACEFUL_EXIT_POLLS {
        thread::sleep(Duration::from_millis(GRACEFUL_EXIT_POLL_MS));
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
    }
    kill_process_tree(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

pub struct SidecarHandle {
    child: Child,
    stdin: Option<ChildStdin>,
    bootstrap: BootstrapInfo,
    stopped: bool,
}

impl SidecarHandle {
    pub fn spawn(paths: &SidecarPaths, timeout: Duration) -> Result<Self, String> {
        let token = generate_token()?;
        let handshake_line = format_handshake_request(&token)?;

        let mut command = Command::new(&paths.node_bin);
        command
            .arg(&paths.entry_script)
            .current_dir(&paths.working_dir)
            .env("STUDYHUB_DESKTOP_RUNTIME_ROOT", &paths.working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_hidden_command(&mut command);

        let mut child = command.spawn().map_err(|err| {
            format!(
                "failed to launch StudyHub sidecar ({}): {err}",
                paths.node_bin.display()
            )
        })?;

        let mut stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        if let Some(stderr_pipe) = stderr {
            let _ = thread::Builder::new()
                .name("studyhub-sidecar-stderr".to_string())
                .spawn(move || {
                    let reader = BufReader::new(stderr_pipe);
                    for line in reader.lines().map_while(Result::ok) {
                        eprintln!("[studyhub-sidecar] {line}");
                    }
                });
        }

        let Some(stdout_pipe) = stdout else {
            terminate_child(&mut child, &mut stdin);
            return Err("sidecar stdout pipe was unavailable".to_string());
        };

        let Some(ref mut stdin_pipe) = stdin else {
            terminate_child(&mut child, &mut stdin);
            return Err("sidecar stdin pipe was unavailable".to_string());
        };

        if let Err(err) = stdin_pipe
            .write_all(handshake_line.as_bytes())
            .and_then(|()| stdin_pipe.flush())
        {
            terminate_child(&mut child, &mut stdin);
            return Err(format!("failed to write handshake to sidecar stdin: {err}"));
        }

        let (tx, rx) = mpsc::channel::<Result<String, String>>();
        let spawn_reader = thread::Builder::new()
            .name("studyhub-sidecar-stdout".to_string())
            .spawn(move || {
                let mut reader = BufReader::new(stdout_pipe);
                let mut sent = false;
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => {
                            if !sent {
                                let _ = tx
                                    .send(Err("sidecar closed stdout before completing handshake"
                                        .to_string()));
                            }
                            break;
                        }
                        Ok(_) => {
                            if !sent {
                                let trimmed = line.trim();
                                if !trimmed.is_empty() {
                                    let _ = tx.send(Ok(trimmed.to_string()));
                                    sent = true;
                                }
                            }
                        }
                        Err(err) => {
                            if !sent {
                                let _ =
                                    tx.send(Err(format!("failed reading sidecar stdout: {err}")));
                            }
                            break;
                        }
                    }
                }
            });

        if let Err(err) = spawn_reader {
            terminate_child(&mut child, &mut stdin);
            return Err(format!("failed to start sidecar stdout reader: {err}"));
        }

        let response_line = match rx.recv_timeout(timeout) {
            Ok(Ok(line)) => line,
            Ok(Err(err)) => {
                terminate_child(&mut child, &mut stdin);
                return Err(err);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                terminate_child(&mut child, &mut stdin);
                return Err(format!(
                    "sidecar handshake timed out after {}s",
                    timeout.as_secs()
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                terminate_child(&mut child, &mut stdin);
                return Err("sidecar stdout reader disconnected before handshake".to_string());
            }
        };

        let port = match parse_handshake_response(&response_line) {
            Ok(port) => port,
            Err(err) => {
                terminate_child(&mut child, &mut stdin);
                return Err(err);
            }
        };

        Ok(Self {
            child,
            stdin,
            bootstrap: BootstrapInfo {
                base_url: format!("http://127.0.0.1:{port}"),
                token,
            },
            stopped: false,
        })
    }

    pub fn bootstrap_info(&self) -> BootstrapInfo {
        self.bootstrap.clone()
    }

    pub fn shutdown(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        terminate_child(&mut self.child, &mut self.stdin);
    }
}

impl Drop for SidecarHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub struct SidecarManager {
    inner: Mutex<Option<SidecarHandle>>,
}

impl SidecarManager {
    pub fn new(handle: SidecarHandle) -> Self {
        Self {
            inner: Mutex::new(Some(handle)),
        }
    }

    pub fn bootstrap_info(&self) -> Result<BootstrapInfo, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "sidecar state lock was poisoned".to_string())?;
        let handle = guard
            .as_ref()
            .ok_or_else(|| "StudyHub sidecar is not running".to_string())?;
        Ok(handle.bootstrap_info())
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(mut handle) = guard.take() {
                handle.shutdown();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_has_256_bit_hex_format_and_entropy() -> Result<(), String> {
        let first = generate_token()?;
        let second = generate_token()?;
        assert_eq!(first.len(), 64);
        assert_eq!(second.len(), 64);
        assert!(first
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')));
        assert!(second
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')));
        assert_ne!(first, second);
        Ok(())
    }

    #[test]
    fn handshake_request_serializes_single_json_line() -> Result<(), String> {
        let token = generate_token()?;
        let line = format_handshake_request(&token)?;
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        let decoded: serde_json::Value =
            serde_json::from_str(line.trim()).map_err(|err| err.to_string())?;
        assert_eq!(decoded["token"], serde_json::Value::String(token));
        Ok(())
    }

    #[test]
    fn handshake_request_rejects_malformed_token() {
        assert!(format_handshake_request("too-short").is_err());
        assert!(format_handshake_request(&"G".repeat(64)).is_err());
    }

    #[test]
    fn handshake_response_parses_valid_port() -> Result<(), String> {
        assert_eq!(parse_handshake_response("{\"port\":4178}\n")?, 4178);
        assert_eq!(parse_handshake_response("  {\"port\": 54321}  ")?, 54321);
        Ok(())
    }

    #[test]
    fn handshake_response_rejects_zero_port_and_malformed_json() {
        assert!(parse_handshake_response("").is_err());
        assert!(parse_handshake_response("{\"port\":0}").is_err());
        assert!(parse_handshake_response("{\"port\":-1}").is_err());
        assert!(parse_handshake_response("{\"port\":70000}").is_err());
        assert!(parse_handshake_response("{\"port\":\"4178\"}").is_err());
        assert!(parse_handshake_response("not-json").is_err());
    }

    #[test]
    fn resolve_runtime_paths_finds_packaged_layout() -> Result<(), String> {
        let unique = generate_token()?;
        let temp_root = std::env::temp_dir().join(format!("studyhub-sidecar-test-{unique}"));
        let runtime_dir = temp_root.join("resources").join("runtime");
        let entry_dir = runtime_dir
            .join("packages")
            .join("studyhub-desktop")
            .join("entry");
        std::fs::create_dir_all(&entry_dir).map_err(|err| err.to_string())?;
        let node_file = runtime_dir.join(node_binary_name());
        let entry_file = entry_dir.join("sidecar.mjs");
        std::fs::write(&node_file, b"").map_err(|err| err.to_string())?;
        std::fs::write(&entry_file, b"").map_err(|err| err.to_string())?;

        let resolved = resolve_runtime_paths(Some(&temp_root), None, false);
        let _ = std::fs::remove_dir_all(&temp_root);

        let paths = resolved?;
        assert_eq!(paths.node_bin, node_file);
        assert_eq!(paths.entry_script, entry_file);
        assert_eq!(paths.working_dir, runtime_dir);
        Ok(())
    }
}
