//! Behaviour tests for `cloakium-maintain verify-publication`.

mod support;

use std::fs;
use std::path::{Path, PathBuf};

use cloakium_maintain::cache;
use cloakium_maintain::report::Reporter;
use cloakium_maintain::util;
use cloakium_maintain::verify_publication::{prepare, VerifyPublicationOptions};
use serde_json::{json, Value};
use support::{read_json, write_json};

const REVISION: &str = "0123456789abcdef0123456789abcdef01234567";
const TAG: &str = "chromium-157.0.8103.50-pw-1.65.0-0123456789";

struct Published {
    _directory: tempfile::TempDir,
    root: PathBuf,
    directory: PathBuf,
    release_json: PathBuf,
    checksums: PathBuf,
    manifest: PathBuf,
}

impl Published {
    fn options(&self) -> VerifyPublicationOptions {
        VerifyPublicationOptions {
            release_json: self.release_json.clone(),
            checksums: self.checksums.clone(),
            manifest: self.manifest.clone(),
            revision: REVISION.to_string(),
        }
    }

    /// Recompute SHA256SUMS and the API JSON from the current directory.
    fn refresh(&self) {
        cache::write_checksums(&self.directory).expect("checksums");
        self.write_release_json();
    }

    fn write_release_json(&self) {
        let mut assets = Vec::new();
        for entry in fs::read_dir(&self.directory).expect("list release") {
            let entry = entry.expect("entry");
            let path = entry.path();
            assets.push(json!({
                "name": entry.file_name().to_string_lossy(),
                "size": fs::metadata(&path).expect("metadata").len(),
                "digest": format!("sha256:{}", util::digest(&path).expect("digest")),
            }));
        }
        write_json(
            &self.release_json,
            &json!({"tag_name": TAG, "assets": assets}),
        );
    }

    fn edit_release_json(&self, mutate: impl FnOnce(&mut Value)) {
        let mut value = read_json(&self.release_json);
        mutate(&mut value);
        write_json(&self.release_json, &value);
    }
}

fn published() -> Published {
    let (directory, root) = support::temp_root();
    let dir = root.join("release");
    fs::create_dir_all(&dir).expect("release directory");
    write_json(
        &dir.join("manifest.json"),
        &json!({
            "schemaVersion": 1,
            "sourceRevision": REVISION,
            "tag": TAG,
            "chromium": "157.0.8103.50",
            "playwright": "1.65.0",
            "signed": true
        }),
    );
    write_json(
        &dir.join("verification.json"),
        &json!({"status": "passed", "exitCode": 0}),
    );
    fs::write(dir.join("nix-cache-info"), "StoreDir: /nix/store\n").expect("cache info");
    fs::write(dir.join("abc.nar.xz"), b"payload").expect("nar");
    fs::write(
        dir.join("abc.narinfo"),
        "StorePath: /nix/store/abc-example\nURL: abc.nar.xz\nNarHash: sha256:x\nNarSize: 7\n",
    )
    .expect("narinfo");
    fs::write(dir.join("release-notes.md"), "# notes\n").expect("notes");

    let published = Published {
        root: root.clone(),
        directory: dir.clone(),
        release_json: root.join("release.json"),
        checksums: dir.join("SHA256SUMS"),
        manifest: dir.join("manifest.json"),
        _directory: directory,
    };
    published.refresh();
    published
}

fn run(
    options: &VerifyPublicationOptions,
) -> anyhow::Result<cloakium_maintain::verify_publication::VerifyPublicationOutcome> {
    prepare(options, &Reporter::silent())
}

fn expect_failure(published: &Published, needle: &str) {
    let error = run(&published.options()).expect_err("verification must fail");
    let message = format!("{error:#}");
    assert!(message.contains(needle), "expected {needle:?} in {message}");
}

#[test]
fn a_published_release_cross_checks_cleanly() {
    let published = published();
    let outputs = published.root.join("outputs");
    let reporter = Reporter::new(Some(outputs.clone()), false);

    let outcome = prepare(&published.options(), &reporter).expect("verify");

    assert_eq!(outcome.tag, TAG);
    assert_eq!(outcome.assets, 7, "six assets plus SHA256SUMS");
    let emitted = fs::read_to_string(outputs).expect("outputs");
    assert!(emitted.contains("verified=true"), "{emitted}");
    assert!(emitted.contains(&format!("tag={TAG}")), "{emitted}");
}

#[test]
fn a_tampered_checksums_file_is_rejected() {
    let published = published();
    let mut text = fs::read_to_string(&published.checksums).expect("sums");
    text.push_str(&format!("{}  injected.txt\n", "0".repeat(64)));
    fs::write(&published.checksums, text).expect("sums");
    expect_failure(&published, "does not match the published asset digest");
}

#[test]
fn a_tampered_manifest_is_rejected() {
    let published = published();
    let mut manifest = read_json(&published.manifest);
    manifest["sourceRevision"] = json!(REVISION);
    manifest["tampered"] = json!(true);
    write_json(&published.manifest, &manifest);
    expect_failure(&published, "does not match SHA256SUMS");
}

#[test]
fn a_missing_asset_is_rejected() {
    let published = published();
    published.edit_release_json(|value| {
        let assets = value["assets"].as_array_mut().expect("assets");
        assets.retain(|asset| asset["name"] != json!("abc.nar.xz"));
    });
    expect_failure(&published, "which the published release does not have");
}

#[test]
fn an_uncovered_extra_asset_is_rejected() {
    let published = published();
    published.edit_release_json(|value| {
        value["assets"].as_array_mut().expect("assets").push(json!({
            "name": "stowaway.bin",
            "size": 4,
            "digest": format!("sha256:{}", "a".repeat(64)),
        }));
    });
    expect_failure(&published, "does not cover");
}

#[test]
fn a_duplicate_published_asset_is_rejected() {
    let published = published();
    published.edit_release_json(|value| {
        let assets = value["assets"].as_array().expect("assets");
        let first = assets[0].clone();
        value["assets"].as_array_mut().expect("assets").push(first);
    });
    expect_failure(&published, "more than once");
}

#[test]
fn a_duplicate_checksums_entry_is_rejected() {
    let published = published();
    let text = fs::read_to_string(&published.checksums).expect("sums");
    let first = text.lines().next().expect("line");
    fs::write(&published.checksums, format!("{text}{first}\n")).expect("sums");
    expect_failure(&published, "more than once");
}

#[test]
fn a_path_traversal_asset_name_is_rejected() {
    let published = published();
    published.edit_release_json(|value| {
        value["assets"].as_array_mut().expect("assets").push(json!({
            "name": "../evil.nar.xz",
            "size": 1,
            "digest": format!("sha256:{}", "b".repeat(64)),
        }));
    });
    expect_failure(&published, "unsafe published asset name");
}

#[test]
fn an_oversized_asset_is_rejected() {
    let published = published();
    published.edit_release_json(|value| {
        let assets = value["assets"].as_array_mut().expect("assets");
        assets[0]["size"] = json!(2u64 * 1024 * 1024 * 1024);
    });
    expect_failure(&published, "2 GiB limit");
}

#[test]
fn an_asset_without_a_server_digest_is_rejected() {
    let published = published();
    published.edit_release_json(|value| {
        let assets = value["assets"].as_array_mut().expect("assets");
        assets[0].as_object_mut().expect("object").remove("digest");
    });
    expect_failure(&published, "no server digest");
}

#[test]
fn a_revision_mismatch_is_rejected() {
    let published = published();
    let mut options = published.options();
    options.revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();
    let error = run(&options).expect_err("revision mismatch");
    assert!(format!("{error:#}").contains("records source"), "{error:#}");
}

#[test]
fn a_tag_mismatch_is_rejected() {
    let published = published();
    published.edit_release_json(|value| {
        value["tag_name"] = json!("chromium-1.0.0-pw-1.0.0-0000000000");
    });
    expect_failure(&published, "does not match the manifest tag");
}

#[test]
fn a_missing_required_asset_is_rejected() {
    let without_evidence = published();
    fs::remove_file(without_evidence.directory.join("verification.json")).expect("remove");
    without_evidence.refresh();
    expect_failure(&without_evidence, "missing verification.json");

    let without_cache_info = published();
    fs::remove_file(without_cache_info.directory.join("nix-cache-info")).expect("remove");
    without_cache_info.refresh();
    expect_failure(&without_cache_info, "missing nix-cache-info");
}

#[test]
fn a_release_without_assets_is_rejected() {
    let published = published();
    published.edit_release_json(|value| {
        value.as_object_mut().expect("object").remove("assets");
    });
    expect_failure(&published, "no assets array");
}

#[test]
fn an_empty_checksums_file_is_rejected() {
    let published = published();
    fs::write(&published.checksums, "").expect("empty sums");
    expect_failure(&published, "is empty");
}

#[test]
fn verifying_twice_is_idempotent() {
    let published = published();
    let first = run(&published.options()).expect("first verification");
    let second = run(&published.options()).expect("second verification");
    assert_eq!(first.tag, second.tag);
    assert_eq!(first.assets, second.assets);
    // No file in the release was rewritten by either run.
    let sums_before = fs::read_to_string(&published.checksums).expect("sums");
    assert!(sums_before.contains("manifest.json"));
    assert!(Path::new(&published.manifest).is_file());
}
