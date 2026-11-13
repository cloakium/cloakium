//! Behaviour tests for `cloakium-maintain update`: version parsing, tarball
//! metadata, the full Playwright bump and the flake reference shape.

mod support;

use anyhow::Result;
use cloakium_maintain::command::{Command, MockRunner, Output};
use cloakium_maintain::report::Reporter;
use cloakium_maintain::update::{browser_metadata, prepare, stable_version};
use serde_json::json;
use std::cell::RefCell;
use std::fs;

use support::update::{fixture, options, BUNDLED_CHROMIUM, CHROMIUM};
use support::{is_command, ok, read_json, write_json, write_npm_tarball, write_tarball_member};

#[test]
fn versions_must_be_stable() {
    assert_eq!(stable_version("1.65.0").expect("stable"), "1.65.0");
    for value in [
        "1.66.0-beta.1",
        "latest",
        "1.65",
        "1.65.0\nx=1",
        "",
        " 1.65.0",
    ] {
        assert!(
            stable_version(value).is_err(),
            "{value:?} must be rejected as unstable"
        );
    }
}

#[test]
fn chromium_release_preserves_driver_metadata() {
    let (_directory, root) = support::temp_root();
    fixture(&root);
    let versions = RefCell::new(vec!["157.0.8103.50", "157.0.8103.78"].into_iter());
    let mut runner = MockRunner::new(move |command: &Command| -> Result<Output> {
        if is_command(command, "nix", &["eval"]) {
            let next = versions.borrow_mut().next().expect("chromium version");
            return Ok(ok(next));
        }
        Ok(ok(if command.program == "npm" {
            "1.65.0"
        } else {
            ""
        }))
    });
    let reporter = Reporter::silent();

    let outcome = prepare(&options(&root, false), &mut runner, &reporter).expect("prepare");

    assert!(outcome.changed);
    let metadata = read_json(&root.join("upstream.json"));
    assert_eq!(metadata["chromium"]["version"], "157.0.8103.78");
    assert_eq!(metadata["playwright"]["version"], "1.65.0");
    assert_eq!(outcome.chromium, "157.0.8103.78");
}

#[test]
fn browser_metadata_reads_only_the_expected_member() {
    let (_directory, root) = support::temp_root();
    let archive = root.join("package.tgz");
    write_npm_tarball(
        &archive,
        &json!({"browsers": [{"name": "chromium", "revision": 1248, "browserVersion": "156.0.8078.4"}]}),
    );

    let metadata = browser_metadata(&archive).expect("metadata");

    assert_eq!(metadata.chromium_version, "156.0.8078.4");
    assert_eq!(metadata.browser_revision, "1248");
}

#[test]
fn browser_metadata_accepts_a_string_revision() {
    let (_directory, root) = support::temp_root();
    let archive = root.join("package.tgz");
    write_npm_tarball(
        &archive,
        &json!({"browsers": [{"name": "chromium", "revision": "1249", "browserVersion": "156.0.8078.4"}]}),
    );

    assert_eq!(
        browser_metadata(&archive)
            .expect("metadata")
            .browser_revision,
        "1249"
    );
}

#[test]
fn browser_metadata_rejects_bad_archives() {
    let (_directory, root) = support::temp_root();

    let missing = root.join("missing.tgz");
    write_tarball_member(&missing, "package/package.json", b"{}");
    assert!(browser_metadata(&missing)
        .expect_err("missing browsers.json")
        .to_string()
        .contains("missing browsers.json"));

    let empty = root.join("empty.tgz");
    write_npm_tarball(&empty, &json!({"browsers": []}));
    assert!(browser_metadata(&empty).is_err());

    let duplicated = root.join("duplicated.tgz");
    write_npm_tarball(
        &duplicated,
        &json!({"browsers": [
            {"name": "chromium", "revision": 1, "browserVersion": "1.0.0.0"},
            {"name": "chromium", "revision": 2, "browserVersion": "2.0.0.0"}
        ]}),
    );
    assert!(browser_metadata(&duplicated)
        .expect_err("two chromium entries")
        .to_string()
        .contains("exactly one Chromium browser entry"));

    let no_version = root.join("no-version.tgz");
    write_npm_tarball(
        &no_version,
        &json!({"browsers": [{"name": "chromium", "revision": 1}]}),
    );
    assert!(browser_metadata(&no_version).is_err());
}

#[test]
fn playwright_bump_rewrites_every_pin() {
    let (_directory, root) = support::temp_root();
    fs::create_dir(root.join("nix")).expect("nix directory");
    fs::write(root.join("flake.lock"), "old-lock").expect("flake.lock");
    write_json(
        &root.join("upstream.json"),
        &json!({
            "playwright": {"version": "1.64.0", "notes": "keep-me"},
            "chromium": {"version": "156.0.1.2", "revision": 999}
        }),
    );
    write_json(
        &root.join("package.json"),
        &json!({
            "name": "@cloakium/browser",
            "devDependencies": {"playwright-core": "1.64.0", "typescript": "7.0.2"}
        }),
    );

    let archive = root.join("playwright-core-1.65.0.tgz");
    write_npm_tarball(
        &archive,
        &json!({"browsers": [{"name": "chromium", "revision": 1248, "browserVersion": BUNDLED_CHROMIUM}]}),
    );
    let archive_path = archive.to_string_lossy().into_owned();
    let upstream_hash = format!("sha256-{}=", "A".repeat(43));
    let upstream_hash_clone = upstream_hash.clone();
    let npm_hash = format!("sha256-{}=", "B".repeat(43));
    let npm_hash_clone = npm_hash.clone();

    let mut runner = MockRunner::new(move |command: &Command| -> Result<Output> {
        if is_command(command, "nix", &["store", "prefetch-file"]) {
            return Ok(ok(
                &json!({"hash": upstream_hash_clone, "storePath": archive_path}).to_string(),
            ));
        }
        if is_command(command, "nix", &["run"]) {
            return Ok(ok(&npm_hash_clone));
        }
        if is_command(command, "nix", &["eval"]) {
            return Ok(ok(CHROMIUM));
        }
        Ok(ok(if command.program == "npm" {
            "1.65.0"
        } else {
            ""
        }))
    });
    let outputs = root.join("github-output");
    let reporter = Reporter::new(Some(outputs.clone()), false);

    let outcome = prepare(&options(&root, false), &mut runner, &reporter).expect("prepare");

    assert!(outcome.changed);
    assert_eq!(outcome.playwright, "1.65.0");
    assert_eq!(outcome.chromium, CHROMIUM);

    let metadata = read_json(&root.join("upstream.json"));
    assert_eq!(metadata["playwright"]["version"], "1.65.0");
    assert_eq!(
        metadata["playwright"]["url"],
        "https://registry.npmjs.org/playwright-core/-/playwright-core-1.65.0.tgz"
    );
    assert_eq!(metadata["playwright"]["hash"], upstream_hash);
    assert_eq!(metadata["playwright"]["chromiumVersion"], BUNDLED_CHROMIUM);
    assert_eq!(metadata["playwright"]["browserRevision"], "1248");
    assert_eq!(metadata["playwright"]["notes"], "keep-me");
    assert_eq!(metadata["chromium"]["version"], CHROMIUM);
    assert_eq!(metadata["chromium"]["revision"], 999);

    let package = read_json(&root.join("package.json"));
    assert_eq!(package["devDependencies"]["playwright-core"], "1.65.0");
    assert_eq!(package["devDependencies"]["typescript"], "7.0.2");
    assert_eq!(package["name"], "@cloakium/browser");

    let hash_file = fs::read_to_string(root.join("nix/npm-deps-hash.nix")).expect("hash file");
    assert_eq!(hash_file, format!("\"{npm_hash}\"\n"));

    let emitted = fs::read_to_string(outputs).expect("outputs");
    for expected in [
        "changed=true",
        "playwright=1.65.0",
        "chromium=157.0.8103.50",
    ] {
        assert!(emitted.contains(expected), "{emitted}");
    }

    let history = runner.rendered_history();
    let install = history
        .iter()
        .find(|entry| entry.starts_with("npm install"))
        .expect("npm install ran");
    for flag in [
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
    ] {
        assert!(install.contains(flag), "{install}");
    }
    let prefetch = history
        .iter()
        .find(|entry| entry.contains("prefetch-npm-deps"))
        .expect("prefetch-npm-deps ran");
    assert!(prefetch.contains("package-lock.json"), "{prefetch}");
}

#[test]
fn the_playwright_view_uses_the_latest_tag() {
    let (_directory, root) = support::temp_root();
    fixture(&root);
    let mut runner = MockRunner::new(|command: &Command| -> Result<Output> {
        Ok(ok(if command.program == "npm" {
            "1.65.0"
        } else {
            CHROMIUM
        }))
    });
    prepare(&options(&root, false), &mut runner, &Reporter::silent()).expect("prepare");

    let history = runner.rendered_history();
    let view = history
        .iter()
        .find(|entry| entry.starts_with("npm view"))
        .expect("npm view ran");
    assert!(view.contains("playwright-core@latest"), "{view}");
    assert!(view.contains("version"), "{view}");
    let update = history
        .iter()
        .find(|entry| entry.contains("nix flake update nixpkgs"))
        .expect("nix flake update ran");
    assert!(update.contains("--flake"), "{update}");
    let canonical = fs::canonicalize(&root).expect("canonical root");
    assert!(
        update.contains(&canonical.display().to_string()),
        "the flake reference must be the absolute root: {update}"
    );
    assert!(
        !update.contains("path:"),
        "forcing the path fetcher would copy target/ into the flake input: {update}"
    );
}
