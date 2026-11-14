//! Selection and validation behaviour of `cloakium-maintain upload-release`.

mod support;

use std::fs;
use std::process::Command as Process;

use cloakium_maintain::upload_pace::PACE_INTERVAL;
use cloakium_maintain::upload_release::{validate_options, UploadOptions};
use support::upload::{fixture, Harness, TAG};

fn message<T: std::fmt::Debug>(result: anyhow::Result<T>) -> String {
    format!("{:#}", result.expect_err("the command must fail"))
}

#[test]
fn help_documents_the_flags_and_the_bounded_runtime() {
    let output = Process::new(env!("CARGO_BIN_EXE_cloakium-maintain"))
        .args(["upload-release", "--help"])
        .output()
        .expect("run --help");
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    for expected in [
        "--input",
        "--repository",
        "--tag",
        "--revision",
        "--timeout",
        "10800",
        "OWNER/REPO",
        "job timeout is separate",
    ] {
        assert!(
            text.contains(expected),
            "{expected} is undocumented: {text}"
        );
    }
}

#[test]
fn the_top_level_help_documents_pacing_and_resume() {
    let output = Process::new(env!("CARGO_BIN_EXE_cloakium-maintain"))
        .arg("--help")
        .output()
        .expect("run --help");
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    for expected in ["8 seconds", "GH_TOKEN", "10800", "missing or differ"] {
        assert!(
            text.contains(expected),
            "{expected} is undocumented: {text}"
        );
    }
}

#[test]
fn upload_release_is_a_documented_subcommand() {
    let output = Process::new(env!("CARGO_BIN_EXE_cloakium-maintain"))
        .arg("--help")
        .output()
        .expect("run --help");
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("upload-release"), "{text}");
    assert!(text.contains("$GITHUB_OUTPUT"), "{text}");
}

#[test]
fn a_complete_draft_is_left_untouched() {
    let mut harness = Harness::new();
    harness.complete_all_except(&[]);
    let outcome = harness.run().expect("upload");

    assert!(harness.uploads().is_empty(), "no asset may be re-uploaded");
    assert!(harness.deletes().is_empty(), "nothing may be deleted");
    assert_eq!(outcome.uploaded.len(), 0);
    assert_eq!(outcome.skipped, harness.fixture.names().len());
    assert_eq!(outcome.content_operations, 0);
    assert!(harness.sleeps().is_empty(), "no pacing is needed");
}

#[test]
fn only_missing_assets_are_uploaded() {
    let mut harness = Harness::new();
    let names = harness.fixture.names();
    let still_missing: Vec<&str> = names.iter().take(3).map(String::as_str).collect();
    harness.complete_all_except(&still_missing);
    let outcome = harness.run().expect("upload");

    let mut expected: Vec<String> = still_missing
        .iter()
        .map(|name| (*name).to_string())
        .collect();
    expected.sort();
    let mut uploaded = harness.uploads();
    uploaded.sort();
    assert_eq!(
        uploaded, expected,
        "only the missing assets may be uploaded"
    );
    assert_eq!(outcome.skipped, names.len() - still_missing.len());
    assert_eq!(outcome.replaced, 0);
    assert_eq!(
        harness.remote_names().len(),
        names.len(),
        "the draft is complete"
    );
}

#[test]
fn content_operations_are_spaced_and_never_concurrent() {
    let mut harness = Harness::new();
    harness.run().expect("upload");
    let uploads = harness.uploads().len();
    assert!(uploads > 1);
    let sleeps = harness.sleeps();
    assert_eq!(sleeps.len(), uploads - 1);
    for sleep in sleeps {
        assert_eq!(sleep, PACE_INTERVAL, "content operations must be spaced");
    }
}

#[test]
fn a_mismatched_asset_is_deleted_by_id_then_uploaded() {
    let mut harness = Harness::new();
    let name = "aaa.nar.xz";
    let stale = format!("sha256:{}", "b".repeat(64));
    harness.push_asset(name, 3, Some(stale), "uploaded");
    let stale_id = harness.asset_id(name);

    let outcome = harness.run().expect("upload");

    assert_eq!(
        harness.deletes(),
        vec![stale_id],
        "only the exact id is deleted"
    );
    assert!(harness.uploads().contains(&name.to_string()));
    assert_eq!(outcome.replaced, 1);
    assert!(harness
        .remote
        .borrow()
        .assets
        .iter()
        .all(|asset| asset.id != stale_id));
}

#[test]
fn an_asset_without_a_verifiable_digest_is_replaced() {
    for digest in [None, Some("md5:abc".to_string())] {
        let mut harness = Harness::new();
        let name = "bbb.narinfo";
        let size = harness.fixture.size(name);
        harness.push_asset(name, size, digest, "uploaded");
        let stale_id = harness.asset_id(name);
        harness.run().expect("upload");
        assert_eq!(harness.deletes(), vec![stale_id]);
        assert!(harness.uploads().contains(&name.to_string()));
    }
}

#[test]
fn a_starter_asset_from_an_aborted_upload_is_replaced() {
    let mut harness = Harness::new();
    let name = "ccc.nar.xz";
    let size = harness.fixture.size(name);
    harness.push_asset(name, size, None, "starter");
    let stale_id = harness.asset_id(name);
    harness.run().expect("upload");
    assert_eq!(harness.deletes(), vec![stale_id]);
}

#[test]
fn a_published_release_is_refused_before_any_mutation() {
    let mut harness = Harness::new();
    harness.set_draft(false);
    let text = message(harness.run());
    assert!(text.contains("already published"), "{text}");
    assert!(harness.uploads().is_empty());
    assert!(harness.deletes().is_empty());
    assert_eq!(harness.history().len(), 1, "only the identity was read");
}

#[test]
fn an_immutable_release_is_refused() {
    let mut harness = Harness::new();
    harness.set_immutable(true);
    let text = message(harness.run());
    assert!(text.contains("immutable"), "{text}");
    assert!(harness.uploads().is_empty());
    assert!(harness.deletes().is_empty());
}

#[test]
fn an_uncovered_draft_asset_is_refused_instead_of_deleted() {
    let mut harness = Harness::new();
    let digest = format!("sha256:{}", "c".repeat(64));
    harness.push_asset("stowaway.bin", 4, Some(digest), "uploaded");
    let text = message(harness.run());
    assert!(text.contains("does not cover"), "{text}");
    assert!(
        harness.deletes().is_empty(),
        "unverified content is never deleted"
    );
    assert!(harness.uploads().is_empty());
}

#[test]
fn a_tampered_local_payload_is_refused_before_any_network_call() {
    let mut harness = Harness::new();
    let path = harness.fixture.input.join("aaa.nar.xz");
    let original = fs::read(&path).expect("payload");
    let mut tampered = original.clone();
    tampered[0] ^= 0x01;
    fs::write(&path, &tampered).expect("tampered payload");
    assert_eq!(tampered.len(), original.len(), "the size is unchanged");

    let text = message(harness.run());
    assert!(
        text.contains("does not match SHA256SUMS"),
        "local hashing must fail fast: {text}"
    );
    assert!(
        harness.history().is_empty(),
        "no remote operation may happen before local verification"
    );
}

#[test]
fn an_unsigned_tree_is_refused_locally() {
    let mut harness = Harness::new();
    let manifest = harness.fixture.input.join("manifest.json");
    let mut value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&manifest).expect("manifest")).expect("json");
    value["signed"] = serde_json::json!(false);
    fs::write(
        &manifest,
        serde_json::to_string_pretty(&value).expect("json"),
    )
    .expect("write");
    let text = message(harness.run());
    assert!(text.contains("not marked signed"), "{text}");
    assert!(harness.history().is_empty(), "no gh call may happen first");
}

#[test]
fn a_manifest_that_does_not_match_the_flags_is_refused() {
    let mut harness = Harness::new();
    let manifest = harness.fixture.input.join("manifest.json");
    let mut value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&manifest).expect("manifest")).expect("json");
    value["tag"] = serde_json::json!("chromium-157.0.8103.50-pw-1.65.0-0123456789");
    fs::write(
        &manifest,
        serde_json::to_string_pretty(&value).expect("json"),
    )
    .expect("write");
    let options = UploadOptions {
        tag: "chromium-158.0.8127.18-pw-1.65.0-0123456789".to_string(),
        ..harness.fixture.options()
    };
    let text = message(harness.run_with(options));
    assert!(text.contains("does not match --tag"), "{text}");

    let mut harness = Harness::new();
    let options = UploadOptions {
        revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        ..harness.fixture.options()
    };
    let text = message(harness.run_with(options));
    assert!(text.contains("does not name --revision"), "{text}");
}

#[test]
fn checksums_that_do_not_cover_the_tree_are_refused() {
    let mut harness = Harness::new();
    fs::write(harness.fixture.input.join("stowaway.bin"), b"extra").expect("extra");
    let text = message(harness.run());
    assert!(text.contains("does not cover exactly"), "{text}");
    assert!(harness.history().is_empty());
}

#[test]
fn a_symlinked_asset_is_refused() {
    let mut harness = Harness::new();
    let target = harness.fixture.input.join("aaa.nar.xz");
    let link = harness.fixture.input.join("evil.nar.xz");
    std::os::unix::fs::symlink(&target, &link).expect("symlink");
    let text = message(harness.run());
    assert!(text.contains("regular file"), "{text}");
    assert!(harness.history().is_empty());
}

#[test]
fn an_unsigned_narinfo_is_refused() {
    let mut harness = Harness::new();
    let path = harness.fixture.input.join("aaa.narinfo");
    let text = fs::read_to_string(&path).expect("narinfo");
    fs::write(&path, text.replace("Sig: cloakium-test:c2ln\n", "")).expect("write");
    let text = message(harness.run());
    assert!(text.contains("unsigned Nix cache entry"), "{text}");
    assert!(harness.history().is_empty());
}

#[test]
fn an_unreachable_release_is_reported() {
    let mut harness = Harness::new();
    harness.fail_view("gh: release not found (HTTP 404)");
    let text = message(harness.run());
    assert!(text.contains("release not found"), "{text}");
    assert!(harness.uploads().is_empty());
    assert!(harness.deletes().is_empty());
}

#[test]
fn no_command_carries_a_credential_or_an_undocumented_filter() {
    let mut harness = Harness::new();
    harness.run().expect("upload");
    for command in harness.history() {
        let text = command.to_lowercase();
        assert!(!text.contains("token"), "{command} mentions a token");
        assert!(
            !text.contains("authorization"),
            "{command} mentions authorization"
        );
        assert!(
            !text.contains("--clobber"),
            "{command} would delete and re-POST"
        );
        assert!(
            !text.contains("name="),
            "{command} uses the undocumented list filter"
        );
    }
}

#[test]
fn options_are_validated_before_any_work() {
    let harness = Harness::new();
    for (repository, needle) in [
        ("owner", "must be owner/repo"),
        ("owner/repo/extra", "must be owner/repo"),
        ("own er/repo", "unexpected characters"),
    ] {
        let options = UploadOptions {
            repository: repository.to_string(),
            ..harness.fixture.options()
        };
        let error = validate_options(&options).expect_err("invalid repository");
        assert!(format!("{error:#}").contains(needle), "{error:#}");
    }
    let mut zero = harness.fixture.options();
    zero.timeout = std::time::Duration::ZERO;
    let error = validate_options(&zero).expect_err("timeout");
    assert!(format!("{error:#}").contains("--timeout"), "{error:#}");
}

#[test]
fn the_fixture_tree_is_a_complete_signed_release() {
    let fixture = fixture();
    let names = fixture.names();
    for required in [
        "SHA256SUMS",
        "manifest.json",
        "verification.json",
        "nix-cache-info",
    ] {
        assert!(names.contains(&required.to_string()), "{required}");
    }
    let manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(fixture.input.join("manifest.json")).expect("read"),
    )
    .expect("json");
    assert_eq!(manifest["tag"], serde_json::json!(TAG));
    assert_eq!(manifest["signed"], serde_json::json!(true));
    assert!(names.len() > 10);
}
