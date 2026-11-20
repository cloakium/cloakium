use serde_json::Value;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use cloakium_audit::environment;
use cloakium_audit::finalize::{self, FinalizeOptions};
use cloakium_audit::hash;
use cloakium_audit::inventory::{self, InventoryBundle, INVENTORY_SCHEMA};
use cloakium_audit::model::{
    Configuration, DisplayKind, DisplaySpec, EnvironmentSpec, Identity, Layer, Mode, Plan, Target,
    PLAN_SCHEMA,
};
use cloakium_audit::report::{
    Check, CheckStatus, CleanupRecord, CleanupStatus, ClientRecord, NodeFacts, Observation,
    ObservationResult, ObservationStatus, ProbeRecord, Report, ResolvedEnvironment, RunRecord,
    RunnerFacts, RunnerReport, RunnerSuite, SuiteRecord, REPORT_SCHEMA, RUNNER_SCHEMA,
};
use cloakium_audit::storage;
use cloakium_audit::tree::{self, ProcessCleanup};
use cloakium_audit::validate;

struct Fixture {
    _directory: tempfile::TempDir,
    run_dir: PathBuf,
    plan_hash: String,
    original: Report,
}

fn target(exe: &Path, client: &Path) -> Target {
    Target {
        id: "subject".to_string(),
        label: "Subject".to_string(),
        artifact_path: exe.to_string_lossy().into_owned(),
        executable_path: exe.to_string_lossy().into_owned(),
        client_module: client.to_string_lossy().into_owned(),
        layer: Layer::Engine,
        identity: Identity::Native,
        args: Vec::new(),
        headless_args: Vec::new(),
        headed_args: Vec::new(),
    }
}

fn configuration(mode: Mode, iteration: u32) -> Configuration {
    Configuration {
        id: format!("subject-{}-{iteration}", mode.as_str()),
        target_id: "subject".to_string(),
        mode,
        iteration,
        profile_id: "default".to_string(),
        seed: None,
        args: Vec::new(),
        context_options: Default::default(),
        suites: vec!["fingerprint".to_string()],
        probe_ids: Some(vec!["navigator-core".to_string()]),
        scenario_ids: None,
        suite_options: Default::default(),
        probe_config: None,
    }
}

fn run(configuration: Configuration, client: &ClientRecord) -> RunRecord {
    RunRecord {
        configuration,
        version: "fixture-browser-1".to_string(),
        client: client.clone(),
        environment: resolved_environment(),
        observations: vec![Observation {
            id: "fingerprint.default.navigator-core".to_string(),
            family: "navigator".to_string(),
            status: ObservationStatus::Observed,
            result: ObservationResult {
                observations: serde_json::json!({"value": 1}),
                checks: vec![
                    check("navigator/ua-non-empty"),
                    check("storage/cookie-coherence"),
                    check("document replacement writes its DOM"),
                ],
                limitations: Vec::new(),
            },
        }],
        cleanup: CleanupRecord {
            status: CleanupStatus::Clean,
            notes: Vec::new(),
            browser_closed: Some(true),
            contexts_closed: Some(true),
            process_exited: Some(true),
        },
        duration_ms: Some(1),
        limitations: Vec::new(),
    }
}

fn check(name: &str) -> Check {
    Check {
        name: name.to_string(),
        passed: Some(true),
        status: Some(CheckStatus::Pass),
    }
}

fn resolved_environment() -> ResolvedEnvironment {
    let directory = tempfile::tempdir().expect("environment temp");
    let spec = EnvironmentSpec {
        id: "fixture".to_string(),
        locale: "en-US".to_string(),
        timezone_id: "UTC".to_string(),
        fontconfig_file: None,
        fontconfig_path: None,
        font_manifest_sha256: None,
        display: DisplaySpec {
            kind: DisplayKind::Managed,
            width: 1280,
            height: 800,
            depth: 24,
            dpi: 96,
            window_manager: "none".to_string(),
            display_name: None,
            xauthority_path: None,
            ownership_manifest_path: None,
        },
        notes: None,
    };
    let _ = directory;
    environment::resolve(&spec).expect("environment")
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().expect("tempdir");
    let run_dir = directory.path().join("run");
    storage::create_private_dir_all(&run_dir).expect("run dir");
    let exe = std::env::current_exe().expect("exe");
    let client_path = directory.path().join("client.mjs");
    std::fs::write(&client_path, "export const value = 1;\n").expect("client");
    let target = target(&exe, &client_path);

    let plan = Plan {
        schema: PLAN_SCHEMA.to_string(),
        id: "plan-finalize-test".to_string(),
        environment: EnvironmentSpec {
            id: "fixture".to_string(),
            locale: "en-US".to_string(),
            timezone_id: "UTC".to_string(),
            fontconfig_file: None,
            fontconfig_path: None,
            font_manifest_sha256: None,
            display: DisplaySpec {
                kind: DisplayKind::Managed,
                width: 1280,
                height: 800,
                depth: 24,
                dpi: 96,
                window_manager: "none".to_string(),
                display_name: None,
                xauthority_path: None,
                ownership_manifest_path: None,
            },
            notes: None,
        },
        targets: vec![target.clone()],
        configurations: vec![
            configuration(Mode::Headless, 1),
            configuration(Mode::Headless, 2),
            configuration(Mode::Headed, 1),
            configuration(Mode::Headed, 2),
        ],
    };
    let plan_path = run_dir.join("plan.json");
    storage::write_private_json(&plan_path, &plan, false).expect("plan");
    let plan_hash = hash::file(&plan_path).expect("plan hash");

    let target_record = inventory::inventory_target(&target).expect("inventory");
    let inventory = InventoryBundle {
        schema: INVENTORY_SCHEMA.to_string(),
        generated_at: "2026-01-01T00:00:00.000Z".to_string(),
        targets: vec![target_record.clone()],
    };
    let inventory_path = run_dir.join("inventory.json");
    storage::write_private_json(&inventory_path, &inventory, false).expect("inventory");
    std::fs::set_permissions(&inventory_path, std::fs::Permissions::from_mode(0o400))
        .expect("inventory mode");

    let entry_sha = hash::file(&client_path).expect("entry hash");
    let client = ClientRecord {
        version: "1.0.0-fixture".to_string(),
        path: client_path.to_string_lossy().into_owned(),
        sha256: "c".repeat(64),
        package_sha256: Some("d".repeat(64)),
        patch_manifest_sha256: Some("e".repeat(64)),
        entry_sha256: Some(entry_sha),
    };
    let runs = vec![
        run(configuration(Mode::Headless, 1), &client),
        run(configuration(Mode::Headless, 2), &client),
        run(configuration(Mode::Headed, 1), &client),
        run(configuration(Mode::Headed, 2), &client),
    ];
    let manifest = "b".repeat(64);
    let suite = SuiteRecord {
        manifest_sha256: manifest.clone(),
        probes: vec![
            ProbeRecord {
                id: "navigator-core".to_string(),
                sha256: "1".repeat(64),
            },
            ProbeRecord {
                id: "geometry/dom-rect-invariants".to_string(),
                sha256: "2".repeat(64),
            },
        ],
        runner: RunnerFacts {
            path: "/private/runner.mjs".to_string(),
            sha256: "a".repeat(64),
        },
        node: NodeFacts {
            path: "/private/node".to_string(),
            sha256: "f".repeat(64),
            version: "v26.0.0".to_string(),
        },
    };
    let execution = serde_json::json!({
        "schema": "cloakium.audit.execution/1",
        "runId": "run-finalize-test",
        "planId": plan.id,
        "planHash": plan_hash,
        "suiteManifestSha256": manifest,
        "nodeSha256": "f".repeat(64),
        "runnerSha256": "a".repeat(64),
        "timeoutMs": 600000
    });
    storage::write_private_json(&run_dir.join("execution.json"), &execution, false)
        .expect("execution");

    let fragment = RunnerReport {
        schema: RUNNER_SCHEMA.to_string(),
        plan_id: Some(plan.id.clone()),
        plan_hash: Some(plan_hash.clone()),
        suite: Some(RunnerSuite {
            manifest_sha256: Some(manifest.clone()),
            probes: vec![
                ProbeRecord {
                    id: "navigator-core".to_string(),
                    sha256: "1".repeat(64),
                },
                ProbeRecord {
                    id: "geometry/dom-rect-invariants".to_string(),
                    sha256: "2".repeat(64),
                },
            ],
        }),
        environment: Some(resolved_environment()),
        runs,
        errors: Vec::new(),
    };
    storage::write_private_json(&run_dir.join("runner-report.json"), &fragment, false)
        .expect("fragment");

    let original = Report {
        schema: REPORT_SCHEMA.to_string(),
        run_id: "run-finalize-test".to_string(),
        plan_id: plan.id,
        plan_hash: plan_hash.clone(),
        suite,
        environment: resolved_environment(),
        targets: vec![target_record],
        runs: Vec::new(),
        errors: Vec::new(),
        started: "2026-01-01T00:00:00.000Z".to_string(),
        finished: "2026-01-01T00:00:10.000Z".to_string(),
        complete: false,
        completeness: Vec::new(),
        limitations: Vec::new(),
        process_cleanup: Some(ProcessCleanup {
            root_pid: 999_999,
            root_start_ticks: 1,
            discovered: Vec::new(),
            signalled: Vec::new(),
            residual: Vec::new(),
            clean: true,
        }),
        postprocessing_recovery: None,
    };
    storage::write_private_json(&run_dir.join("report.json"), &original, false).expect("report");
    Fixture {
        _directory: directory,
        run_dir,
        plan_hash,
        original,
    }
}

fn options(fixture: &Fixture, name: &str) -> FinalizeOptions {
    FinalizeOptions {
        run_dir: fixture.run_dir.clone(),
        output: fixture.run_dir.join(name),
        reason: Some("test recovery".to_string()),
    }
}

#[test]
fn finalize_recovers_all_runs_and_preserves_identity() {
    let fixture = fixture();
    let original_bytes = std::fs::read(fixture.run_dir.join("report.json")).expect("original");
    let (path, report) = finalize::execute(&options(&fixture, "final.json")).expect("finalize");
    assert_eq!(
        std::fs::read(fixture.run_dir.join("report.json")).expect("original after"),
        original_bytes
    );
    assert_eq!(report.plan_hash, fixture.plan_hash);
    assert_eq!(report.run_id, fixture.original.run_id);
    assert_eq!(report.started, fixture.original.started);
    assert_eq!(report.finished, fixture.original.finished);
    assert_eq!(report.runs.len(), 4);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(report.complete, "{:?}", report.completeness);
    assert_eq!(report.suite.probes.len(), 2);
    assert!(report.postprocessing_recovery.is_some());
    let validation = validate::report(&report, &path.to_string_lossy());
    assert!(validation.valid, "{:?}", validation.findings);
    assert_eq!(
        std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn finalize_writes_a_safe_incomplete_report_for_a_malformed_fragment() {
    let fixture = fixture();
    let mut fragment: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture.run_dir.join("runner-report.json")).expect("read"),
    )
    .expect("json");
    fragment["runs"][0]["observations"][0]["result"]["checks"][0]["name"] =
        serde_json::Value::String(format!("cookie/{}\n", "x".repeat(600)));
    std::fs::write(
        fixture.run_dir.join("runner-report.json"),
        serde_json::to_vec(&fragment).expect("json"),
    )
    .expect("write fragment");
    let (path, report) =
        finalize::execute(&options(&fixture, "malformed-final.json")).expect("finalize malformed");
    assert!(!report.complete);
    assert_eq!(report.runs.len(), 0);
    assert!(!report.errors.is_empty());
    assert!(report.errors.iter().all(|error| error.message.len() <= 512));
    assert!(!report
        .errors
        .iter()
        .any(|error| error.message.contains("cookie/")));
    let validation = validate::report(&report, &path.to_string_lossy());
    assert!(validation.valid, "{:?}", validation.findings);
    assert!(fixture
        .run_dir
        .join("runner-report.validation.json")
        .is_file());
}

#[test]
fn finalize_refuses_a_live_owned_identity_and_existing_output() {
    let fixture = fixture();
    let report_path = fixture.run_dir.join("report.json");
    let original_bytes = std::fs::read(&report_path).expect("read");
    let mut original: serde_json::Value = serde_json::from_slice(&original_bytes).expect("json");
    original["processCleanup"]["rootPid"] = serde_json::json!(std::process::id());
    original["processCleanup"]["rootStartTicks"] =
        serde_json::json!(tree::start_ticks(std::process::id()).expect("ticks"));
    std::fs::write(
        fixture.run_dir.join("report.json"),
        serde_json::to_vec(&original).expect("json"),
    )
    .expect("write report");
    let output = fixture.run_dir.join("live-final.json");
    let error = finalize::execute(&FinalizeOptions {
        run_dir: fixture.run_dir.clone(),
        output: output.clone(),
        reason: None,
    })
    .expect_err("live identity must be refused");
    assert!(error.to_string().contains("still live"));
    assert!(!output.exists());
    std::fs::write(&report_path, &original_bytes).expect("restore report");

    let good = finalize::execute(&options(&fixture, "existing-final.json")).expect("finalize");
    let error = finalize::execute(&FinalizeOptions {
        run_dir: fixture.run_dir.clone(),
        output: good.0,
        reason: None,
    })
    .expect_err("existing output must be refused");
    assert!(error.to_string().contains("existing report"));
}

#[test]
fn finalize_cli_recovers_a_closed_fixture() {
    let fixture = fixture();
    let output = fixture.run_dir.join("cli-final.json");
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_cloakium-audit"))
        .args([
            "finalize",
            "--run-dir",
            fixture.run_dir.to_str().expect("dir"),
            "--output",
            output.to_str().expect("output"),
            "--reason",
            "cli test recovery",
        ])
        .output()
        .expect("finalize cli");
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("runs=4"));
    let report: Report =
        serde_json::from_slice(&std::fs::read(&output).expect("read")).expect("parse");
    assert_eq!(report.runs.len(), 4);
    assert!(report.postprocessing_recovery.is_some());
}

#[test]
fn finalize_preserves_uncertain_cleanup_as_valid_incomplete() {
    let fixture = fixture();
    let report_path = fixture.run_dir.join("report.json");
    let mut original: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&report_path).expect("read")).expect("json");
    original["processCleanup"]["clean"] = Value::Bool(false);
    original["processCleanup"]["residual"] = serde_json::json!([]);
    std::fs::write(&report_path, serde_json::to_vec(&original).expect("json")).expect("write");
    let (path, report) = finalize::execute(&options(&fixture, "uncertain-final.json"))
        .expect("finalize uncertain cleanup");
    assert!(!report.complete);
    assert!(!report.process_cleanup.as_ref().expect("cleanup").clean);
    assert!(report
        .process_cleanup
        .as_ref()
        .expect("cleanup")
        .residual
        .is_empty());
    assert!(report
        .errors
        .iter()
        .any(|error| error.kind == cloakium_audit::report::ErrorKind::Cleanup));
    let validation = validate::report(&report, &path.to_string_lossy());
    assert!(validation.valid, "{:?}", validation.findings);
    assert!(!validation.complete);
    assert!(validation
        .completeness
        .iter()
        .any(|reason| reason.contains("uncertain or not clean")));
}
