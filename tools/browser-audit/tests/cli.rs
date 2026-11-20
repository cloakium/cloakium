use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use cloakium_audit::inventory::InventoryBundle;
use cloakium_audit::model::Plan;
use cloakium_audit::validate;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_cloakium-audit")
}

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/audit/schema/fixtures")
        .join(name)
}

fn run(args: &[&str]) -> std::process::Output {
    Command::new(binary()).args(args).output().expect("command")
}

#[test]
fn help_lists_every_required_command() {
    let output = run(&["--help"]);
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    for command in [
        "inventory",
        "plan",
        "validate",
        "run",
        "compare",
        "catalog",
        "schema",
    ] {
        assert!(text.contains(command), "missing {command}: {text}");
    }
}

#[test]
fn validate_accepts_fixtures_and_rejects_invalid_json() {
    let plan = fixture("plan.json");
    let output = run(&["validate", "--plan", plan.to_str().expect("path")]);
    assert!(output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json");
    assert_eq!(value["valid"], true);
    assert_eq!(value["complete"], true);

    let report = fixture("report.json");
    let output = run(&["validate", "--report", report.to_str().expect("path")]);
    assert!(output.status.success());
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json");
    assert_eq!(value["valid"], true);

    let directory = tempfile::tempdir().expect("tempdir");
    let invalid = directory.path().join("invalid.json");
    std::fs::write(&invalid, "{}").expect("write");
    let output = run(&["validate", "--report", invalid.to_str().expect("path")]);
    assert!(!output.status.success());
}

#[test]
fn plan_writes_private_versioned_json() {
    let directory = tempfile::tempdir().expect("tempdir");
    let output_path = directory.path().join("private/plan.json");
    let status = Command::new(binary())
        .args([
            "plan",
            "--baseline",
            "/opt/cloakium/baseline/chrome",
            "--candidate",
            "/opt/cloakium/candidate/chrome",
            "--client-module",
            "/opt/cloakium/client/index.js",
            "--iterations",
            "2",
            "--output",
            output_path.to_str().expect("path"),
            "--suite",
            "core",
        ])
        .status()
        .expect("plan");
    assert!(status.success());
    let plan: Plan =
        serde_json::from_slice(&std::fs::read(&output_path).expect("read")).expect("parse");
    let validation = validate::plan(&plan, "plan.json");
    assert!(validation.valid, "{:?}", validation.findings);
    assert!(validation.complete, "{:?}", validation.completeness);
    assert_eq!(plan.configurations.len(), 8);
    assert_eq!(
        std::fs::metadata(directory.path().join("private"))
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(&output_path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn inventory_hashes_the_test_binary_without_running_it() {
    let directory = tempfile::tempdir().expect("tempdir");
    let output_path = directory.path().join("inventory.json");
    let exe = std::env::current_exe().expect("exe");
    let output = Command::new(binary())
        .args([
            "inventory",
            "--artifact",
            exe.to_str().expect("path"),
            "--output",
            output_path.to_str().expect("path"),
        ])
        .output()
        .expect("inventory");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let bundle: InventoryBundle =
        serde_json::from_slice(&std::fs::read(&output_path).expect("read")).expect("parse");
    assert_eq!(bundle.targets.len(), 1);
    assert_eq!(
        bundle.targets[0].artifact.sha256_before,
        bundle.targets[0].artifact.sha256_after
    );
    assert!(bundle.targets[0].artifact.executable);
}

#[test]
fn compare_and_catalog_keep_one_canonical_feature_row() {
    let directory = tempfile::tempdir().expect("tempdir");
    let compare = directory.path().join("compare.json");
    let status = Command::new(binary())
        .args([
            "compare",
            "--baseline",
            fixture("report.json").to_str().expect("path"),
            "--candidate",
            fixture("report-candidate.json").to_str().expect("path"),
            "--plan",
            fixture("plan.json").to_str().expect("path"),
            "--policy",
            fixture("policy.json").to_str().expect("path"),
            "--output",
            compare.to_str().expect("path"),
        ])
        .status()
        .expect("compare");
    assert!(status.success());
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&compare).expect("read")).expect("parse");
    assert_eq!(value["summary"]["features"], 1);
    assert!(value["summary"]["gaps"].as_u64().unwrap_or(0) >= 1);
    assert_eq!(
        std::fs::metadata(&compare)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );

    let catalog = directory.path().join("catalog.json");
    let status = Command::new(binary())
        .args([
            "catalog",
            "--input",
            compare.to_str().expect("path"),
            "--input",
            compare.to_str().expect("path"),
            "--output",
            catalog.to_str().expect("path"),
        ])
        .status()
        .expect("catalog");
    assert!(status.success());
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&catalog).expect("read")).expect("parse");
    assert_eq!(value["summary"]["features"], 1);
    assert_eq!(value["rows"].as_array().expect("rows").len(), 1);
}

#[test]
fn schema_command_prints_the_same_contract_as_the_files() {
    let output = run(&["schema", "--name", "report"]);
    assert!(output.status.success());
    let printed: serde_json::Value = serde_json::from_slice(&output.stdout).expect("json");
    let file =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/audit/schema/report.schema.json");
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(file).expect("read")).expect("json");
    assert_eq!(printed, saved);
}

#[test]
fn catalog_accepts_an_existing_catalogue_row() {
    let directory = tempfile::tempdir().expect("tempdir");
    let output = directory.path().join("catalog.json");
    let status = Command::new(binary())
        .args([
            "catalog",
            "--input",
            fixture("catalog.json").to_str().expect("path"),
            "--output",
            output.to_str().expect("path"),
        ])
        .status()
        .expect("catalog");
    assert!(status.success());
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(output).expect("read")).expect("json");
    assert_eq!(value["summary"]["features"], 1);
    assert_eq!(value["rows"][0]["unknown"], true);
}
