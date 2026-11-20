use std::path::PathBuf;

use cloakium_audit::inventory::InventoryBundle;
use cloakium_audit::model::Plan;
use cloakium_audit::policy::Policy;
use cloakium_audit::report::{Report, RunnerReport};
use cloakium_audit::validate;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/audit/schema/fixtures")
        .join(name)
}

#[test]
fn plan_fixture_is_valid_and_complete() {
    let plan: Plan = serde_json::from_slice(&std::fs::read(fixture("plan.json")).expect("read"))
        .expect("parse plan");
    let validation = validate::plan(&plan, "plan.json");
    assert!(validation.valid, "{:?}", validation.findings);
    assert!(validation.complete, "{:?}", validation.completeness);
}

#[test]
fn report_fixtures_are_valid_and_honest_about_completeness() {
    let report: Report =
        serde_json::from_slice(&std::fs::read(fixture("report.json")).expect("read"))
            .expect("parse report");
    let validation = validate::report(&report, "report.json");
    assert!(validation.valid, "{:?}", validation.findings);
    assert!(validation.complete, "{:?}", validation.completeness);

    let candidate: Report =
        serde_json::from_slice(&std::fs::read(fixture("report-candidate.json")).expect("read"))
            .expect("parse candidate report");
    let validation = validate::report(&candidate, "report-candidate.json");
    assert!(validation.valid, "{:?}", validation.findings);
    assert!(!validation.complete);
    assert!(!candidate.complete);
}

#[test]
fn runner_fixture_matches_the_whole_plan_protocol() {
    let runner: RunnerReport =
        serde_json::from_slice(&std::fs::read(fixture("runner.json")).expect("read"))
            .expect("parse runner");
    let validation = validate::runner(&runner, "runner.json");
    assert!(validation.valid, "{:?}", validation.findings);
    assert_eq!(runner.runs.len(), 4);
}

#[test]
fn inventory_and_policy_fixtures_parse() {
    let inventory: InventoryBundle =
        serde_json::from_slice(&std::fs::read(fixture("inventory.json")).expect("read"))
            .expect("parse inventory");
    assert_eq!(inventory.targets.len(), 1);
    let policy: Policy =
        serde_json::from_slice(&std::fs::read(fixture("policy.json")).expect("read"))
            .expect("parse policy");
    policy.validate().expect("valid policy");
}

#[test]
fn catalog_fixture_parses_and_is_marked_unknown() {
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture("catalog.json")).expect("read"))
            .expect("parse catalog");
    assert_eq!(value["schema"], "cloakium.audit.catalog/1");
    assert_eq!(value["rows"][0]["unknown"], true);
    assert_eq!(value["rows"][0]["gap"], true);
}

#[test]
fn every_published_schema_is_json() {
    for name in cloakium_audit::schema::NAMES {
        let text = cloakium_audit::schema::text(name).expect("schema");
        let value: serde_json::Value = serde_json::from_str(text).expect(name);
        assert_eq!(value["$id"], format!("cloakium.audit.{name}/1"));
    }
    let all = cloakium_audit::schema::all().expect("all schemas");
    assert_eq!(all["schema"], "cloakium.audit.schemas/1");
}

#[test]
fn script_launcher_fixture_is_accepted_as_a_launcher_record() {
    let bundle: InventoryBundle = serde_json::from_slice(
        &std::fs::read(fixture("inventory-script-launcher.json")).expect("read"),
    )
    .expect("parse");
    let target = &bundle.targets[0];
    assert_eq!(
        target.artifact.kind,
        cloakium_audit::inventory::FileKind::Elf
    );
    assert_eq!(
        target.executable.kind,
        cloakium_audit::inventory::FileKind::Script
    );
    assert!(target.executable.elf.is_none());
}

#[test]
fn execution_context_schema_and_fixture_are_published() {
    let text = cloakium_audit::schema::text("execution").expect("schema");
    let value: serde_json::Value = serde_json::from_str(text).expect("json");
    assert_eq!(value["$id"], "cloakium.audit.execution/1");
    let fixture: serde_json::Value =
        serde_json::from_slice(&std::fs::read(fixture("execution.json")).expect("read"))
            .expect("fixture");
    assert_eq!(fixture["schema"], "cloakium.audit.execution/1");
}
