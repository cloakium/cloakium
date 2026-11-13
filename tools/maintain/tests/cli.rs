//! Command-line contract: help text, root discovery and refusal messages.

mod support;

use std::fs;
use std::process::Command;

use cloakium_maintain::util;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_cloakium-maintain")
}

fn checkout() -> (tempfile::TempDir, std::path::PathBuf) {
    let (directory, root) = support::temp_root();
    fs::write(root.join("flake.nix"), "{ outputs = _: { }; }\n").expect("flake.nix");
    (directory, root)
}

#[test]
fn help_lists_every_subcommand_and_workflow_outputs() {
    let output = Command::new(binary())
        .arg("--help")
        .output()
        .expect("run --help");
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    for expected in [
        "update",
        "validate-update",
        "release",
        "sign-release",
        "--unsigned",
        "$GITHUB_OUTPUT",
        "never printed",
    ] {
        assert!(text.contains(expected), "{expected} missing: {text}");
    }
}

#[test]
fn sign_release_help_documents_the_trusted_flow() {
    let output = Command::new(binary())
        .args(["sign-release", "--help"])
        .output()
        .expect("run sign-release --help");
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    for flag in [
        "--input",
        "--revision",
        "--signing-key",
        "--public-key",
        "--output",
    ] {
        assert!(text.contains(flag), "{flag} is undocumented: {text}");
    }
}

#[test]
fn validate_update_help_documents_both_roots() {
    let output = Command::new(binary())
        .args(["validate-update", "--help"])
        .output()
        .expect("run validate-update --help");
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("--base"), "{text}");
    assert!(text.contains("--candidate"), "{text}");
}

#[test]
fn update_help_documents_its_options() {
    let output = Command::new(binary())
        .args(["update", "--help"])
        .output()
        .expect("run update --help");
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("--root"), "{text}");
    assert!(text.contains("--refresh-toolchain"), "{text}");
    assert!(text.contains("flake.nix"), "{text}");
}

#[test]
fn release_help_documents_every_option() {
    let output = Command::new(binary())
        .args(["release", "--help"])
        .output()
        .expect("run release --help");
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    for flag in [
        "--revision",
        "--root",
        "--output",
        "--signing-key",
        "--public-key",
        "--evidence",
        "--build",
        "--cores",
        "--build-timeout",
    ] {
        assert!(text.contains(flag), "{flag} is undocumented: {text}");
    }
    assert!(text.contains("14400"), "{text}");
    assert!(text.contains("never printed"), "{text}");
}

#[test]
fn release_requires_either_a_signing_key_or_unsigned() {
    let (_directory, root) = checkout();
    let output = Command::new(binary())
        .args([
            "release",
            "--revision",
            "0123456789abcdef0123456789abcdef01234567",
            "--root",
            root.to_str().expect("path"),
        ])
        .output()
        .expect("run release");
    assert!(!output.status.success());
    let text = String::from_utf8_lossy(&output.stderr);
    assert!(text.contains("--signing-key"), "{text}");
}

#[test]
fn unsigned_conflicts_with_a_signing_key() {
    let (_directory, root) = checkout();
    let output = Command::new(binary())
        .args([
            "release",
            "--unsigned",
            "--revision",
            "0123456789abcdef0123456789abcdef01234567",
            "--signing-key",
            root.join("cache.key").to_str().expect("path"),
            "--root",
            root.to_str().expect("path"),
        ])
        .output()
        .expect("run release");
    assert!(!output.status.success());
    let text = String::from_utf8_lossy(&output.stderr);
    assert!(
        text.contains("cannot be used with") || text.contains("--unsigned"),
        "{text}"
    );
}

#[test]
fn running_without_a_subcommand_prints_usage_and_fails() {
    let output = Command::new(binary()).output().expect("run");
    assert!(!output.status.success());
    let text = String::from_utf8_lossy(&output.stderr);
    assert!(text.contains("Usage"), "{text}");
}

#[test]
fn release_refuses_a_short_revision() {
    let (_directory, root) = checkout();
    let output = Command::new(binary())
        .args([
            "release",
            "--revision",
            "abc",
            "--signing-key",
            root.join("cache.key").to_str().expect("path"),
            "--root",
            root.to_str().expect("path"),
        ])
        .output()
        .expect("run release");
    assert!(!output.status.success());
    let text = String::from_utf8_lossy(&output.stderr);
    assert!(text.contains("--revision"), "{text}");
}

#[test]
fn update_names_the_missing_lock_file() {
    let (_directory, root) = checkout();
    let output = Command::new(binary())
        .args(["update", "--root", root.to_str().expect("path")])
        .output()
        .expect("run update");
    assert!(!output.status.success());
    let text = String::from_utf8_lossy(&output.stderr);
    assert!(text.contains("flake.lock"), "{text}");
    assert!(text.contains("--root"), "{text}");
}

#[test]
fn root_discovery_walks_up_from_a_nested_directory() {
    let (_directory, root) = checkout();
    let nested = root.join("tools/maintain");
    fs::create_dir_all(&nested).expect("nested directory");

    let discovered = util::discover_root_from(&nested).expect("discover root");
    assert_eq!(discovered, root);
}

#[test]
fn root_discovery_reports_a_missing_checkout() {
    let (_directory, root) = support::temp_root();
    let error = util::discover_root_from(&root).expect_err("no checkout");
    assert!(format!("{error:#}").contains("flake.nix"), "{error:#}");
}

#[test]
fn an_explicit_root_must_be_a_checkout() {
    let (_directory, root) = support::temp_root();
    let error = util::resolve_root(Some(&root)).expect_err("not a checkout");
    assert!(
        format!("{error:#}").contains("not a Cloakium checkout"),
        "{error:#}"
    );

    let (_directory, root) = checkout();
    assert_eq!(
        util::resolve_root(Some(&root)).expect("checkout"),
        root.canonicalize().expect("canonical")
    );
}

#[test]
fn the_output_directory_defaults_to_the_checkout() {
    let (_directory, root) = support::temp_root();
    assert_eq!(
        cloakium_maintain::release::default_output(&root),
        root.join("artifacts/release")
    );
}

#[test]
fn paths_are_resolved_against_the_working_directory() {
    let (_directory, root) = support::temp_root();
    let original = std::env::current_dir().expect("cwd");
    let absolute = util::absolute(&root.join("artifacts/release")).expect("absolute");
    assert!(absolute.is_absolute());
    assert_eq!(absolute, root.join("artifacts/release"));
    assert_eq!(std::env::current_dir().expect("cwd"), original);
}
