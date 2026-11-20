//! Per-profile/suite/selector repeatability checks.

use std::collections::{BTreeMap, BTreeSet};

use crate::model::{Mode, Plan};
use crate::report::Report;

use super::Validation;

type CollectionKey = (String, String, String, Mode);

pub(crate) fn validate_plan_collections(plan: &Plan, validation: &mut Validation) {
    let layout = layout_from_plan(plan);
    for target in &plan.targets {
        let profiles = profiles_from_plan(plan, &target.id);
        if profiles.is_empty() {
            validation.incomplete(format!(
                "target {} has no profile configurations",
                target.id
            ));
            continue;
        }
        for (profile, scenario) in profiles {
            for mode in [Mode::Headless, Mode::Headed] {
                let iterations = layout
                    .get(&(target.id.clone(), profile.clone(), scenario.clone(), mode))
                    .cloned()
                    .unwrap_or_default();
                if iterations.is_empty() {
                    validation.incomplete(format!(
                        "target {} profile {} has no {} configurations for its selected scenario/suite policy",
                        target.id,
                        profile,
                        mode.as_str()
                    ));
                    continue;
                }
                check_iterations(
                    &iterations,
                    validation,
                    &format!("target {} profile {} {}", target.id, profile, mode.as_str()),
                );
            }
        }
    }
}

pub(crate) fn validate_report_collections(report: &Report, validation: &mut Validation) {
    if report.runs.is_empty() {
        validation.incomplete("report contains no runs");
    }
    let mut layout: BTreeMap<CollectionKey, Vec<u32>> = BTreeMap::new();
    for run in &report.runs {
        layout
            .entry((
                run.configuration.target_id.clone(),
                run.configuration.profile_id.clone(),
                run.configuration.scenario_signature(),
                run.configuration.mode,
            ))
            .or_default()
            .push(run.configuration.iteration);
    }
    for iterations in layout.values_mut() {
        iterations.sort_unstable();
    }
    for target in &report.targets {
        let profiles: BTreeSet<(String, String)> = report
            .runs
            .iter()
            .filter(|run| run.configuration.target_id == target.id)
            .map(|run| {
                (
                    run.configuration.profile_id.clone(),
                    run.configuration.scenario_signature(),
                )
            })
            .collect();
        if profiles.is_empty() {
            validation.incomplete(format!("target {} has no runs", target.id));
            continue;
        }
        for (profile, scenario) in profiles {
            for mode in [Mode::Headless, Mode::Headed] {
                let iterations = layout
                    .get(&(target.id.clone(), profile.clone(), scenario.clone(), mode))
                    .cloned()
                    .unwrap_or_default();
                if iterations.is_empty() {
                    validation.incomplete(format!(
                        "target {} profile {} has no {} runs for its selected scenario/suite policy",
                        target.id,
                        profile,
                        mode.as_str()
                    ));
                    continue;
                }
                check_iterations(
                    &iterations,
                    validation,
                    &format!("target {} profile {} {}", target.id, profile, mode.as_str()),
                );
            }
        }
    }
}

fn layout_from_plan(plan: &Plan) -> BTreeMap<CollectionKey, Vec<u32>> {
    let mut layout: BTreeMap<CollectionKey, Vec<u32>> = BTreeMap::new();
    for configuration in &plan.configurations {
        layout
            .entry((
                configuration.target_id.clone(),
                configuration.profile_id.clone(),
                configuration.scenario_signature(),
                configuration.mode,
            ))
            .or_default()
            .push(configuration.iteration);
    }
    for iterations in layout.values_mut() {
        iterations.sort_unstable();
    }
    layout
}

fn profiles_from_plan(plan: &Plan, target_id: &str) -> BTreeSet<(String, String)> {
    plan.configurations
        .iter()
        .filter(|configuration| configuration.target_id == target_id)
        .map(|configuration| {
            (
                configuration.profile_id.clone(),
                configuration.scenario_signature(),
            )
        })
        .collect()
}

fn check_iterations(iterations: &[u32], validation: &mut Validation, prefix: &str) {
    if iterations.len() < 2 {
        validation.incomplete(format!(
            "{prefix} needs at least 2 iterations for repeatability"
        ));
    }
    let expected: Vec<u32> = (1..=*iterations.iter().max().unwrap_or(&0)).collect();
    if iterations != expected {
        validation.incomplete(format!("{prefix} iterations must be contiguous from 1"));
    }
}
