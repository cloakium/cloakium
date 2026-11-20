use std::path::PathBuf;

use cloakium_audit::difference::{causal_attribution, confounders};
use cloakium_audit::report::{Report, RunRecord};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/audit/schema/fixtures")
        .join(name)
}

fn base_report() -> Report {
    let mut report: Report =
        serde_json::from_slice(&std::fs::read(fixture("report.json")).expect("read"))
            .expect("parse");
    report.suite.probes = vec![cloakium_audit::report::ProbeRecord {
        id: "navigator.webdriver".to_string(),
        sha256: "a".repeat(64),
    }];
    report
}

fn rename(report: &mut Report, id: &str) {
    report.targets[0].id = id.to_string();
    report.targets[0].label = id.to_string();
    for run in &mut report.runs {
        run.configuration.target_id = id.to_string();
        run.configuration.id = format!("{id}-{}", run.configuration.mode.as_str());
    }
}

fn clone_runs(
    report: &Report,
    id: &str,
    version: &str,
    client_version: &str,
    client_sha: &str,
) -> Vec<RunRecord> {
    let mut runs = report.runs.clone();
    for run in &mut runs {
        run.configuration.target_id = id.to_string();
        run.configuration.id = format!(
            "{id}-{}-{}",
            run.configuration.mode.as_str(),
            run.configuration.iteration
        );
        run.version = version.to_string();
        run.client.version = client_version.to_string();
        run.client.sha256 = client_sha.to_string();
    }
    runs
}

fn target<'a>(report: &'a Report, id: &str) -> &'a cloakium_audit::inventory::InventoryRecord {
    report
        .targets
        .iter()
        .find(|target| target.id == id)
        .expect("target")
}

#[test]
fn selected_targets_filter_version_client_seed_and_args_confounders() {
    let mut report = base_report();
    let base_target = report.targets[0].clone();

    let mut pro = base_target.clone();
    pro.id = "pro156".to_string();
    pro.label = "Pro 156".to_string();
    pro.args = vec!["--pro-profile".to_string()];
    pro.headless_args = vec!["--pro-headless".to_string()];
    let mut patched = base_target.clone();
    patched.id = "c157".to_string();
    patched.label = "C 157".to_string();
    patched.identity = cloakium_audit::model::Identity::Persona;
    patched.args = vec!["--patched-profile".to_string()];
    patched.headless_args = vec!["--patched-headless".to_string()];
    let mut unrelated = base_target.clone();
    unrelated.id = "unrelated".to_string();
    unrelated.label = "Unrelated".to_string();
    unrelated.layer = cloakium_audit::model::Layer::Product;
    unrelated.args = vec!["--unrelated-flag".to_string()];

    report.targets = vec![pro.clone(), patched.clone(), unrelated.clone()];
    report.runs = [
        clone_runs(&report, "pro156", "156.0", "pw156", &"1".repeat(64)),
        clone_runs(&report, "c157", "157.0", "pw157", &"2".repeat(64)),
        clone_runs(
            &report,
            "unrelated",
            "999.0",
            "unrelated-client",
            &"9".repeat(64),
        ),
    ]
    .concat();

    let baseline_target = target(&report, "pro156");
    let candidate_target = target(&report, "c157");
    let found = confounders(&report, &report, baseline_target, candidate_target);
    let axes: Vec<&str> = found.iter().map(|item| item.axis.as_str()).collect();
    assert!(axes.contains(&"browser-version"), "{axes:?}");
    assert!(axes.contains(&"client"), "{axes:?}");
    assert!(axes.contains(&"identity"), "{axes:?}");
    assert!(!axes.contains(&"layer"), "{axes:?}");
    assert!(axes.contains(&"config-args"), "{axes:?}");
    assert_ne!(causal_attribution(&found), "unconfounded");

    let rendered = found
        .iter()
        .map(|item| format!("{} {} {}", item.axis, item.baseline, item.candidate))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!rendered.contains("999.0"), "{rendered}");
    assert!(!rendered.contains("unrelated-client"), "{rendered}");
    let version = found
        .iter()
        .find(|item| item.axis == "browser-version")
        .expect("version");
    assert_eq!(version.baseline, "156.0");
    assert_eq!(version.candidate, "157.0");
}

#[test]
fn selected_probe_hashes_and_runner_identity_are_confounders() {
    let baseline = base_report();
    let mut candidate = base_report();
    rename(&mut candidate, "candidate");
    candidate.suite.probes[0].sha256 = "b".repeat(64);

    let found = confounders(
        &baseline,
        &candidate,
        &baseline.targets[0],
        &candidate.targets[0],
    );
    assert!(found.iter().any(|item| item.axis == "probe-source"));
    assert_eq!(causal_attribution(&found), "environment-confounded");

    // An unrelated registry entry must not contaminate selected facts.
    let mut unrelated = base_report();
    rename(&mut unrelated, "candidate");
    unrelated
        .suite
        .probes
        .push(cloakium_audit::report::ProbeRecord {
            id: "unrelated/probe".to_string(),
            sha256: "d".repeat(64),
        });
    let found = confounders(
        &baseline,
        &unrelated,
        &baseline.targets[0],
        &unrelated.targets[0],
    );
    assert!(!found.iter().any(|item| item.axis == "probe-source"));

    // Missing provenance on the selected feature is not proof of equality.
    let mut missing = base_report();
    rename(&mut missing, "candidate");
    missing.suite.probes.clear();
    let found = confounders(
        &baseline,
        &missing,
        &baseline.targets[0],
        &missing.targets[0],
    );
    assert!(found.iter().any(|item| item.axis == "probe-source"));

    let mut runner = base_report();
    rename(&mut runner, "candidate");
    runner.suite.runner.sha256 = "f".repeat(64);
    let found = confounders(&baseline, &runner, &baseline.targets[0], &runner.targets[0]);
    assert!(found.iter().any(|item| item.axis == "runner"));

    let mut manifest = base_report();
    rename(&mut manifest, "candidate");
    manifest.suite.manifest_sha256 = "e".repeat(64);
    let found = confounders(
        &baseline,
        &manifest,
        &baseline.targets[0],
        &manifest.targets[0],
    );
    assert!(found.iter().any(|item| item.axis == "probe-source"));
}

#[test]
fn selected_run_environment_receipt_font_and_config_hashes_are_compared() {
    let mut baseline = base_report();
    for run in &mut baseline.runs {
        run.environment.environment_receipt = Some(serde_json::json!({
            "fontManifestSha256": "a".repeat(64),
            "configSha256": "1".repeat(64)
        }));
    }
    let mut candidate = base_report();
    rename(&mut candidate, "candidate");
    for run in &mut candidate.runs {
        run.environment.environment_receipt = Some(serde_json::json!({
            "fontManifestSha256": "b".repeat(64),
            "configSha256": "2".repeat(64)
        }));
    }
    let found = confounders(
        &baseline,
        &candidate,
        &baseline.targets[0],
        &candidate.targets[0],
    );
    let axes: Vec<&str> = found.iter().map(|item| item.axis.as_str()).collect();
    assert!(axes.contains(&"font"), "{axes:?}");
    assert!(axes.contains(&"config"), "{axes:?}");
    assert_eq!(causal_attribution(&found), "environment-confounded");
}

#[test]
fn mode_specific_target_args_participate_in_the_effective_args_confounder() {
    let mut baseline = base_report();
    baseline.targets[0].headless_args = vec!["--headless-a".to_string()];
    baseline.targets[0].headed_args = vec!["--headed-a".to_string()];
    let mut candidate = base_report();
    rename(&mut candidate, "candidate");
    candidate.targets[0].headless_args = vec!["--headless-b".to_string()];
    candidate.targets[0].headed_args = vec!["--headed-b".to_string()];
    let found = confounders(
        &baseline,
        &candidate,
        &baseline.targets[0],
        &candidate.targets[0],
    );
    assert!(found.iter().any(|item| item.axis == "config-args"));
    assert!(found
        .iter()
        .filter(|item| item.axis == "config-args")
        .all(
            |item| !item.baseline.contains("headless-a") && !item.candidate.contains("headless-b")
        ));
}

#[test]
fn compare_same_full_report_with_explicit_targets_detects_selected_confounders() {
    let directory = tempfile::tempdir().expect("tempdir");
    let mut report = base_report();
    let base_target = report.targets[0].clone();
    let mut pro = base_target.clone();
    pro.id = "pro156".to_string();
    pro.label = "Pro 156".to_string();
    pro.args = vec!["--pro-profile".to_string()];
    let mut patched = base_target.clone();
    patched.id = "c157".to_string();
    patched.label = "C 157".to_string();
    patched.identity = cloakium_audit::model::Identity::Persona;
    patched.args = vec!["--patched-profile".to_string()];
    let mut unrelated = base_target.clone();
    unrelated.id = "unrelated".to_string();
    unrelated.label = "Unrelated".to_string();
    unrelated.layer = cloakium_audit::model::Layer::Product;
    unrelated.args = vec!["--unrelated".to_string()];
    report.targets = vec![pro, patched, unrelated];
    report.runs = [
        clone_runs(&report, "pro156", "156.0", "pw156", &"1".repeat(64)),
        clone_runs(&report, "c157", "157.0", "pw157", &"2".repeat(64)),
        clone_runs(
            &report,
            "unrelated",
            "999.0",
            "unrelated-client",
            &"9".repeat(64),
        ),
    ]
    .concat();
    let report_path = directory.path().join("full-report.json");
    cloakium_audit::storage::write_private_json(&report_path, &report, false).expect("report");
    let output = directory.path().join("comparison.json");
    let (_, comparison) =
        cloakium_audit::compare::execute(&cloakium_audit::compare::CompareOptions {
            baseline: report_path.clone(),
            candidate: report_path,
            policy: None,
            plan: None,
            output,
            baseline_target: Some("pro156".to_string()),
            candidate_target: Some("c157".to_string()),
            force: true,
        })
        .expect("compare");
    let axes: Vec<&str> = comparison
        .confounders
        .iter()
        .map(|item| item.axis.as_str())
        .collect();
    assert!(axes.contains(&"browser-version"), "{axes:?}");
    assert!(axes.contains(&"client"), "{axes:?}");
    assert!(axes.contains(&"config-args"), "{axes:?}");
    assert!(axes.contains(&"identity"), "{axes:?}");
    assert_ne!(comparison.causal_attribution, "unconfounded");
    let rendered = comparison
        .confounders
        .iter()
        .map(|item| format!("{} {} {}", item.axis, item.baseline, item.candidate))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!rendered.contains("999.0"), "{rendered}");
    assert!(!rendered.contains("unrelated-client"), "{rendered}");
}

#[test]
fn selected_target_seed_filters_out_unrelated_target_seed() {
    let mut report = base_report();
    let base_target = report.targets[0].clone();
    let mut pro = base_target.clone();
    pro.id = "pro156".to_string();
    let mut c = base_target.clone();
    c.id = "c157".to_string();
    let mut unrelated = base_target.clone();
    unrelated.id = "unrelated".to_string();
    report.targets = vec![pro, c, unrelated];
    report.runs = [
        clone_runs(&report, "pro156", "156.0", "pw156", &"1".repeat(64)),
        clone_runs(&report, "c157", "157.0", "pw157", &"2".repeat(64)),
        clone_runs(
            &report,
            "unrelated",
            "999.0",
            "unrelated-client",
            &"9".repeat(64),
        ),
    ]
    .concat();
    for run in &mut report.runs {
        run.configuration.seed = Some(match run.configuration.target_id.as_str() {
            "pro156" => cloakium_audit::model::Seed::Text("seed-pro".to_string()),
            "c157" => cloakium_audit::model::Seed::Text("seed-c".to_string()),
            _ => cloakium_audit::model::Seed::Text("seed-unrelated-999".to_string()),
        });
    }
    let found = confounders(
        &report,
        &report,
        target(&report, "pro156"),
        target(&report, "c157"),
    );
    let seed = found
        .iter()
        .find(|item| item.axis == "seed")
        .expect("selected seed confounder");
    assert!(seed.baseline.contains("seed-pro"));
    assert!(seed.candidate.contains("seed-c"));
    assert!(!seed.baseline.contains("999"));
    assert!(!seed.candidate.contains("999"));
}

#[test]
fn selected_fixture_origins_are_confounders_when_explicit_and_divergent() {
    let mut baseline = base_report();
    for run in &mut baseline.runs {
        run.environment.diagnostics = Some(serde_json::json!({
            "sharedProbeFixture": {
                "receipt": {
                    "origin": "http://127.0.0.1:4100",
                    "crossOrigin": "http://127.0.0.1:4101"
                }
            }
        }));
    }
    let mut candidate = base_report();
    rename(&mut candidate, "candidate");
    for run in &mut candidate.runs {
        run.environment.diagnostics = Some(serde_json::json!({
            "sharedProbeFixture": {
                "receipt": {
                    "origin": "http://127.0.0.1:4200",
                    "crossOrigin": "http://127.0.0.1:4201"
                }
            }
        }));
    }
    let found = confounders(
        &baseline,
        &candidate,
        &baseline.targets[0],
        &candidate.targets[0],
    );
    assert!(found.iter().any(|item| item.axis == "fixture-origin"));
    assert_eq!(causal_attribution(&found), "environment-confounded");

    let mut same = candidate.clone();
    for run in &mut same.runs {
        run.environment.diagnostics = baseline.runs[0].environment.diagnostics.clone();
    }
    let found = confounders(&baseline, &same, &baseline.targets[0], &same.targets[0]);
    assert!(!found.iter().any(|item| item.axis == "fixture-origin"));

    let mut missing = base_report();
    rename(&mut missing, "candidate");
    let found = confounders(
        &baseline,
        &missing,
        &baseline.targets[0],
        &missing.targets[0],
    );
    assert!(found.iter().any(|item| item.axis == "fixture-origin"));
}
