//! Difference rows, deep value comparison, coverage and confounder facts.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::Mode;
use crate::report::{Observation, Report, RunRecord};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DifferenceClass {
    CapabilityDifference,
    SharedFailure,
    StableFieldDifference,
    OrdinaryVariation,
    HeadlessRegression,
    HeadlessImprovement,
    IterationInstability,
    ExecutionError,
    CoverageGap,
    Unsupported,
    Unknown,
    IntentionalDifference,
}

impl DifferenceClass {
    pub fn gap(self) -> bool {
        matches!(
            self,
            Self::CapabilityDifference
                | Self::SharedFailure
                | Self::StableFieldDifference
                | Self::HeadlessRegression
                | Self::IterationInstability
                | Self::ExecutionError
                | Self::CoverageGap
        )
    }

    pub fn unknown(self) -> bool {
        self == Self::Unknown
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::CapabilityDifference => "capability-difference",
            Self::SharedFailure => "shared-failure",
            Self::StableFieldDifference => "stable-field-difference",
            Self::OrdinaryVariation => "ordinary-variation",
            Self::HeadlessRegression => "headless-regression",
            Self::HeadlessImprovement => "headless-improvement",
            Self::IterationInstability => "iteration-instability",
            Self::ExecutionError => "execution-error",
            Self::CoverageGap => "coverage-gap",
            Self::Unsupported => "unsupported",
            Self::Unknown => "unknown",
            Self::IntentionalDifference => "intentional-difference",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub role: String,
    pub run_id: String,
    pub configuration_id: String,
    pub target_id: String,
    pub mode: Mode,
    pub iteration: u32,
}

impl Provenance {
    pub fn from_run(role: &str, report: &Report, run: &RunRecord) -> Self {
        Self {
            role: role.to_string(),
            run_id: report.run_id.clone(),
            configuration_id: run.configuration.id.clone(),
            target_id: run.configuration.target_id.clone(),
            mode: run.configuration.mode,
            iteration: run.configuration.iteration,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Difference {
    pub feature_id: String,
    pub family: String,
    pub classification: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_classification: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtype: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<Mode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_status: Option<String>,
    pub gap: bool,
    pub unknown: bool,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provenance: Vec<Provenance>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub confounders: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub causal_attribution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub justification: Option<String>,
}

impl Difference {
    pub fn new(
        class: DifferenceClass,
        feature_id: &str,
        family: &str,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            feature_id: feature_id.to_string(),
            family: family.to_string(),
            classification: class.label().to_string(),
            original_classification: None,
            subtype: None,
            check: None,
            mode: None,
            baseline_status: None,
            candidate_status: None,
            gap: class.gap(),
            unknown: class.unknown(),
            detail: detail.into(),
            baseline: None,
            candidate: None,
            provenance: Vec::new(),
            confounders: Vec::new(),
            causal_attribution: None,
            policy_id: None,
            justification: None,
        }
    }

    pub fn with_check(mut self, check: &str) -> Self {
        self.check = Some(check.to_string());
        self
    }

    pub fn with_mode(mut self, mode: Mode) -> Self {
        self.mode = Some(mode);
        self
    }

    pub fn with_status(mut self, baseline: &str, candidate: &str) -> Self {
        self.baseline_status = Some(baseline.to_string());
        self.candidate_status = Some(candidate.to_string());
        self
    }

    pub fn with_values(mut self, baseline: Option<Value>, candidate: Option<Value>) -> Self {
        self.baseline = baseline;
        self.candidate = candidate;
        self
    }

    pub fn with_provenance(mut self, provenance: Vec<Provenance>) -> Self {
        self.provenance = provenance;
        self
    }

    pub fn with_confounders(mut self, confounders: &[Confounder]) -> Self {
        self.confounders = confounders.iter().map(|item| item.axis.clone()).collect();
        self.causal_attribution = Some(causal_attribution(confounders).to_string());
        self
    }

    pub fn mark_intentional(mut self, policy_id: &str, justification: &str) -> Self {
        let allowed = matches!(
            self.classification.as_str(),
            "capability-difference"
                | "stable-field-difference"
                | "ordinary-variation"
                | "headless-regression"
                | "headless-improvement"
        );
        if allowed {
            self.original_classification = Some(self.classification.clone());
            self.classification = DifferenceClass::IntentionalDifference.label().to_string();
            self.gap = false;
            self.unknown = false;
            self.policy_id = Some(policy_id.to_string());
            self.justification = Some(justification.to_string());
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Confounder {
    pub axis: String,
    pub baseline: String,
    pub candidate: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub executed: bool,
    pub accepted: bool,
    pub failed: bool,
    pub unknown: bool,
    pub unsupported: bool,
    pub runs: usize,
    pub statuses: Vec<String>,
}

impl Coverage {
    pub fn empty() -> Self {
        Self {
            executed: false,
            accepted: false,
            failed: false,
            unknown: false,
            unsupported: false,
            runs: 0,
            statuses: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModePair {
    pub headless: Coverage,
    pub headed: Coverage,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeatureCoverage {
    pub id: String,
    pub families: Vec<String>,
    pub baseline: ModePair,
    pub candidate: ModePair,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValueDiff {
    pub path: String,
    pub baseline: Option<Value>,
    pub candidate: Option<Value>,
}

mod confounders;
mod environment;
pub(crate) use environment::fixture_origins;
mod value;
pub use confounders::{causal_attribution, confounders, observed_families, observed_feature_ids};
pub use value::{diff_values, value_at_path};

pub fn observation_map(run: &RunRecord) -> BTreeMap<String, &Observation> {
    run.observations
        .iter()
        .map(|observation| (observation.id.clone(), observation))
        .collect()
}

pub fn family_of<'a>(
    baseline: Option<&'a Observation>,
    candidate: Option<&'a Observation>,
) -> String {
    candidate
        .map(|observation| observation.family.clone())
        .or_else(|| baseline.map(|observation| observation.family.clone()))
        .unwrap_or_else(|| "unknown".to_string())
}

pub fn cover(report: &Report, target_id: &str, feature_id: &str) -> ModePair {
    let mut pair = ModePair {
        headless: Coverage::empty(),
        headed: Coverage::empty(),
    };
    for run in report
        .runs
        .iter()
        .filter(|run| run.configuration.target_id == target_id)
    {
        let Some(observation) = run
            .observations
            .iter()
            .find(|observation| observation.id == feature_id)
        else {
            continue;
        };
        let coverage = match run.configuration.mode {
            Mode::Headless => &mut pair.headless,
            Mode::Headed => &mut pair.headed,
        };
        coverage.executed = true;
        coverage.runs += 1;
        coverage.accepted |= observation.accepted();
        coverage.failed |= observation
            .result
            .checks
            .iter()
            .any(|check| check.effective() == crate::report::EffectiveCheck::Fail);
        coverage.unknown |= observation.result.checks.iter().any(|check| {
            matches!(
                check.effective(),
                crate::report::EffectiveCheck::Unknown | crate::report::EffectiveCheck::Skipped
            )
        });
        coverage.unsupported |= observation
            .result
            .checks
            .iter()
            .any(|check| check.effective() == crate::report::EffectiveCheck::Unsupported);
        let status = format!("{:?}", observation.status).to_ascii_lowercase();
        if !coverage.statuses.contains(&status) {
            coverage.statuses.push(status);
        }
    }
    pair
}

#[cfg(test)]
mod tests;
