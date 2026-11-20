//! Compare baseline and candidate reports into retained differences, gap
//! classifications, confounders and headless/headed coverage.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::difference::{
    causal_attribution, cover as coverage, observed_families, observed_feature_ids, Confounder,
    Difference, DifferenceClass, FeatureCoverage,
};
use crate::hash;
use crate::inventory::InventoryRecord;
use crate::model::{Mode, Plan};
use crate::policy::Policy;
use crate::report::{Report, RunRecord};
use crate::storage;
use crate::time;
use crate::util;
use crate::validate;

pub const COMPARE_SCHEMA: &str = "cloakium.audit.compare/1";

#[derive(Debug, Clone)]
pub struct CompareOptions {
    pub baseline: PathBuf,
    pub candidate: PathBuf,
    pub policy: Option<PathBuf>,
    pub plan: Option<PathBuf>,
    pub output: PathBuf,
    pub baseline_target: Option<String>,
    pub candidate_target: Option<String>,
    pub force: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRef {
    pub path: String,
    pub run_id: String,
    pub plan_hash: String,
    pub complete: bool,
    pub target_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRef {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRef {
    pub path: String,
    pub sha256: String,
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareSummary {
    pub features: usize,
    pub differences: usize,
    pub gaps: usize,
    pub capability_differences: usize,
    pub shared_failures: usize,
    pub stable_field_differences: usize,
    pub ordinary_variation: usize,
    pub headless_regressions: usize,
    pub headless_improvements: usize,
    pub iteration_instability: usize,
    pub execution_errors: usize,
    pub coverage_gaps: usize,
    pub unsupported: usize,
    pub unknown: usize,
    pub intentional: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareReport {
    pub schema: String,
    pub generated_at: String,
    pub baseline: ReportRef,
    pub candidate: ReportRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<PolicyRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<PlanRef>,
    pub confounders: Vec<Confounder>,
    pub causal_attribution: String,
    pub features: Vec<FeatureCoverage>,
    pub differences: Vec<Difference>,
    pub gaps: Vec<Difference>,
    pub summary: CompareSummary,
    pub complete: bool,
    pub completeness: Vec<String>,
}

pub fn execute(options: &CompareOptions) -> Result<(PathBuf, CompareReport)> {
    let baseline_path = util::absolute(&options.baseline)?;
    let candidate_path = util::absolute(&options.candidate)?;
    let baseline = load_report(&baseline_path)?;
    let candidate = load_report(&candidate_path)?;
    let baseline_target = select_target(
        &baseline,
        options.baseline_target.as_deref(),
        "baseline",
        &baseline_path,
    )?;
    let candidate_target = select_target(
        &candidate,
        options.candidate_target.as_deref(),
        "candidate",
        &candidate_path,
    )?;

    let (policy, policy_ref) = match &options.policy {
        Some(path) => {
            let path = util::absolute(path)?;
            let bytes = storage::read_bytes(&path)?;
            let policy: Policy = serde_json::from_slice(&bytes)
                .with_context(|| format!("failed to parse policy {}", path.display()))?;
            policy.validate()?;
            let policy_ref = PolicyRef {
                path: path.to_string_lossy().into_owned(),
                sha256: hash::bytes(&bytes),
            };
            (policy, Some(policy_ref))
        }
        None => (Policy::empty(), None),
    };

    let plan = match &options.plan {
        Some(path) => {
            let path = util::absolute(path)?;
            let bytes = storage::read_bytes(&path)?;
            let plan: Plan = serde_json::from_slice(&bytes)
                .with_context(|| format!("failed to parse plan {}", path.display()))?;
            let validation = validate::plan(&plan, &path.to_string_lossy());
            if !validation.valid {
                bail!("comparison plan is invalid");
            }
            Some((path, hash::bytes(&bytes), plan, validation.complete))
        }
        None => None,
    };

    let confounders =
        crate::difference::confounders(&baseline, &candidate, baseline_target, candidate_target);
    let attribution = causal_attribution(&confounders).to_string();
    let mut differences = Vec::new();
    let mut stable_observed = BTreeSet::new();
    let mut completeness = Vec::new();

    let baseline_runs = runs_by_key(&baseline, &baseline_target.id)?;
    let candidate_runs = runs_by_key(&candidate, &candidate_target.id)?;
    for (key, baseline_run) in &baseline_runs {
        match candidate_runs.get(key) {
            Some(candidate_run) => compare_runs(
                &baseline,
                &candidate,
                baseline_run,
                candidate_run,
                &policy,
                &confounders,
                &mut differences,
                &mut stable_observed,
            ),
            None => missing_run_coverage(
                &baseline,
                baseline_run,
                "baseline",
                "candidate",
                &mut differences,
            ),
        }
    }
    for (key, candidate_run) in &candidate_runs {
        if !baseline_runs.contains_key(key) {
            missing_run_coverage(
                &candidate,
                candidate_run,
                "candidate",
                "baseline",
                &mut differences,
            );
        }
    }

    compare_modes(
        &baseline,
        &baseline_target.id,
        "baseline",
        &policy,
        &confounders,
        &mut stable_observed,
        &mut differences,
    );
    compare_modes(
        &candidate,
        &candidate_target.id,
        "candidate",
        &policy,
        &confounders,
        &mut stable_observed,
        &mut differences,
    );
    iteration_instability(
        &baseline,
        &baseline_target.id,
        "baseline",
        &policy,
        &mut differences,
        &mut stable_observed,
    );
    iteration_instability(
        &candidate,
        &candidate_target.id,
        "candidate",
        &policy,
        &mut differences,
        &mut stable_observed,
    );
    execution_rows(&baseline, &baseline_target.id, "baseline", &mut differences);
    execution_rows(
        &candidate,
        &candidate_target.id,
        "candidate",
        &mut differences,
    );

    for difference in &mut differences {
        if let Some(entry) = policy.match_entry(
            &difference.feature_id,
            difference.check.as_deref(),
            difference.mode,
        ) {
            let marked = difference
                .clone()
                .mark_intentional(&entry.id, &entry.justification);
            *difference = marked;
        }
    }
    let differences = merge_repeated(differences);

    let mut feature_ids = observed_feature_ids(&baseline, &baseline_target.id);
    feature_ids.extend(observed_feature_ids(&candidate, &candidate_target.id));
    let baseline_families = observed_families(&baseline, &baseline_target.id);
    let candidate_families = observed_families(&candidate, &candidate_target.id);
    let features = feature_ids
        .into_iter()
        .map(|id| {
            let mut families = BTreeSet::new();
            if let Some(family) = baseline_families.get(&id) {
                families.insert(family.clone());
            }
            if let Some(family) = candidate_families.get(&id) {
                families.insert(family.clone());
            }
            FeatureCoverage {
                id: id.clone(),
                families: families.into_iter().collect(),
                baseline: coverage(&baseline, &baseline_target.id, &id),
                candidate: coverage(&candidate, &candidate_target.id, &id),
            }
        })
        .collect::<Vec<_>>();

    let gaps: Vec<Difference> = differences
        .iter()
        .filter(|difference| difference.gap)
        .cloned()
        .collect();
    let unknown_rows = differences
        .iter()
        .filter(|difference| {
            difference.unknown || difference.classification == DifferenceClass::Unsupported.label()
        })
        .count();

    for field in &policy.stable_fields {
        if !stable_observed.contains(field) {
            completeness.push(format!(
                "stable field {field} was not observed in either report"
            ));
        }
    }
    for feature in &features {
        for (role, pair) in [
            ("baseline", &feature.baseline),
            ("candidate", &feature.candidate),
        ] {
            for (mode, coverage) in [("headless", &pair.headless), ("headed", &pair.headed)] {
                if !coverage.executed {
                    completeness.push(format!(
                        "feature {} has no {mode} coverage in {role}",
                        feature.id
                    ));
                } else if !coverage.accepted {
                    completeness.push(format!(
                        "feature {} has no accepted {mode} result in {role}",
                        feature.id
                    ));
                }
            }
        }
    }
    if !gaps.is_empty() {
        completeness.push(format!("{} gap rows remain", gaps.len()));
    }
    if unknown_rows > 0 {
        completeness.push(format!("{unknown_rows} unknown or unsupported rows remain"));
    }
    if !baseline.complete {
        completeness.push("baseline report does not claim complete".to_string());
        completeness.extend(baseline.completeness.clone());
    }
    if !candidate.complete {
        completeness.push("candidate report does not claim complete".to_string());
        completeness.extend(candidate.completeness.clone());
    }
    let plan_ref = match &plan {
        Some((path, sha256, plan, plan_complete)) => {
            if !*plan_complete {
                completeness.push("comparison plan is incomplete".to_string());
            }
            if baseline.plan_hash != *sha256 || candidate.plan_hash != *sha256 {
                completeness.push("report planHash does not match the supplied plan".to_string());
            }
            if baseline.plan_id != plan.id || candidate.plan_id != plan.id {
                completeness.push("report planId does not match the supplied plan".to_string());
            }
            completeness.extend(missing_plan_configurations(
                plan,
                &baseline,
                &baseline_target.id,
                &candidate,
                &candidate_target.id,
            ));
            Some(PlanRef {
                path: path.to_string_lossy().into_owned(),
                sha256: sha256.clone(),
                complete: *plan_complete,
            })
        }
        None => {
            completeness
                .push("plan was not supplied; completeness cannot be established".to_string());
            None
        }
    };
    completeness.sort();
    completeness.dedup();
    let complete = completeness.is_empty();
    let summary = summarize(&features, &differences, &gaps);
    let report = CompareReport {
        schema: COMPARE_SCHEMA.to_string(),
        generated_at: time::now_rfc3339(),
        baseline: ReportRef {
            path: baseline_path.to_string_lossy().into_owned(),
            run_id: baseline.run_id.clone(),
            plan_hash: baseline.plan_hash.clone(),
            complete: baseline.complete,
            target_id: baseline_target.id.clone(),
        },
        candidate: ReportRef {
            path: candidate_path.to_string_lossy().into_owned(),
            run_id: candidate.run_id.clone(),
            plan_hash: candidate.plan_hash.clone(),
            complete: candidate.complete,
            target_id: candidate_target.id.clone(),
        },
        policy: policy_ref,
        plan: plan_ref,
        confounders,
        causal_attribution: attribution,
        features,
        differences,
        gaps,
        summary,
        complete,
        completeness,
    };
    let output = util::absolute(&options.output)?;
    storage::write_private_json(&output, &report, options.force)?;
    Ok((output, report))
}

fn load_report(path: &Path) -> Result<Report> {
    let bytes = storage::read_bytes(path)?;
    let report: Report = serde_json::from_slice(&bytes)
        .with_context(|| format!("failed to parse report {}", path.display()))?;
    let validation = validate::report(&report, &path.to_string_lossy());
    if !validation.valid {
        let messages: Vec<&str> = validation
            .findings
            .iter()
            .filter(|finding| finding.severity == validate::Severity::Error)
            .map(|finding| finding.message.as_str())
            .collect();
        bail!(
            "report {} is invalid: {}",
            path.display(),
            messages.join("; ")
        );
    }
    Ok(report)
}

fn select_target<'a>(
    report: &'a Report,
    explicit: Option<&str>,
    preferred: &str,
    path: &Path,
) -> Result<&'a InventoryRecord> {
    if let Some(id) = explicit {
        return report
            .targets
            .iter()
            .find(|target| target.id == id)
            .with_context(|| format!("report {} has no target {id}", path.display()));
    }
    if report.targets.len() == 1 {
        return Ok(&report.targets[0]);
    }
    if let Some(target) = report.targets.iter().find(|target| target.id == preferred) {
        return Ok(target);
    }
    bail!(
        "report {} has {} targets; pass --{}-target",
        path.display(),
        report.targets.len(),
        preferred
    )
}

type RunKey = (Mode, u32, String, String);

fn runs_by_key<'a>(report: &'a Report, target_id: &str) -> Result<BTreeMap<RunKey, &'a RunRecord>> {
    let mut runs = BTreeMap::new();
    for run in report
        .runs
        .iter()
        .filter(|run| run.configuration.target_id == target_id)
    {
        let key = run.configuration.match_key();
        if runs.insert(key, run).is_some() {
            bail!(
                "report {} has ambiguous configurations for mode/iteration/profile",
                report.run_id
            );
        }
    }
    Ok(runs)
}

#[allow(clippy::too_many_arguments)]
mod merge;
mod pairing;
mod stability;
use merge::*;
use pairing::*;
use stability::*;
