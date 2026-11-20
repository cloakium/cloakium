//! start / status / stop. The socket belongs to the X server: this module never
//! unlinks it, and reports whether it is gone instead.

use crate::json::{bool_field, num_field, str_field};
use crate::proc;
use crate::state::{self, Manifest, Screen};
use crate::x11::{self, Tools};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const READY_BUDGET: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Wm {
    None,
    Openbox,
}

impl Wm {
    pub fn parse(s: &str) -> Result<Wm, String> {
        match s {
            "none" => Ok(Wm::None),
            "openbox" => Ok(Wm::Openbox),
            other => Err(format!(
                "unknown window manager '{}' (expected none or openbox)",
                other
            )),
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Wm::None => "none",
            Wm::Openbox => "openbox",
        }
    }
}

pub struct StartOpts {
    pub state_dir: PathBuf,
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub dpi: u32,
    pub window_manager: Wm,
}

pub fn socket_for(display: &str) -> PathBuf {
    PathBuf::from(format!(
        "/tmp/.X11-unix/X{}",
        display.trim_start_matches(':')
    ))
}

fn error_json(message: &str) -> String {
    let mut out = String::from("{");
    str_field(&mut out, "schema", state::SCHEMA, true);
    bool_field(&mut out, "ok", false, true);
    str_field(&mut out, "error", message, false);
    out.push('}');
    out
}

/// Remove only files that are unambiguously ours: the manifest and the cookie.
/// The socket is left to the server.
fn cleanup(root: &Path, manifest: Option<&Manifest>) {
    if let Some(m) = manifest {
        if let Ok(meta) = fs::symlink_metadata(&m.xauthority_path) {
            if meta.is_file() && meta.uid() == state::euid() {
                let _ = fs::remove_file(&m.xauthority_path);
            }
        }
    }
    let _ = fs::remove_file(state::manifest_path(root));
    proc::reap_own_children();
}

pub fn start(opts: &StartOpts) -> Result<String, String> {
    let root = &opts.state_dir;
    state::ensure_dir(root)?;

    if let Some(prev) = state::ensure_reusable(root)? {
        let tools = Tools::resolve()?;
        if proc::owned(prev.xvfb_pid, &tools.xvfb, prev.xvfb_start_ticks) {
            return Err(format!(
                "a display this tool owns is already running ({}) in {}",
                prev.display,
                root.display()
            ));
        }
        cleanup(root, Some(&prev));
    }

    if opts.width == 0 || opts.height == 0 || opts.depth == 0 || opts.dpi == 0 {
        return Err("width, height, depth and dpi must be non-zero".into());
    }

    let tools = Tools::resolve()?;
    let home = root.join("home");
    let run = root.join("run");
    let logs = root.join("logs");
    for d in [&home, &run, &logs, &run.join("tmp")] {
        state::private_dir(d)?;
    }
    let auth = state::auth_path(root);
    state::write_auth(&auth)?;
    state::auth_file_ok(&auth)?;

    let env = x11::minimal_env(&home, &run);
    let (rd, wr) = x11::pipe().map_err(|e| format!("pipe: {}", e))?;

    let screen = format!("{}x{}x{}", opts.width, opts.height, opts.depth);
    let args: Vec<String> = vec![
        "-displayfd".into(),
        wr.to_string(),
        "-screen".into(),
        "0".into(),
        screen.clone(),
        "-dpi".into(),
        opts.dpi.to_string(),
        "-nolisten".into(),
        "tcp".into(),
        "-noreset".into(),
        "-auth".into(),
        auth.display().to_string(),
    ];

    let xvfb = match x11::spawn_detached(&tools.xvfb, &args, &env, &logs.join("xvfb.log")) {
        Ok(child) => child,
        Err(e) => {
            x11::close_fd(rd);
            x11::close_fd(wr);
            let _ = fs::remove_file(&auth);
            return Err(format!("starting Xvfb: {}", e));
        }
    };
    let xvfb_pid = xvfb.id();
    x11::close_fd(wr);

    let number = match x11::read_display_number(rd, READY_BUDGET) {
        Some(n) => n,
        None => {
            x11::close_fd(rd);
            proc::signal(xvfb_pid, proc::SIGKILL);
            let _ = fs::remove_file(&auth);
            return Err(format!(
                "Xvfb did not report a display on -displayfd (pid {})",
                xvfb_pid
            ));
        }
    };
    x11::close_fd(rd);
    let display = format!(":{}", number);

    let fail = |message: String, xvfb_pid: u32, wm_pid: u32| -> String {
        if wm_pid != 0 {
            proc::terminate(wm_pid);
        }
        proc::terminate(xvfb_pid);
        if let Ok(meta) = fs::symlink_metadata(&auth) {
            if meta.is_file() && meta.uid() == state::euid() {
                let _ = fs::remove_file(&auth);
            }
        }
        error_json(&message)
    };

    if let Err(e) = proc::wait_until("X server", READY_BUDGET, || {
        x11::reachable(&tools, &display, &auth)
    }) {
        return Err(fail(format!("{} ({})", e, display), xvfb_pid, 0));
    }
    if !x11::auth_enforced(&tools, &display) {
        return Err(fail(
            format!("{} accepted a client without the cookie", display),
            xvfb_pid,
            0,
        ));
    }

    let mut wm_pid = 0u32;
    if opts.window_manager == Wm::Openbox {
        let openbox = match &tools.openbox {
            Some(p) => p.clone(),
            None => {
                return Err(fail(
                    "openbox requested but not available".into(),
                    xvfb_pid,
                    0,
                ))
            }
        };
        let mut wm_env = env.clone();
        wm_env.push(("DISPLAY".into(), display.clone()));
        wm_env.push(("XAUTHORITY".into(), auth.display().to_string()));
        match x11::spawn_detached(&openbox, &[], &wm_env, &logs.join("wm.log")) {
            Ok(child) => wm_pid = child.id(),
            Err(e) => {
                return Err(fail(format!("starting openbox: {}", e), xvfb_pid, 0));
            }
        }
        if let Err(e) = proc::wait_until("window manager", READY_BUDGET, || {
            x11::wm_ready(&tools, &display, &auth, &home)
        }) {
            return Err(fail(e, xvfb_pid, wm_pid));
        }
    }

    let identity = state::socket_identity(&socket_for(&display));
    let manifest = Manifest {
        display: display.clone(),
        xauthority_path: auth.clone(),
        xvfb_pid,
        xvfb_start_ticks: proc::start_ticks(xvfb_pid).unwrap_or(0),
        wm_pid,
        wm_start_ticks: if wm_pid != 0 {
            proc::start_ticks(wm_pid).unwrap_or(0)
        } else {
            0
        },
        screen: Screen {
            width: opts.width,
            height: opts.height,
            depth: opts.depth,
            dpi: opts.dpi,
        },
        window_manager: opts.window_manager.name().to_string(),
        auth_enforced: true,
        socket_dev: identity.map(|(dev, _)| dev),
        socket_ino: identity.map(|(_, ino)| ino),
    };

    if let Err(e) = state::write_manifest(root, &manifest) {
        return Err(fail(format!("writing manifest: {}", e), xvfb_pid, wm_pid));
    }
    Ok(manifest.to_json())
}

pub fn status(state_dir: &Path) -> Result<String, String> {
    let m = state::read_manifest(state_dir)?;
    let tools = Tools::resolve()?;
    let xvfb_ok = proc::owned(m.xvfb_pid, &tools.xvfb, m.xvfb_start_ticks);
    let wm_ok = m.wm_pid == 0
        || tools
            .openbox
            .as_ref()
            .map(|p| proc::owned(m.wm_pid, p, m.wm_start_ticks))
            .unwrap_or(false);
    let sock = socket_for(&m.display);
    let identity = state::socket_identity(&sock);
    let socket_owned = identity.is_some();
    let identity_matched = match (identity, m.socket_dev, m.socket_ino) {
        (Some((dev, ino)), Some(mdev), Some(mino)) => dev == mdev && ino == mino,
        _ => false,
    };
    let reachable = xvfb_ok && x11::reachable(&tools, &m.display, &m.xauthority_path);
    let mut out = String::from("{");
    str_field(&mut out, "schema", state::SCHEMA, true);
    str_field(&mut out, "display", &m.display, true);
    str_field(
        &mut out,
        "xauthorityPath",
        &m.xauthority_path.display().to_string(),
        true,
    );
    num_field(&mut out, "xvfbPid", m.xvfb_pid as i64, true);
    num_field(&mut out, "wmPid", m.wm_pid as i64, true);
    bool_field(&mut out, "xvfbAlive", xvfb_ok, true);
    bool_field(&mut out, "wmAlive", wm_ok, true);
    bool_field(&mut out, "socketOwned", socket_owned, true);
    bool_field(&mut out, "socketIdentityMatched", identity_matched, true);
    bool_field(&mut out, "reachable", reachable, false);
    out.push('}');
    Ok(out)
}

pub fn stop(state_dir: &Path) -> Result<String, String> {
    let m = match state::read_manifest(state_dir) {
        Ok(m) => m,
        Err(e) => {
            let mut out = String::from("{");
            str_field(&mut out, "schema", state::SCHEMA, true);
            bool_field(&mut out, "stopped", false, true);
            str_field(&mut out, "reason", &e, false);
            out.push('}');
            return Ok(out);
        }
    };
    let tools = x11::resolve_optional();
    let sock = socket_for(&m.display);
    let before = state::socket_identity(&sock);
    let identity_matched = match (before, m.socket_dev, m.socket_ino) {
        (Some((dev, ino)), Some(mdev), Some(mino)) => dev == mdev && ino == mino,
        _ => false,
    };

    let mut killed: Vec<u32> = Vec::new();
    let mut skipped: Vec<u32> = Vec::new();

    if m.wm_pid != 0 {
        let owned = tools
            .openbox
            .as_ref()
            .map(|p| proc::owned(m.wm_pid, p, m.wm_start_ticks))
            .unwrap_or(false);
        if owned {
            proc::terminate(m.wm_pid);
            killed.push(m.wm_pid);
        } else {
            skipped.push(m.wm_pid);
        }
    }
    let xvfb_owned = tools
        .xvfb
        .as_ref()
        .map(|p| proc::owned(m.xvfb_pid, p, m.xvfb_start_ticks))
        .unwrap_or(false);
    if xvfb_owned {
        proc::terminate(m.xvfb_pid);
        killed.push(m.xvfb_pid);
    } else {
        skipped.push(m.xvfb_pid);
    }

    // The X server removes its own socket on a clean exit. This tool never
    // unlinks it: a stale manifest must not delete an endpoint that now belongs
    // to a different (possibly same-uid) display.
    let after = state::socket_identity(&sock);
    let socket_present_before = before.is_some();
    let socket_present_after = after.is_some();
    let socket_cleanup = if !socket_present_after {
        if socket_present_before {
            "removed"
        } else {
            "absent"
        }
    } else {
        "unknown"
    };

    let mut auth_removed = false;
    if let Ok(meta) = fs::symlink_metadata(&m.xauthority_path) {
        if meta.is_file() && meta.uid() == state::euid() {
            auth_removed = fs::remove_file(&m.xauthority_path).is_ok();
        }
    }
    let state_removed = fs::remove_file(state::manifest_path(state_dir)).is_ok();
    proc::reap_own_children();

    let mut out = String::from("{");
    str_field(&mut out, "schema", state::SCHEMA, true);
    bool_field(&mut out, "stopped", true, true);
    str_field(&mut out, "display", &m.display, true);
    out.push_str("\"killedPids\":[");
    out.push_str(
        &killed
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push_str("],\"skippedPids\":[");
    out.push_str(
        &skipped
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push_str("],");
    bool_field(&mut out, "socketPresentBefore", socket_present_before, true);
    bool_field(&mut out, "socketPresentAfter", socket_present_after, true);
    bool_field(&mut out, "socketRemoved", !socket_present_after, true);
    bool_field(&mut out, "socketIdentityMatched", identity_matched, true);
    str_field(&mut out, "socketCleanup", socket_cleanup, true);
    bool_field(&mut out, "authRemoved", auth_removed, true);
    bool_field(&mut out, "stateRemoved", state_removed, false);
    out.push('}');
    Ok(out)
}

#[cfg(test)]
#[path = "run_tests.rs"]
mod tests;
