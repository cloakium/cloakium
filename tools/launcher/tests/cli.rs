#![cfg(unix)]

use std::io::{Read, Write};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

fn launcher() -> &'static str {
    env!("CARGO_BIN_EXE_cloakium-chromium")
}

fn fixture() -> &'static str {
    env!("CARGO_BIN_EXE_cloakium-launcher-fixture")
}

#[test]
fn execs_with_profiled_args_and_preserves_exit_code() {
    let output = Command::new(launcher())
        .env("CLOAKIUM_REAL_CHROMIUM", fixture())
        .args([
            "--headless",
            "--fingerprint=seed",
            "--no-sandbox",
            "--proxy-server=http://user:pass@127.0.0.1:8080",
            "--",
            "https://example.test/a?b=c",
        ])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(42));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines[0], "ARG:--screen-info={1920x1080}");
    assert_eq!(
        lines[1],
        "ARG:--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"
    );
    assert_eq!(
        &lines[2..8],
        &[
            "ARG:--headless",
            "ARG:--fingerprint=seed",
            "ARG:--no-sandbox",
            "ARG:--proxy-server=http://user:pass@127.0.0.1:8080",
            "ARG:--",
            "ARG:https://example.test/a?b=c",
        ]
    );
    assert!(lines.contains(&"ENV:false"));
}

#[test]
fn preserves_stdin_and_stdout() {
    let mut child = Command::new(launcher())
        .env("CLOAKIUM_REAL_CHROMIUM", fixture())
        .args(["--headless", "--fingerprint=seed"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"hello stdin\n")
        .unwrap();
    drop(child.stdin.take());

    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(42));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("STDIN:hello stdin\n"));
}

#[test]
fn preserves_extra_file_descriptors() {
    extern "C" {
        fn dup2(oldfd: i32, newfd: i32) -> i32;
    }

    let (mut read3, write3) = UnixStream::pair().unwrap();
    let (mut read4, write4) = UnixStream::pair().unwrap();
    let write3_fd = write3.as_raw_fd();
    let write4_fd = write4.as_raw_fd();

    let mut command = Command::new(launcher());
    command
        .env("CLOAKIUM_REAL_CHROMIUM", fixture())
        .args(["--headless", "--fingerprint=seed"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            if dup2(write3_fd, 3) < 0 || dup2(write4_fd, 4) < 0 {
                return Err(std::io::Error::from_raw_os_error(5));
            }
            Ok(())
        });
    }

    let mut child = command.spawn().unwrap();
    drop(write3);
    drop(write4);
    assert_eq!(child.wait().unwrap().code(), Some(42));

    let mut out3 = String::new();
    read3.read_to_string(&mut out3).unwrap();
    let mut out4 = String::new();
    read4.read_to_string(&mut out4).unwrap();
    assert_eq!(out3, "FD3\n");
    assert_eq!(out4, "FD4\n");
}

#[test]
fn reports_missing_real_binary_without_printing_args() {
    let output = Command::new(launcher())
        .env_remove("CLOAKIUM_REAL_CHROMIUM")
        .args(["--headless", "--fingerprint=secret-value"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("CLOAKIUM_REAL_CHROMIUM"));
    assert!(!stderr.contains("secret-value"));
    assert!(!stderr.contains("--fingerprint"));
}

#[test]
fn leaves_headed_arguments_unchanged() {
    let output = Command::new(launcher())
        .env("CLOAKIUM_REAL_CHROMIUM", fixture())
        .args(["--no-sandbox", "https://example.test"])
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(42));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(!stdout.contains("--screen-info"));
    assert!(!stdout.contains("--blink-settings"));
    assert!(stdout.contains("ARG:--no-sandbox"));
    assert!(stdout.contains("ARG:https://example.test"));
}
