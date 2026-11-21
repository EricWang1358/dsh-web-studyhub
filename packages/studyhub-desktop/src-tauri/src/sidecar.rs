use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const TOKEN_BYTES: usize = 32;
const DEFAULT_STARTUP_TIMEOUT_SECS: u64 = 20;
const GRACEFUL_EXIT_TIMEOUT: Duration = Duration::from_millis(3_000);
const GRACEFUL_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_STRAY_HANDSHAKE_LINES: usize = 64;
const DEFAULT_MAX_RESTARTS_IN_WINDOW: usize = 3;
const DEFAULT_RESTART_WINDOW_SECS: u64 = 60;
const DEFAULT_BASE_BACKOFF_MS: u64 = 250;
const DEFAULT_MAX_BACKOFF_MS: u64 = 4_000;
const DEFAULT_WATCHDOG_POLL_MS: u64 = 250;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapInfo {
    pub base_url: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarHealth {
    pub running: bool,
    pub shutting_down: bool,
    pub updating: bool,
    pub restarting: bool,
    pub restart_count: usize,
    pub max_restarts: usize,
    pub crash_loop_exhausted: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarEvent {
    Restarted {
        bootstrap: BootstrapInfo,
        restart_count: usize,
    },
    RestartExhausted {
        restart_count: usize,
        last_error: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestartPolicy {
    pub max_restarts: usize,
    pub window: Duration,
    pub base_backoff: Duration,
    pub max_backoff: Duration,
    pub poll_interval: Duration,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            max_restarts: DEFAULT_MAX_RESTARTS_IN_WINDOW,
            window: Duration::from_secs(DEFAULT_RESTART_WINDOW_SECS),
            base_backoff: Duration::from_millis(DEFAULT_BASE_BACKOFF_MS),
            max_backoff: Duration::from_millis(DEFAULT_MAX_BACKOFF_MS),
            poll_interval: Duration::from_millis(DEFAULT_WATCHDOG_POLL_MS),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RestartTracker {
    policy: RestartPolicy,
    recent: VecDeque<Instant>,
    total_restarts: usize,
}

impl RestartTracker {
    pub fn new(policy: RestartPolicy) -> Self {
        Self {
            policy,
            recent: VecDeque::new(),
            total_restarts: 0,
        }
    }

    pub fn prune(&mut self, now: Instant) {
        while let Some(&oldest) = self.recent.front() {
            if now.saturating_duration_since(oldest) > self.policy.window {
                let _ = self.recent.pop_front();
            } else {
                break;
            }
        }
    }

    pub fn record_and_next_backoff(&mut self, now: Instant) -> Option<Duration> {
        self.prune(now);
        if self.recent.len() >= self.policy.max_restarts {
            return None;
        }
        let attempt = u32::try_from(self.recent.len()).unwrap_or(u32::MAX);
        let shift = attempt.min(20);
        let factor = 1u32.checked_shl(shift).unwrap_or(u32::MAX);
        let scaled = self
            .policy
            .base_backoff
            .saturating_mul(factor)
            .min(self.policy.max_backoff);
        self.recent.push_back(now);
        self.total_restarts = self.total_restarts.saturating_add(1);
        Some(scaled)
    }

    pub fn max_restarts(&self) -> usize {
        self.policy.max_restarts
    }

    pub fn total_restarts(&self) -> usize {
        self.total_restarts
    }
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

pub fn read_handshake_port<R: BufRead>(reader: &mut R) -> Result<u16, String> {
    let mut line = String::new();
    let mut stray_lines = 0usize;
    let mut last_error: Option<String> = None;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => {
                return Err(last_error.unwrap_or_else(|| {
                    "sidecar closed stdout before completing handshake".to_string()
                }));
            }
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match parse_handshake_response(trimmed) {
                    Ok(port) => return Ok(port),
                    Err(err) => {
                        eprintln!("[studyhub-sidecar] ignoring pre-handshake stdout line: {trimmed}");
                        last_error = Some(err);
                        stray_lines = stray_lines.saturating_add(1);
                        if stray_lines >= MAX_STRAY_HANDSHAKE_LINES {
                            return Err(last_error.unwrap_or_else(|| {
                                "sidecar emitted too many non-handshake stdout lines".to_string()
                            }));
                        }
                    }
                }
            }
            Err(err) => return Err(format!("failed reading sidecar stdout: {err}")),
        }
    }
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

#[cfg(any(windows, test))]
fn strip_windows_verbatim_prefix_str(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return rest.to_string();
        }
    }
    raw.to_string()
}

pub fn normalize_runtime_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(raw) = path.to_str() {
            return PathBuf::from(strip_windows_verbatim_prefix_str(raw));
        }
    }
    path.to_path_buf()
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
            node_bin: normalize_runtime_path(&node_bin),
            entry_script: normalize_runtime_path(&entry_script),
            working_dir: normalize_runtime_path(&working_dir),
        });
    }

    let mut candidate_roots = Vec::new();
    if let Some(dir) = resource_dir {
        let dir = normalize_runtime_path(dir);
        candidate_roots.push(dir.join("resources").join("runtime"));
        candidate_roots.push(dir.join("runtime"));
    }
    if let Some(dir) = exe_dir {
        let dir = normalize_runtime_path(dir);
        candidate_roots.push(dir.join("resources").join("runtime"));
        candidate_roots.push(dir.join("runtime"));
    }

    for root in candidate_roots {
        let root = normalize_runtime_path(&root);
        let node_bin = root.join(node_binary_name());
        if node_bin.is_file() {
            if let Some(entry_script) = find_entry_in_runtime(&root) {
                return Ok(SidecarPaths {
                    node_bin: normalize_runtime_path(&node_bin),
                    entry_script: normalize_runtime_path(&entry_script),
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

#[cfg(windows)]
fn resolve_taskkill_path() -> PathBuf {
    if let Some(sys_root) = std::env::var_os("SystemRoot") {
        let candidate = PathBuf::from(sys_root)
            .join("System32")
            .join("taskkill.exe");
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("taskkill")
}

fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new(resolve_taskkill_path());
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminationOutcome {
    AlreadyExited,
    GracefulExit,
    ForcedKill,
}

fn terminate_child_with_timeout(
    child: &mut Child,
    stdin: &mut Option<ChildStdin>,
    grace_timeout: Duration,
    poll_interval: Duration,
) -> TerminationOutcome {
    if matches!(child.try_wait(), Ok(Some(_))) {
        drop(stdin.take());
        return TerminationOutcome::AlreadyExited;
    }
    drop(stdin.take());
    if matches!(child.try_wait(), Ok(Some(_))) {
        return TerminationOutcome::GracefulExit;
    }
    let deadline = Instant::now() + grace_timeout;
    let step = poll_interval.max(Duration::from_millis(1));
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        if remaining.is_zero() {
            break;
        }
        thread::sleep(step.min(remaining));
        if matches!(child.try_wait(), Ok(Some(_))) {
            return TerminationOutcome::GracefulExit;
        }
    }
    kill_process_tree(child.id());
    if !matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.kill();
    }
    let _ = child.wait();
    TerminationOutcome::ForcedKill
}

fn terminate_child(child: &mut Child, stdin: &mut Option<ChildStdin>) {
    let _ = terminate_child_with_timeout(
        child,
        stdin,
        GRACEFUL_EXIT_TIMEOUT,
        GRACEFUL_EXIT_POLL_INTERVAL,
    );
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

        let (tx, rx) = mpsc::channel::<Result<u16, String>>();
        let spawn_reader = thread::Builder::new()
            .name("studyhub-sidecar-stdout".to_string())
            .spawn(move || {
                let mut reader = BufReader::new(stdout_pipe);
                let handshake = read_handshake_port(&mut reader);
                let _ = tx.send(handshake);
                let mut drain = String::new();
                while matches!(reader.read_line(&mut drain), Ok(n) if n > 0) {
                    drain.clear();
                }
            });

        if let Err(err) = spawn_reader {
            terminate_child(&mut child, &mut stdin);
            return Err(format!("failed to start sidecar stdout reader: {err}"));
        }

        let port = match rx.recv_timeout(timeout) {
            Ok(Ok(port)) => port,
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

    pub fn poll_exit(&mut self) -> Option<String> {
        if self.stopped {
            return None;
        }
        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.stopped = true;
                drop(self.stdin.take());
                Some(format!("sidecar exited unexpectedly ({status})"))
            }
            Ok(None) => None,
            Err(err) => {
                self.stopped = true;
                drop(self.stdin.take());
                Some(format!("failed checking sidecar process status: {err}"))
            }
        }
    }

    pub fn is_alive(&mut self) -> bool {
        if self.stopped {
            return false;
        }
        self.poll_exit().is_none()
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

trait ManagedSidecar: Send {
    fn bootstrap_info(&self) -> BootstrapInfo;
    fn poll_exit(&mut self) -> Option<String>;
    fn is_alive(&mut self) -> bool;
    fn shutdown(&mut self);
}

impl ManagedSidecar for SidecarHandle {
    fn bootstrap_info(&self) -> BootstrapInfo {
        SidecarHandle::bootstrap_info(self)
    }

    fn poll_exit(&mut self) -> Option<String> {
        SidecarHandle::poll_exit(self)
    }

    fn is_alive(&mut self) -> bool {
        SidecarHandle::is_alive(self)
    }

    fn shutdown(&mut self) {
        SidecarHandle::shutdown(self);
    }
}

type SidecarSpawner = Arc<dyn Fn() -> Result<Box<dyn ManagedSidecar>, String> + Send + Sync>;
type SidecarEventCallback = Arc<dyn Fn(SidecarEvent) + Send + Sync>;

struct SupervisorState {
    process: Option<Box<dyn ManagedSidecar>>,
    shutting_down: bool,
    updating: bool,
    restarting: bool,
    restart_tracker: RestartTracker,
    crash_loop_exhausted: bool,
    last_error: Option<String>,
}

struct SupervisorShared {
    state: Mutex<SupervisorState>,
    wake: Condvar,
}

fn wait_backoff_interruptible(shared: &SupervisorShared, backoff: Duration) -> bool {
    if backoff.is_zero() {
        let Ok(state) = shared.state.lock() else {
            return false;
        };
        return !state.shutting_down && !state.updating;
    }
    let deadline = Instant::now() + backoff;
    let Ok(mut state) = shared.state.lock() else {
        return false;
    };
    loop {
        if state.shutting_down || state.updating {
            return false;
        }
        let now = Instant::now();
        if now >= deadline {
            return true;
        }
        let remaining = deadline.saturating_duration_since(now);
        match shared.wake.wait_timeout(state, remaining) {
            Ok((guard, _)) => state = guard,
            Err(_) => return false,
        }
    }
}

fn park_until_shutdown(shared: &SupervisorShared) {
    let Ok(mut state) = shared.state.lock() else {
        return;
    };
    while !state.shutting_down && !state.updating {
        match shared.wake.wait(state) {
            Ok(guard) => state = guard,
            Err(_) => return,
        }
    }
}

fn run_watchdog(
    shared: Arc<SupervisorShared>,
    spawner: SidecarSpawner,
    on_event: Option<SidecarEventCallback>,
    poll_interval: Duration,
) {
    loop {
        let backoff = {
            let Ok(mut state) = shared.state.lock() else {
                return;
            };
            if state.shutting_down || state.updating {
                return;
            }
            let exit_reason = if let Some(proc) = state.process.as_mut() {
                proc.poll_exit()
            } else if !state.crash_loop_exhausted && !state.restarting {
                Some(
                    state
                        .last_error
                        .clone()
                        .unwrap_or_else(|| "sidecar process is not running".to_string()),
                )
            } else {
                None
            };
            let Some(reason) = exit_reason else {
                if shared.wake.wait_timeout(state, poll_interval).is_err() {
                    return;
                }
                continue;
            };

            state.process = None;
            state.last_error = Some(reason.clone());
            match state
                .restart_tracker
                .record_and_next_backoff(Instant::now())
            {
                Some(delay) => {
                    state.restarting = true;
                    delay
                }
                None => {
                    state.crash_loop_exhausted = true;
                    state.restarting = false;
                    let restart_count = state.restart_tracker.total_restarts();
                    drop(state);
                    if let Some(ref cb) = on_event {
                        cb(SidecarEvent::RestartExhausted {
                            restart_count,
                            last_error: reason,
                        });
                    }
                    park_until_shutdown(&shared);
                    return;
                }
            }
        };

        if !wait_backoff_interruptible(&shared, backoff) {
            return;
        }

        match spawner() {
            Ok(mut new_proc) => {
                let event = {
                    let Ok(mut state) = shared.state.lock() else {
                        new_proc.shutdown();
                        return;
                    };
                    if state.shutting_down || state.updating {
                        drop(state);
                        new_proc.shutdown();
                        return;
                    }
                    let bootstrap = new_proc.bootstrap_info();
                    let restart_count = state.restart_tracker.total_restarts();
                    state.process = Some(new_proc);
                    state.restarting = false;
                    state.last_error = None;
                    SidecarEvent::Restarted {
                        bootstrap,
                        restart_count,
                    }
                };
                if let Some(ref cb) = on_event {
                    cb(event);
                }
            }
            Err(err) => {
                let Ok(mut state) = shared.state.lock() else {
                    return;
                };
                state.restarting = false;
                state.last_error = Some(err);
                if state.shutting_down || state.updating {
                    return;
                }
            }
        }
    }
}

pub struct SidecarManager {
    shared: Arc<SupervisorShared>,
    watchdog: Mutex<Option<JoinHandle<()>>>,
}

impl SidecarManager {
    pub fn spawn_supervised<F>(
        paths: SidecarPaths,
        timeout: Duration,
        policy: RestartPolicy,
        on_event: F,
    ) -> Result<Self, String>
    where
        F: Fn(SidecarEvent) + Send + Sync + 'static,
    {
        let initial = SidecarHandle::spawn(&paths, timeout)?;
        let spawner: SidecarSpawner = Arc::new(move || {
            SidecarHandle::spawn(&paths, timeout)
                .map(|handle| Box::new(handle) as Box<dyn ManagedSidecar>)
        });
        Ok(Self::from_managed(
            Box::new(initial),
            policy,
            Some(spawner),
            Some(Arc::new(on_event)),
        ))
    }

    fn from_managed(
        initial: Box<dyn ManagedSidecar>,
        policy: RestartPolicy,
        spawner: Option<SidecarSpawner>,
        on_event: Option<SidecarEventCallback>,
    ) -> Self {
        let shared = Arc::new(SupervisorShared {
            state: Mutex::new(SupervisorState {
                process: Some(initial),
                shutting_down: false,
                updating: false,
                restarting: false,
                restart_tracker: RestartTracker::new(policy),
                crash_loop_exhausted: false,
                last_error: None,
            }),
            wake: Condvar::new(),
        });

        let watchdog_handle = spawner.and_then(|spawn_fn| {
            let shared_clone = Arc::clone(&shared);
            thread::Builder::new()
                .name("studyhub-sidecar-watchdog".to_string())
                .spawn(move || {
                    run_watchdog(shared_clone, spawn_fn, on_event, policy.poll_interval);
                })
                .ok()
        });

        Self {
            shared,
            watchdog: Mutex::new(watchdog_handle),
        }
    }

    pub fn bootstrap_info(&self) -> Result<BootstrapInfo, String> {
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| "sidecar state lock was poisoned".to_string())?;
        if state.shutting_down {
            return Err("StudyHub sidecar is shutting down".to_string());
        }
        if let Some(proc) = state.process.as_mut() {
            if let Some(reason) = proc.poll_exit() {
                state.process = None;
                state.last_error = Some(reason);
                self.shared.wake.notify_all();
                return Err(
                    "StudyHub sidecar exited unexpectedly; recovery in progress".to_string()
                );
            }
            if proc.is_alive() {
                return Ok(proc.bootstrap_info());
            }
            state.process = None;
            state.last_error = Some("StudyHub sidecar exited unexpectedly".to_string());
            self.shared.wake.notify_all();
            return Err("StudyHub sidecar exited unexpectedly; recovery in progress".to_string());
        }
        if state.restarting {
            return Err("StudyHub sidecar is restarting".to_string());
        }
        if state.crash_loop_exhausted {
            let detail = state
                .last_error
                .as_deref()
                .unwrap_or("restart limit reached");
            return Err(format!(
                "StudyHub sidecar stopped after repeated crashes ({detail})"
            ));
        }
        Err("StudyHub sidecar is not running".to_string())
    }

    pub fn health(&self) -> Result<SidecarHealth, String> {
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| "sidecar state lock was poisoned".to_string())?;
        let running = if let Some(proc) = state.process.as_mut() {
            if let Some(reason) = proc.poll_exit() {
                state.process = None;
                if !state.shutting_down && !state.updating {
                    state.last_error = Some(reason);
                    self.shared.wake.notify_all();
                }
                false
            } else {
                proc.is_alive()
            }
        } else {
            false
        };
        Ok(SidecarHealth {
            running,
            shutting_down: state.shutting_down,
            updating: state.updating,
            restarting: state.restarting,
            restart_count: state.restart_tracker.total_restarts(),
            max_restarts: state.restart_tracker.max_restarts(),
            crash_loop_exhausted: state.crash_loop_exhausted,
            last_error: state.last_error.clone(),
        })
    }

    pub fn ensure_ready_for_update(&self) -> Result<(), String> {
        let state = self
            .shared
            .state
            .lock()
            .map_err(|_| "sidecar state lock was poisoned".to_string())?;
        if state.shutting_down {
            return Err(
                "cannot install desktop update while application is shutting down".to_string(),
            );
        }
        if state.updating {
            return Err("desktop update exit is already in progress".to_string());
        }
        Ok(())
    }

    pub fn prepare_for_update_exit(&self) {
        self.stop_internal(true);
    }

    pub fn shutdown(&self) {
        self.stop_internal(false);
    }

    fn stop_internal(&self, mark_updating: bool) {
        let taken_process = if let Ok(mut state) = self.shared.state.lock() {
            state.shutting_down = true;
            if mark_updating {
                state.updating = true;
            }
            state.restarting = false;
            self.shared.wake.notify_all();
            state.process.take()
        } else {
            None
        };

        if let Some(mut proc) = taken_process {
            proc.shutdown();
        }

        let watchdog_handle = if let Ok(mut guard) = self.watchdog.lock() {
            guard.take()
        } else {
            None
        };
        if let Some(handle) = watchdog_handle {
            if handle.thread().id() != thread::current().id() {
                let _ = handle.join();
            }
        }

        let leftover = if let Ok(mut state) = self.shared.state.lock() {
            state.process.take()
        } else {
            None
        };
        if let Some(mut proc) = leftover {
            proc.shutdown();
        }
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct FakeSidecar {
        bootstrap: BootstrapInfo,
        crashed: Arc<AtomicBool>,
        shutdown_called: Arc<AtomicBool>,
        stopped: bool,
    }

    impl ManagedSidecar for FakeSidecar {
        fn bootstrap_info(&self) -> BootstrapInfo {
            self.bootstrap.clone()
        }

        fn poll_exit(&mut self) -> Option<String> {
            if self.stopped {
                return None;
            }
            if self.crashed.load(Ordering::SeqCst) {
                self.stopped = true;
                return Some("simulated crash (exit code 1)".to_string());
            }
            None
        }

        fn is_alive(&mut self) -> bool {
            !self.stopped && !self.crashed.load(Ordering::SeqCst)
        }

        fn shutdown(&mut self) {
            self.stopped = true;
            self.shutdown_called.store(true, Ordering::SeqCst);
        }
    }

    fn test_policy(max_restarts: usize) -> RestartPolicy {
        RestartPolicy {
            max_restarts,
            window: Duration::from_secs(60),
            base_backoff: Duration::from_millis(5),
            max_backoff: Duration::from_millis(20),
            poll_interval: Duration::from_millis(5),
        }
    }

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
    fn restart_tracker_applies_exponential_backoff_and_window_limit() {
        let policy = RestartPolicy {
            max_restarts: 3,
            window: Duration::from_secs(60),
            base_backoff: Duration::from_millis(250),
            max_backoff: Duration::from_millis(1_000),
            poll_interval: Duration::from_millis(50),
        };
        let mut tracker = RestartTracker::new(policy);
        let t0 = Instant::now();
        assert_eq!(
            tracker.record_and_next_backoff(t0),
            Some(Duration::from_millis(250))
        );
        assert_eq!(
            tracker.record_and_next_backoff(t0 + Duration::from_secs(1)),
            Some(Duration::from_millis(500))
        );
        assert_eq!(
            tracker.record_and_next_backoff(t0 + Duration::from_secs(2)),
            Some(Duration::from_millis(1_000))
        );
        // 4th crash within 60s window is refused
        assert_eq!(
            tracker.record_and_next_backoff(t0 + Duration::from_secs(3)),
            None
        );
        // After the 60s window passes, budget replenishes
        assert_eq!(
            tracker.record_and_next_backoff(t0 + Duration::from_secs(65)),
            Some(Duration::from_millis(250))
        );
        assert_eq!(tracker.total_restarts(), 4);
    }

    #[test]
    fn supervised_manager_restarts_on_crash_and_emits_fresh_bootstrap() -> Result<(), String> {
        let initial_crashed = Arc::new(AtomicBool::new(false));
        let initial_shutdown = Arc::new(AtomicBool::new(false));
        let initial = FakeSidecar {
            bootstrap: BootstrapInfo {
                base_url: "http://127.0.0.1:4100".to_string(),
                token: "a".repeat(64),
            },
            crashed: Arc::clone(&initial_crashed),
            shutdown_called: Arc::clone(&initial_shutdown),
            stopped: false,
        };

        let spawn_count = Arc::new(AtomicUsize::new(0));
        let spawn_count_clone = Arc::clone(&spawn_count);
        let spawner: SidecarSpawner = Arc::new(move || {
            let n = spawn_count_clone.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(Box::new(FakeSidecar {
                bootstrap: BootstrapInfo {
                    base_url: format!("http://127.0.0.1:{}", 4100 + n),
                    token: format!("{n:0>64}"),
                },
                crashed: Arc::new(AtomicBool::new(false)),
                shutdown_called: Arc::new(AtomicBool::new(false)),
                stopped: false,
            }))
        });

        let (tx, rx) = mpsc::channel::<SidecarEvent>();
        let events_tx = Mutex::new(tx);
        let callback: SidecarEventCallback = Arc::new(move |evt| {
            if let Ok(sender) = events_tx.lock() {
                let _ = sender.send(evt);
            }
        });

        let manager = SidecarManager::from_managed(
            Box::new(initial),
            test_policy(3),
            Some(spawner),
            Some(callback),
        );

        assert_eq!(manager.bootstrap_info()?.base_url, "http://127.0.0.1:4100");
        initial_crashed.store(true, Ordering::SeqCst);
        let _ = manager.health()?;

        let evt = rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|err| format!("did not receive restart event: {err}"))?;
        match evt {
            SidecarEvent::Restarted {
                bootstrap,
                restart_count,
            } => {
                assert_eq!(bootstrap.base_url, "http://127.0.0.1:4101");
                assert_eq!(restart_count, 1);
            }
            SidecarEvent::RestartExhausted { .. } => {
                return Err("expected Restarted event, got RestartExhausted".to_string());
            }
        }
        assert_eq!(manager.bootstrap_info()?.base_url, "http://127.0.0.1:4101");
        assert_eq!(spawn_count.load(Ordering::SeqCst), 1);
        manager.shutdown();
        Ok(())
    }

    #[test]
    fn supervised_manager_stops_restarting_after_window_cap() -> Result<(), String> {
        let initial = FakeSidecar {
            bootstrap: BootstrapInfo {
                base_url: "http://127.0.0.1:4200".to_string(),
                token: "b".repeat(64),
            },
            crashed: Arc::new(AtomicBool::new(true)),
            shutdown_called: Arc::new(AtomicBool::new(false)),
            stopped: false,
        };

        let spawn_count = Arc::new(AtomicUsize::new(0));
        let spawn_count_clone = Arc::clone(&spawn_count);
        let spawner: SidecarSpawner = Arc::new(move || {
            let n = spawn_count_clone.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(Box::new(FakeSidecar {
                bootstrap: BootstrapInfo {
                    base_url: format!("http://127.0.0.1:{}", 4200 + n),
                    token: format!("{n:0>64}"),
                },
                // Every respawned instance immediately crashes to exercise the 3-restart cap
                crashed: Arc::new(AtomicBool::new(true)),
                shutdown_called: Arc::new(AtomicBool::new(false)),
                stopped: false,
            }))
        });

        let (tx, rx) = mpsc::channel::<SidecarEvent>();
        let events_tx = Mutex::new(tx);
        let callback: SidecarEventCallback = Arc::new(move |evt| {
            if let Ok(sender) = events_tx.lock() {
                let _ = sender.send(evt);
            }
        });

        let manager = SidecarManager::from_managed(
            Box::new(initial),
            test_policy(3),
            Some(spawner),
            Some(callback),
        );

        let mut exhausted = false;
        for _ in 0..8 {
            let evt = rx
                .recv_timeout(Duration::from_secs(2))
                .map_err(|err| format!("timed out waiting for supervisor event: {err}"))?;
            if let SidecarEvent::RestartExhausted { restart_count, .. } = evt {
                assert_eq!(restart_count, 3);
                exhausted = true;
                break;
            }
        }
        assert!(exhausted);
        assert_eq!(spawn_count.load(Ordering::SeqCst), 3);
        let health = manager.health()?;
        assert!(!health.running);
        assert!(health.crash_loop_exhausted);
        assert_eq!(health.restart_count, 3);
        assert!(manager.bootstrap_info().is_err());
        manager.shutdown();
        Ok(())
    }

    #[test]
    fn explicit_shutdown_and_update_exit_never_trigger_restart() -> Result<(), String> {
        let initial_crashed = Arc::new(AtomicBool::new(false));
        let initial_shutdown = Arc::new(AtomicBool::new(false));
        let initial = FakeSidecar {
            bootstrap: BootstrapInfo {
                base_url: "http://127.0.0.1:4300".to_string(),
                token: "c".repeat(64),
            },
            crashed: Arc::clone(&initial_crashed),
            shutdown_called: Arc::clone(&initial_shutdown),
            stopped: false,
        };

        let spawn_count = Arc::new(AtomicUsize::new(0));
        let spawn_count_clone = Arc::clone(&spawn_count);
        let spawner: SidecarSpawner = Arc::new(move || {
            spawn_count_clone.fetch_add(1, Ordering::SeqCst);
            Err("should never be called after shutdown".to_string())
        });

        let manager =
            SidecarManager::from_managed(Box::new(initial), test_policy(3), Some(spawner), None);

        manager.ensure_ready_for_update()?;
        manager.prepare_for_update_exit();
        initial_crashed.store(true, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(30));

        assert!(initial_shutdown.load(Ordering::SeqCst));
        assert_eq!(spawn_count.load(Ordering::SeqCst), 0);
        assert!(manager.ensure_ready_for_update().is_err());
        let health = manager.health()?;
        assert!(!health.running);
        assert!(health.shutting_down);
        assert!(health.updating);
        Ok(())
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

    #[test]
    fn read_handshake_port_skips_pre_handshake_noise_and_rejects_eof() -> Result<(), String> {
        let mut cursor = std::io::Cursor::new(
            b"\n[dotenv] loaded .env\n{\"debug\":true}\n{\"port\":4188}\n".as_slice(),
        );
        assert_eq!(read_handshake_port(&mut cursor)?, 4188);

        let mut empty = std::io::Cursor::new(b"".as_slice());
        assert!(read_handshake_port(&mut empty).is_err());

        let mut only_noise = std::io::Cursor::new(b"booting...\nnot json\n".as_slice());
        assert!(read_handshake_port(&mut only_noise).is_err());
        Ok(())
    }

    #[test]
    fn strip_windows_verbatim_prefix_normalizes_drive_and_unc_paths() {
        assert_eq!(
            strip_windows_verbatim_prefix_str(
                r"\\?\C:\Program Files\StudyHub\resources\runtime\node.exe"
            ),
            r"C:\Program Files\StudyHub\resources\runtime\node.exe"
        );
        assert_eq!(
            strip_windows_verbatim_prefix_str(r"\\?\UNC\server\share\StudyHub"),
            r"\\server\share\StudyHub"
        );
        assert_eq!(
            strip_windows_verbatim_prefix_str(r"C:\Users\dev\StudyHub"),
            r"C:\Users\dev\StudyHub"
        );
        assert_eq!(
            strip_windows_verbatim_prefix_str(r"\\?\Volume{01234567}\foo"),
            r"\\?\Volume{01234567}\foo"
        );
    }

    fn spawn_node_script(script: &str) -> Result<(Child, Option<ChildStdin>), String> {
        let mut cmd = Command::new(node_binary_name());
        cmd.args(["-e", script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        configure_hidden_command(&mut cmd);
        let mut child = cmd
            .spawn()
            .map_err(|err| format!("failed to spawn node test process: {err}"))?;
        let stdin = child.stdin.take();
        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .map_err(|err| format!("failed waiting for node test process readiness: {err}"))?;
        }
        Ok((child, stdin))
    }

    #[test]
    fn graceful_exit_defaults_allow_realistic_windows_shutdown() {
        assert!(GRACEFUL_EXIT_TIMEOUT >= Duration::from_millis(2_500));
        assert!(GRACEFUL_EXIT_TIMEOUT <= Duration::from_millis(5_000));
        assert!(GRACEFUL_EXIT_POLL_INTERVAL >= Duration::from_millis(20));
        assert!(GRACEFUL_EXIT_POLL_INTERVAL <= Duration::from_millis(100));
    }

    #[test]
    fn terminate_child_waits_for_graceful_exit_on_stdin_eof() -> Result<(), String> {
        // Exits 200ms after stdin EOF (longer than the previous 150ms cutoff) to prove
        // graceful shutdown completes cleanly without falling through to forced tree kill.
        let (mut child, mut stdin) = spawn_node_script(
            "process.stdin.resume(); process.stdin.once('end', () => setTimeout(() => process.exit(0), 200)); console.log('ready');",
        )?;
        let outcome = terminate_child_with_timeout(
            &mut child,
            &mut stdin,
            Duration::from_millis(2_000),
            Duration::from_millis(25),
        );
        assert_eq!(outcome, TerminationOutcome::GracefulExit);
        assert!(stdin.is_none());
        let status = child.try_wait().map_err(|err| err.to_string())?;
        assert!(matches!(status, Some(code) if code.success()));
        Ok(())
    }

    #[test]
    fn terminate_child_force_kills_unresponsive_process_after_timeout() -> Result<(), String> {
        let (mut child, mut stdin) = spawn_node_script(
            "process.stdin.resume(); console.log('ready'); setInterval(() => {}, 10_000);",
        )?;
        let started = Instant::now();
        let outcome = terminate_child_with_timeout(
            &mut child,
            &mut stdin,
            Duration::from_millis(120),
            Duration::from_millis(20),
        );
        let elapsed = started.elapsed();
        assert_eq!(outcome, TerminationOutcome::ForcedKill);
        assert!(stdin.is_none());
        assert!(elapsed >= Duration::from_millis(100));
        assert!(child.try_wait().map_err(|err| err.to_string())?.is_some());
        Ok(())
    }

    #[test]
    fn terminate_child_returns_already_exited_without_waiting() -> Result<(), String> {
        let (mut child, mut stdin) = spawn_node_script("process.exit(0);")?;
        let _ = child.wait().map_err(|err| err.to_string())?;
        let started = Instant::now();
        let outcome = terminate_child_with_timeout(
            &mut child,
            &mut stdin,
            Duration::from_secs(3),
            Duration::from_millis(50),
        );
        assert_eq!(outcome, TerminationOutcome::AlreadyExited);
        assert!(stdin.is_none());
        assert!(started.elapsed() < Duration::from_millis(500));
        Ok(())
    }
}
