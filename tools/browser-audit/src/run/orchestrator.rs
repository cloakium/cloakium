//! Whole-plan run orchestration.
use super::support::*;
use crate::environment;
use crate::hash;
use crate::inventory;
use crate::lock::AuditLock;
use crate::model::Plan;
use crate::process::{self, ProcessSpec};
use crate::report::{
    CleanupStatus, ErrorKind, ObservationStatus, ProbeRecord, Report, REPORT_SCHEMA,
};
use crate::storage;
use crate::util;
use crate::validate;
use anyhow::{bail, Context, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;
pub fn execute(options: &RunOptions) -> Result<RunOutcome> {
    let plan_path = util::absolute(&options.plan)?;
    let plan_bytes = storage::read_bytes(&plan_path)?;
    let plan_hash = hash::bytes(&plan_bytes);
    let plan: Plan = serde_json::from_slice(&plan_bytes)
        .with_context(|| format!("failed to parse plan {}", plan_path.display()))?;
    let plan_validation = validate::plan(&plan, &plan_path.to_string_lossy());
    if !plan_validation.valid {
        let messages: Vec<&str> = plan_validation
            .findings
            .iter()
            .filter(|finding| finding.severity == validate::Severity::Error)
            .map(|finding| finding.message.as_str())
            .collect();
        bail!("plan is invalid: {}", messages.join("; "));
    }
    let run_id = crate::time::unique_id("run");
    let output = match &options.output {
        Some(path) => util::absolute(path)?,
        None => storage::default_run_dir(&run_id)?,
    };
    storage::ensure_fresh_dir(&output, true)?;
    let lock_path = match &options.lock {
        Some(path) => util::absolute(path)?,
        None => storage::default_lock_path()?,
    };
    let lock = AuditLock::acquire(&lock_path)?;
    let started = crate::time::now_rfc3339();
    let deadline = Instant::now() + options.timeout;
    let runtime_env = runtime_env()?;
    let run_plan_path = output.join("plan.json");
    storage::write_private(&run_plan_path, &plan_bytes, false)?;
    let inventory = inventory::from_plan(&plan)?;
    let inventory_path = output.join("inventory.json");
    storage::write_private_json(&inventory_path, &inventory, false)?;
    storage::freeze(&inventory_path)?;
    let mut environment = environment::resolve(&plan.environment)?;
    if runtime_env.h3_bin.is_some() {
        environment
            .resolved
            .environment
            .applied_keys
            .push("CLOAKIUM_H3_BIN".to_string());
    }
    if runtime_env.display_bin.is_some() {
        environment
            .resolved
            .environment
            .applied_keys
            .push("CLOAKIUM_AUDIT_DISPLAY_BIN".to_string());
    }
    if runtime_env.fc_list_bin.is_some() {
        environment
            .resolved
            .environment
            .applied_keys
            .push("CLOAKIUM_FC_LIST_BIN".to_string());
    }
    if runtime_env.openssl_bin.is_some() {
        environment
            .resolved
            .environment
            .applied_keys
            .push("OPENSSL_BIN".to_string());
    }
    environment
        .resolved
        .environment
        .applied_keys
        .push("CLOAKIUM_AUDIT_SEAT_RUST".to_string());
    environment
        .resolved
        .environment
        .applied_keys
        .push("CLOAKIUM_AUDIT_SUITE_MANIFEST_SHA256".to_string());
    environment.resolved.environment.applied_keys.sort();
    environment.resolved.environment.applied_keys.dedup();
    storage::write_private_json(&output.join("environment.json"), &environment, false)?;
    let node = identify_tool(&options.node, "node", true)?;
    let node_version = node_version(&node, &output, &plan, deadline, &runtime_env)?;
    let runner = identify_tool(&options.runner, "runner", false)?;
    let manifest_sha256 = match &options.suite_manifest {
        Some(path) => {
            let path = util::absolute(path)?;
            identify_regular(&path, "suite manifest")?;
            hash::file(&path)?
        }
        None => runner.sha256.clone(),
    };
    let entries = target_entries(&plan)?;
    write_execution_context(
        &output,
        &run_id,
        &plan.id,
        &plan_hash,
        &manifest_sha256,
        &node.sha256,
        &runner.sha256,
        options.timeout.as_millis(),
    )?;
    let mut errors = Vec::new();
    let remaining = deadline.saturating_duration_since(Instant::now());
    let outcome = if remaining.is_zero() {
        errors.push(error(
            ErrorKind::Timeout,
            "run",
            None,
            "wall-clock budget was exhausted before the runner started",
        ));
        None
    } else {
        Some(process::run(&ProcessSpec {
            program: node.path.clone(),
            args: vec![
                runner.path.to_string_lossy().into_owned(),
                "--plan".to_string(),
                run_plan_path.to_string_lossy().into_owned(),
                "--output".to_string(),
                output.to_string_lossy().into_owned(),
            ],
            env: minimal_env(&plan, &output, &runtime_env, Some(&manifest_sha256)),
            cwd: output.clone(),
            stdout_path: output.join("runner.stdout.log"),
            stderr_path: output.join("runner.stderr.log"),
            timeout: remaining,
        })?)
    };
    if let Some(outcome) = &outcome {
        if !outcome.cleanup.clean {
            errors.push(error(
                ErrorKind::Cleanup,
                "process",
                None,
                "owned descendant cleanup left a live process; no reuse or relaunch was attempted",
            ));
        }
    }
    let mut fragment = None;
    if let Some(outcome) = &outcome {
        if outcome.timed_out {
            errors.push(error(
                ErrorKind::Timeout,
                "execution",
                None,
                "runner exceeded the wall-clock budget and its owned process group was terminated; no observations were accepted and no duplicate was launched",
            ));
        } else {
            match read_fragment(&output, &outcome.stdout) {
                Ok(value) => fragment = Some(value),
                Err(problem) => errors.push(error(
                    ErrorKind::Protocol,
                    "runner",
                    None,
                    format!(
                        "{problem}; private logs are under runner.stdout.log and runner.stderr.log"
                    ),
                )),
            }
            if !outcome.success() {
                errors.push(error(
                    ErrorKind::Execution,
                    "execution",
                    None,
                    format!("runner {}", outcome.summary()),
                ));
            }
        }
    }
    let mut runs = Vec::new();
    let mut probes: BTreeMap<String, ProbeRecord> = BTreeMap::new();
    let mut manifest_seen = false;
    if let Some(fragment) = &fragment {
        let validation = validate::runner(fragment, "runner-report.json");
        if !validation.valid {
            errors.push(error(
                ErrorKind::Protocol,
                "runner",
                None,
                invalid_fragment_summary(&output, &validation),
            ));
        } else {
            if let Some(plan_id) = &fragment.plan_id {
                if plan_id != &plan.id {
                    errors.push(error(
                        ErrorKind::Protocol,
                        "runner",
                        None,
                        "runner planId mismatch",
                    ));
                }
            }
            if let Some(reported_hash) = &fragment.plan_hash {
                if reported_hash != &plan_hash {
                    errors.push(error(
                        ErrorKind::Protocol,
                        "runner",
                        None,
                        "runner planHash mismatch",
                    ));
                }
            }
            if let Some(top) = &fragment.environment {
                environment = merge_environment(&environment, top).unwrap_or_else(|problem| {
                    errors.push(error(ErrorKind::Protocol, "environment", None, problem));
                    environment.clone()
                });
            }
            if let Some(suite) = &fragment.suite {
                if let Some(manifest) = &suite.manifest_sha256 {
                    if manifest != &manifest_sha256 {
                        errors.push(error(
                            ErrorKind::Protocol,
                            "suite",
                            None,
                            "runner suite manifest hash does not match the selected manifest",
                        ));
                    } else {
                        manifest_seen = true;
                    }
                }
                for probe in &suite.probes {
                    match probes.get(&probe.id) {
                        Some(existing) if existing.sha256 != probe.sha256 => errors.push(error(
                            ErrorKind::Protocol,
                            "suite",
                            None,
                            format!("probe {} has conflicting hashes", probe.id),
                        )),
                        Some(_) => {}
                        None => {
                            probes.insert(probe.id.clone(), probe.clone());
                        }
                    }
                }
            }
            let mut seen = BTreeSet::new();
            for run in &fragment.runs {
                let Some(planned) = plan.configuration(&run.configuration.id) else {
                    errors.push(error(
                        ErrorKind::Protocol,
                        "runner",
                        Some(run.configuration.id.clone()),
                        "runner returned a configuration that is not in the plan",
                    ));
                    continue;
                };
                if planned != &run.configuration {
                    errors.push(error(
                        ErrorKind::Protocol,
                        "runner",
                        Some(run.configuration.id.clone()),
                        "runner configuration does not match the plan",
                    ));
                    continue;
                }
                if !seen.insert(run.configuration.id.clone()) {
                    errors.push(error(
                        ErrorKind::Protocol,
                        "runner",
                        Some(run.configuration.id.clone()),
                        "runner returned a duplicate configuration",
                    ));
                    continue;
                }
                let mut run = run.clone();
                if let Some(entry) = entries.get(&run.configuration.target_id) {
                    if !client_path_matches(&run.client.path, &entry.path) {
                        errors.push(error(
                            ErrorKind::Protocol,
                            "client",
                            Some(run.configuration.id.clone()),
                            "runner client path does not match the selected client module",
                        ));
                    }
                    if let Some(reported) = &run.client.entry_sha256 {
                        if reported != &entry.sha256 {
                            errors.push(error(
                                ErrorKind::Protocol,
                                "client",
                                Some(run.configuration.id.clone()),
                                "runner client entrySha256 does not match the selected entry file",
                            ));
                        }
                    }
                    run.client.entry_sha256 = Some(entry.sha256.clone());
                }
                run.environment = match merge_environment(&environment, &run.environment) {
                    Ok(value) => value,
                    Err(problem) => {
                        errors.push(error(
                            ErrorKind::Protocol,
                            "environment",
                            Some(run.configuration.id.clone()),
                            format!("run environment provenance mismatch: {problem}"),
                        ));
                        environment.clone()
                    }
                };
                if run.cleanup.status != CleanupStatus::Clean {
                    errors.push(error(
                        ErrorKind::Cleanup,
                        "cleanup",
                        Some(run.configuration.id.clone()),
                        "runner did not prove clean context and browser shutdown",
                    ));
                }
                runs.push(run);
            }
            for planned in &plan.configurations {
                if !seen.contains(&planned.id) {
                    errors.push(error(
                        ErrorKind::Protocol,
                        "runner",
                        Some(planned.id.clone()),
                        "runner returned no run for this planned configuration",
                    ));
                }
            }
            for item in &fragment.errors {
                if sanitized_error(item) {
                    errors.push(item.clone());
                } else {
                    errors.push(error(
                        ErrorKind::Protocol,
                        "runner",
                        item.configuration_id.clone(),
                        "runner error payload was not a short sanitized summary and was not copied",
                    ));
                }
            }
        }
    }
    let inventory_stable = verify_inventory(&inventory, &mut errors);
    let node_after = identify_tool(&options.node, "node", true)?;
    let runner_after = identify_tool(&options.runner, "runner", false)?;
    let node_stable = node_after.sha256 == node.sha256;
    let runner_stable = runner_after.sha256 == runner.sha256;
    if !node_stable {
        errors.push(error(
            ErrorKind::Inventory,
            "node",
            None,
            "node changed during the run",
        ));
    }
    if !runner_stable {
        errors.push(error(
            ErrorKind::Inventory,
            "runner",
            None,
            "runner changed during the run",
        ));
    }
    let mut client_stable = true;
    for (target_id, entry) in &entries {
        if hash::file(&entry.path).ok().as_deref() != Some(entry.sha256.as_str()) {
            client_stable = false;
            errors.push(error(
                ErrorKind::Inventory,
                "client",
                None,
                format!("client module changed during the run for target {target_id}"),
            ));
        }
    }
    if runs.len() != plan.configurations.len() {
        errors.push(error(
            ErrorKind::Protocol,
            "runner",
            None,
            "runner did not return every planned configuration",
        ));
    }
    let suite = build_suite(
        manifest_sha256.clone(),
        probes.into_values().collect(),
        &runner,
        &node,
        node_version,
    );
    let mut completeness = plan_validation.completeness.clone();
    if suite.probes.is_empty() {
        completeness.push("suite reports no probe hashes".to_string());
    }
    if !manifest_seen {
        completeness.push("runner did not confirm the suite manifest hash".to_string());
    }
    for run in &runs {
        if run.cleanup.status != CleanupStatus::Clean {
            completeness.push(format!("run {} did not clean up", run.configuration.id));
        }
        if run.observations.is_empty() {
            completeness.push(format!("run {} has no observations", run.configuration.id));
        }
        for observation in &run.observations {
            if observation.status != ObservationStatus::Observed {
                completeness.push(format!(
                    "run {} observation {} is not observed",
                    run.configuration.id, observation.id
                ));
            }
            if observation.result.checks.is_empty() {
                completeness.push(format!(
                    "run {} observation {} has no functional checks",
                    run.configuration.id, observation.id
                ));
            }
            for check in &observation.result.checks {
                if check.effective() != crate::report::EffectiveCheck::Pass {
                    completeness.push(format!(
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
    let complete = completeness.is_empty()
        && inventory_stable
        && node_stable
        && runner_stable
        && client_stable;
    let report = Report {
        schema: REPORT_SCHEMA.to_string(),
        run_id,
        plan_id: plan.id.clone(),
        plan_hash: plan_hash.clone(),
        suite,
        environment,
        targets: inventory.targets.clone(),
        runs,
        errors,
        started,
        finished: crate::time::now_rfc3339(),
        complete,
        completeness: completeness.clone(),
        limitations: plan_validation.completeness,
        process_cleanup: outcome.as_ref().map(|value| value.cleanup.clone()),
        postprocessing_recovery: None,
    };
    let report_path = output.join("report.json");
    storage::write_private_json(&report_path, &report, true)?;
    if !complete {
        storage::freeze(&report_path)?;
    }
    let validation = validate::report(&report, &report_path.to_string_lossy());
    if !validation.valid {
        drop(lock);
        bail!(
            "internal report validation failed after writing {}: {:?}",
            report_path.display(),
            validation.findings
        );
    }
    drop(lock);
    Ok(RunOutcome {
        report_path,
        complete,
        run_count: report.runs.len(),
        error_count: report.errors.len(),
        plan_hash,
    })
}
