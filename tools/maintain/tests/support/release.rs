//! Shared fixture for the `release` test suites.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use cloakium_maintain::command::{Command, MockRunner, Output};
use cloakium_maintain::release::{ReleaseOptions, DEFAULT_CORES};
use serde_json::json;

use super::{is_command, ok, write_json};

pub const REVISION: &str = "0123456789abcdef0123456789abcdef01234567";
pub const CHROMIUM: &str = "157.0.8103.50";
pub const PLAYWRIGHT: &str = "1.65.0";
/// The CfT major `playwright-core` bundles (one newer than the native build).
pub const BUNDLED_CHROMIUM: &str = "158.0.8127.18";

pub struct Fixture {
    pub _directory: tempfile::TempDir,
    pub root: PathBuf,
    pub store: PathBuf,
    pub evidence: PathBuf,
    pub public_key: PathBuf,
    pub output: PathBuf,
    pub signing_key: PathBuf,
}

pub fn fixture() -> Fixture {
    let (directory, root) = super::temp_root();
    let store = root.join("store");
    fs::create_dir_all(store.join("browser/lib/node_modules/@cloakium/browser"))
        .expect("browser package directory");
    fs::create_dir_all(store.join("playwright/lib/node_modules/playwright-core"))
        .expect("playwright package directory");
    fs::create_dir_all(store.join("chromium")).expect("chromium output");

    write_json(
        &root.join("upstream.json"),
        &json!({
            "playwright": {"version": PLAYWRIGHT, "chromiumVersion": BUNDLED_CHROMIUM, "url": "https://example.test/pw.tgz", "hash": "sha256-x"},
            "chromium": {"version": CHROMIUM}
        }),
    );
    write_json(
        &root.join("package.json"),
        &json!({"name": "@cloakium/browser", "version": "0.1.0"}),
    );
    write_json(
        &root.join("flake.lock"),
        &json!({
            "nodes": {
                "nixpkgs": {"locked": {"rev": "0123456789abcdef0123456789abcdef01234567", "narHash": "sha256-lock", "lastModified": 1}},
                "root": {"inputs": {"nixpkgs": "nixpkgs"}}
            },
            "root": "root",
            "version": 7
        }),
    );
    fs::create_dir_all(root.join("patches/nested")).expect("patches");
    fs::write(root.join("patches/a.patch"), "first patch\n").expect("patch");
    fs::write(root.join("patches/nested/b.patch"), "second patch\n").expect("patch");
    fs::write(root.join("patches/ignored.txt"), "not a patch\n").expect("file");

    let evidence = root.join("verification.json");
    fs::write(&evidence, "{\"passed\": true}\n").expect("evidence");
    let public_key = root.join("cache-public-key.txt");
    fs::write(&public_key, "cloakium-maintain-test:AAAA\n").expect("public key");
    let signing_key = root.join("cache.key");
    fs::write(&signing_key, "not printed\n").expect("signing key");

    Fixture {
        root: root.clone(),
        store,
        evidence,
        public_key,
        output: root.join("artifacts/release"),
        signing_key,
        _directory: directory,
    }
}

pub fn options(fixture: &Fixture) -> ReleaseOptions {
    ReleaseOptions {
        root: fixture.root.clone(),
        revision: REVISION.to_string(),
        output: fixture.output.clone(),
        signing_key: Some(fixture.signing_key.clone()),
        unsigned: false,
        public_key: Some(fixture.public_key.clone()),
        evidence: Some(fixture.evidence.clone()),
        build: false,
        cores: DEFAULT_CORES,
        ..ReleaseOptions::default()
    }
}

pub fn unsigned_options(fixture: &Fixture) -> ReleaseOptions {
    ReleaseOptions {
        signing_key: None,
        unsigned: true,
        ..options(fixture)
    }
}

/// What the mocked `nix copy` writes into the destination cache.
pub fn write_staged_cache(destination: &Path, signed: bool) {
    let nar = destination.join("nar");
    fs::create_dir_all(&nar).expect("nar directory");
    fs::write(nar.join("first.nar.xz"), b"first").expect("nar");
    fs::write(nar.join("second.nar.xz"), b"second").expect("nar");
    let signature = if signed {
        "Sig: cloakium-maintain-test:c2ln\n"
    } else {
        ""
    };
    fs::write(
        destination.join("first.narinfo"),
        format!("StorePath: /nix/store/aaa-first\nURL: nar/first.nar.xz\nNarHash: sha256:first\n{signature}"),
    )
    .expect("narinfo");
    fs::write(
        destination.join("second.narinfo"),
        format!("StorePath: /nix/store/bbb-second\nURL: nar/second.nar.xz\nNarHash: sha256:second\n{signature}"),
    )
    .expect("narinfo");
    fs::write(destination.join("nix-cache-info"), "StoreDir: /nix/store\n").expect("cache info");
}

pub fn release_runner(fixture: &Fixture) -> MockRunner<impl FnMut(&Command) -> Result<Output>> {
    let chromium_out = fixture.store.join("chromium").display().to_string();
    let playwright_out = fixture.store.join("playwright").display().to_string();
    let browser_out = fixture.store.join("browser").display().to_string();
    let playwright_lib = fixture
        .store
        .join("playwright/lib/node_modules/playwright-core")
        .display()
        .to_string();
    let closure =
        json!({"/nix/store/aaa-first": {"narHash": "sha256:first", "signatures": []}}).to_string();

    MockRunner::new(move |command: &Command| -> Result<Output> {
        if command.program == "npm" {
            let destination = command
                .args
                .iter()
                .position(|arg| arg == "--pack-destination")
                .map(|index| command.args[index + 1].clone())
                .expect("--pack-destination");
            let source = command.args.last().expect("package directory");
            let name = if source.contains("@cloakium/browser") {
                "cloakium-browser-0.1.0.tgz"
            } else {
                "playwright-core-1.65.0.tgz"
            };
            fs::write(Path::new(&destination).join(name), name.as_bytes()).expect("tarball");
            return Ok(ok(&json!([{"filename": name, "size": 12}]).to_string()));
        }
        if is_command(command, "nix", &["copy"]) {
            let destination = command.args[2]
                .strip_prefix("file://")
                .and_then(|rest| rest.split('?').next())
                .expect("destination");
            write_staged_cache(Path::new(destination), true);
            return Ok(ok(""));
        }
        if is_command(command, "nix", &["path-info"]) {
            return Ok(ok(&closure));
        }
        if is_command(command, "nix", &["eval"]) {
            let expression = command.args.last().expect("expression");
            let value = if expression.ends_with("builtins.currentSystem") {
                "x86_64-linux"
            } else if expression.ends_with("#chromium.version") {
                CHROMIUM
            } else if expression.ends_with("#playwright.libPath") {
                return Ok(ok(&playwright_lib));
            } else if expression.ends_with(".chromium.outPath") {
                return Ok(ok(&chromium_out));
            } else if expression.ends_with(".playwright.outPath") {
                return Ok(ok(&playwright_out));
            } else if expression.ends_with(".browser.outPath") {
                return Ok(ok(&browser_out));
            } else {
                bail!("unexpected nix eval: {expression}");
            };
            return Ok(ok(value));
        }
        Ok(ok(""))
    })
}
