//! Observation tri-state validation.

use std::collections::BTreeSet;

use crate::report::{CheckStatus, Observation};

use super::messages::is_unsafe_label;
use super::Validation;

pub(crate) fn validate_observations(observations: &[Observation], validation: &mut Validation) {
    let mut ids = BTreeSet::new();
    for observation in observations {
        if is_unsafe_label(&observation.id) {
            validation.error(
                "observation.id",
                "observation id must be a non-empty safe label",
            );
        }
        if !ids.insert(observation.id.clone()) {
            validation.error(
                "observation.duplicate",
                format!("duplicate observation id {}", observation.id),
            );
        }
        if is_unsafe_label(&observation.family) {
            validation.error(
                "observation.family",
                format!(
                    "observation {} family must be a non-empty safe label",
                    observation.id
                ),
            );
        }
        let mut check_names = BTreeSet::new();
        for check in &observation.result.checks {
            if is_unsafe_label(&check.name) {
                validation.error(
                    "check.name",
                    format!("observation {} has an empty check name", observation.id),
                );
            }
            if !check_names.insert(check.name.clone()) {
                validation.error(
                    "check.duplicate",
                    format!(
                        "observation {} duplicate check {}",
                        observation.id, check.name
                    ),
                );
            }
            match (check.status, check.passed) {
                (Some(CheckStatus::Pass), Some(true)) | (Some(CheckStatus::Fail), Some(false)) => {}
                (Some(CheckStatus::Pass), _) => validation.error(
                    "check.tristate",
                    format!("check {} status pass requires passed true", check.name),
                ),
                (Some(CheckStatus::Fail), _) => validation.error(
                    "check.tristate",
                    format!("check {} status fail requires passed false", check.name),
                ),
                (Some(_), Some(true)) => validation.error(
                    "check.tristate",
                    format!(
                        "check {} non-pass status cannot carry passed true",
                        check.name
                    ),
                ),
                (Some(_), Some(false) | None) | (None, _) => {}
            }
        }
    }
}
