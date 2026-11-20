//! Iteration instability and execution-error rows.
use std::collections::{BTreeMap, BTreeSet};

use crate::difference::{value_at_path, Difference, DifferenceClass, Provenance};
use crate::model::Mode;
use crate::policy::Policy;
use crate::report::{CleanupStatus, Report, RunRecord};
use serde_json::Value;

pub(crate) fn iteration_instability(
    report: &Report,
    target_id: &str,
    role: &str,
    policy: &Policy,
    differences: &mut Vec<Difference>,
    stable_observed: &mut BTreeSet<String>,
) {
    let mut runs_by_mode: BTreeMap<(Mode, String, String), Vec<&RunRecord>> = BTreeMap::new();
    for run in report
        .runs
        .iter()
        .filter(|run| run.configuration.target_id == target_id)
    {
        runs_by_mode
            .entry((
                run.configuration.mode,
                run.configuration.profile_id.clone(),
                run.configuration.scenario_signature(),
            ))
            .or_default()
            .push(run);
    }
    for ((mode, _profile, _scenario), runs) in runs_by_mode {
        if runs.len() < 2 {
            continue;
        }
        let mut features: BTreeSet<String> = BTreeSet::new();
        for run in &runs {
            features.extend(
                run.observations
                    .iter()
                    .map(|observation| observation.id.clone()),
            );
        }
        for feature in features {
            let present: Vec<&RunRecord> = runs
                .iter()
                .copied()
                .filter(|run| {
                    run.observations
                        .iter()
                        .any(|observation| observation.id == feature)
                })
                .collect();
            let mut checks: BTreeSet<String> = BTreeSet::new();
            for run in &present {
                if let Some(observation) = run
                    .observations
                    .iter()
                    .find(|observation| observation.id == feature)
                {
                    checks.extend(
                        observation
                            .result
                            .checks
                            .iter()
                            .map(|check| check.name.clone()),
                    );
                }
            }
            for check in checks {
                let mut values = Vec::new();
                for run in &present {
                    if let Some(observation) = run
                        .observations
                        .iter()
                        .find(|observation| observation.id == feature)
                    {
                        if let Some(value) = observation.check(&check) {
                            values.push((run.configuration.iteration, value.effective_label()));
                        }
                    }
                }
                if distinct_labels(&values) > 1 {
                    let provenance = present
                        .iter()
                        .map(|run| Provenance::from_run(role, report, run))
                        .collect();
                    differences.push(
                        Difference::new(
                            DifferenceClass::IterationInstability,
                            &feature,
                            present
                                .first()
                                .and_then(|run| run.observations.iter().find(|observation| observation.id == feature))
                                .map(|observation| observation.family.as_str())
                                .unwrap_or("unknown"),
                            format!("check {check} changed across iterations"),
                        )
                        .with_check(&check)
                        .with_mode(mode)
                        .with_values(
                            Some(Value::Array(
                                values
                                    .iter()
                                    .map(|(iteration, value)| {
                                        serde_json::json!({"iteration": iteration, "status": value})
                                    })
                                    .collect(),
                            )),
                            None,
                        )
                        .with_provenance(provenance),
                    );
                }
            }
            for field in &policy.stable_fields {
                let mut values = Vec::new();
                for run in &present {
                    if let Some(observation) = run
                        .observations
                        .iter()
                        .find(|observation| observation.id == feature)
                    {
                        if let Some(value) = value_at_path(&observation.result.observations, field)
                        {
                            stable_observed.insert(field.clone());
                            values.push((run.configuration.iteration, value.clone()));
                        }
                    }
                }
                if values.len() > 1 && values.windows(2).any(|pair| pair[0].1 != pair[1].1) {
                    let provenance = present
                        .iter()
                        .map(|run| Provenance::from_run(role, report, run))
                        .collect();
                    differences.push(
                        Difference::new(
                            DifferenceClass::IterationInstability,
                            &feature,
                            present
                                .first()
                                .and_then(|run| run.observations.iter().find(|observation| observation.id == feature))
                                .map(|observation| observation.family.as_str())
                                .unwrap_or("unknown"),
                            format!("stable field {field} changed across iterations"),
                        )
                        .with_mode(mode)
                        .with_values(
                            Some(Value::Array(
                                values
                                    .iter()
                                    .map(|(iteration, value)| {
                                        serde_json::json!({"iteration": iteration, "value": value})
                                    })
                                    .collect(),
                            )),
                            None,
                        )
                        .with_provenance(provenance),
                    );
                }
            }
        }
    }
}

pub(crate) fn distinct_labels(values: &[(u32, &'static str)]) -> usize {
    values
        .iter()
        .map(|(_, label)| *label)
        .collect::<BTreeSet<_>>()
        .len()
}

pub(crate) fn execution_rows(
    report: &Report,
    target_id: &str,
    role: &str,
    differences: &mut Vec<Difference>,
) {
    for run in report
        .runs
        .iter()
        .filter(|run| run.configuration.target_id == target_id)
    {
        if run.cleanup.status != CleanupStatus::Clean {
            differences.push(
                Difference::new(
                    DifferenceClass::ExecutionError,
                    "$run",
                    "execution",
                    format!(
                        "{} cleanup is {}; browser/context ownership was not proven",
                        run.configuration.id,
                        cleanup_label(run.cleanup.status)
                    ),
                )
                .with_mode(run.configuration.mode)
                .with_provenance(vec![Provenance::from_run(role, report, run)]),
            );
        }
    }
    for (index, error) in report.errors.iter().enumerate() {
        let run_any = error
            .configuration_id
            .as_deref()
            .and_then(|id| report.runs.iter().find(|run| run.configuration.id == id));
        let selected = run_any.filter(|run| run.configuration.target_id == target_id);
        if run_any.is_some() && selected.is_none() {
            // A configuration-scoped error belongs to another target; never
            // attribute it to the selected target.
            continue;
        }
        let detail = if let Some(run) = selected {
            format!(
                "{} error #{} for selected configuration {}",
                error.phase, index, run.configuration.id
            )
        } else if error.configuration_id.is_some() {
            format!(
                "{} report-level error #{} with unknown configuration scope",
                error.phase, index
            )
        } else {
            format!("{} report-level error #{}", error.phase, index)
        };
        let mut difference =
            Difference::new(DifferenceClass::ExecutionError, "$run", "execution", detail);
        if let Some(run) = selected {
            difference = difference
                .with_mode(run.configuration.mode)
                .with_provenance(vec![Provenance::from_run(role, report, run)]);
        }
        differences.push(difference);
    }
}

pub(crate) fn cleanup_label(status: CleanupStatus) -> &'static str {
    match status {
        CleanupStatus::Clean => "clean",
        CleanupStatus::Incomplete => "incomplete",
        CleanupStatus::NotRun => "not-run",
    }
}
pub(crate) fn mode_missing(
    report: &Report,
    role: &str,
    run: &RunRecord,
    missing_mode: Mode,
    profile: &str,
    iteration: u32,
    differences: &mut Vec<Difference>,
) {
    if run.observations.is_empty() {
        differences.push(
            Difference::new(
                DifferenceClass::CoverageGap,
                "$run",
                "execution",
                format!(
                    "{role} has no {} run for profile {profile} iteration {iteration}; scenario/suite selections differ or the mode is missing",
                    missing_mode.as_str()
                ),
            )
            .with_mode(missing_mode)
            .with_provenance(vec![Provenance::from_run(role, report, run)]),
        );
        return;
    }
    for observation in &run.observations {
        differences.push(
            Difference::new(
                DifferenceClass::CoverageGap,
                &observation.id,
                &observation.family,
                format!(
                    "{role} has no {} coverage for profile {profile} iteration {iteration}; scenario/suite selections differ or the mode is missing",
                    missing_mode.as_str()
                ),
            )
            .with_mode(missing_mode)
            .with_provenance(vec![Provenance::from_run(role, report, run)]),
        );
    }
}
