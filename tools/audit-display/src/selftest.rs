//! Non-browser self-test: allocation, readiness, auth enforcement, the pid
//! reuse guard, and cleanup. Leaves no process behind.

use crate::json::Json;
use crate::proc;
use crate::run::{self, socket_for, StartOpts, Wm};
use crate::state::{self, Manifest};
use crate::x11::{self, Tools};
use std::fs;
use std::path::Path;

fn json_bool(text: &str, key: &str) -> bool {
    Json::parse(text)
        .ok()
        .and_then(|j| j.get(key).and_then(Json::as_bool))
        .unwrap_or(false)
}

pub fn run_selftest(state_dir: &Path) -> Result<String, String> {
    let result = selftest_inner(state_dir);
    if result.is_err() {
        let _ = crate::run::stop(state_dir);
    }
    result
}

fn selftest_inner(state_dir: &Path) -> Result<String, String> {
    let mut checks: Vec<(&str, bool)> = Vec::new();
    state::ensure_dir(state_dir)?;

    let opts = StartOpts {
        state_dir: state_dir.to_path_buf(),
        width: 1280,
        height: 720,
        depth: 24,
        dpi: 96,
        window_manager: Wm::Openbox,
    };
    let started = run::start(&opts)?;
    let parsed = Json::parse(&started).map_err(|e| format!("start output: {}", e))?;
    let manifest = Manifest::from_json(state_dir, &parsed)?;
    let tools = Tools::resolve()?;

    checks.push(("start_reports_owned", {
        parsed.get("owned").and_then(Json::as_bool).unwrap_or(false)
    }));
    checks.push((
        "start_reports_auth_enforced",
        json_bool(&started, "authEnforced"),
    ));
    checks.push((
        "display_is_allocated_number",
        manifest.display.starts_with(':')
            && manifest.display[1..].bytes().all(|b| b.is_ascii_digit()),
    ));
    checks.push((
        "screen_matches_request",
        manifest.screen.geometry() == "1280x720x24",
    ));

    let status = run::status(state_dir)?;
    checks.push(("status_reachable", json_bool(&status, "reachable")));
    checks.push(("status_xvfb_alive", json_bool(&status, "xvfbAlive")));
    checks.push(("status_wm_alive", json_bool(&status, "wmAlive")));
    checks.push(("status_socket_owned", json_bool(&status, "socketOwned")));
    checks.push((
        "unauthenticated_client_refused",
        x11::auth_enforced(&tools, &manifest.display),
    ));

    // PID-reuse guard: a manifest with the right pid but a wrong start tick must
    // never be signalled, and must not take the live server down.
    let guard_root = state_dir.join("guard");
    state::private_dir(&guard_root)?;
    let guard_auth = state::auth_path(&guard_root);
    state::write_auth(&guard_auth)?;
    let guard = Manifest {
        display: manifest.display.clone(),
        xauthority_path: guard_auth,
        xvfb_pid: manifest.xvfb_pid,
        xvfb_start_ticks: manifest.xvfb_start_ticks.wrapping_add(1),
        wm_pid: 0,
        wm_start_ticks: 0,
        screen: manifest.screen.clone(),
        window_manager: "none".to_string(),
        auth_enforced: true,
        socket_dev: None,
        socket_ino: None,
    };
    state::write_manifest(&guard_root, &guard)?;
    let guard_stop = run::stop(&guard_root)?;
    let guard_json = Json::parse(&guard_stop).map_err(|e| e.to_string())?;
    let skipped = guard_json
        .get("skippedPids")
        .and_then(|v| match v {
            Json::Arr(items) => Some(items.iter().any(|i| i.as_u32() == Some(manifest.xvfb_pid))),
            _ => None,
        })
        .unwrap_or(false);
    checks.push(("pid_reuse_guard_skips", skipped));
    checks.push((
        "pid_reuse_guard_keeps_server",
        proc::owned(manifest.xvfb_pid, &tools.xvfb, manifest.xvfb_start_ticks),
    ));
    let _ = fs::remove_dir_all(&guard_root);

    let stopped = run::stop(state_dir)?;
    checks.push((
        "stop_reports_stopped",
        json_bool(&stopped, "stopped") && json_bool(&stopped, "stateRemoved"),
    ));
    checks.push((
        "stop_leaves_no_socket",
        json_bool(&stopped, "socketRemoved")
            && !socket_for(&manifest.display).exists()
            && matches!(
                Json::parse(&stopped)
                    .ok()
                    .and_then(|j| j
                        .get("socketCleanup")
                        .and_then(Json::as_str)
                        .map(str::to_string))
                    .as_deref(),
                Some("removed") | Some("absent")
            ),
    ));
    checks.push((
        "socket_identity_recorded",
        manifest.socket_dev.is_some() && manifest.socket_ino.is_some(),
    ));
    checks.push((
        "processes_gone",
        !proc::alive(manifest.xvfb_pid) && (manifest.wm_pid == 0 || !proc::alive(manifest.wm_pid)),
    ));

    let ok = checks.iter().all(|(_, v)| *v);
    let mut out = String::from("{");
    crate::json::str_field(&mut out, "schema", state::SCHEMA, true);
    crate::json::bool_field(&mut out, "ok", ok, true);
    out.push_str("\"checks\":{");
    out.push_str(
        &checks
            .iter()
            .map(|(k, v)| format!("\"{}\":{}", k, v))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push_str("},");
    crate::json::str_field(&mut out, "display", &manifest.display, false);
    out.push('}');
    Ok(out)
}
