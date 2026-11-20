use crate::run::*;
use crate::state::{self, Manifest, Screen};
use std::os::unix::fs::PermissionsExt;

fn temp_root(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "clad-run-{}-{}-{}",
        name,
        std::process::id(),
        crate::paths::nonce()
    ));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700)).unwrap();
    p
}

#[test]
fn window_manager_names() {
    assert_eq!(Wm::parse("none").unwrap(), Wm::None);
    assert_eq!(Wm::parse("openbox").unwrap(), Wm::Openbox);
    assert!(Wm::parse("fluxbox").is_err());
    assert_eq!(Wm::None.name(), "none");
}

#[test]
fn socket_path_follows_protocol() {
    assert_eq!(socket_for(":7"), PathBuf::from("/tmp/.X11-unix/X7"));
    assert_eq!(socket_for(":102"), PathBuf::from("/tmp/.X11-unix/X102"));
}

#[test]
fn error_receipt_is_one_json_object() {
    let e = error_json("boom");
    assert!(e.starts_with('{') && e.ends_with('}'));
    let j = crate::json::Json::parse(&e).unwrap();
    assert_eq!(
        j.get("ok").and_then(crate::json::Json::as_bool),
        Some(false)
    );
    assert_eq!(
        j.get("error").and_then(crate::json::Json::as_str),
        Some("boom")
    );
}

#[test]
fn zero_geometry_is_refused_before_spawning() {
    let opts = StartOpts {
        state_dir: temp_root("zero"),
        width: 0,
        height: 1080,
        depth: 24,
        dpi: 96,
        window_manager: Wm::None,
    };
    assert!(start(&opts).is_err());
}

/// A stale manifest must never unlink a socket it does not own, even when
/// the socket path matches and the uid matches.
#[test]
fn stale_manifest_does_not_unlink_a_foreign_socket() {
    let xdir = Path::new("/tmp/.X11-unix");
    if !xdir.is_dir() || crate::x11::Tools::resolve().is_err() {
        return; // environment without an X toolchain or socket dir
    }
    // Pick a number that is very unlikely to be live, then bind a fake
    // endpoint there. Skip if it already exists.
    let number = 3000 + (std::process::id() % 1000);
    let sock = socket_for(&format!(":{}", number));
    if sock.exists() {
        return;
    }
    let listener = match std::os::unix::net::UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(_) => return,
    };
    let root = temp_root("stale-socket");
    state::write_auth(&state::auth_path(&root)).unwrap();
    let stale = Manifest {
        display: format!(":{}", number),
        xauthority_path: state::auth_path(&root),
        xvfb_pid: 4_000_000_000, // not a live pid
        xvfb_start_ticks: 1,
        wm_pid: 0,
        wm_start_ticks: 0,
        screen: Screen {
            width: 1920,
            height: 1080,
            depth: 24,
            dpi: 96,
        },
        window_manager: "none".into(),
        auth_enforced: true,
        socket_dev: None,
        socket_ino: None,
    };
    state::write_manifest(&root, &stale).unwrap();

    let receipt = stop(&root).expect("stop runs");
    assert!(
        sock.exists(),
        "foreign socket must survive a stale manifest: {}",
        receipt
    );
    let parsed = crate::json::Json::parse(&receipt).unwrap();
    assert_eq!(
        parsed
            .get("socketCleanup")
            .and_then(crate::json::Json::as_str),
        Some("unknown")
    );
    assert_eq!(
        parsed
            .get("socketRemoved")
            .and_then(crate::json::Json::as_bool),
        Some(false)
    );
    drop(listener);
    let _ = std::fs::remove_file(&sock);
    let _ = std::fs::remove_dir_all(&root);
}
