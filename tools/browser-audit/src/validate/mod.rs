//! Strict plan, report and runner validation.
use std::collections::{BTreeMap, BTreeSet};

use crate::model::{is_safe_id, Mode, Plan, PLAN_SCHEMA};
use crate::report::{
    CleanupStatus, EffectiveCheck, Report, RunnerReport, REPORT_SCHEMA, RUNNER_SCHEMA,
};

mod rules;
use rules::*;
mod messages;
mod observations;
mod repeatability;
pub use messages::looks_like_raw_error;
pub(crate) use messages::{cleanup_label, error_kind_label, validate_error};
pub(crate) use observations::validate_observations;
pub(crate) use repeatability::{validate_plan_collections, validate_report_collections};

mod types;
pub use types::{Finding, Severity, Validation};

pub fn plan(plan: &Plan, path: &str) -> Validation {
    let mut validation = Validation::new("plan", path);
    if plan.schema != PLAN_SCHEMA {
        validation.error(
            "schema",
            format!("expected schema {PLAN_SCHEMA}, found {}", plan.schema),
        );
    }
    if !is_safe_id(&plan.id) {
        validation.error("plan.id", "plan id must be a safe ASCII identifier");
    }
    validate_environment_spec(&plan.environment, &mut validation);

    let mut target_ids = BTreeSet::new();
    for target in &plan.targets {
        if !is_safe_id(&target.id) {
            validation.error("target.id", format!("unsafe target id: {}", target.id));
        }
        if !target_ids.insert(target.id.clone()) {
            validation.error(
                "target.duplicate",
                format!("duplicate target id: {}", target.id),
            );
        }
        if target.label.trim().is_empty() {
            validation.error(
                "target.label",
                format!("target {} has an empty label", target.id),
            );
        }
        for (field, value) in [
            ("artifactPath", &target.artifact_path),
            ("executablePath", &target.executable_path),
            ("clientModule", &target.client_module),
        ] {
            if let Err(error) = crate::util::ensure_absolute(value, field) {
                validation.error("target.path", format!("target {}: {error}", target.id));
            }
        }
        for (field, args) in [
            ("args", &target.args),
            ("headlessArgs", &target.headless_args),
            ("headedArgs", &target.headed_args),
        ] {
            validate_args(
                args,
                &format!("target {} {field}", target.id),
                &mut validation,
            );
        }
    }
    if plan.targets.is_empty() {
        validation.error("targets.empty", "a plan needs at least one target");
    }

    let mut configuration_ids = BTreeSet::new();
    let mut match_keys = BTreeSet::new();
    let mut used_targets = BTreeSet::new();
    for configuration in &plan.configurations {
        validate_configuration(configuration, &target_ids, &mut validation);
        if let Some(locale) = configuration
            .context_options
            .get("locale")
            .and_then(|value| value.as_str())
        {
            if locale != plan.environment.locale {
                validation.error(
                    "configuration.locale",
                    format!(
                        "configuration {} locale overrides the environment locale",
                        configuration.id
                    ),
                );
            }
        }
        if !configuration_ids.insert(configuration.id.clone()) {
            validation.error(
                "configuration.duplicate",
                format!("duplicate configuration id: {}", configuration.id),
            );
        }
        if !match_keys.insert((
            configuration.target_id.clone(),
            configuration.mode,
            configuration.iteration,
            configuration.profile_id.clone(),
            configuration.scenario_signature(),
        )) {
            validation.error(
                "configuration.ambiguous",
                format!(
                    "configuration {} duplicates target/mode/iteration/profile",
                    configuration.id
                ),
            );
        }
        used_targets.insert(configuration.target_id.clone());
    }
    if plan.configurations.is_empty() {
        validation.error(
            "configurations.empty",
            "a plan needs at least one configuration",
        );
    }
    for target in &plan.targets {
        if !used_targets.contains(&target.id) {
            validation.error(
                "configuration.missing",
                format!("target {} has no configurations", target.id),
            );
        }
    }

    validate_plan_collections(plan, &mut validation);
    validation.finalize()
}

pub fn report(report: &Report, path: &str) -> Validation {
    let mut validation = Validation::new("report", path);
    if report.schema != REPORT_SCHEMA {
        validation.error(
            "schema",
            format!("expected schema {REPORT_SCHEMA}, found {}", report.schema),
        );
    }
    if !is_safe_id(&report.run_id) {
        validation.error("runId", "runId must be a safe ASCII identifier");
    }
    if !is_safe_id(&report.plan_id) {
        validation.error("planId", "planId must be a safe ASCII identifier");
    }
    if !crate::hash::is_sha256(&report.plan_hash) {
        validation.error("planHash", "planHash must be a lowercase SHA-256 digest");
    }
    validate_suite(
        &report.suite.manifest_sha256,
        &report.suite.probes,
        &mut validation,
    );
    if !crate::hash::is_sha256(&report.suite.runner.sha256) {
        validation.error(
            "suite.runner",
            "runner sha256 must be a lowercase SHA-256 digest",
        );
    }
    if !crate::hash::is_sha256(&report.suite.node.sha256) {
        validation.error(
            "suite.node",
            "node sha256 must be a lowercase SHA-256 digest",
        );
    }
    for (field, value) in [
        ("suite.runner.path", &report.suite.runner.path),
        ("suite.node.path", &report.suite.node.path),
    ] {
        if let Err(error) = crate::util::ensure_absolute(value, field) {
            validation.error("suite.path", error.to_string());
        }
    }
    if report.suite.node.version.trim().is_empty() {
        validation.error("suite.node.version", "node version cannot be empty");
    }
    validate_resolved_environment(&report.environment, &mut validation);
    if let Some(cleanup) = &report.process_cleanup {
        validate_process_cleanup(cleanup, &mut validation);
    }
    validate_targets(&report.targets, &mut validation);

    let target_ids: BTreeSet<String> = report
        .targets
        .iter()
        .map(|target| target.id.clone())
        .collect();
    let mut run_ids = BTreeSet::new();
    let mut run_keys = BTreeSet::new();
    let mut feature_sets: BTreeMap<String, BTreeSet<Mode>> = BTreeMap::new();
    for run in &report.runs {
        validate_configuration(&run.configuration, &target_ids, &mut validation);
        if !run_ids.insert(run.configuration.id.clone()) {
            validation.error(
                "run.duplicate",
                format!("duplicate run configuration: {}", run.configuration.id),
            );
        }
        if !run_keys.insert((
            run.configuration.target_id.clone(),
            run.configuration.match_key(),
        )) {
            validation.error(
                "run.ambiguous",
                format!(
                    "run {} duplicates a target/profile/scenario/mode/iteration key",
                    run.configuration.id
                ),
            );
        }
        if !target_ids.contains(&run.configuration.target_id) {
            validation.error(
                "run.target",
                format!("run {} references an unknown target", run.configuration.id),
            );
        }
        if run.version.trim().is_empty() {
            validation.error(
                "run.version",
                format!("run {} has no browser version", run.configuration.id),
            );
        }
        if run.client.version.trim().is_empty() {
            validation.error(
                "run.client.version",
                format!(
                    "run {} client version cannot be empty",
                    run.configuration.id
                ),
            );
        }
        if !crate::hash::is_sha256(&run.client.sha256) {
            validation.error(
                "run.client",
                format!("run {} client sha256 is invalid", run.configuration.id),
            );
        }
        for (field, value) in [
            ("packageSha256", &run.client.package_sha256),
            ("patchManifestSha256", &run.client.patch_manifest_sha256),
            ("entrySha256", &run.client.entry_sha256),
        ] {
            if value
                .as_deref()
                .is_some_and(|digest| !crate::hash::is_sha256(digest))
            {
                validation.error(
                    "run.client",
                    format!(
                        "run {} {field} is not a SHA-256 digest",
                        run.configuration.id
                    ),
                );
            }
        }
        if let Err(error) = crate::util::ensure_absolute(&run.client.path, "client.path") {
            validation.error(
                "run.client",
                format!("run {}: {error}", run.configuration.id),
            );
        }
        validate_resolved_environment(&run.environment, &mut validation);
        validate_observations(&run.observations, &mut validation);
        if run.cleanup.status == CleanupStatus::Clean
            && (run.cleanup.browser_closed == Some(false)
                || run.cleanup.contexts_closed == Some(false)
                || run.cleanup.process_exited == Some(false))
        {
            validation.error(
                "cleanup.claim",
                format!(
                    "run {} claims clean cleanup while a resource is open",
                    run.configuration.id
                ),
            );
        }
        for observation in &run.observations {
            feature_sets
                .entry(observation.id.clone())
                .or_default()
                .insert(run.configuration.mode);
        }
        if run.cleanup.status != CleanupStatus::Clean {
            validation.incomplete(format!(
                "run {} cleanup is {}",
                run.configuration.id,
                cleanup_label(run.cleanup.status)
            ));
        }
        if run.observations.is_empty() {
            validation.incomplete(format!("run {} has no observations", run.configuration.id));
        }
        for observation in &run.observations {
            if observation.result.checks.is_empty() {
                validation.incomplete(format!(
                    "run {} observation {} has no functional checks",
                    run.configuration.id, observation.id
                ));
            }
            if observation.status != crate::report::ObservationStatus::Observed {
                validation.incomplete(format!(
                    "run {} observation {} is not observed",
                    run.configuration.id, observation.id
                ));
            }
            for check in &observation.result.checks {
                if check.effective() != EffectiveCheck::Pass {
                    validation.incomplete(format!(
                        "run {} observation {} check {} is {}",
                        run.configuration.id,
                        observation.id,
                        check.name,
                        check.effective_label()
                    ));
                }
            }
        }
    }
    validate_report_collections(report, &mut validation);
    for (feature, modes) in feature_sets {
        for mode in [Mode::Headless, Mode::Headed] {
            if !modes.contains(&mode) {
                validation.incomplete(format!(
                    "feature {feature} has no {} coverage",
                    mode.as_str()
                ));
            }
        }
    }
    for error in &report.errors {
        validate_error(error, &mut validation);
        validation.incomplete(format!(
            "report records a {} error in {}: {}",
            error_kind_label(error.kind),
            error.phase,
            error.message
        ));
    }
    if report.complete && (!validation.valid || !validation.complete) {
        validation.error(
            "complete.claim",
            "report claims complete while errors, missing coverage or non-pass checks remain",
        );
    }
    validation.finalize()
}

pub fn runner(fragment: &RunnerReport, path: &str) -> Validation {
    let mut validation = Validation::new("runner", path);
    if fragment.schema != RUNNER_SCHEMA {
        validation.error(
            "schema",
            format!("expected schema {RUNNER_SCHEMA}, found {}", fragment.schema),
        );
    }
    if let Some(plan_id) = &fragment.plan_id {
        if !is_safe_id(plan_id) {
            validation.error("planId", "runner planId is not safe");
        }
    }
    if let Some(plan_hash) = &fragment.plan_hash {
        if !crate::hash::is_sha256(plan_hash) {
            validation.error("planHash", "runner planHash is not a SHA-256 digest");
        }
    }
    if let Some(environment) = &fragment.environment {
        validate_resolved_environment(environment, &mut validation);
    }
    if let Some(suite) = &fragment.suite {
        let manifest = suite
            .manifest_sha256
            .clone()
            .unwrap_or_else(|| "0".repeat(64));
        validate_suite(&manifest, &suite.probes, &mut validation);
        if suite.manifest_sha256.is_none() {
            validation.warn(
                "suite.manifest",
                "runner did not echo the suite manifest hash",
            );
        }
    }
    let mut ids = BTreeSet::new();
    for run in &fragment.runs {
        validate_configuration(&run.configuration, &BTreeSet::new(), &mut validation);
        if !ids.insert(run.configuration.id.clone()) {
            validation.error(
                "run.duplicate",
                format!("duplicate runner configuration {}", run.configuration.id),
            );
        }
        if run.version.trim().is_empty() {
            validation.error(
                "version",
                format!("run {} has no browser version", run.configuration.id),
            );
        }
        if run.client.version.trim().is_empty() {
            validation.error(
                "client.version",
                format!(
                    "run {} client version cannot be empty",
                    run.configuration.id
                ),
            );
        }
        if !crate::hash::is_sha256(&run.client.sha256) {
            validation.error(
                "client",
                format!(
                    "run {} client sha256 must be a lowercase SHA-256 digest",
                    run.configuration.id
                ),
            );
        }
        for (field, value) in [
            ("packageSha256", &run.client.package_sha256),
            ("patchManifestSha256", &run.client.patch_manifest_sha256),
            ("entrySha256", &run.client.entry_sha256),
        ] {
            if value
                .as_deref()
                .is_some_and(|digest| !crate::hash::is_sha256(digest))
            {
                validation.error(
                    "client",
                    format!(
                        "run {} {field} is not a SHA-256 digest",
                        run.configuration.id
                    ),
                );
            }
        }
        if let Err(error) = crate::util::ensure_absolute(&run.client.path, "client.path") {
            validation.error("client", error.to_string());
        }
        validate_resolved_environment(&run.environment, &mut validation);
        validate_observations(&run.observations, &mut validation);
    }
    if fragment.runs.is_empty() {
        validation.incomplete("runner returned no runs");
    }
    for error in &fragment.errors {
        validate_error(error, &mut validation);
    }
    validation.finalize()
}

#[cfg(test)]
mod tests;
