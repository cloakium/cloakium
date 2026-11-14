//! Guard rails for `cloakium-maintain sign-release`.
//!
//! Every case here is a staged release that must never be signed or published.

mod support;

use std::cell::RefCell;
use std::fs;
use std::rc::Rc;

use anyhow::{bail, Result};
use cloakium_maintain::cache;
use cloakium_maintain::command::{Command, MockRunner, Output};
use cloakium_maintain::report::Reporter;
use cloakium_maintain::sign_release::prepare;
use serde_json::json;
use support::sign::{expect_failure, nix32, signer, staged, PUBLIC_KEY};
use support::{is_command, ok, read_json, write_json};

#[test]
fn a_reused_output_directory_is_refused() {
    let current = staged();
    fs::create_dir(current.root.join("signed")).expect("existing output");
    let mut requested = current.options();
    requested.output = Some(current.root.join("signed"));
    expect_failure(&requested, "refuse to reuse");
}

#[test]
fn the_revision_must_match_the_manifest() {
    let current = staged();
    let mut requested = current.options();
    requested.revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string();
    expect_failure(&requested, "does not match --revision");
}

#[test]
fn an_already_signed_release_is_refused() {
    let current = staged();
    let mut manifest = current.manifest();
    manifest["signed"] = json!(true);
    write_json(&current.release.join("manifest.json"), &manifest);
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(&current.options(), "already marked signed");
}

#[test]
fn a_tampered_payload_fails_verification() {
    // Payload swapped without touching the narinfo: the compressed file no
    // longer matches FileHash.
    let current = staged();
    fs::write(current.release.join("chromium.nar"), b"tampered").expect("tamper");
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(&current.options(), "FileSize for chromium.nar");

    // The attack the signature defends against: rewrite the payload, rewrap the
    // compressed hash and refresh SHA256SUMS, but the signed NarHash still
    // disagrees with the decompressed NAR.
    let current = staged();
    let narinfo_path = current.release.join("chromium.narinfo");
    let original = fs::read_to_string(&narinfo_path).expect("narinfo");
    let payload = b"PAYLOAD FOR CHROMIUM".to_vec();
    fs::write(current.release.join("chromium.nar"), &payload).expect("tamper");
    let rewrapped = original
        .lines()
        .map(|line| {
            if line.starts_with("FileHash: ") {
                format!("FileHash: sha256:{}", nix32(&payload))
            } else if line.starts_with("FileSize: ") {
                format!("FileSize: {}", payload.len())
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&narinfo_path, format!("{rewrapped}\n")).expect("narinfo");
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(&current.options(), "NarHash for chromium.nar");
}

#[test]
fn a_digest_mismatch_in_sha256sums_is_rejected() {
    let current = staged();
    let sums = fs::read_to_string(current.release.join("SHA256SUMS")).expect("sums");
    let mut rewritten = String::new();
    for line in sums.lines() {
        let (digest, name) = line.split_once("  ").expect("two spaces");
        let digest = if name == "manifest.json" {
            "0".repeat(64)
        } else {
            digest.to_string()
        };
        rewritten.push_str(&format!("{digest}  {name}\n"));
    }
    fs::write(current.release.join("SHA256SUMS"), rewritten).expect("sums");
    expect_failure(&current.options(), "does not match SHA256SUMS");
}

#[test]
fn an_unlisted_asset_is_rejected() {
    let current = staged();
    fs::write(current.release.join("stowaway.txt"), b"extra").expect("extra asset");
    expect_failure(&current.options(), "does not cover exactly");
}

#[test]
fn a_symlinked_asset_is_rejected() {
    let current = staged();
    std::os::unix::fs::symlink(
        current.release.join("manifest.json"),
        current.release.join("manifest-link.json"),
    )
    .expect("symlink");
    expect_failure(&current.options(), "regular files");
}

#[test]
fn a_missing_narinfo_for_an_output_is_rejected() {
    let current = staged();
    fs::remove_file(current.release.join("browser.narinfo")).expect("remove narinfo");
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(&current.options(), "has no narinfo for");
}

#[test]
fn failed_evidence_is_rejected() {
    let current = staged();
    let mut evidence = read_json(&current.release.join("verification.json"));
    evidence["status"] = json!("failed");
    write_json(&current.release.join("verification.json"), &evidence);
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(&current.options(), "verification status");
}

#[test]
fn a_nonzero_exit_code_is_rejected() {
    let current = staged();
    let mut evidence = read_json(&current.release.join("verification.json"));
    evidence["exitCode"] = json!(1);
    write_json(&current.release.join("verification.json"), &evidence);
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(&current.options(), "exitCode");
}

#[test]
fn a_recorded_signal_is_rejected() {
    let current = staged();
    let mut evidence = read_json(&current.release.join("verification.json"));
    evidence["signals"] = json!(["SIGSEGV"]);
    write_json(&current.release.join("verification.json"), &evidence);
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(&current.options(), "signal");
}

#[test]
fn a_failed_check_entry_is_rejected() {
    let current = staged();
    let mut evidence = read_json(&current.release.join("verification.json"));
    evidence["checks"] = json!([{"name": "browser", "status": "failed"}]);
    write_json(&current.release.join("verification.json"), &evidence);
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(&current.options(), "did not pass");
}

#[test]
fn evidence_version_mismatch_is_rejected() {
    let current = staged();
    let mut evidence = read_json(&current.release.join("verification.json"));
    evidence["browserVersion"] = json!("156.0.0.0");
    write_json(&current.release.join("verification.json"), &evidence);
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(&current.options(), "verification recorded browser");
}

#[test]
fn a_bundled_chromium_outside_the_window_is_rejected() {
    let current = staged();
    let mut manifest = current.manifest();
    manifest["upstream"]["playwright"]["chromiumVersion"] = json!("159.0.8200.1");
    write_json(&current.release.join("manifest.json"), &manifest);
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(&current.options(), "compatibility window");
}

#[test]
fn a_native_pin_that_disagrees_with_the_actual_browser_is_rejected() {
    let current = staged();
    let mut manifest = current.manifest();
    manifest["upstream"]["chromium"]["version"] = json!("156.0.8078.4");
    write_json(&current.release.join("manifest.json"), &manifest);
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(
        &current.options(),
        "does not match the actual manifest chromium",
    );
}

#[test]
fn ambiguous_or_partial_evidence_versions_are_rejected() {
    let current = staged();
    let mut evidence = read_json(&current.release.join("verification.json"));
    evidence["browserVersion"] = json!("Chromium 157.0.8103.50 and 158.0.8127.18");
    write_json(&current.release.join("verification.json"), &evidence);
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(&current.options(), "ambiguous versions");

    let current = staged();
    let mut evidence = read_json(&current.release.join("verification.json"));
    evidence["browserVersion"] = json!("Chromium 157.0.8103");
    write_json(&current.release.join("verification.json"), &evidence);
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(&current.options(), "no 4-component version");
}

#[test]
fn a_key_that_does_not_match_the_public_key_is_rejected() {
    let current = staged();
    let mut runner = signer(
        "cloakium-test:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
        Rc::new(RefCell::new(0)),
    );
    let error = prepare(&current.options(), &mut runner, &Reporter::silent())
        .expect_err("mismatched key pair");
    assert!(
        format!("{error:#}").contains("does not derive"),
        "{error:#}"
    );
    assert!(!current.narinfo("chromium").contains("Sig:"));
}

#[test]
fn a_tampered_flake_lock_is_rejected() {
    let current = staged();
    let mut manifest = current.manifest();
    manifest["flakeLock"]["sha256"] = json!("0".repeat(64));
    write_json(&current.release.join("manifest.json"), &manifest);
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(
        &current.options(),
        "does not match manifest flakeLock.sha256",
    );
}

#[test]
fn a_wrong_tag_is_rejected() {
    let current = staged();
    let mut manifest = current.manifest();
    manifest["tag"] = json!("chromium-1.0.0-pw-1.0.0-0000000000");
    write_json(&current.release.join("manifest.json"), &manifest);
    cache::write_checksums(&current.release).expect("checksums");
    expect_failure(&current.options(), "does not match the release versions");
}

#[test]
fn a_signature_failure_aborts_before_publication() {
    let current = staged();
    let mut runner = MockRunner::new(|command: &Command| -> Result<Output> {
        if is_command(command, "nix", &["key", "convert-secret-to-public"]) {
            return Ok(ok(PUBLIC_KEY));
        }
        if is_command(command, "nix", &["store", "sign"]) {
            return Ok(ok("added 3 signatures"));
        }
        if is_command(command, "nix", &["store", "verify"]) {
            bail!("signature is not valid");
        }
        bail!("unexpected command");
    });
    let error = prepare(&current.options(), &mut runner, &Reporter::silent())
        .expect_err("verification must fail");
    assert!(format!("{error:#}").contains("signature is not valid"));
    // The staged manifest must never claim success.
    assert_eq!(current.manifest()["signed"], false);
}
