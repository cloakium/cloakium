//! Recorded comparison policy: explicit intentional differences and stable fields.
//!
//! A policy cannot hide arbitrary evidence: every allowlist entry needs a
//! justification and exact feature ids, and every raw difference is retained.

use std::collections::BTreeSet;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::model::Mode;

pub const POLICY_SCHEMA: &str = "cloakium.audit.policy/1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AllowlistEntry {
    pub id: String,
    pub justification: String,
    pub feature_ids: Vec<String>,
    #[serde(default)]
    pub checks: Vec<String>,
    #[serde(default)]
    pub modes: Vec<Mode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub schema: String,
    #[serde(default)]
    pub allowlist: Vec<AllowlistEntry>,
    #[serde(default)]
    pub stable_fields: Vec<String>,
}

impl Policy {
    pub fn empty() -> Self {
        Self {
            schema: POLICY_SCHEMA.to_string(),
            allowlist: Vec::new(),
            stable_fields: Vec::new(),
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema != POLICY_SCHEMA {
            bail!(
                "expected policy schema {POLICY_SCHEMA}, found {}",
                self.schema
            );
        }
        let mut ids = BTreeSet::new();
        for entry in &self.allowlist {
            if entry.id.trim().is_empty() || !ids.insert(entry.id.clone()) {
                bail!("allowlist ids must be unique and non-empty");
            }
            if entry.justification.trim().len() < 10 {
                bail!(
                    "allowlist {} needs a specific justification, not a generic exclusion",
                    entry.id
                );
            }
            if entry.feature_ids.is_empty() {
                bail!("allowlist {} names no feature ids", entry.id);
            }
            let mut features = BTreeSet::new();
            for feature in &entry.feature_ids {
                if feature.trim().is_empty()
                    || feature == "*"
                    || feature.eq_ignore_ascii_case("all")
                    || !features.insert(feature)
                {
                    bail!(
                        "allowlist {} uses a broad or duplicate feature id: {feature}",
                        entry.id
                    );
                }
            }
            for check in &entry.checks {
                if check.trim().is_empty() || check == "*" {
                    bail!("allowlist {} uses a broad check selector", entry.id);
                }
            }
        }
        let mut stable = BTreeSet::new();
        for field in &self.stable_fields {
            if field.trim().is_empty() || field.contains('*') || !stable.insert(field) {
                bail!("stableFields must be unique, non-empty exact paths: {field}");
            }
            if !field
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "._-[]:$".contains(character))
            {
                bail!("stable field path contains unsupported characters: {field}");
            }
        }
        Ok(())
    }

    pub fn match_entry(
        &self,
        feature_id: &str,
        check: Option<&str>,
        mode: Option<Mode>,
    ) -> Option<&AllowlistEntry> {
        self.allowlist.iter().find(|entry| {
            entry
                .feature_ids
                .iter()
                .any(|feature| feature == feature_id)
                && (entry.checks.is_empty()
                    || check.is_some_and(|value| entry.checks.iter().any(|item| item == value)))
                && (entry.modes.is_empty()
                    || mode.is_some_and(|value| entry.modes.contains(&value)))
        })
    }

    pub fn stable(&self, path: &str) -> bool {
        self.stable_fields.iter().any(|field| field == path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broad_allowlists_are_rejected() {
        let mut policy = Policy::empty();
        policy.allowlist.push(AllowlistEntry {
            id: "broad".to_string(),
            justification: "because the profile differs".to_string(),
            feature_ids: vec!["*".to_string()],
            checks: Vec::new(),
            modes: Vec::new(),
        });
        assert!(policy.validate().is_err());
    }

    #[test]
    fn exact_entries_match_only_their_feature() {
        let mut policy = Policy::empty();
        policy.allowlist.push(AllowlistEntry {
            id: "locale".to_string(),
            justification: "profile intentionally uses fr-FR".to_string(),
            feature_ids: vec!["navigator.language".to_string()],
            checks: vec!["language".to_string()],
            modes: vec![Mode::Headless],
        });
        assert!(policy
            .match_entry("navigator.language", Some("language"), Some(Mode::Headless))
            .is_some());
        assert!(policy
            .match_entry("navigator.language", Some("other"), Some(Mode::Headless))
            .is_none());
        assert!(policy
            .match_entry(
                "navigator.userAgent",
                Some("language"),
                Some(Mode::Headless)
            )
            .is_none());
    }
}
