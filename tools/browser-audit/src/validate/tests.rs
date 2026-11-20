use std::collections::BTreeSet;

use super::plan as validate_plan;
use crate::model::Seed;
use crate::plan::{self, PlanOptions};

fn options() -> PlanOptions {
    PlanOptions {
        baseline: "/opt/baseline/chrome".to_string(),
        candidate: "/opt/candidate/chrome".to_string(),
        baseline_launcher: None,
        candidate_launcher: None,
        client_module: "/opt/client/index.js".to_string(),
        iterations: 2,
        environment_id: "test".to_string(),
        locale: "en-US".to_string(),
        timezone_id: "UTC".to_string(),
        fontconfig_file: None,
        fontconfig_path: None,
        font_manifest_sha256: None,
        display: PlanOptions::default_display(),
        notes: None,
        suites: vec!["fingerprint".to_string()],
        probe_ids: None,
        scenario_ids: None,
        suite_options: Default::default(),
        probe_config: None,
        seed: Some(Seed::Text("42424".to_string())),
        baseline_layer: crate::model::Layer::Engine,
        candidate_layer: crate::model::Layer::Engine,
        baseline_identity: crate::model::Identity::Native,
        candidate_identity: crate::model::Identity::Native,
    }
}

#[test]
fn generated_plan_is_valid_and_complete() {
    let generated = plan::generate(&options()).expect("plan");
    let validation = validate_plan(&generated, "plan.json");
    assert!(validation.valid, "{:?}", validation.findings);
    assert!(validation.complete, "{:?}", validation.completeness);
}

#[test]
fn one_iteration_is_valid_but_incomplete() {
    let mut options = options();
    options.iterations = 1;
    let generated = plan::generate(&options).expect("plan");
    let validation = validate_plan(&generated, "plan.json");
    assert!(validation.valid);
    assert!(!validation.complete);
    assert!(validation
        .completeness
        .iter()
        .any(|reason| reason.contains("2 iterations")));
}

#[test]
fn unknown_target_and_duplicate_ids_are_errors() {
    let mut generated = plan::generate(&options()).expect("plan");
    generated.configurations[0].target_id = "missing".to_string();
    generated.configurations[1].id = generated.configurations[0].id.clone();
    let validation = validate_plan(&generated, "plan.json");
    assert!(!validation.valid);
    let codes: BTreeSet<&str> = validation
        .findings
        .iter()
        .map(|f| f.code.as_str())
        .collect();
    assert!(codes.contains("configuration.target"));
    assert!(codes.contains("configuration.duplicate"));
}

#[test]
fn a_posix_locale_is_rejected_as_a_browser_locale() {
    let mut options = options();
    options.locale = "C.UTF-8".to_string();
    let generated = plan::generate(&options).expect("plan");
    let validation = validate_plan(&generated, "plan.json");
    assert!(!validation.valid);
    assert!(validation
        .findings
        .iter()
        .any(|finding| finding.code == "environment.locale"));
}
