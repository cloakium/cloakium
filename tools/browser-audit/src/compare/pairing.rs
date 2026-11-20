//! Pairwise report comparison.
use super::stability::mode_missing;
use std::collections::{BTreeMap, BTreeSet};

use crate::difference::{
    family_of, fixture_origins, observation_map, value_at_path, Confounder, Difference,
    DifferenceClass, Provenance,
};
use crate::model::Mode;
use crate::policy::Policy;
use crate::report::{check_map, EffectiveCheck, ObservationStatus, Report, RunRecord};

#[allow(clippy::too_many_arguments)]
pub(crate) fn compare_runs(
    baseline_report: &Report,
    candidate_report: &Report,
    baseline_run: &RunRecord,
    candidate_run: &RunRecord,
    policy: &Policy,
    confounders: &[Confounder],
    differences: &mut Vec<Difference>,
    stable_observed: &mut BTreeSet<String>,
) {
    let baseline_observations = observation_map(baseline_run);
    let candidate_observations = observation_map(candidate_run);
    let features: BTreeSet<&String> = baseline_observations
        .keys()
        .chain(candidate_observations.keys())
        .collect();
    let pair_provenance = vec![
        Provenance::from_run("baseline", baseline_report, baseline_run),
        Provenance::from_run("candidate", candidate_report, candidate_run),
    ];
    for feature in features {
        let baseline = baseline_observations.get(feature).copied();
        let candidate = candidate_observations.get(feature).copied();
        let family = family_of(baseline, candidate);
        if baseline.is_none() || candidate.is_none() {
            differences.push(
                Difference::new(
                    DifferenceClass::CoverageGap,
                    feature,
                    &family,
                    if baseline.is_none() {
                        "baseline run has no observation for this feature"
                    } else {
                        "candidate run has no observation for this feature"
                    },
                )
                .with_mode(candidate_run.configuration.mode)
                .with_provenance(pair_provenance.clone()),
            );
            continue;
        }
        let baseline = baseline.expect("checked");
        let candidate = candidate.expect("checked");
        if baseline.status == ObservationStatus::Unsupported
            || candidate.status == ObservationStatus::Unsupported
        {
            differences.push(
                Difference::new(
                    DifferenceClass::Unsupported,
                    feature,
                    &family,
                    "the target explicitly reports this feature as unsupported; this is not a pass",
                )
                .with_mode(candidate_run.configuration.mode)
                .with_provenance(pair_provenance.clone()),
            );
            continue;
        }
        if baseline.status == ObservationStatus::Error
            || candidate.status == ObservationStatus::Error
        {
            differences.push(
                Difference::new(
                    DifferenceClass::ExecutionError,
                    feature,
                    &family,
                    "observation execution error; this is separate from an observed inconsistency",
                )
                .with_mode(candidate_run.configuration.mode)
                .with_provenance(pair_provenance.clone()),
            );
            continue;
        }
        let baseline_checks = check_map(baseline);
        let candidate_checks = check_map(candidate);
        let checks: BTreeSet<&String> = baseline_checks
            .keys()
            .chain(candidate_checks.keys())
            .collect();
        for check in checks {
            let left = baseline_checks.get(check).copied();
            let right = candidate_checks.get(check).copied();
            let (Some(left), Some(right)) = (left, right) else {
                differences.push(
                    Difference::new(
                        DifferenceClass::CoverageGap,
                        feature,
                        &family,
                        "a functional check is missing from one report",
                    )
                    .with_check(check)
                    .with_mode(candidate_run.configuration.mode)
                    .with_provenance(pair_provenance.clone()),
                );
                continue;
            };
            let Some(difference) = check_difference(feature, &family, check, left, right) else {
                continue;
            };
            differences.push(
                difference
                    .with_mode(candidate_run.configuration.mode)
                    .with_provenance(pair_provenance.clone())
                    .with_confounders(confounders),
            );
        }

        let baseline_values = &baseline.result.observations;
        let candidate_values = &candidate.result.observations;
        for value_diff in crate::difference::diff_values(baseline_values, candidate_values) {
            if policy.stable(&value_diff.path) {
                continue;
            }
            differences.push(
                Difference::new(
                    DifferenceClass::OrdinaryVariation,
                    feature,
                    &family,
                    "observation value varies; ordinary variation is never an automatic gap",
                )
                .with_mode(candidate_run.configuration.mode)
                .with_values(value_diff.baseline, value_diff.candidate)
                .with_provenance(pair_provenance.clone()),
            );
        }
        for field in &policy.stable_fields {
            let left = value_at_path(baseline_values, field);
            let right = value_at_path(candidate_values, field);
            if left.is_some() || right.is_some() {
                stable_observed.insert(field.clone());
            }
            if left != right {
                differences.push(
                    Difference::new(
                        DifferenceClass::StableFieldDifference,
                        feature,
                        &family,
                        format!("declared stable field changed: {field}"),
                    )
                    .with_mode(candidate_run.configuration.mode)
                    .with_values(left.cloned(), right.cloned())
                    .with_provenance(pair_provenance.clone())
                    .with_confounders(confounders),
                );
            }
        }
    }
}

pub(crate) fn check_difference(
    feature: &str,
    family: &str,
    check: &str,
    baseline: EffectiveCheck,
    candidate: EffectiveCheck,
) -> Option<Difference> {
    let baseline_label = check_label(baseline);
    let candidate_label = check_label(candidate);
    let (class, detail) = match (baseline, candidate) {
        (EffectiveCheck::Pass, EffectiveCheck::Pass) => return None,
        (EffectiveCheck::Pass, EffectiveCheck::Fail) => (
            DifferenceClass::CapabilityDifference,
            "candidate failed a check that the baseline passed",
        ),
        (EffectiveCheck::Fail, EffectiveCheck::Pass) => (
            DifferenceClass::CapabilityDifference,
            "candidate passed a check that the baseline failed",
        ),
        (EffectiveCheck::Fail, EffectiveCheck::Fail) => (
            DifferenceClass::SharedFailure,
            "both reports fail the same functional check",
        ),
        (EffectiveCheck::Error, _) | (_, EffectiveCheck::Error) => (
            DifferenceClass::ExecutionError,
            "a check did not execute; this is not an observed inconsistency",
        ),
        (EffectiveCheck::Unsupported, _) | (_, EffectiveCheck::Unsupported) => (
            DifferenceClass::Unsupported,
            "a check is explicitly unsupported; this is never a pass",
        ),
        _ => (
            DifferenceClass::Unknown,
            "at least one report has unknown or skipped evidence; unknown is never a failure",
        ),
    };
    Some(
        Difference::new(class, feature, family, detail)
            .with_check(check)
            .with_status(baseline_label, candidate_label),
    )
}

pub(crate) fn check_label(value: EffectiveCheck) -> &'static str {
    match value {
        EffectiveCheck::Pass => "pass",
        EffectiveCheck::Fail => "fail",
        EffectiveCheck::Unknown => "unknown",
        EffectiveCheck::Error => "error",
        EffectiveCheck::Unsupported => "unsupported",
        EffectiveCheck::Skipped => "skipped",
    }
}

pub(crate) fn missing_run_coverage(
    report: &Report,
    run: &RunRecord,
    role: &str,
    missing: &str,
    differences: &mut Vec<Difference>,
) {
    if run.observations.is_empty() {
        differences.push(
            Difference::new(
                DifferenceClass::CoverageGap,
                "$run",
                "execution",
                format!(
                    "{missing} has no matching run for {} iteration {}",
                    run.configuration.profile_id, run.configuration.iteration
                ),
            )
            .with_mode(run.configuration.mode)
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
                    "{missing} has no matching {} run for profile {} iteration {}",
                    run.configuration.mode.as_str(),
                    run.configuration.profile_id,
                    run.configuration.iteration
                ),
            )
            .with_mode(run.configuration.mode)
            .with_provenance(vec![Provenance::from_run(role, report, run)]),
        );
    }
}

pub(crate) fn compare_modes(
    report: &Report,
    target_id: &str,
    role: &str,
    policy: &Policy,
    confounders: &[Confounder],
    stable_observed: &mut BTreeSet<String>,
    differences: &mut Vec<Difference>,
) {
    type ModeGroup<'a> = (Option<&'a RunRecord>, Option<&'a RunRecord>);
    let mut groups: BTreeMap<(String, String, u32), ModeGroup<'_>> = BTreeMap::new();
    for run in report
        .runs
        .iter()
        .filter(|run| run.configuration.target_id == target_id)
    {
        let group = groups
            .entry((
                run.configuration.profile_id.clone(),
                run.configuration.scenario_signature(),
                run.configuration.iteration,
            ))
            .or_default();
        match run.configuration.mode {
            Mode::Headless => group.0 = Some(run),
            Mode::Headed => group.1 = Some(run),
        }
    }
    for ((profile, _scenario, iteration), (headless, headed)) in groups {
        match (headless, headed) {
            (Some(headless), Some(headed)) => compare_mode_pair(
                report,
                role,
                headless,
                headed,
                &profile,
                iteration,
                policy,
                confounders,
                stable_observed,
                differences,
            ),
            (Some(run), None) => mode_missing(
                report,
                role,
                run,
                Mode::Headed,
                &profile,
                iteration,
                differences,
            ),
            (None, Some(run)) => mode_missing(
                report,
                role,
                run,
                Mode::Headless,
                &profile,
                iteration,
                differences,
            ),
            (None, None) => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn compare_mode_pair(
    report: &Report,
    role: &str,
    headless: &RunRecord,
    headed: &RunRecord,
    profile: &str,
    iteration: u32,
    policy: &Policy,
    confounders: &[Confounder],
    stable_observed: &mut BTreeSet<String>,
    differences: &mut Vec<Difference>,
) {
    let headless_observations = observation_map(headless);
    let headed_observations = observation_map(headed);
    let features: BTreeSet<&String> = headless_observations
        .keys()
        .chain(headed_observations.keys())
        .collect();
    let provenance = vec![
        Provenance::from_run(role, report, headless),
        Provenance::from_run(role, report, headed),
    ];
    for feature in features {
        let left = headless_observations.get(feature).copied();
        let right = headed_observations.get(feature).copied();
        let family = family_of(left, right);
        let (Some(left), Some(right)) = (left, right) else {
            differences.push(
                Difference::new(
                    DifferenceClass::CoverageGap,
                    feature,
                    &family,
                    format!(
                        "mode pair for {role} profile {profile} iteration {iteration} is incomplete"
                    ),
                )
                .with_provenance(provenance.clone()),
            );
            continue;
        };
        let headless_checks = check_map(left);
        let headed_checks = check_map(right);
        let checks: BTreeSet<&String> =
            headless_checks.keys().chain(headed_checks.keys()).collect();
        for check in checks {
            let headless_status = headless_checks.get(check).copied();
            let headed_status = headed_checks.get(check).copied();
            let (Some(headless_status), Some(headed_status)) = (headless_status, headed_status)
            else {
                differences.push(
                    Difference::new(
                        DifferenceClass::CoverageGap,
                        feature,
                        &family,
                        "mode pair lacks a functional check",
                    )
                    .with_check(check)
                    .with_provenance(provenance.clone()),
                );
                continue;
            };
            let difference = match (headless_status, headed_status) {
                (EffectiveCheck::Fail, EffectiveCheck::Pass) => Some(
                    Difference::new(
                        DifferenceClass::HeadlessRegression,
                        feature,
                        &family,
                        "headed passed while headless failed within the same target",
                    )
                    .with_check(check)
                    .with_mode(Mode::Headless)
                    .with_status("fail", "pass")
                    .with_provenance(provenance.clone()),
                ),
                (EffectiveCheck::Pass, EffectiveCheck::Fail) => Some(
                    Difference::new(
                        DifferenceClass::HeadlessImprovement,
                        feature,
                        &family,
                        "headless passed with actual acceptance while headed failed; headful-only evidence would not be enough",
                    )
                    .with_check(check)
                    .with_mode(Mode::Headless)
                    .with_status("pass", "fail")
                    .with_provenance(provenance.clone()),
                ),
                (EffectiveCheck::Error, _) | (_, EffectiveCheck::Error) => Some(
                    Difference::new(
                        DifferenceClass::ExecutionError,
                        feature,
                        &family,
                        "a mode-pair check did not execute",
                    )
                    .with_check(check)
                    .with_provenance(provenance.clone()),
                ),
                (EffectiveCheck::Unsupported, _) | (_, EffectiveCheck::Unsupported) => Some(
                    Difference::new(
                        DifferenceClass::Unsupported,
                        feature,
                        &family,
                        "a mode-pair check is explicitly unsupported",
                    )
                    .with_check(check)
                    .with_provenance(provenance.clone()),
                ),
                _ => None,
            };
            if let Some(difference) = difference {
                differences.push(difference.with_confounders(confounders));
            }
        }
        for field in &policy.stable_fields {
            let headless_value = value_at_path(&left.result.observations, field);
            let headed_value = value_at_path(&right.result.observations, field);
            if headless_value.is_some() || headed_value.is_some() {
                stable_observed.insert(field.clone());
            }
            if headless_value != headed_value {
                let mut stable_confounders = confounders.to_vec();
                if !stable_confounders
                    .iter()
                    .any(|item| item.axis == "fixture-origin")
                    && fixture_origins(report, &headless.configuration.target_id).is_empty()
                {
                    stable_confounders.push(Confounder {
                        axis: "fixture-origin".to_string(),
                        baseline: "unavailable".to_string(),
                        candidate: "unavailable".to_string(),
                    });
                }
                differences.push(
                    Difference::new(
                        DifferenceClass::StableFieldDifference,
                        feature,
                        &family,
                        format!(
                            "declared stable field {field} differs between headed and headless for profile {profile} iteration {iteration}"
                        ),
                    )
                    .with_mode(Mode::Headless)
                    .with_values(headed_value.cloned(), headless_value.cloned())
                    .with_provenance(provenance.clone())
                    .with_confounders(&stable_confounders),
                );
            }
        }
    }
}
