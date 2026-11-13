//! Shared fixture for the validate-update test suites.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use cloakium_maintain::report::Reporter;
use cloakium_maintain::validate_update::{prepare, ValidateUpdateOptions};
use serde_json::{json, Value};

use super::{read_json, write_json};

pub const OLD_PLAYWRIGHT: &str = "1.64.0";
pub const NEW_PLAYWRIGHT: &str = "1.65.0";
pub const CHROMIUM: &str = "157.0.8103.50";
pub const BUNDLED_CHROMIUM: &str = "158.0.8127.18";
pub const OLD_LOCK_REV: &str = "1111111111111111111111111111111111111111";
pub const NEW_LOCK_REV: &str = "2222222222222222222222222222222222222222";

pub fn npm_hash(seed: char) -> String {
    format!("\"sha256-{}{}=\"\n", seed, seed.to_string().repeat(42))
}

pub fn lock_file(rev: &str) -> Value {
    json!({
        "nodes": {
            "nixpkgs": {
                "locked": {
                    "lastModified": if rev == OLD_LOCK_REV { 1 } else { 2 },
                    "narHash": if rev == OLD_LOCK_REV { "sha256-old" } else { "sha256-new" },
                    "owner": "NixOS",
                    "repo": "nixpkgs",
                    "rev": rev,
                    "type": "github"
                },
                "original": {
                    "owner": "NixOS",
                    "ref": "nixos-unstable",
                    "repo": "nixpkgs",
                    "type": "github"
                }
            },
            "root": {"inputs": {"nixpkgs": "nixpkgs"}}
        },
        "root": "root",
        "version": 7
    })
}

pub fn upstream_file(playwright: &str) -> Value {
    json!({
        "playwright": {
            "version": playwright,
            "url": format!("https://registry.npmjs.org/playwright-core/-/playwright-core-{playwright}.tgz"),
            "hash": format!("sha256-{}=", "A".repeat(43)),
            "chromiumVersion": BUNDLED_CHROMIUM,
            "browserRevision": "1254"
        },
        "chromium": {"version": CHROMIUM}
    })
}

pub fn package_file(playwright: &str) -> Value {
    json!({
        "name": "@cloakium/browser",
        "version": "0.1.0",
        "scripts": {"test": "node tests/run.mjs", "build": "node scripts/build.mjs"},
        "devDependencies": {
            "@types/node": "26.6.6",
            "playwright-core": playwright,
            "typescript": "7.0.2"
        },
        "peerDependencies": {"playwright-core": ">=1.64.1 <1.66.0"}
    })
}

pub fn lock_file_json(playwright: &str) -> Value {
    json!({
        "name": "@cloakium/browser",
        "version": "0.1.0",
        "lockfileVersion": 3,
        "requires": true,
        "packages": {
            "": {
                "name": "@cloakium/browser",
                "version": "0.1.0",
                "devDependencies": {
                    "@types/node": "26.6.6",
                    "playwright-core": playwright,
                    "typescript": "7.0.2"
                }
            },
            "node_modules/@types/node": {"version": "26.6.6", "dev": true},
            "node_modules/playwright-core": {
                "version": playwright,
                "resolved": format!("https://registry.npmjs.org/playwright-core/-/playwright-core-{playwright}.tgz"),
                "integrity": "sha512-PLACEHOLDER",
                "dev": true
            },
            "node_modules/typescript": {"version": "7.0.2", "dev": true}
        }
    })
}

pub fn write_tree(root: &Path, playwright: &str, lock_rev: &str, hash_seed: char) {
    fs::create_dir_all(root.join("nix")).expect("nix directory");
    write_json(&root.join("flake.lock"), &lock_file(lock_rev));
    write_json(&root.join("upstream.json"), &upstream_file(playwright));
    write_json(&root.join("package.json"), &package_file(playwright));
    write_json(&root.join("package-lock.json"), &lock_file_json(playwright));
    fs::write(root.join("nix/npm-deps-hash.nix"), npm_hash(hash_seed)).expect("npm hash");
}

pub struct Trees {
    pub _directory: tempfile::TempDir,
    pub base: PathBuf,
    pub candidate: PathBuf,
}

pub fn new_trees() -> Trees {
    let (directory, root) = super::temp_root();
    let base = root.join("base");
    let candidate = root.join("candidate");
    write_tree(&base, OLD_PLAYWRIGHT, OLD_LOCK_REV, 'A');
    write_tree(&candidate, NEW_PLAYWRIGHT, NEW_LOCK_REV, 'B');
    Trees {
        _directory: directory,
        base,
        candidate,
    }
}

pub fn run(
    base: &Path,
    candidate: &Path,
) -> Result<cloakium_maintain::validate_update::ValidateUpdateOutcome> {
    prepare(
        &ValidateUpdateOptions {
            base: base.to_path_buf(),
            candidate: candidate.to_path_buf(),
        },
        &Reporter::silent(),
    )
}

pub fn expect_failure(trees: &Trees, needle: &str) {
    let error = run(&trees.base, &trees.candidate).expect_err("validation must fail");
    let message = format!("{error:#}");
    assert!(message.contains(needle), "expected {needle:?} in {message}");
}

pub fn edit_json(path: &Path, mutate: impl FnOnce(&mut Value)) {
    let mut value = read_json(path);
    mutate(&mut value);
    write_json(path, &value);
}

/// Turn the trees into full checkouts, which is what `--candidate .` sees.
pub fn as_checkout(trees: &Trees) {
    for root in [&trees.base, &trees.candidate] {
        fs::write(root.join("flake.nix"), "{ outputs = _: { }; }\n").expect("flake.nix");
        fs::create_dir_all(root.join("src")).expect("src");
        fs::write(root.join("src/app.ts"), "export {};\n").expect("source");
    }
}

/// The build outputs a real workspace accumulates: GC-root symlinks,
/// `node_modules` link farms and staged artifacts.
pub fn add_build_outputs(root: &Path) {
    fs::create_dir_all(root.join("node_modules/.bin")).expect("node_modules/.bin");
    fs::write(root.join("node_modules/.bin/tsc-real"), b"#!/bin/sh\n").expect("bin");
    std::os::unix::fs::symlink("tsc-real", root.join("node_modules/.bin/tsc"))
        .expect("node_modules symlink");
    std::os::unix::fs::symlink(
        "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-chromium-patch-check",
        root.join("result-patch-check"),
    )
    .expect("result GC root");
    fs::create_dir_all(root.join("artifacts/release")).expect("artifacts");
    fs::write(root.join("artifacts/release/manifest.json"), "{}\n").expect("artifact");
    fs::create_dir_all(root.join("dist")).expect("dist");
    fs::write(root.join("dist/index.js"), "export {};\n").expect("build output");
}
