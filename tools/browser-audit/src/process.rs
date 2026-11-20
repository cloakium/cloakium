//! Bounded child execution with an owned process group and detached descendants.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::raw::c_int;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use wait_timeout::ChildExt;

use crate::tree::{ProcessCleanup, ProcessTree};

const SIGTERM: c_int = 15;
const SIGKILL: c_int = 9;
const GRACE: Duration = Duration::from_secs(5);
const SAMPLE_SLICE: Duration = Duration::from_millis(100);
const STDOUT_LIMIT: usize = 16 * 1024 * 1024;
const STDERR_LIMIT: usize = 1024 * 1024;
const LOG_DRAIN_WAIT: Duration = Duration::from_secs(2);

extern "C" {
    fn kill(process: c_int, signal: c_int) -> c_int;
}

#[derive(Debug, Clone)]
pub struct ProcessSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct ProcessOutcome {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub timed_out: bool,
    pub elapsed_ms: u128,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub cleanup: ProcessCleanup,
}

impl ProcessOutcome {
    pub fn success(&self) -> bool {
        !self.timed_out && self.code == Some(0)
    }

    pub fn summary(&self) -> String {
        if self.timed_out {
            return "timed out".to_string();
        }
        match (self.code, self.signal) {
            (Some(code), _) => format!("exit {code}"),
            (None, Some(signal)) => format!("signal {signal}"),
            _ => "unknown termination".to_string(),
        }
    }
}

pub fn run(spec: &ProcessSpec) -> Result<ProcessOutcome> {
    let started = Instant::now();
    let stdout_file = create_log(&spec.stdout_path)?;
    let stderr_file = create_log(&spec.stderr_path)?;
    let mut builder = Command::new(&spec.program);
    builder
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(&spec.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    builder.process_group(0);
    let mut child = builder
        .spawn()
        .with_context(|| format!("failed to start {}", spec.program.display()))?;
    let root_pid = child.id();
    let mut tree = ProcessTree::new(root_pid);
    let (stdout_done, stdout_result) = drain(child.stdout.take(), stdout_file, STDOUT_LIMIT);
    let (stderr_done, stderr_result) = drain(child.stderr.take(), stderr_file, STDERR_LIMIT);

    let deadline = Instant::now() + spec.timeout;
    let mut timed_out = false;
    let mut status: Option<ExitStatus> = None;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            timed_out = true;
            break;
        }
        let slice = remaining.min(SAMPLE_SLICE);
        match child.wait_timeout(slice)? {
            Some(value) => {
                status = Some(value);
                break;
            }
            None => {
                if let Some(tree) = tree.as_mut() {
                    tree.sample();
                }
            }
        }
    }

    if timed_out {
        if let Some(tree) = tree.as_mut() {
            tree.terminate(GRACE);
        } else {
            signal_group(-(root_pid as i32), SIGTERM);
            thread::sleep(GRACE);
            signal_group(-(root_pid as i32), SIGKILL);
        }
        status = Some(child.wait()?);
    } else if let Some(tree) = tree.as_mut() {
        tree.finish_normal();
    }

    // A detached browser may hold the inherited pipes open even after the
    // runner exits. Wait briefly, then read the capped private logs.
    let stdout_truncated = stdout_result.recv_timeout(LOG_DRAIN_WAIT).unwrap_or(true);
    let stderr_truncated = stderr_result.recv_timeout(LOG_DRAIN_WAIT).unwrap_or(true);
    drop(stdout_done);
    drop(stderr_done);
    let (stdout, stdout_capped) = read_bounded(&spec.stdout_path, STDOUT_LIMIT)?;
    let (stderr, stderr_capped) = read_bounded(&spec.stderr_path, STDERR_LIMIT)?;
    let status = status.context("child process produced no exit status")?;
    let cleanup = tree.map(ProcessTree::receipt).unwrap_or(ProcessCleanup {
        root_pid,
        root_start_ticks: 0,
        discovered: Vec::new(),
        signalled: Vec::new(),
        residual: Vec::new(),
        clean: false,
    });
    Ok(ProcessOutcome {
        code: status.code(),
        signal: signal_of(&status),
        timed_out,
        elapsed_ms: started.elapsed().as_millis(),
        stdout,
        stderr,
        stdout_truncated: stdout_truncated || stdout_capped,
        stderr_truncated: stderr_truncated || stderr_capped,
        cleanup,
    })
}

fn create_log(path: &Path) -> Result<File> {
    if let Some(parent) = path.parent() {
        crate::storage::create_private_dir_all(parent)?;
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("failed to create a fresh log {}", path.display()))
}

type DrainResult = mpsc::Receiver<bool>;

fn drain<R: Read + Send + 'static>(
    reader: Option<R>,
    mut file: File,
    limit: usize,
) -> (thread::JoinHandle<()>, DrainResult) {
    let (sender, receiver) = mpsc::channel();
    let handle = thread::spawn(move || {
        let Some(mut reader) = reader else {
            let _ = sender.send(false);
            return;
        };
        let mut buffer = [0u8; 8192];
        let mut written = 0usize;
        let mut discarded = false;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let remaining = limit.saturating_sub(written);
                    let keep = remaining.min(read);
                    if keep > 0 {
                        let _ = file.write_all(&buffer[..keep]);
                        written += keep;
                    }
                    if keep < read {
                        discarded = true;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = file.flush();
        let _ = sender.send(discarded);
    });
    (handle, receiver)
}

fn signal_group(process_group: i32, signal: c_int) {
    if process_group >= 0 {
        return;
    }
    unsafe {
        kill(process_group, signal);
    }
}

fn read_bounded(path: &Path, limit: usize) -> Result<(String, bool)> {
    let file = File::open(path).with_context(|| format!("failed to read {}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let truncated = bytes.len() > limit;
    bytes.truncate(limit);
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

fn signal_of(status: &ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn spec(directory: &Path, script: &str, timeout: Duration) -> ProcessSpec {
        let runner = directory.join("runner.sh");
        fs::write(&runner, script).expect("script");
        ProcessSpec {
            program: shell().expect("shell"),
            args: vec![runner.to_string_lossy().into_owned()],
            env: BTreeMap::from([(
                "PATH".to_string(),
                "/run/current-system/sw/bin:/usr/bin:/bin".to_string(),
            )]),
            cwd: directory.to_path_buf(),
            stdout_path: directory.join("stdout.log"),
            stderr_path: directory.join("stderr.log"),
            timeout,
        }
    }

    fn shell() -> Option<PathBuf> {
        if Path::new("/bin/sh").exists() {
            return Some(PathBuf::from("/bin/sh"));
        }
        for directory in std::env::split_paths(&std::env::var_os("PATH")?) {
            let candidate = directory.join("sh");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }

    #[test]
    fn captures_output_and_exit_code() {
        if shell().is_none() {
            return;
        }
        let directory = tempfile::tempdir().expect("tempdir");
        let spec = spec(
            directory.path(),
            "printf 'ok'; exit 0",
            Duration::from_secs(5),
        );
        let outcome = run(&spec).expect("run");
        assert!(outcome.success());
        assert_eq!(outcome.stdout, "ok");
        assert!(outcome.cleanup.clean);
    }

    #[test]
    fn timeout_terminates_the_owned_group_and_detached_child() {
        if shell().is_none() {
            return;
        }
        let directory = tempfile::tempdir().expect("tempdir");
        let pid_file = directory.path().join("detached.pid");
        let setsid = which("setsid");
        let Some(sleep) = which("sleep") else {
            return;
        };
        let script = if let Some(setsid) = setsid {
            format!(
                "{} '{}' 30 & echo $! > '{}'\n{} 30 &\nwait\n",
                setsid.display(),
                sleep.display(),
                pid_file.display(),
                sleep.display()
            )
        } else {
            format!("{} 30 &\nwait\n", sleep.display())
        };
        let spec = spec(directory.path(), &script, Duration::from_millis(500));
        let outcome = run(&spec).expect("run");
        assert!(outcome.timed_out);
        assert!(!outcome.success());
        assert!(outcome.cleanup.root_pid > 0);
        if pid_file.is_file() {
            let text = fs::read_to_string(pid_file).expect("pid");
            let pid: u32 = text.trim().parse().expect("pid number");
            assert!(
                !crate::tree::pid_is_live(pid),
                "detached child {pid} survived"
            );
        }
    }

    #[test]
    fn an_unrelated_foreign_process_survives_a_timeout() {
        if shell().is_none() {
            return;
        }
        let Some(sleep) = which("sleep") else {
            return;
        };
        let mut foreign = std::process::Command::new(&sleep)
            .arg("30")
            .spawn()
            .expect("foreign");
        let directory = tempfile::tempdir().expect("tempdir");
        let spec = spec(
            directory.path(),
            &format!("{} 30 &\nwait\n", sleep.display()),
            Duration::from_millis(300),
        );
        let outcome = run(&spec).expect("run");
        assert!(outcome.timed_out);
        assert!(crate::tree::pid_is_live(foreign.id()));
        let _ = foreign.kill();
        let _ = foreign.wait();
    }

    #[test]
    fn log_files_are_fresh_and_symlinks_are_rejected() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("log");
        fs::write(&path, b"old").expect("old");
        assert!(create_log(&path).is_err());
        let link = directory.path().join("link");
        std::os::unix::fs::symlink(&path, &link).expect("symlink");
        assert!(create_log(&link).is_err());
    }

    fn which(name: &str) -> Option<PathBuf> {
        for directory in std::env::split_paths(&std::env::var_os("PATH")?) {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }
}
