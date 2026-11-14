//! Behaviour tests for `cloakium-maintain update` refresh, repair and failure
//! paths.

mod support;

use anyhow::bail;
use std::fs;

use anyhow::Result;
use cloakium_maintain::command::{Command, MockRunner, Output};
use cloakium_maintain::report::Reporter;
use cloakium_maintain::update::prepare;
use serde_json::json;

use support::update::{fixture, older_fixture, options, BUNDLED_CHROMIUM, CHROMIUM};
use support::{args_start_with, is_command, ok, read_json, write_json, write_npm_tarball};

#[test]
fn unchanged_release_restores_toolchain_lock() {
    let (_directory, root) = support::temp_root();
    fixture(&root);
    let lock = root.join("flake.lock");
    let mut runner = MockRunner::new(move |command: &Command| -> Result<Output> {
        if args_start_with(command, &["flake", "update"]) {
            fs::write(&lock, "new-lock").expect("update lock");
        }
        Ok(ok(if command.program == "npm" {
            "1.65.0"
        } else {
            CHROMIUM
        }))
    });
    let outputs = root.join("github-output");
    let reporter = Reporter::new(Some(outputs.clone()), false);

    let outcome = prepare(&options(&root, false), &mut runner, &reporter).expect("prepare");

    assert!(!outcome.changed);
    assert_eq!(
        fs::read_to_string(root.join("flake.lock")).expect("read lock"),
        "old-lock"
    );
    let emitted = fs::read_to_string(outputs).expect("outputs");
    assert!(emitted.contains("changed=false"), "{emitted}");
    assert!(emitted.contains("playwright=1.65.0"), "{emitted}");
}

#[test]
fn failed_update_is_not_reported_as_success() {
    let (_directory, root) = support::temp_root();
    fixture(&root);
    let mut runner = MockRunner::new(|command: &Command| -> Result<Output> {
        if args_start_with(command, &["flake", "update"]) {
            bail!("upstream unavailable");
        }
        Ok(ok(if command.program == "npm" {
            "1.65.0"
        } else {
            CHROMIUM
        }))
    });

    let error =
        prepare(&options(&root, false), &mut runner, &Reporter::silent()).expect_err("must fail");
    assert!(format!("{error:#}").contains("upstream unavailable"));
}

#[test]
fn refresh_toolchain_commits_a_changed_lock() {
    let (_directory, root) = support::temp_root();
    fixture(&root);
    let lock = root.join("flake.lock");
    let mut runner = MockRunner::new(move |command: &Command| -> Result<Output> {
        if args_start_with(command, &["flake", "update"]) {
            fs::write(&lock, "new-lock").expect("update lock");
        }
        Ok(ok(if command.program == "npm" {
            "1.65.0"
        } else {
            CHROMIUM
        }))
    });

    let outcome =
        prepare(&options(&root, true), &mut runner, &Reporter::silent()).expect("prepare");

    assert!(outcome.changed);
    assert_eq!(
        fs::read_to_string(root.join("flake.lock")).expect("read lock"),
        "new-lock"
    );
}

#[test]
fn refresh_toolchain_without_a_lock_change_stays_unchanged() {
    let (_directory, root) = support::temp_root();
    fixture(&root);
    let mut runner = MockRunner::new(|command: &Command| -> Result<Output> {
        Ok(ok(if command.program == "npm" {
            "1.65.0"
        } else {
            CHROMIUM
        }))
    });

    let outcome =
        prepare(&options(&root, true), &mut runner, &Reporter::silent()).expect("prepare");

    assert!(!outcome.changed);
}

#[test]
fn an_invalid_npm_dependency_hash_is_rejected() {
    let (_directory, root) = support::temp_root();
    older_fixture(&root);
    let archive = root.join("playwright-core-1.65.0.tgz");
    write_npm_tarball(
        &archive,
        &json!({"browsers": [{"name": "chromium", "revision": 1248, "browserVersion": BUNDLED_CHROMIUM}]}),
    );
    let archive_path = archive.to_string_lossy().into_owned();
    let mut runner = MockRunner::new(move |command: &Command| -> Result<Output> {
        if is_command(command, "nix", &["store", "prefetch-file"]) {
            return Ok(ok(
                &json!({"hash": "sha256-upstream=", "storePath": archive_path}).to_string(),
            ));
        }
        if is_command(command, "nix", &["run"]) {
            return Ok(ok("not-a-hash"));
        }
        Ok(ok(if command.program == "npm" {
            "1.65.0"
        } else {
            CHROMIUM
        }))
    });

    let error = prepare(&options(&root, false), &mut runner, &Reporter::silent())
        .expect_err("invalid hash");
    assert!(
        format!("{error:#}").contains("invalid npm dependency hash"),
        "{error:#}"
    );
}

#[test]
fn prefetch_without_a_store_path_is_rejected() {
    let (_directory, root) = support::temp_root();
    older_fixture(&root);
    let mut runner = MockRunner::new(|command: &Command| -> Result<Output> {
        if is_command(command, "nix", &["store", "prefetch-file"]) {
            return Ok(ok(&json!({"hash": "sha256-upstream="}).to_string()));
        }
        Ok(ok(if command.program == "npm" {
            "1.65.0"
        } else {
            CHROMIUM
        }))
    });

    let error = prepare(&options(&root, false), &mut runner, &Reporter::silent())
        .expect_err("missing store path");
    assert!(format!("{error:#}").contains("storePath"), "{error:#}");
}

#[test]
fn an_empty_chromium_version_is_rejected() {
    let (_directory, root) = support::temp_root();
    fixture(&root);
    let mut runner = MockRunner::new(|command: &Command| -> Result<Output> {
        Ok(ok(if command.program == "npm" {
            "1.65.0"
        } else {
            ""
        }))
    });

    let error = prepare(&options(&root, false), &mut runner, &Reporter::silent())
        .expect_err("empty chromium version");
    assert!(format!("{error:#}").contains("empty value"), "{error:#}");
}

#[test]
fn a_missing_flake_lock_names_the_root() {
    let (_directory, root) = support::temp_root();
    let mut runner = MockRunner::new(|_: &Command| -> Result<Output> { Ok(ok("")) });

    let error = prepare(&options(&root, false), &mut runner, &Reporter::silent())
        .expect_err("missing flake.lock");
    assert!(format!("{error:#}").contains("--root"), "{error:#}");
}

#[test]
fn a_missing_native_chromium_pin_is_repaired() {
    let (_directory, root) = support::temp_root();
    fixture(&root);
    // The driver agent wrote only the Playwright side of the metadata.
    write_json(
        &root.join("upstream.json"),
        &json!({"playwright": {"version": "1.65.0", "chromiumVersion": BUNDLED_CHROMIUM}}),
    );
    let mut runner = MockRunner::new(|command: &Command| -> Result<Output> {
        Ok(ok(if command.program == "npm" {
            "1.65.0"
        } else {
            CHROMIUM
        }))
    });
    let outputs = root.join("github-output");
    let reporter = Reporter::new(Some(outputs.clone()), false);

    let outcome = prepare(&options(&root, false), &mut runner, &reporter).expect("prepare");

    assert!(outcome.changed, "a missing native pin is a real change");
    let metadata = read_json(&root.join("upstream.json"));
    assert_eq!(metadata["chromium"]["version"], CHROMIUM);
    assert_eq!(metadata["playwright"]["version"], "1.65.0");
    assert_eq!(metadata["playwright"]["chromiumVersion"], BUNDLED_CHROMIUM);
    let emitted = fs::read_to_string(outputs).expect("outputs");
    assert!(emitted.contains("changed=true"), "{emitted}");
}

#[test]
fn a_stale_native_chromium_pin_is_repaired() {
    let (_directory, root) = support::temp_root();
    fixture(&root);
    write_json(
        &root.join("upstream.json"),
        &json!({
            "playwright": {"version": "1.65.0", "chromiumVersion": BUNDLED_CHROMIUM},
            "chromium": {"version": "156.0.8078.4", "revision": 1200}
        }),
    );
    let mut runner = MockRunner::new(|command: &Command| -> Result<Output> {
        Ok(ok(if command.program == "npm" {
            "1.65.0"
        } else {
            CHROMIUM
        }))
    });

    let outcome =
        prepare(&options(&root, false), &mut runner, &Reporter::silent()).expect("prepare");

    assert!(outcome.changed, "a stale native pin is a real change");
    let metadata = read_json(&root.join("upstream.json"));
    assert_eq!(metadata["chromium"]["version"], CHROMIUM);
    assert_eq!(
        metadata["chromium"]["revision"], 1200,
        "unrelated metadata must be preserved"
    );
}

#[test]
fn a_newer_bundled_chromium_is_prepared_without_a_major_cap() {
    let (_directory, root) = support::temp_root();
    older_fixture(&root);
    let archive = root.join("playwright-core-1.65.1.tgz");
    write_npm_tarball(
        &archive,
        &json!({"browsers": [{"name": "chromium", "revision": 1400, "browserVersion": "159.0.8154.6"}]}),
    );
    let archive_path = archive.to_string_lossy().into_owned();
    let mut runner = MockRunner::new(move |command: &Command| -> Result<Output> {
        if is_command(command, "nix", &["store", "prefetch-file"]) {
            return Ok(ok(
                &json!({"hash": "sha256-upstream=", "storePath": archive_path}).to_string(),
            ));
        }
        if is_command(command, "nix", &["run"]) {
            return Ok(ok(&format!("sha256-{}=", "B".repeat(43))));
        }
        Ok(ok(if command.program == "npm" {
            "1.65.1"
        } else {
            CHROMIUM
        }))
    });

    let outcome = prepare(&options(&root, false), &mut runner, &Reporter::silent())
        .expect("a two-major CfT jump must not block a candidate");

    assert!(outcome.changed);
    assert_eq!(outcome.playwright, "1.65.1");
    let metadata = read_json(&root.join("upstream.json"));
    assert_eq!(metadata["playwright"]["version"], "1.65.1");
    assert_eq!(metadata["playwright"]["chromiumVersion"], "159.0.8154.6");
    assert_eq!(
        metadata["chromium"]["version"], CHROMIUM,
        "the native pin stays exactly what the flake builds"
    );
}
