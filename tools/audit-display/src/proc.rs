//! Process identity and lifecycle. Ownership is `pid + start ticks + expected
//! executable`, so a recycled pid can never be signalled.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const SIGTERM: i32 = 15;
pub const SIGKILL: i32 = 9;

extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
}

/// `/proc/<pid>/stat` field 22 (starttime in clock ticks), parsed after the
/// parenthesised comm so names containing spaces are safe.
pub fn start_ticks_from_stat(stat: &str) -> Option<u64> {
    let close = stat.rfind(')')?;
    let rest = &stat[close + 1..];
    rest.split_whitespace().nth(19)?.parse().ok()
}

pub fn start_ticks(pid: u32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
    start_ticks_from_stat(&stat)
}

pub fn exe(pid: u32) -> Option<PathBuf> {
    fs::read_link(format!("/proc/{}/exe", pid)).ok()
}

/// Zombies are treated as gone: they still own a /proc entry until reaped.
pub fn alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    match fs::read_to_string(format!("/proc/{}/stat", pid)) {
        Ok(stat) => {
            let close = match stat.rfind(')') {
                Some(i) => i,
                None => return false,
            };
            let state = stat[close + 1..]
                .split_whitespace()
                .next()
                .unwrap_or_default();
            state != "Z" && state != "X"
        }
        Err(_) => false,
    }
}

/// True when the pid is alive, was started at `ticks`, and runs `expected`
/// (or a wrapped binary inside the same package directory).
pub fn owned(pid: u32, expected: &Path, ticks: u64) -> bool {
    if !alive(pid) {
        return false;
    }
    if start_ticks(pid) != Some(ticks) {
        return false;
    }
    let pkg = expected
        .parent()
        .and_then(Path::parent)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| expected.display().to_string());
    match exe(pid) {
        Some(path) => {
            let s = path.display().to_string();
            s == expected.display().to_string() || s.starts_with(&format!("{}/", pkg))
        }
        None => false,
    }
}

pub fn signal(pid: u32, sig: i32) {
    if alive(pid) {
        unsafe { kill(pid as i32, sig) };
    }
}

pub fn reap_own_children() {
    for _ in 0..16 {
        if unsafe { waitpid(-1, std::ptr::null_mut(), 1) } <= 0 {
            break;
        }
    }
}

pub fn wait_until(
    label: &str,
    budget: Duration,
    mut f: impl FnMut() -> bool,
) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < budget {
        if f() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    Err(format!(
        "{} not ready within {} ms",
        label,
        budget.as_millis()
    ))
}

pub fn wait_gone(pid: u32, budget: Duration) -> bool {
    wait_until("process exit", budget, || !alive(pid)).is_ok()
}

/// Bounded TERM then KILL for a process we have already proven is ours.
pub fn terminate(pid: u32) {
    signal(pid, SIGTERM);
    if !wait_gone(pid, Duration::from_secs(5)) {
        signal(pid, SIGKILL);
        let _ = wait_gone(pid, Duration::from_secs(3));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_ticks_survives_comm_with_spaces_and_parens() {
        let stat =
            "42 (my (odd) chrome) S 1 42 42 0 -1 4194560 1 0 0 0 5 6 0 0 20 0 1 0 998877 0 0";
        assert_eq!(start_ticks_from_stat(stat), Some(998877));
    }

    #[test]
    fn start_ticks_rejects_garbage() {
        assert_eq!(start_ticks_from_stat("no parens"), None);
        assert_eq!(start_ticks_from_stat("1 (x) S 1"), None);
    }

    #[test]
    fn dead_pids_are_not_alive() {
        assert!(!alive(0));
        assert!(!alive(4_000_000_000));
    }

    #[test]
    fn ownership_requires_matching_ticks() {
        let me = std::process::id();
        let exe = exe(me).expect("own exe");
        let ticks = start_ticks(me).expect("own ticks");
        assert!(owned(me, &exe, ticks));
        assert!(!owned(me, &exe, ticks.wrapping_add(1)));
        assert!(!owned(me, Path::new("/nonexistent/binary"), ticks));
    }
}
