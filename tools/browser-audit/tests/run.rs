#[path = "run/observed_failures.rs"]
mod observed_failures;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

use cloakium_audit::environment;
use cloakium_audit::hash;
use cloakium_audit::model::{
    Configuration, DisplayKind, DisplaySpec, EnvironmentSpec, Identity, Layer, Mode, Plan, Target,
    PLAN_SCHEMA,
};
use cloakium_audit::report::{
    AuditError, Check, CheckStatus, CleanupRecord, CleanupStatus, ClientRecord, ErrorKind,
    Observation, ObservationResult, ObservationStatus, ProbeRecord, Report, RunRecord,
    RunnerReport, RunnerSuite, RUNNER_SCHEMA,
};
use cloakium_audit::storage;
use cloakium_audit::validate;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_cloakium-audit")
}

fn find_tool(name: &str) -> String {
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    panic!("required test tool not found: {name}");
}

fn shell() -> String {
    for name in ["sh", "bash"] {
        for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    panic!("no shell found for test");
}

fn write_executable(path: &Path, text: &str) {
    std::fs::write(path, text).expect("write");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("mode");
}

fn plan_for(exe: &Path, client: &Path, directory: &Path) -> Plan {
    let environment = EnvironmentSpec {
        id: "test".to_string(),
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
            ownership_manifest_path: Some(
                directory
                    .join("display-ownership.json")
                    .to_string_lossy()
                    .into_owned(),
            ),
        },
        notes: None,
    };
    let target = Target {
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
    };
    let mut configurations = Vec::new();
    for mode in [Mode::Headless, Mode::Headed] {
        for iteration in 1..=2 {
            configurations.push(Configuration {
                id: format!("subject-{}-{iteration}", mode.as_str()),
                target_id: target.id.clone(),
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
            });
        }
    }
    Plan {
        schema: PLAN_SCHEMA.to_string(),
        id: "plan-run-test".to_string(),
        environment,
        targets: vec![target],
        configurations,
    }
}

fn runner_report(
    plan: &Plan,
    client: &Path,
    environment: &cloakium_audit::report::ResolvedEnvironment,
    plan_hash: &str,
    manifest: &str,
) -> RunnerReport {
    let runs = plan
        .configurations
        .iter()
        .map(|configuration| RunRecord {
            configuration: configuration.clone(),
            version: "fake-browser-1.0".to_string(),
            client: ClientRecord {
                version: "0.0.0-fake".to_string(),
                path: client.to_string_lossy().into_owned(),
                sha256: "c".repeat(64),
                package_sha256: Some("d".repeat(64)),
                patch_manifest_sha256: Some("e".repeat(64)),
                entry_sha256: None,
            },
            environment: environment.clone(),
            observations: vec![Observation {
                id: "navigator.webdriver".to_string(),
                family: "navigator".to_string(),
                status: ObservationStatus::Observed,
                result: ObservationResult {
                    observations: serde_json::json!({"webdriver": false}),
                    checks: vec![Check {
                        name: "webdriver-hidden".to_string(),
                        passed: Some(true),
                        status: Some(CheckStatus::Pass),
                    }],
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
        })
        .collect();
    RunnerReport {
        schema: RUNNER_SCHEMA.to_string(),
        plan_id: Some(plan.id.clone()),
        plan_hash: Some(plan_hash.to_string()),
        suite: Some(RunnerSuite {
            manifest_sha256: Some(manifest.to_string()),
            probes: vec![ProbeRecord {
                id: "navigator-core".to_string(),
                sha256: "a".repeat(64),
            }],
        }),
        environment: Some(environment.clone()),
        runs,
        errors: Vec::new(),
    }
}

#[test]
fn run_invokes_one_whole_plan_node_process_and_writes_a_private_report() {
    let directory = tempfile::tempdir().expect("tempdir");
    let exe = std::env::current_exe().expect("exe");
    let client = directory.path().join("client.js");
    std::fs::write(&client, "export const name = 'client';\n").expect("client");
    let plan = plan_for(&exe, &client, directory.path());
    let plan_path = directory.path().join("plan.json");
    storage::write_private_json(&plan_path, &plan, false).expect("plan write");
    let plan_hash = hash::file(&plan_path).expect("hash");
    let environment = environment::resolve(&plan.environment).expect("environment");

    let fragment_path = directory.path().join("fragment.json");
    let runner_path = directory.path().join("run.mjs");
    std::fs::write(&runner_path, "// selected runner\n").expect("runner");
    let manifest = hash::file(&runner_path).expect("runner hash");
    let fragment = runner_report(&plan, &client, &environment, &plan_hash, &manifest);
    storage::write_private_json(&fragment_path, &fragment, false).expect("fragment");

    let node = directory.path().join("fake-node");
    write_executable(
        &node,
        &format!(
            "#!{}\nif [ \"$1\" = \"--version\" ]; then printf 'v0.0.0-fake\\n'; exit 0; fi\n{} '{}' \"$5\"/runner-report.json\nprintf 'progress\\n'\n",
            shell(),
            find_tool("cp"),
            fragment_path.display()
        ),
    );
    let output = directory.path().join("run-out");
    let status = Command::new(binary())
        .args([
            "run",
            "--plan",
            plan_path.to_str().expect("path"),
            "--node",
            node.to_str().expect("path"),
            "--runner",
            runner_path.to_str().expect("path"),
            "--output",
            output.to_str().expect("path"),
            "--lock",
            directory.path().join("seat.lock").to_str().expect("path"),
            "--timeout",
            "60",
        ])
        .status()
        .expect("run");
    assert!(status.success());
    let report_path = output.join("report.json");
    let report: Report =
        serde_json::from_slice(&std::fs::read(&report_path).expect("read")).expect("parse");
    let validation = validate::report(&report, "report.json");
    assert!(validation.valid, "{:?}", validation.findings);
    assert!(report.complete, "{:?}", report.completeness);
    assert_eq!(report.runs.len(), 4);
    assert!(report.suite.probes.len() == 1);
    let entry = report
        .runs
        .iter()
        .filter_map(|run| run.client.entry_sha256.as_deref())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(entry.len(), 1);
    assert_eq!(
        std::fs::metadata(&output)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(&report_path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(output.join("runner-report.json").is_file());
    let execution: serde_json::Value =
        serde_json::from_slice(&std::fs::read(output.join("execution.json")).expect("execution"))
            .expect("execution json");
    assert_eq!(
        execution["suiteManifestSha256"],
        report.suite.manifest_sha256
    );
    assert!(
        report
            .process_cleanup
            .as_ref()
            .expect("process cleanup receipt")
            .clean
    );
}

#[test]
fn whole_run_timeout_is_reported_and_never_duplicated() {
    let directory = tempfile::tempdir().expect("tempdir");
    let exe = std::env::current_exe().expect("exe");
    let client = directory.path().join("client.js");
    std::fs::write(&client, "export const name = 'client';\n").expect("client");
    let plan = plan_for(&exe, &client, directory.path());
    let plan_path = directory.path().join("plan.json");
    storage::write_private_json(&plan_path, &plan, false).expect("plan write");
    let runner_path = directory.path().join("run.mjs");
    std::fs::write(&runner_path, "// selected runner\n").expect("runner");
    let node = directory.path().join("fake-node");
    write_executable(
        &node,
        &format!(
            "#!{}\nif [ \"$1\" = \"--version\" ]; then printf 'v0.0.0-fake\\n'; exit 0; fi\n{} 30 &\nwait\n",
            shell(),
            find_tool("sleep")
        ),
    );
    let output = directory.path().join("run-out");
    let status = Command::new(binary())
        .args([
            "run",
            "--plan",
            plan_path.to_str().expect("path"),
            "--node",
            node.to_str().expect("path"),
            "--runner",
            runner_path.to_str().expect("path"),
            "--output",
            output.to_str().expect("path"),
            "--lock",
            directory.path().join("seat.lock").to_str().expect("path"),
            "--timeout",
            "6",
        ])
        .status()
        .expect("run");
    assert_eq!(status.code(), Some(2));
    let report: Report =
        serde_json::from_slice(&std::fs::read(output.join("report.json")).expect("read"))
            .expect("parse");
    assert!(!report.complete);
    assert!(report.runs.is_empty());
    assert!(report
        .errors
        .iter()
        .any(|error| error.kind == ErrorKind::Timeout));
    assert!(
        output.join("runner.stderr.log").is_file() || output.join("runner.stdout.log").is_file()
    );
}

#[test]
fn runner_errors_must_be_sanitized_summaries() {
    let directory = tempfile::tempdir().expect("tempdir");
    let exe = std::env::current_exe().expect("exe");
    let client = directory.path().join("client.js");
    std::fs::write(&client, "client\n").expect("client");
    let plan = plan_for(&exe, &client, directory.path());
    let plan_path = directory.path().join("plan.json");
    storage::write_private_json(&plan_path, &plan, false).expect("plan write");
    let plan_hash = hash::file(&plan_path).expect("hash");
    let environment = environment::resolve(&plan.environment).expect("environment");
    let runner_path = directory.path().join("run.mjs");
    std::fs::write(&runner_path, "// runner\n").expect("runner");
    let manifest = hash::file(&runner_path).expect("hash");
    let mut fragment = runner_report(&plan, &client, &environment, &plan_hash, &manifest);
    fragment.errors.push(AuditError {
        kind: ErrorKind::Execution,
        phase: "probe".to_string(),
        configuration_id: None,
        code: Some("driver-error".to_string()),
        operation: Some("connect".to_string()),
        target_closed: Some(true),
        timeout_category: None,
        message: "raw driver text with a secret must not survive".to_string(),
    });
    let fragment_path = directory.path().join("fragment.json");
    storage::write_private_json(&fragment_path, &fragment, false).expect("fragment");
    let node = directory.path().join("fake-node");
    write_executable(
        &node,
        &format!(
            "#!{}\nif [ \"$1\" = \"--version\" ]; then printf 'v0.0.0-fake\\n'; exit 0; fi\n{} '{}' \"$5\"/runner-report.json\nexit 0\n",
            shell(),
            find_tool("cp"),
            fragment_path.display()
        ),
    );
    let output = directory.path().join("run-out");
    let status = Command::new(binary())
        .args([
            "run",
            "--plan",
            plan_path.to_str().expect("path"),
            "--node",
            node.to_str().expect("path"),
            "--runner",
            runner_path.to_str().expect("path"),
            "--output",
            output.to_str().expect("path"),
            "--lock",
            directory.path().join("seat.lock").to_str().expect("path"),
            "--timeout",
            "60",
        ])
        .status()
        .expect("run");
    assert_eq!(status.code(), Some(2));
    let report: Report =
        serde_json::from_slice(&std::fs::read(output.join("report.json")).expect("read"))
            .expect("parse");
    assert!(!report.complete);
    assert!(report.errors.iter().any(|error| error.phase == "runner"));
    assert!(!report
        .errors
        .iter()
        .any(|error| error.message.to_ascii_lowercase().contains("secret")));
}

#[test]
fn lock_seat_blocks_a_second_run_without_starting_node() {
    let directory = tempfile::tempdir().expect("tempdir");
    let lock_path = directory.path().join("seat.lock");
    let _lock = cloakium_audit::lock::AuditLock::acquire(&lock_path).expect("lock");
    let exe = std::env::current_exe().expect("exe");
    let client = directory.path().join("client.js");
    std::fs::write(&client, "client\n").expect("client");
    let plan = plan_for(&exe, &client, directory.path());
    let plan_path = directory.path().join("plan.json");
    storage::write_private_json(&plan_path, &plan, false).expect("plan write");
    let runner_path = directory.path().join("run.mjs");
    std::fs::write(&runner_path, "// runner\n").expect("runner");
    let node = directory.path().join("fake-node");
    write_executable(&node, &format!("#!{}\nexit 0\n", shell()));
    let output = directory.path().join("run-out");
    let result = Command::new(binary())
        .args([
            "run",
            "--plan",
            plan_path.to_str().expect("path"),
            "--node",
            node.to_str().expect("path"),
            "--runner",
            runner_path.to_str().expect("path"),
            "--output",
            output.to_str().expect("path"),
            "--lock",
            lock_path.to_str().expect("path"),
            "--timeout",
            "60",
        ])
        .output()
        .expect("run");
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("exclusive seat"));
    assert!(!output.join("report.json").exists());
}
