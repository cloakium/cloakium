use std::path::PathBuf;

use cloakium_audit::compare::{self, CompareOptions, CompareReport};
use serde_json::Value;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/audit/schema/fixtures")
        .join(name)
}

fn fixture(name: &str) -> Value {
    serde_json::from_slice(&std::fs::read(fixture_path(name)).expect("read")).expect("parse")
}

fn compare(baseline: &Value, candidate: &Value, policy: Option<&Value>) -> CompareReport {
    let directory = tempfile::tempdir().expect("tempdir");
    let plan_path = directory.path().join("plan.json");
    std::fs::copy(fixture_path("plan.json"), &plan_path).expect("plan");
    let baseline_path = directory.path().join("baseline.json");
    let candidate_path = directory.path().join("candidate.json");
    std::fs::write(&baseline_path, serde_json::to_vec(baseline).expect("json")).expect("write");
    std::fs::write(
        &candidate_path,
        serde_json::to_vec(candidate).expect("json"),
    )
    .expect("write");
    let policy_path = policy.map(|value| {
        let path = directory.path().join("policy.json");
        std::fs::write(&path, serde_json::to_vec(value).expect("json")).expect("write");
        path
    });
    let output = directory.path().join("compare.json");
    let (_, report) = compare::execute(&CompareOptions {
        baseline: baseline_path,
        candidate: candidate_path,
        policy: policy_path,
        plan: Some(plan_path),
        output,
        baseline_target: None,
        candidate_target: None,
        force: false,
    })
    .expect("compare");
    report
}

fn candidate_with_passing_checks() -> Value {
    let mut candidate = fixture("report-candidate.json");
    for run in candidate["runs"].as_array_mut().expect("runs") {
        for observation in run["observations"].as_array_mut().expect("observations") {
            for check in observation["result"]["checks"]
                .as_array_mut()
                .expect("checks")
            {
                check["passed"] = Value::Bool(true);
                check["status"] = Value::String("pass".to_string());
            }
        }
    }
    candidate["complete"] = Value::Bool(true);
    candidate["completeness"] = Value::Array(Vec::new());
    candidate
}

fn set_check(candidate: &mut Value, run_id: &str, passed: bool, status: &str) {
    for run in candidate["runs"].as_array_mut().expect("runs") {
        if run["configuration"]["id"] == run_id {
            for observation in run["observations"].as_array_mut().expect("observations") {
                for check in observation["result"]["checks"]
                    .as_array_mut()
                    .expect("checks")
                {
                    check["passed"] = Value::Bool(passed);
                    check["status"] = Value::String(status.to_string());
                }
            }
        }
    }
    candidate["complete"] = Value::Bool(false);
}

#[test]
fn ordinary_value_variation_is_retained_but_not_a_gap() {
    let baseline = fixture("report.json");
    let mut candidate = candidate_with_passing_checks();
    candidate["runs"][0]["observations"][0]["result"]["observations"]["noise"] = Value::from(7);
    let report = compare(&baseline, &candidate, None);
    assert!(report.complete, "{:?}", report.completeness);
    assert_eq!(report.summary.gaps, 0);
    assert!(report.summary.ordinary_variation >= 1);
    assert!(report
        .differences
        .iter()
        .any(|difference| difference.classification == "ordinary-variation" && !difference.gap));
}

#[test]
fn unknown_status_with_passed_false_is_unknown_not_fail() {
    let baseline = fixture("report.json");
    let mut candidate = candidate_with_passing_checks();
    set_check(&mut candidate, "candidate-headless-1", false, "unknown");
    let report = compare(&baseline, &candidate, None);
    let unknown: Vec<_> = report
        .differences
        .iter()
        .filter(|difference| difference.classification == "unknown")
        .collect();
    assert!(!unknown.is_empty(), "{:?}", report.differences);
    assert!(unknown
        .iter()
        .all(|difference| !difference.gap && difference.unknown));
    assert!(!report
        .differences
        .iter()
        .any(|difference| difference.classification == "capability-difference"));
}

#[test]
fn declared_stable_field_difference_is_a_gap() {
    let baseline = fixture("report.json");
    let mut candidate = candidate_with_passing_checks();
    for run in candidate["runs"].as_array_mut().expect("runs") {
        for observation in run["observations"].as_array_mut().expect("observations") {
            observation["result"]["observations"]["webdriver"] = Value::Bool(true);
        }
    }
    let policy = serde_json::json!({
        "schema": "cloakium.audit.policy/1",
        "allowlist": [],
        "stableFields": ["webdriver"]
    });
    let report = compare(&baseline, &candidate, Some(&policy));
    assert!(report
        .differences
        .iter()
        .any(
            |difference| difference.classification == "stable-field-difference" && difference.gap
        ));
    assert!(report.summary.gaps >= 1);
}

#[test]
fn within_target_headless_regression_is_separate_from_capability_difference() {
    let baseline = fixture("report.json");
    let mut candidate = candidate_with_passing_checks();
    set_check(&mut candidate, "candidate-headless-1", false, "fail");
    let report = compare(&baseline, &candidate, None);
    assert!(report
        .differences
        .iter()
        .any(|difference| difference.classification == "headless-regression" && difference.gap));
    assert!(report.summary.headless_regressions >= 1);
    assert!(report.summary.capability_differences >= 1);
}

#[test]
fn headless_improvement_requires_actual_headless_acceptance() {
    let baseline = fixture("report.json");
    let mut candidate = candidate_with_passing_checks();
    set_check(&mut candidate, "candidate-headed-1", false, "fail");
    let report = compare(&baseline, &candidate, None);
    let improvement = report
        .differences
        .iter()
        .find(|difference| difference.classification == "headless-improvement")
        .expect("improvement");
    assert!(!improvement.gap);
    assert_eq!(
        improvement.mode,
        Some(cloakium_audit::model::Mode::Headless)
    );
    assert!(improvement.detail.contains("actual acceptance"));
}

#[test]
fn iteration_instability_is_recorded() {
    let baseline = fixture("report.json");
    let mut candidate = candidate_with_passing_checks();
    set_check(&mut candidate, "candidate-headless-2", false, "fail");
    let report = compare(&baseline, &candidate, None);
    assert!(report
        .differences
        .iter()
        .any(|difference| difference.classification == "iteration-instability" && difference.gap));
    assert!(report.summary.iteration_instability >= 1);
}

#[test]
fn browser_version_difference_is_a_confounder_not_a_causal_claim() {
    let baseline = fixture("report.json");
    let mut candidate = fixture("report-candidate.json");
    for run in candidate["runs"].as_array_mut().expect("runs") {
        run["version"] = Value::String("other-browser-9.0".to_string());
    }
    let report = compare(&baseline, &candidate, None);
    assert_eq!(report.causal_attribution, "version-confounded");
    assert!(report
        .confounders
        .iter()
        .any(|confounder| confounder.axis == "browser-version"));
    assert!(report
        .differences
        .iter()
        .filter(|difference| difference.classification == "capability-difference")
        .all(|difference| difference
            .confounders
            .iter()
            .any(|axis| axis == "browser-version")));
}

#[test]
fn recorded_policy_marks_an_exact_difference_intentional() {
    let baseline = fixture("report.json");
    let candidate = fixture("report-candidate.json");
    let policy = serde_json::json!({
        "schema": "cloakium.audit.policy/1",
        "allowlist": [{
            "id": "known-webdriver-policy",
            "justification": "This exact feature is an intentional persona policy for the candidate.",
            "featureIds": ["navigator.webdriver"],
            "checks": ["webdriver-hidden"],
            "modes": ["headless", "headed"]
        }],
        "stableFields": []
    });
    let report = compare(&baseline, &candidate, Some(&policy));
    assert!(report
        .differences
        .iter()
        .any(
            |difference| difference.classification == "intentional-difference"
                && !difference.gap
                && difference.policy_id.as_deref() == Some("known-webdriver-policy")
        ));
    assert_eq!(report.summary.intentional, report.summary.differences);
}

fn set_mode_observation(report: &mut Value, mode: &str, field: &str, value: Value) {
    for run in report["runs"].as_array_mut().expect("runs") {
        if run["configuration"]["mode"] == mode {
            for observation in run["observations"].as_array_mut().expect("observations") {
                observation["result"]["observations"][field] = value.clone();
            }
        }
    }
}

#[test]
fn declared_stable_field_parity_is_checked_between_modes() {
    let mut report = fixture("report.json");
    set_mode_observation(
        &mut report,
        "headless",
        "render",
        Value::String("headless-a".into()),
    );
    set_mode_observation(
        &mut report,
        "headed",
        "render",
        Value::String("headed-b".into()),
    );

    let without_policy = compare(&report, &report, None);
    assert_eq!(without_policy.summary.gaps, 0);
    assert!(!without_policy
        .differences
        .iter()
        .any(|difference| difference.classification == "stable-field-difference"));

    let policy = serde_json::json!({
        "schema": "cloakium.audit.policy/1",
        "allowlist": [],
        "stableFields": ["render"]
    });
    let with_policy = compare(&report, &report, Some(&policy));
    let stable = with_policy
        .differences
        .iter()
        .find(|difference| difference.classification == "stable-field-difference")
        .expect("mode stable-field-difference");
    assert_eq!(stable.mode, Some(cloakium_audit::model::Mode::Headless));
    assert!(stable.detail.contains("render"));
    assert!(stable.detail.contains("headed"));
    assert!(stable.detail.contains("headless"));
    assert_eq!(stable.baseline, Some(Value::String("headed-b".into())));
    assert_eq!(stable.candidate, Some(Value::String("headless-a".into())));
    assert!(with_policy.summary.gaps >= 1);
}

#[test]
fn mode_seed_mismatch_is_recorded_as_a_confounder() {
    let mut report = fixture("report.json");
    set_mode_observation(
        &mut report,
        "headless",
        "render",
        Value::String("headless-a".into()),
    );
    set_mode_observation(
        &mut report,
        "headed",
        "render",
        Value::String("headed-b".into()),
    );
    for run in report["runs"].as_array_mut().expect("runs") {
        run["configuration"]["seed"] = Value::String(
            match run["configuration"]["mode"].as_str() {
                Some("headless") => "seed-headless",
                _ => "seed-headed",
            }
            .to_string(),
        );
    }
    let policy = serde_json::json!({
        "schema": "cloakium.audit.policy/1",
        "allowlist": [],
        "stableFields": ["render"]
    });
    let comparison = compare(&report, &report, Some(&policy));
    assert!(comparison
        .confounders
        .iter()
        .any(|confounder| confounder.axis == "seed"));
    assert!(comparison
        .differences
        .iter()
        .filter(|difference| difference.classification == "stable-field-difference")
        .all(|difference| difference.confounders.iter().any(|axis| axis == "seed")));
}

#[test]
fn foreign_target_errors_are_not_attributed_to_the_selected_target() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut report = fixture("report.json");
    let other_target = {
        let mut target = report["targets"][0].clone();
        target["id"] = Value::String("other".to_string());
        target["label"] = Value::String("Other".to_string());
        target
    };
    report["targets"]
        .as_array_mut()
        .expect("targets")
        .push(other_target);
    let baseline_runs = report["runs"].as_array().expect("runs").clone();
    for mut run in baseline_runs {
        let id = run["configuration"]["id"].as_str().expect("id");
        let suffix = id.strip_prefix("baseline-").unwrap_or(id);
        run["configuration"]["id"] = Value::String(format!("other-{suffix}"));
        run["configuration"]["targetId"] = Value::String("other".to_string());
        report["runs"].as_array_mut().expect("runs").push(run);
    }
    report["errors"] = serde_json::json!([
        {
            "kind": "execution",
            "phase": "aux",
            "configurationId": "baseline-headless-1",
            "message": "own-target auxiliary error"
        },
        {
            "kind": "execution",
            "phase": "aux",
            "configurationId": "other-headless-1",
            "message": "foreign-target auxiliary error"
        },
        {
            "kind": "execution",
            "phase": "aux",
            "message": "report-level auxiliary error"
        },
        {
            "kind": "execution",
            "phase": "aux",
            "configurationId": "unknown-configuration",
            "message": "unknown-configuration auxiliary error"
        }
    ]);
    report["complete"] = Value::Bool(false);
    report["completeness"] = Value::Array(Vec::new());
    let report_path = directory.path().join("two-target-report.json");
    std::fs::write(&report_path, serde_json::to_vec(&report).expect("json")).expect("write");
    let output = directory.path().join("comparison.json");
    let (_, comparison) = compare::execute(&CompareOptions {
        baseline: report_path.clone(),
        candidate: report_path,
        policy: None,
        plan: None,
        output,
        baseline_target: Some("baseline".to_string()),
        candidate_target: Some("baseline".to_string()),
        force: true,
    })
    .expect("compare");
    let execution: Vec<_> = comparison
        .differences
        .iter()
        .filter(|difference| difference.classification == "execution-error")
        .collect();
    assert_eq!(execution.len(), 3, "{execution:#?}");
    assert_eq!(
        execution
            .iter()
            .filter(|difference| difference.mode.is_none())
            .count(),
        2
    );
    assert_eq!(
        execution
            .iter()
            .filter(|difference| difference.mode == Some(cloakium_audit::model::Mode::Headless))
            .count(),
        1
    );
    assert!(execution
        .iter()
        .all(|difference| !difference.detail.contains("foreign-target")));
}
