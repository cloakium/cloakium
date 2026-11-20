//! Public validation result types.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Severity {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub severity: Severity,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configuration_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Validation {
    pub schema: String,
    pub target: String,
    pub path: String,
    pub valid: bool,
    pub complete: bool,
    pub findings: Vec<Finding>,
    pub completeness: Vec<String>,
}

impl Validation {
    pub(crate) fn new(target: &str, path: &str) -> Self {
        Self {
            schema: "cloakium.audit.validation/1".to_string(),
            target: target.to_string(),
            path: path.to_string(),
            valid: true,
            complete: true,
            findings: Vec::new(),
            completeness: Vec::new(),
        }
    }

    pub(crate) fn error(&mut self, code: &str, message: impl Into<String>) {
        self.valid = false;
        self.findings.push(Finding {
            severity: Severity::Error,
            code: code.to_string(),
            message: message.into(),
            configuration_id: None,
        });
    }

    pub(crate) fn warn(&mut self, code: &str, message: impl Into<String>) {
        self.findings.push(Finding {
            severity: Severity::Warning,
            code: code.to_string(),
            message: message.into(),
            configuration_id: None,
        });
    }

    pub(crate) fn incomplete(&mut self, reason: impl Into<String>) {
        self.complete = false;
        self.completeness.push(reason.into());
    }

    pub(crate) fn finalize(mut self) -> Self {
        if !self.valid {
            self.complete = false;
            self.completeness.push("document is invalid".to_string());
        }
        self
    }
}
