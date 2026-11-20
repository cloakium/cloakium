//! X server plumbing: tool resolution, a detached spawn, `-displayfd`
//! allocation, and the two readiness probes. Every wait is bounded.

use std::io::{self, Read};
use std::os::fd::FromRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const XVFB_BAKED: &str = match option_env!("CLOAKIUM_AUDIT_XVFB") {
    Some(v) => v,
    None => "",
};
const OPENBOX_BAKED: &str = match option_env!("CLOAKIUM_AUDIT_OPENBOX") {
    Some(v) => v,
    None => "",
};
const XPROP_BAKED: &str = match option_env!("CLOAKIUM_AUDIT_XPROP") {
    Some(v) => v,
    None => "",
};
const XDPIINFO_BAKED: &str = match option_env!("CLOAKIUM_AUDIT_XDPIINFO") {
    Some(v) => v,
    None => "",
};

pub struct Tools {
    pub xvfb: PathBuf,
    pub openbox: Option<PathBuf>,
    pub xprop: PathBuf,
    pub xdpyinfo: PathBuf,
}

fn resolve(env_key: &str, baked: &str, name: &str) -> Result<PathBuf, String> {
    if let Ok(v) = std::env::var(env_key) {
        let p = PathBuf::from(v);
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!("{}={} is not a file", env_key, p.display()));
    }
    if !baked.is_empty() {
        let p = PathBuf::from(baked);
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!(
            "baked path for {} is missing: {}",
            name,
            p.display()
        ));
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let p = Path::new(dir).join(name);
            if p.is_file() {
                return Ok(p);
            }
        }
    }
    Err(format!(
        "{} not found: set the matching CLOAKIUM_AUDIT_* variable or put it on PATH",
        name
    ))
}

impl Tools {
    pub fn resolve() -> Result<Tools, String> {
        Ok(Tools {
            xvfb: resolve("CLOAKIUM_AUDIT_XVFB", XVFB_BAKED, "Xvfb")?,
            openbox: resolve("CLOAKIUM_AUDIT_OPENBOX", OPENBOX_BAKED, "openbox").ok(),
            xprop: resolve("CLOAKIUM_AUDIT_XPROP", XPROP_BAKED, "xprop")?,
            xdpyinfo: resolve("CLOAKIUM_AUDIT_XDPIINFO", XDPIINFO_BAKED, "xdpyinfo")?,
        })
    }
}

/// Minimal, explicit environment for every child we start. Nothing is
/// inherited from the caller.
pub fn minimal_env(home: &Path, run: &Path) -> Vec<(String, String)> {
    vec![
        ("HOME".into(), home.display().to_string()),
        ("XDG_RUNTIME_DIR".into(), run.display().to_string()),
        ("TMPDIR".into(), run.join("tmp").display().to_string()),
        ("LANG".into(), "C.UTF-8".into()),
        ("LC_ALL".into(), "C.UTF-8".into()),
        ("TZ".into(), "UTC".into()),
    ]
}

extern "C" {
    fn setsid() -> i32;
}

pub fn spawn_detached(
    program: &Path,
    args: &[String],
    env: &[(String, String)],
    log: &Path,
) -> io::Result<Child> {
    let out = crate::paths::open_log(log)?;
    let err = out.try_clone()?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    for (k, v) in env {
        cmd.env(k, v);
    }
    unsafe {
        cmd.pre_exec(|| {
            setsid();
            Ok(())
        });
    }
    cmd.spawn()
}

extern "C" {
    fn pipe2(fds: *mut i32, flags: i32) -> i32;
    fn poll(fds: *mut PollFd, n: u64, timeout: i32) -> i32;
    fn close(fd: i32) -> i32;
}

#[repr(C)]
struct PollFd {
    fd: i32,
    events: i16,
    revents: i16,
}

pub fn pipe() -> io::Result<(i32, i32)> {
    let mut fds = [0i32; 2];
    if unsafe { pipe2(fds.as_mut_ptr(), 0) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok((fds[0], fds[1]))
    }
}

pub fn close_fd(fd: i32) {
    if fd >= 0 {
        unsafe { close(fd) };
    }
}

/// Reads the display number the server writes on `-displayfd`.
pub fn read_display_number(fd: i32, budget: Duration) -> Option<u32> {
    let start = Instant::now();
    let mut buf = [0u8; 32];
    let file = std::mem::ManuallyDrop::new(unsafe { std::fs::File::from_raw_fd(fd) });
    loop {
        let left = budget.checked_sub(start.elapsed())?;
        let mut p = PollFd {
            fd,
            events: 1,
            revents: 0,
        };
        let rc = unsafe { poll(&mut p, 1, left.as_millis().min(30_000) as i32) };
        if rc < 0 {
            return None;
        }
        if rc == 0 {
            continue;
        }
        let n = match (&*file).read(&mut buf) {
            Ok(0) => return None,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => continue,
            Err(_) => return None,
        };
        let text = String::from_utf8_lossy(&buf[..n]).to_string();
        if let Some(first) = text.split_whitespace().next() {
            if let Ok(v) = first.parse::<u32>() {
                return Some(v);
            }
        }
    }
}

fn run_tool(program: &Path, args: &[&str], env: &[(String, String)]) -> Option<bool> {
    let mut cmd = Command::new(program);
    cmd.args(args).env_clear();
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.output().ok().map(|o| o.status.success())
}

/// Positive readiness: a real client connects with the owned cookie.
pub fn reachable(tools: &Tools, display: &str, auth: &Path) -> bool {
    let env = vec![
        ("DISPLAY".to_string(), display.to_string()),
        ("XAUTHORITY".to_string(), auth.display().to_string()),
        ("HOME".to_string(), "/nonexistent".to_string()),
        ("LC_ALL".to_string(), "C".to_string()),
    ];
    run_tool(&tools.xdpyinfo, &["-display", display], &env).unwrap_or(false)
}

/// Negative assertion: a client without the cookie must be refused.
pub fn auth_enforced(tools: &Tools, display: &str) -> bool {
    let env = vec![
        ("DISPLAY".to_string(), display.to_string()),
        ("XAUTHORITY".to_string(), "/dev/null".to_string()),
        ("HOME".to_string(), "/nonexistent".to_string()),
        ("LC_ALL".to_string(), "C".to_string()),
    ];
    // Success here means the server accepted an unauthorised client.
    !run_tool(&tools.xdpyinfo, &["-display", display], &env).unwrap_or(false)
}

pub fn wm_ready(tools: &Tools, display: &str, auth: &Path, home: &Path) -> bool {
    let env = vec![
        ("DISPLAY".to_string(), display.to_string()),
        ("XAUTHORITY".to_string(), auth.display().to_string()),
        ("HOME".to_string(), home.display().to_string()),
        ("LC_ALL".to_string(), "C".to_string()),
    ];
    let mut cmd = Command::new(&tools.xprop);
    cmd.args(["-display", display, "-root", "_NET_SUPPORTING_WM_CHECK"])
        .env_clear();
    for (k, v) in &env {
        cmd.env(k, v);
    }
    cmd.output()
        .ok()
        .map(|o| {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            text.contains("window id")
        })
        .unwrap_or(false)
}

/// Tool paths that may be unavailable. Ownership checks that cannot resolve a
/// tool must treat the process as not ours rather than erroring.
pub struct ToolPaths {
    pub xvfb: Option<PathBuf>,
    pub openbox: Option<PathBuf>,
}

pub fn resolve_optional() -> ToolPaths {
    let pick = |env_key: &str, baked: &str, name: &str| -> Option<PathBuf> {
        if let Ok(v) = std::env::var(env_key) {
            let p = PathBuf::from(v);
            if p.is_file() {
                return Some(p);
            }
        }
        if !baked.is_empty() {
            let p = PathBuf::from(baked);
            if p.is_file() {
                return Some(p);
            }
        }
        std::env::var("PATH").ok().and_then(|path| {
            path.split(':')
                .map(|d| Path::new(d).join(name))
                .find(|p| p.is_file())
        })
    };
    ToolPaths {
        xvfb: pick("CLOAKIUM_AUDIT_XVFB", XVFB_BAKED, "Xvfb"),
        openbox: pick("CLOAKIUM_AUDIT_OPENBOX", OPENBOX_BAKED, "openbox"),
    }
}
