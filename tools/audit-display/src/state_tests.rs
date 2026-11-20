//! Unit tests for the state directory and manifest rules. Pulled out of
//! `state.rs` so that file stays small; included as `mod tests`.

use crate::state::*;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static SEQ: AtomicU32 = AtomicU32::new(0);

struct Temp(PathBuf);

impl Temp {
    fn new(name: &str) -> Temp {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("clad-{}-{}-{}", name, std::process::id(), n));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        Temp(p)
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn manifest(root: &Path) -> Manifest {
    Manifest {
        display: ":7".into(),
        xauthority_path: auth_path(root),
        xvfb_pid: 1234,
        xvfb_start_ticks: 99,
        wm_pid: 1235,
        wm_start_ticks: 100,
        screen: Screen {
            width: 1920,
            height: 1080,
            depth: 24,
            dpi: 96,
        },
        window_manager: "openbox".into(),
        auth_enforced: true,
        socket_dev: None,
        socket_ino: None,
    }
}

fn parse_manifest(root: &Path, text: &str) -> Result<Manifest, String> {
    Manifest::from_json(root, &crate::json::Json::parse(text)?)
}

#[test]
fn round_trips() {
    let t = Temp::new("rt");
    let m = manifest(&t.0);
    let text = m.to_json();
    let parsed = parse_manifest(&t.0, &text).unwrap();
    assert_eq!(parsed, m);
    assert!(text.contains("\"owned\":true"));
    assert!(text.contains("\"schema\":\"cloakium.audit.display/1\""));
    assert!(!text.contains("cookie"));
}

#[test]
fn rejects_foreign_or_inconsistent_manifests() {
    let t = Temp::new("reject");
    assert!(parse_manifest(&t.0, r#"{"schema":"other","owned":true}"#).is_err());
    assert!(parse_manifest(
        &t.0,
        r#"{"schema":"cloakium.audit.display/1","owned":false}"#
    )
    .is_err());
    let missing_owned = manifest(&t.0)
        .to_json()
        .replace("\"owned\":true", "\"ownedX\":true");
    assert!(parse_manifest(&t.0, &missing_owned).is_err());
    let no_auth = manifest(&t.0)
        .to_json()
        .replace("\"authEnforced\":true", "\"authEnforced\":false");
    assert!(parse_manifest(&t.0, &no_auth).is_err());
}

#[test]
fn rejects_bad_display_and_paths() {
    let t = Temp::new("fields");
    for d in ["0", ":x", "host:1", ":12345", ""] {
        let text = manifest(&t.0)
            .to_json()
            .replace("\":7\"", &format!("\"{}\"", d));
        assert!(
            parse_manifest(&t.0, &text).is_err(),
            "display {:?} should be rejected",
            d
        );
    }
    let outside = manifest(&t.0).to_json().replace(
        &auth_path(&t.0).display().to_string(),
        "/tmp/elsewhere/Xauthority",
    );
    assert!(parse_manifest(&t.0, &outside).is_err());
}

#[test]
fn ensure_dir_enforces_ownership_rules() {
    assert!(ensure_dir(Path::new("relative/path")).is_err());
    let t = Temp::new("dir");
    fs::set_permissions(&t.0, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(ensure_dir(&t.0).is_err());
    fs::set_permissions(&t.0, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(ensure_dir(&t.0).is_ok());

    let link = t.0.with_extension("link");
    let _ = fs::remove_file(&link);
    std::os::unix::fs::symlink(&t.0, &link).unwrap();
    assert!(ensure_dir(&link).is_err());
    let _ = fs::remove_file(&link);

    let fresh = t.0.join("fresh");
    ensure_dir(&fresh).unwrap();
    assert_eq!(
        fs::metadata(&fresh).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn auth_file_rules() {
    let t = Temp::new("auth");
    let p = auth_path(&t.0);
    write_auth(&p).unwrap();
    assert!(auth_file_ok(&p).is_ok());
    assert_eq!(fs::metadata(&p).unwrap().len(), 44);
    fs::set_permissions(&p, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(auth_file_ok(&p).is_err());
    fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).unwrap();
    let link = t.0.join("link-auth");
    let _ = fs::remove_file(&link);
    std::os::unix::fs::symlink(&p, &link).unwrap();
    assert!(auth_file_ok(&link).is_err());
}

#[test]
fn reusable_only_when_no_manifest() {
    let t = Temp::new("reuse");
    assert!(ensure_reusable(&t.0).unwrap().is_none());
    write_manifest(&t.0, &manifest(&t.0)).unwrap();
    assert!(ensure_reusable(&t.0).unwrap().is_some());
}

#[test]
fn manifest_file_rules() {
    let t = Temp::new("mfile");
    write_manifest(&t.0, &manifest(&t.0)).unwrap();
    assert_eq!(
        fs::metadata(manifest_path(&t.0))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    fs::set_permissions(manifest_path(&t.0), fs::Permissions::from_mode(0o644)).unwrap();
    assert!(read_manifest(&t.0).is_err());
}

#[test]
fn parser_rejects_duplicate_keys() {
    let err = crate::json::Json::parse(r#"{"a":1,"a":2}"#).unwrap_err();
    assert!(err.contains("duplicate key"), "got: {}", err);
    // A manifest with a duplicated field must not be readable either.
    let t = Temp::new("dup");
    let text = manifest(&t.0)
        .to_json()
        .replace("\"owned\":true", "\"owned\":true,\"owned\":true");
    assert!(parse_manifest(&t.0, &text).is_err());
}

#[test]
fn manifest_rejects_unknown_fields() {
    let t = Temp::new("unknown");
    let text = manifest(&t.0)
        .to_json()
        .replace("\"owned\":true", "\"owned\":true,\"extra\":1");
    let err = parse_manifest(&t.0, &text).unwrap_err();
    assert!(err.contains("unknown field"), "got: {}", err);

    let screen = manifest(&t.0)
        .to_json()
        .replace("\"dpi\":96", "\"dpi\":96,\"scale\":2");
    assert!(parse_manifest(&t.0, &screen).is_err());
}

#[test]
fn auth_symlink_is_refused_and_victim_untouched() {
    let t = Temp::new("authlink");
    let victim = t.0.join("victim.txt");
    fs::write(&victim, b"do-not-touch").unwrap();
    fs::set_permissions(&victim, fs::Permissions::from_mode(0o600)).unwrap();
    let link = auth_path(&t.0);
    std::os::unix::fs::symlink(&victim, &link).unwrap();

    let err = write_auth(&link).unwrap_err();
    assert!(err.contains("symlink"), "got: {}", err);
    assert_eq!(fs::read(&victim).unwrap(), b"do-not-touch");
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn manifest_symlink_is_refused_and_victim_untouched() {
    let t = Temp::new("manlink");
    let victim = t.0.join("victim.json");
    fs::write(&victim, b"{}").unwrap();
    let link = manifest_path(&t.0);
    std::os::unix::fs::symlink(&victim, &link).unwrap();

    let err = write_manifest(&t.0, &manifest(&t.0)).unwrap_err();
    assert!(err.contains("symlink"), "got: {}", err);
    assert_eq!(fs::read(&victim).unwrap(), b"{}");
    assert!(read_manifest(&t.0).is_err());
}

#[test]
fn ancestry_alias_is_refused() {
    let t = Temp::new("ancestry");
    let real = t.0.join("real");
    fs::create_dir(&real).unwrap();
    fs::set_permissions(&real, fs::Permissions::from_mode(0o700)).unwrap();
    let alias = t.0.join("alias");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    let err = ensure_dir(&alias.join("child")).unwrap_err();
    assert!(err.contains("symlink"), "got: {}", err);
    assert!(!real.join("child").exists());
}

#[test]
fn parent_dir_escape_is_refused() {
    let t = Temp::new("escape");
    let err = ensure_dir(&t.0.join("..").join("elsewhere")).unwrap_err();
    assert!(err.contains(".."), "got: {}", err);
}

#[test]
fn round_trips_with_socket_identity() {
    let t = Temp::new("ident");
    let mut m = manifest(&t.0);
    m.socket_dev = Some(66305);
    m.socket_ino = Some(987654321);
    let text = m.to_json();
    // Every comma-separated pair must parse: this catches emission mistakes in
    // the optional trailing fields.
    let parsed = parse_manifest(&t.0, &text).unwrap();
    assert_eq!(parsed, m);
    assert!(text.contains("\"socketDev\":66305"));
    assert!(text.contains("\"socketIno\":987654321"));

    let mut only_ino = manifest(&t.0);
    only_ino.socket_ino = Some(7);
    let parsed = parse_manifest(&t.0, &only_ino.to_json()).unwrap();
    assert_eq!(parsed, only_ino);

    let mut only_dev = manifest(&t.0);
    only_dev.socket_dev = Some(7);
    let parsed = parse_manifest(&t.0, &only_dev.to_json()).unwrap();
    assert_eq!(parsed, only_dev);
}
