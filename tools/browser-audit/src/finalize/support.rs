//! Finalize verification helpers.

use std::path::Path;

use crate::hash;
use crate::model::Plan;
use crate::report::{AuditError, ErrorKind, Report, RunnerReport};
use crate::validate;

use super::ExecutionRecord;

pub(crate) fn verify_execution(
    execution: &ExecutionRecord,
    plan: &Plan,
    plan_hash: &str,
    original: &Report,
    fragment: Option<&RunnerReport>,
    errors: &mut Vec<AuditError>,
) {
    let ok = execution.schema == "cloakium.audit.execution/1"
        && execution.plan_id == plan.id
        && execution.plan_hash == plan_hash
        && execution.run_id == original.run_id
        && execution.suite_manifest_sha256 == original.suite.manifest_sha256
        && execution.node_sha256 == original.suite.node.sha256
        && execution.runner_sha256 == original.suite.runner.sha256
        && execution.timeout_ms > 0;
    if !ok {
        errors.push(error(
            ErrorKind::Protocol,
            "execution",
            "execution.json identities do not match the original report",
        ));
    }
    if let Some(fragment) = fragment {
        if fragment
            .plan_id
            .as_deref()
            .is_some_and(|value| value != plan.id)
            || fragment
                .plan_hash
                .as_deref()
                .is_some_and(|value| value != plan_hash)
        {
            errors.push(error(
                ErrorKind::Protocol,
                "execution",
                "runner fragment identity does not match plan.json",
            ));
        }
        if let Some(manifest) = fragment
            .suite
            .as_ref()
            .and_then(|suite| suite.manifest_sha256.as_deref())
        {
            if manifest != execution.suite_manifest_sha256 {
                errors.push(error(
                    ErrorKind::Protocol,
                    "suite",
                    "runner manifest does not match execution.json",
                ));
            }
        }
    }
}

pub(crate) fn client_path_matches(reported: &str, entry: &str) -> bool {
    if reported == entry {
        return true;
    }
    let reported = Path::new(reported);
    let entry_path = Path::new(entry);
    if let (Ok(left), Ok(right)) = (
        std::fs::canonicalize(reported),
        std::fs::canonicalize(entry_path),
    ) {
        if left == right || entry_path.starts_with(&left) {
            return true;
        }
    }
    entry.starts_with(&format!("{}/", reported.display()))
}

pub(crate) fn current_entry_hash(path: &str) -> Option<String> {
    let path = Path::new(path);
    if path.is_file() {
        hash::file(path).ok()
    } else {
        None
    }
}

pub(crate) fn sanitized(error: &AuditError) -> bool {
    !error.message.trim().is_empty()
        && error.message.len() <= 512
        && !error
            .message
            .chars()
            .any(|character| character.is_control())
        && !validate::looks_like_raw_error(&error.message)
}

pub(crate) fn error(kind: ErrorKind, phase: &str, message: impl Into<String>) -> AuditError {
    AuditError {
        kind,
        phase: phase.to_string(),
        configuration_id: None,
        code: None,
        operation: None,
        target_closed: None,
        timeout_category: None,
        message: message.into(),
    }
}

pub(crate) fn error_kind(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Timeout => "timeout",
        ErrorKind::Protocol => "protocol",
        ErrorKind::Execution => "execution",
        ErrorKind::Cleanup => "cleanup",
        ErrorKind::Inventory => "inventory",
        ErrorKind::Configuration => "configuration",
        ErrorKind::Internal => "internal",
    }
}
