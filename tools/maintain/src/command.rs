//! Subprocess execution with explicit deadlines.
//!
//! Every command carries its own wall-clock budget so a hung build, copy or
//! network query can never block a maintenance run forever.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command as Process, Stdio};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use wait_timeout::ChildExt;

pub const QUERY_TIMEOUT: Duration = Duration::from_secs(600);
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(1800);
pub const CACHE_COPY_TIMEOUT: Duration = Duration::from_secs(3600);

/// Where a child process reads its standard input from.
#[derive(Debug, Clone, Default)]
pub enum Stdin {
    #[default]
    Null,
    File(PathBuf),
}

/// A fully described child process.
#[derive(Debug, Clone)]
pub struct Command {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub timeout: Duration,
    /// Capture stdout/stderr instead of letting them reach the terminal.
    pub capture: bool,
    /// Replacement text for error messages, used when arguments are sensitive.
    pub description: Option<String>,
    pub stdin: Stdin,
}

impl Command {
    pub fn new<S: Into<String>>(
        program: impl Into<String>,
        args: impl IntoIterator<Item = S>,
    ) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            cwd: None,
            timeout: QUERY_TIMEOUT,
            capture: true,
            description: None,
            stdin: Stdin::Null,
        }
    }

    pub fn cwd(mut self, directory: impl AsRef<Path>) -> Self {
        self.cwd = Some(directory.as_ref().to_path_buf());
        self
    }

    pub fn timeout(mut self, budget: Duration) -> Self {
        self.timeout = budget;
        self
    }

    pub fn capture(mut self, capture: bool) -> Self {
        self.capture = capture;
        self
    }

    pub fn describe(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Feed the child a file, used for secrets that must never appear in argv.
    pub fn stdin_file(mut self, path: impl AsRef<Path>) -> Self {
        self.stdin = Stdin::File(path.as_ref().to_path_buf());
        self
    }

    pub fn display(&self) -> String {
        if let Some(description) = &self.description {
            return description.clone();
        }
        let mut text = self.program.clone();
        for arg in &self.args {
            text.push(' ');
            text.push_str(arg);
        }
        text
    }
}

/// Result of a completed command.
#[derive(Debug, Clone, Default)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
}

impl Output {
    pub fn stdout_trimmed(&self) -> &str {
        self.stdout.trim()
    }
}

/// Indirection that lets every workflow step run against a mock in tests.
pub trait Runner {
    fn run(&mut self, command: &Command) -> Result<Output>;
}

/// Real subprocess execution with a hard deadline.
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessRunner;

impl Runner for ProcessRunner {
    fn run(&mut self, command: &Command) -> Result<Output> {
        let mut builder = Process::new(&command.program);
        builder.args(&command.args);
        match &command.stdin {
            Stdin::Null => {
                builder.stdin(Stdio::null());
            }
            Stdin::File(path) => {
                let file = File::open(path)
                    .with_context(|| format!("failed to open {}", path.display()))?;
                builder.stdin(Stdio::from(file));
            }
        }
        if let Some(directory) = &command.cwd {
            builder.current_dir(directory);
        }
        if command.capture {
            builder.stdout(Stdio::piped()).stderr(Stdio::piped());
        } else {
            builder.stdout(Stdio::inherit()).stderr(Stdio::inherit());
        }
        let mut child = builder
            .spawn()
            .with_context(|| format!("failed to start {}", command.display()))?;
        let stdout_reader = child.stdout.take().map(drain_in_background);
        let stderr_reader = child.stderr.take().map(drain_in_background);

        // Draining both pipes on threads keeps a chatty child from filling a
        // pipe buffer and deadlocking while we wait for its deadline.
        let status = child
            .wait_timeout(command.timeout)
            .with_context(|| format!("failed to wait for {}", command.display()))?;
        let timed_out = status.is_none();
        let status = match status {
            Some(status) => status,
            None => {
                let _ = child.kill();
                child
                    .wait()
                    .with_context(|| format!("failed to reap {}", command.display()))?
            }
        };

        let stdout = collect(stdout_reader);
        let stderr = collect(stderr_reader);
        if timed_out {
            bail!(
                "{} exceeded its deadline of {}s\n{}\n{}",
                command.display(),
                command.timeout.as_secs(),
                stdout.trim(),
                stderr.trim()
            );
        }
        if !status.success() {
            bail!(
                "{} failed with status {}\n{}\n{}",
                command.display(),
                describe_status(status.code()),
                stdout.trim(),
                stderr.trim()
            );
        }
        Ok(Output {
            stdout,
            stderr,
            code: status.code(),
        })
    }
}

fn describe_status(code: Option<i32>) -> String {
    code.map_or_else(|| "signal".to_string(), |code| code.to_string())
}

fn drain_in_background(mut pipe: impl Read + Send + 'static) -> JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = pipe.read_to_end(&mut buffer);
        buffer
    })
}

fn collect(handle: Option<JoinHandle<Vec<u8>>>) -> String {
    match handle.and_then(|handle| handle.join().ok()) {
        Some(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        None => String::new(),
    }
}

/// Test double: closure-backed [`Runner`] that records every command.
pub struct MockRunner<F>
where
    F: FnMut(&Command) -> Result<Output>,
{
    handler: F,
    history: Vec<Command>,
}

impl<F> MockRunner<F>
where
    F: FnMut(&Command) -> Result<Output>,
{
    pub fn new(handler: F) -> Self {
        Self {
            handler,
            history: Vec::new(),
        }
    }

    pub fn history(&self) -> &[Command] {
        &self.history
    }

    pub fn rendered_history(&self) -> Vec<String> {
        self.history.iter().map(Command::display).collect()
    }
}

impl<F> Runner for MockRunner<F>
where
    F: FnMut(&Command) -> Result<Output>,
{
    fn run(&mut self, command: &Command) -> Result<Output> {
        self.history.push(command.clone());
        (self.handler)(command)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> Command {
        Command::new("sh", ["-c", script])
    }

    #[test]
    fn capture_returns_trimmed_stdout() {
        let output = ProcessRunner
            .run(&sh("printf 'hello\\n'").timeout(Duration::from_secs(30)))
            .expect("command should succeed");
        assert_eq!(output.stdout_trimmed(), "hello");
        assert_eq!(output.code, Some(0));
    }

    #[test]
    fn failing_command_reports_stdout_and_stderr() {
        let error = ProcessRunner
            .run(&sh("printf out; printf err >&2; exit 3").timeout(Duration::from_secs(30)))
            .expect_err("command must fail");
        let message = format!("{error:#}");
        assert!(message.contains("out"), "{message}");
        assert!(message.contains("err"), "{message}");
        assert!(message.contains('3'), "{message}");
    }

    #[test]
    fn deadline_kills_a_hung_child() {
        let started = std::time::Instant::now();
        let error = ProcessRunner
            .run(&sh("sleep 30").timeout(Duration::from_millis(250)))
            .expect_err("command must time out");
        assert!(format!("{error:#}").contains("deadline"));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn description_replaces_arguments_in_errors() {
        let error = ProcessRunner
            .run(&sh("exit 1").describe("redacted command"))
            .expect_err("command must fail");
        let message = format!("{error:#}");
        assert!(message.starts_with("redacted command"), "{message}");
        assert!(!message.contains("exit 1"), "{message}");
    }
}
