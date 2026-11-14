//! Evidence parsing: the Node producer records the browser's own `--version`
//! output (`"Chromium 157.0.8103.50"`), not a bare version string.

mod support;

use std::fs;
use std::path::PathBuf;

use cloakium_maintain::sign_validate::{recorded_version, validate_evidence, Facts};

/// Captured from the real pipeline (`artifacts/verification.json`).
const REAL_EVIDENCE: &str = include_str!("fixtures/node-verification.json");

fn facts() -> Facts {
    Facts {
        chromium: "157.0.8103.50".to_string(),
        playwright: "1.65.0".to_string(),
        tag: "chromium-157.0.8103.50-pw-1.65.0-ee40282702".to_string(),
        system: "x86_64-linux".to_string(),
        revision: "ee40282702cbac4ca96fe4cfd1e299c3eb775a87".to_string(),
        outputs: vec![
            "/nix/store/aaa-chromium".to_string(),
            "/nix/store/bbb-playwright".to_string(),
            "/nix/store/ccc-browser".to_string(),
        ],
        packages: vec![
            "cloakium-browser-0.1.0.tgz".to_string(),
            "playwright-core-1.65.0.tgz".to_string(),
        ],
    }
}

fn evidence_path(text: &str) -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().expect("tempdir");
    let path = directory.path().join("verification.json");
    fs::write(&path, text).expect("write evidence");
    (directory, path)
}

#[test]
fn the_real_node_evidence_validates() {
    let (_directory, path) = evidence_path(REAL_EVIDENCE);

    validate_evidence(&path, &facts()).expect("the Node producer's evidence must validate");
}

#[test]
fn a_different_recorded_browser_is_rejected() {
    let (_directory, path) =
        evidence_path(&REAL_EVIDENCE.replace("Chromium 157.0.8103.50", "Chromium 158.0.8127.18"));

    let error = validate_evidence(&path, &facts()).expect_err("mismatched browser");
    assert!(
        format!("{error:#}").contains("pins the native Chromium 157.0.8103.50"),
        "{error:#}"
    );
}

#[test]
fn version_parsing_accepts_cli_and_canonical_forms() {
    for text in [
        "157.0.8103.50",
        "Chromium 157.0.8103.50",
        "Chromium 157.0.8103.50 (Developer Build) (64-bit)",
        "Chromium 157.0.8103.50 (Official Build) stable",
        "  Chromium 157.0.8103.50\n",
        "Chromium 157.0.8103.50 / 157.0.8103.50",
    ] {
        assert_eq!(
            recorded_version(text, 4).expect(text),
            "157.0.8103.50",
            "{text:?}"
        );
    }
}

#[test]
fn version_parsing_rejects_ambiguous_partial_or_unrelated_text() {
    for text in [
        "Chromium 157.0.8103.50 and 158.0.8127.18",
        "157.0.8103.50.1",
        "Chromium 157.0.8103",
        "Chromium 157.0",
        "Chromium",
        "",
        "Chromium 157.0.8103.50x",
        "build 1570.8103.50",
        "157.0.8103.50 156.0.8078.4",
    ] {
        assert!(
            recorded_version(text, 4).is_err(),
            "{text:?} must be rejected"
        );
    }
}
