use std::path::PathBuf;

use cloakium_audit::compare::{self, CompareOptions};
use cloakium_audit::model::Plan;
use cloakium_audit::report::Report;
use cloakium_audit::validate;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/audit/schema/fixtures")
        .join(name)
}

fn plan() -> Plan {
    serde_json::from_slice(&std::fs::read(fixture("plan.json")).expect("read")).expect("plan")
}

fn report() -> Report {
    serde_json::from_slice(&std::fs::read(fixture("report.json")).expect("read")).expect("report")
}

fn with_second_profile(mut plan: Plan) -> Plan {
    for configuration in &mut plan.configurations {
        configuration.profile_id = "profile-a".to_string();
        configuration.id = format!("profile-a-{}", configuration.id);
    }
    let clones = plan
        .configurations
        .iter()
        .cloned()
        .map(|mut configuration| {
            configuration.profile_id = "profile-b".to_string();
            configuration.id = format!("profile-b-{}", configuration.id);
            configuration
        })
        .collect::<Vec<_>>();
    plan.configurations.extend(clones);
    plan
}

fn report_with_second_profile(mut report: Report) -> Report {
    for run in &mut report.runs {
        run.configuration.profile_id = "profile-a".to_string();
        run.configuration.id = format!("profile-a-{}", run.configuration.id);
    }
    let clones = report
        .runs
        .iter()
        .cloned()
        .map(|mut run| {
            run.configuration.profile_id = "profile-b".to_string();
            run.configuration.id = format!("profile-b-{}", run.configuration.id);
            run
        })
        .collect::<Vec<_>>();
    report.runs.extend(clones);
    report
}

#[test]
fn plan_completeness_is_per_profile_and_requires_both_modes_and_repeatability() {
    let plan = with_second_profile(plan());
    let validation = validate::plan(&plan, "plan.json");
    assert!(validation.valid, "{:?}", validation.findings);
    assert!(validation.complete, "{:?}", validation.completeness);

    let mut missing = plan.clone();
    missing.configurations.retain(|configuration| {
        !(configuration.profile_id == "profile-b"
            && configuration.mode == cloakium_audit::model::Mode::Headed
            && configuration.iteration == 2)
    });
    let validation = validate::plan(&missing, "plan.json");
    assert!(validation.valid);
    assert!(!validation.complete);
    assert!(validation
        .completeness
        .iter()
        .any(|reason| reason.contains("profile-b") && reason.contains("headed")));
}

#[test]
fn plan_rejects_duplicate_configuration_keys_even_with_unique_ids() {
    let mut plan = plan();
    let mut duplicate = plan.configurations[0].clone();
    duplicate.id = "unique-id-but-duplicate-key".to_string();
    plan.configurations.push(duplicate);
    let validation = validate::plan(&plan, "plan.json");
    assert!(!validation.valid);
    assert!(validation
        .findings
        .iter()
        .any(|finding| finding.code == "configuration.ambiguous"));
}

#[test]
fn report_completeness_is_per_profile_and_requires_both_modes_and_repeatability() {
    let report = report_with_second_profile(report());
    let validation = validate::report(&report, "report.json");
    assert!(validation.valid, "{:?}", validation.findings);
    assert!(validation.complete, "{:?}", validation.completeness);

    let mut missing = report.clone();
    missing.complete = false;
    missing.runs.retain(|run| {
        !(run.configuration.profile_id == "profile-b"
            && run.configuration.mode == cloakium_audit::model::Mode::Headed
            && run.configuration.iteration == 2)
    });
    let validation = validate::report(&missing, "report.json");
    assert!(validation.valid);
    assert!(!validation.complete);
    assert!(validation
        .completeness
        .iter()
        .any(|reason| reason.contains("profile-b") && reason.contains("headed")));
}

#[test]
fn report_rejects_duplicate_run_keys_even_with_unique_ids() {
    let mut report = report();
    let mut duplicate = report.runs[0].clone();
    duplicate.configuration.id = "unique-run-id-but-duplicate-key".to_string();
    report.runs.push(duplicate);
    let validation = validate::report(&report, "report.json");
    assert!(!validation.valid);
    assert!(validation
        .findings
        .iter()
        .any(|finding| finding.code == "run.ambiguous"));
}

#[test]
fn scenario_mismatch_across_modes_is_a_coverage_gap_not_a_fake_pair() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut report = report();
    report.complete = false;
    for run in &mut report.runs {
        run.configuration.scenario_ids = Some(vec![match run.configuration.mode {
            cloakium_audit::model::Mode::Headless => "scenario-headless".to_string(),
            cloakium_audit::model::Mode::Headed => "scenario-headed".to_string(),
        }]);
    }
    let path = directory.path().join("scenario-report.json");
    cloakium_audit::storage::write_private_json(&path, &report, false).expect("report");
    let output = directory.path().join("compare.json");
    let (_, comparison) = compare::execute(&CompareOptions {
        baseline: path.clone(),
        candidate: path,
        policy: None,
        plan: None,
        output,
        baseline_target: None,
        candidate_target: None,
        force: true,
    })
    .expect("compare");
    assert!(comparison
        .gaps
        .iter()
        .any(|difference| difference.classification == "coverage-gap"
            && difference.detail.contains("scenario/suite")));
    assert!(!comparison
        .gaps
        .iter()
        .any(
            |difference| difference.classification == "headless-regression"
                || difference.classification == "headless-improvement"
        ));
}

#[test]
fn uncertain_process_cleanup_is_valid_but_incomplete() {
    let mut report = report();
    report.complete = false;
    report.process_cleanup = Some(cloakium_audit::tree::ProcessCleanup {
        root_pid: 999_999,
        root_start_ticks: 1,
        discovered: Vec::new(),
        signalled: Vec::new(),
        residual: Vec::new(),
        clean: false,
    });
    let validation = validate::report(&report, "report.json");
    assert!(validation.valid, "{:?}", validation.findings);
    assert!(!validation.complete);
    assert!(validation
        .completeness
        .iter()
        .any(|reason| reason.contains("uncertain or not clean")));
}

#[test]
fn clean_process_cleanup_with_residual_ids_is_rejected() {
    let mut report = report();
    report.complete = false;
    report.process_cleanup = Some(cloakium_audit::tree::ProcessCleanup {
        root_pid: 999_999,
        root_start_ticks: 1,
        discovered: vec![cloakium_audit::tree::OwnedProcess {
            pid: 424_242,
            start_ticks: 7,
        }],
        signalled: Vec::new(),
        residual: vec![cloakium_audit::tree::OwnedProcess {
            pid: 424_242,
            start_ticks: 7,
        }],
        clean: true,
    });
    let validation = validate::report(&report, "report.json");
    assert!(!validation.valid);
    assert!(validation
        .findings
        .iter()
        .any(|finding| finding.code == "processCleanup.clean"));
}

#[test]
fn a_report_cannot_claim_complete_with_uncertain_cleanup() {
    let mut report = report();
    report.process_cleanup = Some(cloakium_audit::tree::ProcessCleanup {
        root_pid: 999_999,
        root_start_ticks: 1,
        discovered: Vec::new(),
        signalled: Vec::new(),
        residual: Vec::new(),
        clean: false,
    });
    report.complete = true;
    let validation = validate::report(&report, "report.json");
    assert!(!validation.valid);
    assert!(validation
        .findings
        .iter()
        .any(|finding| finding.code == "complete.claim"));
}
