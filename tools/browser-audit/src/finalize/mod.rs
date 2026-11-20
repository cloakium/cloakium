//! Recover a canonical report from a completed closed run without executing it.
//!
//! This is a postprocessor: it reads the plan, inventory, execution context,
//! original report and runner fragment, verifies their immutable identities,
//! revalidates the fragment with the fixed rules, and writes a new report. It
//! never launches Node or a browser.

use std::collections::BTreeSet;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::Value;

use crate::hash;
use crate::inventory::{self, InventoryBundle};
use crate::model::Plan;
use crate::report::{
    CleanupStatus, ErrorKind, ObservationStatus, PostprocessingRecovery, Report, RunnerReport,
    REPORT_SCHEMA, RUNNER_SCHEMA,
};
use crate::storage;
use crate::time;
use crate::tree::{self, ProcessStatus};
use crate::util;
use crate::validate;

#[derive(Debug, Clone)]
pub struct FinalizeOptions {
    pub run_dir: PathBuf,
    pub output: PathBuf,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecutionRecord {
    schema: String,
    run_id: String,
    plan_id: String,
    plan_hash: String,
    suite_manifest_sha256: String,
    node_sha256: String,
    runner_sha256: String,
    timeout_ms: u64,
}

pub fn execute(options: &FinalizeOptions) -> Result<(PathBuf, Report)> {
    let run_dir = util::absolute(&options.run_dir)?;
    if !run_dir.is_dir() {
        bail!("run directory is not a directory: {}", run_dir.display());
    }
    let output = util::absolute(&options.output)?;
    if output.exists() {
        bail!(
            "refusing to replace an existing report: {}",
            output.display()
        );
    }

    let plan_path = run_dir.join("plan.json");
    let plan_bytes = storage::read_bytes(&plan_path)?;
    let plan_hash = hash::bytes(&plan_bytes);
    let plan: Plan = serde_json::from_slice(&plan_bytes)
        .with_context(|| format!("failed to parse {}", plan_path.display()))?;
    let plan_validation = validate::plan(&plan, &plan_path.to_string_lossy());
    if !plan_validation.valid {
        bail!("cannot finalize an invalid plan");
    }

    let inventory_path = run_dir.join("inventory.json");
    let inventory_bytes = storage::read_bytes(&inventory_path)?;
    let inventory: InventoryBundle = serde_json::from_slice(&inventory_bytes)
        .with_context(|| format!("failed to parse {}", inventory_path.display()))?;
    let inventory_mode = std::fs::metadata(&inventory_path)
        .map(|metadata| metadata.permissions().mode() & 0o777)
        .unwrap_or(0);

    let original_path = run_dir.join("report.json");
    let original_bytes = storage::read_bytes(&original_path)?;
    let original: Report = serde_json::from_slice(&original_bytes)
        .with_context(|| format!("failed to parse the original {}", original_path.display()))?;
    if original.schema != REPORT_SCHEMA {
        bail!("original report has schema {}", original.schema);
    }
    let original_sha256 = hash::bytes(&original_bytes);

    let execution_path = run_dir.join("execution.json");
    let execution: Option<ExecutionRecord> = match storage::read_bytes(&execution_path) {
        Ok(bytes) => Some(
            serde_json::from_slice(&bytes)
                .with_context(|| format!("failed to parse {}", execution_path.display()))?,
        ),
        Err(_) => None,
    };

    let fragment_path = run_dir.join("runner-report.json");
    let fragment_bytes = storage::read_bytes(&fragment_path)?;
    let fragment_sha256 = hash::bytes(&fragment_bytes);
    let parsed_fragment: Option<RunnerReport> = serde_json::from_slice(&fragment_bytes).ok();

    let mut errors = Vec::new();
    let mut limitations = original.limitations.clone();
    let mut invalid_fragment = false;
    let fragment = match parsed_fragment {
        Some(fragment) if fragment.schema == RUNNER_SCHEMA => {
            let validation = validate::runner(&fragment, &fragment_path.to_string_lossy());
            if validation.valid {
                Some(fragment)
            } else {
                invalid_fragment = true;
                let summary = crate::run::invalid_fragment_summary(&run_dir, &validation);
                errors.push(error(ErrorKind::Protocol, "runner", summary));
                None
            }
        }
        _ => {
            invalid_fragment = true;
            errors.push(error(
                ErrorKind::Protocol,
                "runner",
                "runner-report.json is not a valid runner/1 document",
            ));
            None
        }
    };

    if let Some(execution) = &execution {
        verify_execution(
            execution,
            &plan,
            &plan_hash,
            &original,
            fragment.as_ref(),
            &mut errors,
        );
    } else {
        errors.push(error(
            ErrorKind::Protocol,
            "execution",
            "execution.json is missing",
        ));
    }
    if original.plan_hash != plan_hash || original.plan_id != plan.id {
        errors.push(error(
            ErrorKind::Protocol,
            "identity",
            "original report identity does not match plan.json",
        ));
    }
    if inventory_mode != 0o400 {
        errors.push(error(
            ErrorKind::Inventory,
            "inventory",
            "inventory.json is not the immutable 0400 snapshot",
        ));
    }
    if original.targets != inventory.targets {
        errors.push(error(
            ErrorKind::Inventory,
            "inventory",
            "inventory.json does not match the original report targets",
        ));
    }
    let mut inventory_stable = true;
    for record in &inventory.targets {
        if let Err(problem) = inventory::verify_unchanged(record) {
            inventory_stable = false;
            errors.push(error(
                ErrorKind::Inventory,
                "inventory",
                format!("inventory is no longer unchanged: {problem}"),
            ));
        }
    }
    let mut cleanup_ok = true;
    let mut live_owned = false;
    match &original.process_cleanup {
        Some(receipt) => {
            if !receipt.clean || !receipt.residual.is_empty() {
                cleanup_ok = false;
                errors.push(error(
                    ErrorKind::Cleanup,
                    "process",
                    "original process cleanup is not clean and closed",
                ));
            }
            match tree::process_status(receipt.root_pid) {
                ProcessStatus::Live
                    if tree::start_ticks(receipt.root_pid) == Some(receipt.root_start_ticks) =>
                {
                    cleanup_ok = false;
                    live_owned = true;
                    errors.push(error(
                        ErrorKind::Cleanup,
                        "process",
                        "original root process identity is still live",
                    ));
                }
                ProcessStatus::Unavailable => {
                    cleanup_ok = false;
                    errors.push(error(
                        ErrorKind::Cleanup,
                        "process",
                        "original root process identity is unavailable",
                    ));
                }
                _ => {}
            }
            for identity in &receipt.discovered {
                match tree::process_status(identity.pid) {
                    ProcessStatus::Live
                        if tree::start_ticks(identity.pid) == Some(identity.start_ticks) =>
                    {
                        cleanup_ok = false;
                        live_owned = true;
                        errors.push(error(
                            ErrorKind::Cleanup,
                            "process",
                            "an owned descendant identity is still live",
                        ));
                    }
                    ProcessStatus::Unavailable => {
                        cleanup_ok = false;
                        errors.push(error(
                            ErrorKind::Cleanup,
                            "process",
                            "an owned descendant identity is unavailable",
                        ));
                    }
                    _ => {}
                }
            }
        }
        None => {
            cleanup_ok = false;
            errors.push(error(
                ErrorKind::Cleanup,
                "process",
                "original report has no process cleanup receipt",
            ));
        }
    }
    if let Some(value) = original
        .environment
        .diagnostics
        .as_ref()
        .and_then(|diagnostics| diagnostics.pointer("/displayCleanup/closed"))
        .and_then(Value::as_bool)
    {
        if !value {
            cleanup_ok = false;
            errors.push(error(
                ErrorKind::Cleanup,
                "display",
                "original display cleanup was not closed",
            ));
        }
    }

    if live_owned {
        bail!("refusing to finalize while an owned runtime identity is still live");
    }
    let mut runs = Vec::new();
    let mut seen = BTreeSet::new();
    let fragment_errors = fragment
        .as_ref()
        .map(|value| value.errors.clone())
        .unwrap_or_default();
    if let Some(fragment) = &fragment {
        if let Some(suite) = &fragment.suite {
            for probe in &suite.probes {
                if !crate::hash::is_sha256(&probe.sha256) {
                    errors.push(error(
                        ErrorKind::Protocol,
                        "suite",
                        "original probe hash registry is invalid",
                    ));
                }
            }
        }
        for run in &fragment.runs {
            let Some(planned) = plan.configuration(&run.configuration.id) else {
                errors.push(error(
                    ErrorKind::Protocol,
                    "runner",
                    "runner returned a configuration outside the plan",
                ));
                continue;
            };
            if planned != &run.configuration || !seen.insert(run.configuration.id.clone()) {
                errors.push(error(
                    ErrorKind::Protocol,
                    "runner",
                    "runner configuration is duplicated or differs from the plan",
                ));
                continue;
            }
            let Some(target) = plan.target(&run.configuration.target_id) else {
                errors.push(error(
                    ErrorKind::Protocol,
                    "runner",
                    "runner configuration references an unknown target",
                ));
                continue;
            };
            if !client_path_matches(&run.client.path, &target.client_module) {
                errors.push(error(
                    ErrorKind::Protocol,
                    "client",
                    "runner client path does not match the plan client module",
                ));
            }
            if let Some(entry) = &run.client.entry_sha256 {
                if !crate::hash::is_sha256(entry) {
                    errors.push(error(
                        ErrorKind::Protocol,
                        "client",
                        "runner client entrySha256 is invalid",
                    ));
                } else if let Some(current) = current_entry_hash(&target.client_module) {
                    if &current != entry {
                        limitations.push(format!(
                            "client source changed after the completed run for target {}; original entry digest preserved",
                            target.id
                        ));
                    }
                }
            } else {
                limitations.push(format!(
                    "original fragment did not record client.entrySha256 for target {}; package/entry digests preserved",
                    target.id
                ));
            }
            if run.cleanup.status != CleanupStatus::Clean {
                cleanup_ok = false;
                errors.push(error(
                    ErrorKind::Cleanup,
                    "cleanup",
                    "run cleanup is not clean",
                ));
            }
            runs.push(run.clone());
        }
    }
    for planned in &plan.configurations {
        if !seen.contains(&planned.id) {
            errors.push(error(
                ErrorKind::Protocol,
                "runner",
                "planned configuration has no recovered run",
            ));
        }
    }
    for item in fragment_errors {
        if sanitized(&item) {
            errors.push(item);
        } else {
            errors.push(error(
                ErrorKind::Protocol,
                "runner",
                "runner error summary was not sanitized and was not copied",
            ));
        }
    }

    let probes = fragment
        .as_ref()
        .and_then(|value| value.suite.as_ref())
        .map(|suite| suite.probes.clone())
        .unwrap_or_default();
    let manifest_sha256 = execution
        .as_ref()
        .map(|value| value.suite_manifest_sha256.clone())
        .unwrap_or_else(|| original.suite.manifest_sha256.clone());
    let mut suite = original.suite.clone();
    suite.probes = probes;
    let mut environment = original.environment.clone();
    if let Some(fragment_environment) = fragment
        .as_ref()
        .and_then(|value| value.environment.as_ref())
    {
        if environment.diagnostics.is_none() {
            environment.diagnostics = fragment_environment.diagnostics.clone();
        }
        if environment.environment_receipt.is_none() {
            environment.environment_receipt = fragment_environment.environment_receipt.clone();
        }
    }

    let mut completeness = plan_validation.completeness.clone();
    if invalid_fragment {
        completeness.push("runner fragment was invalid and no runs were accepted".to_string());
    }
    if suite.probes.is_empty() {
        completeness.push("recovered suite has no probe hash registry".to_string());
    }
    if suite.manifest_sha256 != manifest_sha256 {
        completeness.push("suite manifest hash does not match execution.json".to_string());
    }
    if runs.len() != plan.configurations.len() {
        completeness.push("not every planned configuration was recovered".to_string());
    }
    if !inventory_stable {
        completeness.push("inventory changed after the completed run".to_string());
    }
    if !cleanup_ok {
        completeness.push("owned cleanup is not proven terminal and clean".to_string());
    }
    for run in &runs {
        if run.observations.is_empty() {
            completeness.push(format!("run {} has no observations", run.configuration.id));
        }
        for observation in &run.observations {
            if observation.status != ObservationStatus::Observed || !observation.accepted() {
                completeness.push(format!(
                    "run {} observation {} is not accepted",
                    run.configuration.id, observation.id
                ));
            }
        }
    }
    for item in &errors {
        completeness.push(format!(
            "{} error in {}: {}",
            error_kind(item.kind),
            item.phase,
            item.message
        ));
    }
    completeness.sort();
    completeness.dedup();
    if !original.errors.is_empty() {
        limitations.push(format!(
            "original report contained {} protocol errors superseded by finalize; original errors were not copied",
            original.errors.len()
        ));
    }
    limitations.push(
        "postprocessed from a completed closed run; no Node or browser was launched".to_string(),
    );
    let complete = completeness.is_empty();

    let report = Report {
        schema: REPORT_SCHEMA.to_string(),
        run_id: original.run_id.clone(),
        plan_id: plan.id.clone(),
        plan_hash: plan_hash.clone(),
        suite,
        environment,
        targets: original.targets.clone(),
        runs,
        errors,
        started: original.started.clone(),
        finished: original.finished.clone(),
        complete,
        completeness,
        limitations,
        process_cleanup: original.process_cleanup.clone(),
        postprocessing_recovery: Some(PostprocessingRecovery {
            original_report_path: original_path.to_string_lossy().into_owned(),
            original_report_sha256: original_sha256,
            fragment_sha256,
            plan_sha256: plan_hash,
            tool_version: env!("CARGO_PKG_VERSION").to_string(),
            generated_at: time::now_rfc3339(),
            reason: options
                .reason
                .clone()
                .unwrap_or_else(|| "canonical recovery from a completed closed run".to_string()),
        }),
    };
    let validation = validate::report(&report, &output.to_string_lossy());
    if !validation.valid {
        bail!("recovered report failed canonical validation");
    }
    storage::write_private_json(&output, &report, false)?;
    Ok((output, report))
}

mod support;
use support::*;
