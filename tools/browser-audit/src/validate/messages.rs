//! Sanitized error and label helpers.

use crate::report::CleanupStatus;

use super::Validation;

pub(crate) fn validate_error(error: &crate::report::AuditError, validation: &mut Validation) {
    if error.message.trim().is_empty() {
        validation.error("error.message", "an audit error message cannot be empty");
        return;
    }
    if error.message.len() > 512
        || error
            .message
            .chars()
            .any(|character| character.is_control())
        || looks_like_raw_error(&error.message)
    {
        validation.error(
            "error.message",
            "audit error messages must be short, single-line sanitized summaries; unsanitized driver diagnostics must not be copied",
        );
    }
    for (field, value) in [
        ("code", &error.code),
        ("operation", &error.operation),
        ("timeoutCategory", &error.timeout_category),
    ] {
        if let Some(value) = value {
            if value.is_empty()
                || value.len() > 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            {
                validation.error(
                    "error.field",
                    format!("audit error {field} must be a short stable identifier"),
                );
            }
        }
    }
}

pub fn looks_like_raw_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    [
        "secret",
        "password",
        "passwd",
        "token",
        "cookie",
        "credential",
        "authorization",
        "apikey",
        "argv",
        "raw driver",
        "http://",
        "https://",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
        || message.contains('@')
        || message.contains('\n')
        || message.contains('\r')
}

pub(crate) fn is_unsafe_label(value: &str) -> bool {
    value.trim().is_empty()
        || value.len() > 256
        || value.chars().any(|character| character.is_control())
}

pub(crate) fn cleanup_label(status: CleanupStatus) -> &'static str {
    match status {
        CleanupStatus::Clean => "clean",
        CleanupStatus::Incomplete => "incomplete",
        CleanupStatus::NotRun => "not-run",
    }
}

pub(crate) fn error_kind_label(kind: crate::report::ErrorKind) -> &'static str {
    match kind {
        crate::report::ErrorKind::Timeout => "timeout",
        crate::report::ErrorKind::Protocol => "protocol",
        crate::report::ErrorKind::Execution => "execution",
        crate::report::ErrorKind::Cleanup => "cleanup",
        crate::report::ErrorKind::Inventory => "inventory",
        crate::report::ErrorKind::Configuration => "configuration",
        crate::report::ErrorKind::Internal => "internal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_labels_allow_slashes_and_spaces_but_not_controls() {
        assert!(!is_unsafe_label("storage/cookie-coherence"));
        assert!(!is_unsafe_label("document replacement writes its DOM"));
        assert!(!is_unsafe_label("geometry/dom-rect-invariants"));
        assert!(is_unsafe_label("line\nbreak"));
        assert!(is_unsafe_label(""));
    }
}
