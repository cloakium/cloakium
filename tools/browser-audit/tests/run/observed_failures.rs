use super::*;
use cloakium_audit::report::CheckStatus;

#[test]
fn observed_check_failures_are_not_execution_errors() {
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
    for run in &mut fragment.runs {
        for observation in &mut run.observations {
            for check in &mut observation.result.checks {
                check.passed = Some(false);
                check.status = Some(CheckStatus::Fail);
            }
        }
    }
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
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.runs.len(), 4);
    assert!(report
        .completeness
        .iter()
        .any(|reason| reason.contains("is fail")));
}

#[test]
fn malformed_fragment_produces_a_valid_incomplete_report_and_safe_errors() {
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
    for run in &mut fragment.runs {
        for observation in &mut run.observations {
            for check in &mut observation.result.checks {
                check.name = format!("cookie/{}\n", "x".repeat(600));
            }
        }
    }
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
            directory.path().join("seat.lock").to_str().expect("path"),
            "--timeout",
            "60",
        ])
        .output()
        .expect("run");
    assert_eq!(result.status.code(), Some(2));
    let report: Report =
        serde_json::from_slice(&std::fs::read(output.join("report.json")).expect("read"))
            .expect("parse");
    assert!(!report.complete);
    assert!(!report.errors.is_empty());
    assert!(report.errors.iter().all(|error| error.message.len() <= 512));
    assert!(!report
        .errors
        .iter()
        .any(|error| error.message.contains("cookie/")));
    assert!(output.join("runner-report.validation.json").is_file());
    let validation = validate::report(&report, "report.json");
    assert!(validation.valid, "{:?}", validation.findings);
    assert!(!String::from_utf8_lossy(&result.stderr).contains("internal report validation failed"));
}
