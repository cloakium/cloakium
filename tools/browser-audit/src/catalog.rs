//! Merge canonical gap rows by feature id, preserving provenance and unknowns.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::compare::COMPARE_SCHEMA;
use crate::difference::Provenance;
use crate::hash;
use crate::storage;
use crate::time;
use crate::util;

pub const CATALOG_SCHEMA: &str = "cloakium.audit.catalog/1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub path: String,
    pub sha256: String,
    pub schema: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogRow {
    pub feature_id: String,
    pub families: Vec<String>,
    pub classifications: Vec<String>,
    #[serde(default)]
    pub original_classifications: Vec<String>,
    pub statuses: Vec<String>,
    pub checks: Vec<String>,
    pub modes: Vec<String>,
    pub gap: bool,
    pub unknown: bool,
    pub details: Vec<String>,
    pub confounders: Vec<String>,
    pub policy_ids: Vec<String>,
    pub justifications: Vec<String>,
    pub provenance: Vec<Provenance>,
    pub unknown_provenance: Vec<Provenance>,
    pub sources: Vec<SourceRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogSummary {
    pub features: usize,
    pub gaps: usize,
    pub unknown: usize,
    pub intentional: usize,
    pub sources: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    pub schema: String,
    pub generated_at: String,
    pub sources: Vec<SourceRef>,
    pub rows: Vec<CatalogRow>,
    pub summary: CatalogSummary,
}

pub struct CatalogOptions {
    pub inputs: Vec<PathBuf>,
    pub output: PathBuf,
    pub force: bool,
}

#[derive(Default)]
struct MergeRow {
    families: BTreeSet<String>,
    classifications: BTreeSet<String>,
    original_classifications: BTreeSet<String>,
    statuses: BTreeSet<String>,
    checks: BTreeSet<String>,
    modes: BTreeSet<String>,
    gap: bool,
    unknown: bool,
    details: BTreeSet<String>,
    confounders: BTreeSet<String>,
    policy_ids: BTreeSet<String>,
    justifications: BTreeSet<String>,
    provenance: BTreeMap<ProvenanceKey, Provenance>,
    unknown_provenance: BTreeMap<ProvenanceKey, Provenance>,
    sources: BTreeSet<SourceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ProvenanceKey(String);

impl From<&Provenance> for ProvenanceKey {
    fn from(value: &Provenance) -> Self {
        Self(format!(
            "{}|{}|{}|{}|{:?}|{}",
            value.role,
            value.run_id,
            value.configuration_id,
            value.target_id,
            value.mode,
            value.iteration
        ))
    }
}

pub fn execute(options: &CatalogOptions) -> Result<(PathBuf, Catalog)> {
    if options.inputs.is_empty() {
        bail!("catalog needs at least one --input");
    }
    let mut sources = BTreeSet::new();
    let mut merged: BTreeMap<String, MergeRow> = BTreeMap::new();
    for input in &options.inputs {
        let path = util::absolute(input)?;
        let bytes = storage::read_bytes(&path)?;
        let value: Value = serde_json::from_slice(&bytes)
            .with_context(|| format!("failed to parse catalog input {}", path.display()))?;
        let schema = value
            .get("schema")
            .and_then(Value::as_str)
            .with_context(|| format!("{} has no schema field", path.display()))?
            .to_string();
        let source = SourceRef {
            path: path.to_string_lossy().into_owned(),
            sha256: hash::bytes(&bytes),
            schema: schema.clone(),
        };
        sources.insert(source.clone());
        let rows = match schema.as_str() {
            COMPARE_SCHEMA => value
                .get("differences")
                .and_then(Value::as_array)
                .with_context(|| format!("{} has no differences array", path.display()))?,
            CATALOG_SCHEMA => value
                .get("rows")
                .and_then(Value::as_array)
                .with_context(|| format!("{} has no rows array", path.display()))?,
            other => bail!(
                "unsupported catalog input schema in {}: {other}",
                path.display()
            ),
        };
        for row in rows {
            merge_row(&mut merged, row, &source)?;
        }
    }

    let rows = merged
        .into_iter()
        .map(|(feature_id, row)| CatalogRow {
            feature_id,
            families: row.families.into_iter().collect(),
            classifications: row.classifications.into_iter().collect(),
            original_classifications: row.original_classifications.into_iter().collect(),
            statuses: row.statuses.into_iter().collect(),
            checks: row.checks.into_iter().collect(),
            modes: row.modes.into_iter().collect(),
            gap: row.gap,
            unknown: row.unknown,
            details: row.details.into_iter().collect(),
            confounders: row.confounders.into_iter().collect(),
            policy_ids: row.policy_ids.into_iter().collect(),
            justifications: row.justifications.into_iter().collect(),
            provenance: row.provenance.into_values().collect(),
            unknown_provenance: row.unknown_provenance.into_values().collect(),
            sources: row.sources.into_iter().collect(),
        })
        .collect::<Vec<_>>();
    let gaps = rows.iter().filter(|row| row.gap).count();
    let unknown = rows.iter().filter(|row| row.unknown).count();
    let intentional = rows
        .iter()
        .filter(|row| {
            row.classifications
                .iter()
                .any(|value| value == "intentional-difference")
        })
        .count();
    let catalog = Catalog {
        schema: CATALOG_SCHEMA.to_string(),
        generated_at: time::now_rfc3339(),
        sources: sources.into_iter().collect(),
        summary: CatalogSummary {
            features: rows.len(),
            gaps,
            unknown,
            intentional,
            sources: options.inputs.len(),
        },
        rows,
    };
    let output = util::absolute(&options.output)?;
    storage::write_private_json(&output, &catalog, options.force)?;
    Ok((output, catalog))
}

fn merge_row(
    merged: &mut BTreeMap<String, MergeRow>,
    row: &Value,
    source: &SourceRef,
) -> Result<()> {
    let feature_id = row
        .get("featureId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .context("catalog row has no featureId")?
        .to_string();
    let classifications: Vec<String> = match row.get("classification").and_then(Value::as_str) {
        Some(value) => vec![value.to_string()],
        None => row
            .get("classifications")
            .and_then(Value::as_array)
            .context("catalog row has no classification")?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    };
    if classifications.is_empty() {
        bail!("catalog row has an empty classification list");
    }
    let classification = classifications[0].as_str();
    let entry = merged.entry(feature_id).or_default();
    entry.sources.insert(source.clone());
    if let Some(family) = row.get("family").and_then(Value::as_str) {
        if !family.trim().is_empty() {
            entry.families.insert(family.to_string());
        }
    }
    if let Some(families) = row.get("families").and_then(Value::as_array) {
        for family in families.iter().filter_map(Value::as_str) {
            if !family.trim().is_empty() {
                entry.families.insert(family.to_string());
            }
        }
    }
    for classification in &classifications {
        entry.classifications.insert(classification.clone());
    }
    if let Some(original) = row.get("originalClassification").and_then(Value::as_str) {
        entry.original_classifications.insert(original.to_string());
    }
    if let Some(originals) = row.get("originalClassifications").and_then(Value::as_array) {
        for original in originals.iter().filter_map(Value::as_str) {
            entry.original_classifications.insert(original.to_string());
        }
    }
    if let Some(status) = row.get("baselineStatus").and_then(Value::as_str) {
        entry.statuses.insert(status.to_string());
    }
    if let Some(status) = row.get("candidateStatus").and_then(Value::as_str) {
        entry.statuses.insert(status.to_string());
    }
    if let Some(statuses) = row.get("statuses").and_then(Value::as_array) {
        for status in statuses.iter().filter_map(Value::as_str) {
            entry.statuses.insert(status.to_string());
        }
    }
    if let Some(check) = row.get("check").and_then(Value::as_str) {
        entry.checks.insert(check.to_string());
    }
    if let Some(checks) = row.get("checks").and_then(Value::as_array) {
        for check in checks.iter().filter_map(Value::as_str) {
            entry.checks.insert(check.to_string());
        }
    }
    if let Some(mode) = row.get("mode").and_then(Value::as_str) {
        entry.modes.insert(mode.to_string());
    }
    if let Some(modes) = row.get("modes").and_then(Value::as_array) {
        for mode in modes.iter().filter_map(Value::as_str) {
            entry.modes.insert(mode.to_string());
        }
    }
    if let Some(detail) = row.get("detail").and_then(Value::as_str) {
        if !detail.trim().is_empty() {
            entry.details.insert(detail.to_string());
        }
    }
    if let Some(details) = row.get("details").and_then(Value::as_array) {
        for detail in details.iter().filter_map(Value::as_str) {
            entry.details.insert(detail.to_string());
        }
    }
    if let Some(confounders) = row.get("confounders").and_then(Value::as_array) {
        for confounder in confounders.iter().filter_map(Value::as_str) {
            entry.confounders.insert(confounder.to_string());
        }
    }
    if let Some(policy) = row.get("policyId").and_then(Value::as_str) {
        entry.policy_ids.insert(policy.to_string());
    }
    if let Some(policies) = row.get("policyIds").and_then(Value::as_array) {
        for policy in policies.iter().filter_map(Value::as_str) {
            entry.policy_ids.insert(policy.to_string());
        }
    }
    if let Some(justification) = row.get("justification").and_then(Value::as_str) {
        entry.justifications.insert(justification.to_string());
    }
    if let Some(justifications) = row.get("justifications").and_then(Value::as_array) {
        for justification in justifications.iter().filter_map(Value::as_str) {
            entry.justifications.insert(justification.to_string());
        }
    }
    entry.gap |= row.get("gap").and_then(Value::as_bool).unwrap_or({
        matches!(
            classification,
            "capability-difference"
                | "shared-failure"
                | "stable-field-difference"
                | "headless-regression"
                | "iteration-instability"
                | "execution-error"
                | "coverage-gap"
        )
    });
    let row_unknown = row.get("unknown").and_then(Value::as_bool).unwrap_or(false)
        || classifications.iter().any(|value| value == "unknown");
    entry.unknown |= row_unknown;
    let provenance = parse_provenance(row.get("provenance"))?;
    for item in provenance {
        entry.provenance.insert(ProvenanceKey::from(&item), item);
    }
    if row_unknown {
        for item in entry.provenance.values().cloned().collect::<Vec<_>>() {
            entry
                .unknown_provenance
                .insert(ProvenanceKey::from(&item), item);
        }
    }
    let unknown_provenance = parse_provenance(row.get("unknownProvenance"))?;
    for item in unknown_provenance {
        entry
            .unknown_provenance
            .insert(ProvenanceKey::from(&item), item);
    }
    Ok(())
}

fn parse_provenance(value: Option<&Value>) -> Result<Vec<Provenance>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(array) = value.as_array() else {
        bail!("provenance must be an array");
    };
    let mut result = Vec::new();
    for item in array {
        result.push(serde_json::from_value(item.clone()).context("provenance entry is malformed")?);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rows_merge_by_feature_and_preserve_unknowns() {
        let source = SourceRef {
            path: "/tmp/a.json".to_string(),
            sha256: "a".repeat(64),
            schema: COMPARE_SCHEMA.to_string(),
        };
        let mut merged = BTreeMap::new();
        merge_row(
            &mut merged,
            &json!({
                "featureId": "navigator.webdriver",
                "family": "navigator",
                "classification": "capability-difference",
                "gap": true,
                "detail": "candidate failed",
                "provenance": [{"role": "candidate", "runId": "run-1", "configurationId": "c", "targetId": "candidate", "mode": "headless", "iteration": 1}]
            }),
            &source,
        )
        .expect("first");
        merge_row(
            &mut merged,
            &json!({
                "featureId": "navigator.webdriver",
                "family": "navigator",
                "classification": "unknown",
                "unknown": true,
                "detail": "not observed",
                "provenance": [{"role": "baseline", "runId": "run-0", "configurationId": "b", "targetId": "baseline", "mode": "headless", "iteration": 1}]
            }),
            &source,
        )
        .expect("second");
        let row = merged.get("navigator.webdriver").expect("row");
        assert!(row.gap);
        assert!(row.unknown);
        assert_eq!(row.classifications.len(), 2);
        assert_eq!(row.provenance.len(), 2);
        assert_eq!(row.unknown_provenance.len(), 2);
    }
}
