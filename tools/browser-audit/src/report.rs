//! Canonical report, runner-fragment and observation types.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::inventory::InventoryRecord;
use crate::model::{Configuration, DisplaySpec};
use crate::tree::ProcessCleanup;

pub const REPORT_SCHEMA: &str = "cloakium.audit.report/1";
pub const RUNNER_SCHEMA: &str = "cloakium.audit.runner/1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OsFacts {
    pub id: String,
    pub name: String,
    pub version_id: String,
    pub pretty_name: String,
    pub build_id: String,
    pub kernel: String,
    pub arch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimezoneFacts {
    pub id: String,
    pub zoneinfo_path: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FontconfigFacts {
    pub declared_file: String,
    pub real_path: String,
    pub exists: bool,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_real_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_exists: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayFacts {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket_exists: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xauthority_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xauthority_real_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xauthority_exists: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xauthority_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ownership_manifest_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ownership_manifest_real_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ownership_manifest_exists: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ownership_manifest_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocaleFacts {
    pub declared: String,
    pub source: String,
    pub process_lang: String,
    pub process_lc_all: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentPolicy {
    pub mode: String,
    pub inherited: bool,
    pub applied_keys: Vec<String>,
    pub display_keys: Vec<String>,
    pub headless_display: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedFacts {
    pub os: OsFacts,
    pub timezone: TimezoneFacts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fontconfig: Option<FontconfigFacts>,
    pub display: DisplayFacts,
    pub locale: LocaleFacts,
    pub environment: EnvironmentPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedEnvironment {
    pub id: String,
    pub locale: String,
    pub timezone_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fontconfig_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fontconfig_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_manifest_sha256: Option<String>,
    pub display: DisplaySpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub resolved: ResolvedFacts,
    /// Additional provenance supplied by the selected JS runner (probe hashes,
    /// client hashes, fontconfig diagnostics). Environment values are not
    /// accepted here; only evidence derived from files and tool output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Value>,
    /// Parent-owned environment receipt (actual font files, noexcept ambient
    /// endpoints, isolation flags). It is a map so the parent can add fields
    /// without changing the Rust envelope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment_receipt: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeRecord {
    pub id: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeFacts {
    pub path: String,
    pub sha256: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerFacts {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuiteRecord {
    pub manifest_sha256: String,
    pub probes: Vec<ProbeRecord>,
    pub runner: RunnerFacts,
    pub node: NodeFacts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientRecord {
    pub version: String,
    pub path: String,
    /// Whole client package content-manifest digest (or the entry digest when
    /// the runner has no package manifest).
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_manifest_sha256: Option<String>,
    /// Digest of the exact plan `clientModule` entry file, computed by Rust.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ObservationStatus {
    Observed,
    Error,
    Unsupported,
    Skipped,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CheckStatus {
    Pass,
    Fail,
    Unknown,
    Error,
    Unsupported,
    Skipped,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Check {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<CheckStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectiveCheck {
    Pass,
    Fail,
    Unknown,
    Error,
    Unsupported,
    Skipped,
}

impl Check {
    /// The tri-state contract: a non-pass/non-fail status plus `passed: false`
    /// or `null` is unknown (or error/unsupported), never a failure.
    pub fn effective(&self) -> EffectiveCheck {
        match self.status {
            Some(CheckStatus::Pass) => EffectiveCheck::Pass,
            Some(CheckStatus::Fail) => EffectiveCheck::Fail,
            Some(CheckStatus::Error) => EffectiveCheck::Error,
            Some(CheckStatus::Unsupported) => EffectiveCheck::Unsupported,
            Some(CheckStatus::Skipped | CheckStatus::NotApplicable) => EffectiveCheck::Skipped,
            Some(CheckStatus::Unknown) => EffectiveCheck::Unknown,
            None => match self.passed {
                Some(true) => EffectiveCheck::Pass,
                Some(false) => EffectiveCheck::Fail,
                None => EffectiveCheck::Unknown,
            },
        }
    }

    pub fn effective_label(&self) -> &'static str {
        match self.effective() {
            EffectiveCheck::Pass => "pass",
            EffectiveCheck::Fail => "fail",
            EffectiveCheck::Unknown => "unknown",
            EffectiveCheck::Error => "error",
            EffectiveCheck::Unsupported => "unsupported",
            EffectiveCheck::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationResult {
    pub observations: Value,
    #[serde(default)]
    pub checks: Vec<Check>,
    #[serde(default)]
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub id: String,
    pub family: String,
    pub status: ObservationStatus,
    pub result: ObservationResult,
}

impl Observation {
    pub fn accepted(&self) -> bool {
        self.status == ObservationStatus::Observed
            && !self.result.checks.is_empty()
            && self
                .result
                .checks
                .iter()
                .all(|check| check.effective() == EffectiveCheck::Pass)
    }

    pub fn check(&self, name: &str) -> Option<&Check> {
        self.result.checks.iter().find(|check| check.name == name)
    }

    pub fn check_names(&self) -> BTreeSet<String> {
        self.result
            .checks
            .iter()
            .map(|check| check.name.clone())
            .collect()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CleanupStatus {
    Clean,
    Incomplete,
    NotRun,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupRecord {
    pub status: CleanupStatus,
    #[serde(default)]
    pub notes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_closed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contexts_closed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_exited: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRecord {
    pub configuration: Configuration,
    pub version: String,
    pub client: ClientRecord,
    pub environment: ResolvedEnvironment,
    pub observations: Vec<Observation>,
    pub cleanup: CleanupRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    Timeout,
    Protocol,
    Execution,
    Cleanup,
    Inventory,
    Configuration,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditError {
    pub kind: ErrorKind,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration_id: Option<String>,
    /// Short stable error class from a known enum; never a raw driver message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_closed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_category: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PostprocessingRecovery {
    pub original_report_path: String,
    pub original_report_sha256: String,
    pub fragment_sha256: String,
    pub plan_sha256: String,
    pub tool_version: String,
    pub generated_at: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
    pub schema: String,
    pub run_id: String,
    pub plan_id: String,
    pub plan_hash: String,
    pub suite: SuiteRecord,
    pub environment: ResolvedEnvironment,
    pub targets: Vec<InventoryRecord>,
    pub runs: Vec<RunRecord>,
    pub errors: Vec<AuditError>,
    pub started: String,
    pub finished: String,
    pub complete: bool,
    #[serde(default)]
    pub completeness: Vec<String>,
    #[serde(default)]
    pub limitations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_cleanup: Option<ProcessCleanup>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub postprocessing_recovery: Option<PostprocessingRecovery>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerSuite {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_sha256: Option<String>,
    #[serde(default)]
    pub probes: Vec<ProbeRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerReport {
    pub schema: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suite: Option<RunnerSuite>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<ResolvedEnvironment>,
    #[serde(default)]
    pub runs: Vec<RunRecord>,
    #[serde(default)]
    pub errors: Vec<AuditError>,
}

pub fn check_map(observation: &Observation) -> BTreeMap<String, EffectiveCheck> {
    observation
        .result
        .checks
        .iter()
        .map(|check| (check.name.clone(), check.effective()))
        .collect()
}
