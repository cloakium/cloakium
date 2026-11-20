//! Deduplication, plan coverage and summary counts.

use std::collections::{BTreeMap, BTreeSet};

use crate::difference::{Difference, DifferenceClass, FeatureCoverage};
use crate::model::{Mode, Plan};
use crate::report::Report;

use super::CompareSummary;
pub(crate) fn missing_plan_configurations(
    plan: &Plan,
    baseline: &Report,
    baseline_target: &str,
    candidate: &Report,
    candidate_target: &str,
) -> Vec<String> {
    let mut reasons = Vec::new();
    for (report, target, role) in [
        (baseline, baseline_target, "baseline"),
        (candidate, candidate_target, "candidate"),
    ] {
        let present: BTreeSet<&str> = report
            .runs
            .iter()
            .map(|run| run.configuration.id.as_str())
            .collect();
        for configuration in plan
            .configurations
            .iter()
            .filter(|configuration| configuration.target_id == target)
        {
            if !present.contains(configuration.id.as_str()) {
                reasons.push(format!(
                    "{role} report is missing plan configuration {}",
                    configuration.id
                ));
            }
        }
    }
    reasons
}

/// Functional checks observed in several iterations are one feature-level row;
/// provenance keeps every contributing run. Value rows stay per occurrence so
/// ordinary variation is never discarded.
pub(crate) fn merge_repeated(differences: Vec<Difference>) -> Vec<Difference> {
    let mut merged: Vec<Difference> = Vec::new();
    let mut indexes: BTreeMap<String, usize> = BTreeMap::new();
    for difference in differences {
        let repeatable = matches!(
            difference.classification.as_str(),
            "capability-difference"
                | "shared-failure"
                | "headless-regression"
                | "headless-improvement"
                | "execution-error"
                | "stable-field-difference"
                | "intentional-difference"
        );
        if !repeatable {
            merged.push(difference);
            continue;
        }
        let mut key = format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}",
            difference.feature_id,
            difference.classification,
            difference.original_classification.as_deref().unwrap_or(""),
            difference.check.as_deref().unwrap_or(""),
            difference.mode.map(Mode::as_str).unwrap_or(""),
            difference.baseline_status.as_deref().unwrap_or(""),
            difference.candidate_status.as_deref().unwrap_or(""),
            difference.detail,
            difference.policy_id.as_deref().unwrap_or("")
        );
        if matches!(
            difference.classification.as_str(),
            "execution-error" | "stable-field-difference"
        ) {
            let mut run_ids: Vec<&str> = difference
                .provenance
                .iter()
                .map(|item| item.run_id.as_str())
                .collect();
            run_ids.sort_unstable();
            run_ids.dedup();
            key.push('|');
            key.push_str(&run_ids.join(","));
        }
        if let Some(index) = indexes.get(&key).copied() {
            let target = &mut merged[index];
            for item in difference.provenance {
                if !target.provenance.iter().any(|existing| {
                    existing.role == item.role
                        && existing.run_id == item.run_id
                        && existing.configuration_id == item.configuration_id
                        && existing.iteration == item.iteration
                }) {
                    target.provenance.push(item);
                }
            }
            for confounder in difference.confounders {
                if !target.confounders.contains(&confounder) {
                    target.confounders.push(confounder);
                }
            }
        } else {
            indexes.insert(key, merged.len());
            merged.push(difference);
        }
    }
    merged
}

pub(crate) fn summarize(
    features: &[FeatureCoverage],
    differences: &[Difference],
    gaps: &[Difference],
) -> CompareSummary {
    let count = |label: &str| {
        differences
            .iter()
            .filter(|difference| difference.classification == label)
            .count()
    };
    CompareSummary {
        features: features.len(),
        differences: differences.len(),
        gaps: gaps.len(),
        capability_differences: count(DifferenceClass::CapabilityDifference.label()),
        shared_failures: count(DifferenceClass::SharedFailure.label()),
        stable_field_differences: count(DifferenceClass::StableFieldDifference.label()),
        ordinary_variation: count(DifferenceClass::OrdinaryVariation.label()),
        headless_regressions: count(DifferenceClass::HeadlessRegression.label()),
        headless_improvements: count(DifferenceClass::HeadlessImprovement.label()),
        iteration_instability: count(DifferenceClass::IterationInstability.label()),
        execution_errors: count(DifferenceClass::ExecutionError.label()),
        coverage_gaps: count(DifferenceClass::CoverageGap.label()),
        unsupported: count(DifferenceClass::Unsupported.label()),
        unknown: count(DifferenceClass::Unknown.label()),
        intentional: count(DifferenceClass::IntentionalDifference.label()),
    }
}
