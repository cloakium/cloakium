//! Verification-evidence validation.
//!
//! The evidence is produced by the Node verifier and records the *tested*
//! native browser and Playwright versions, the aggregate exit code and the
//! individual check results. It is the only compatibility signal a release is
//! judged by: there is no version heuristic anywhere in this crate.

use std::path::Path;

use anyhow::{ensure, Context, Result};
use serde_json::Value;

use crate::release::EVIDENCE_ASSET;
use crate::sign_validate::{string_field, Facts};
use crate::util;

const PASS_WORDS: [&str; 4] = ["passed", "pass", "ok", "success"];

/// Validate the recorded integration evidence against the release pins.
pub fn validate_evidence(path: &Path, facts: &Facts) -> Result<()> {
    let evidence = util::read_json(path)
        .with_context(|| format!("the release has no readable {EVIDENCE_ASSET}"))?;
    let status = string_field(&evidence, "status", "verification.json")?;
    ensure!(
        status == "passed",
        "the recorded verification status is {status:?}, expected \"passed\""
    );
    let exit_code = evidence
        .get("exitCode")
        .or_else(|| evidence.get("exit_code"))
        .and_then(Value::as_i64)
        .context("verification.json has no exitCode")?;
    ensure!(
        exit_code == 0,
        "the recorded verification exitCode is {exit_code}, expected 0"
    );
    for key in ["signal", "signals"] {
        if let Some(value) = evidence.get(key) {
            ensure!(
                no_signals(value),
                "verification.json records a process signal ({key})"
            );
        }
    }
    if let Some(checks) = evidence.get("checks").or_else(|| evidence.get("allChecks")) {
        let checks = checks
            .as_array()
            .context("verification checks must be an array")?;
        ensure!(!checks.is_empty(), "verification.json records no checks");
        for (index, check) in checks.iter().enumerate() {
            ensure!(
                check_passed(check),
                "verification check {} did not pass: {check}",
                index + 1
            );
        }
    }
    let browser = evidence_browser_version(&evidence)
        .context("verification.json does not record the tested browserVersion")?;
    let parts = facts.chromium.split('.').count();
    let actual = recorded_version(&browser, parts)?;
    let playwright = evidence_version(&evidence, "playwright")
        .context("verification.json does not record the verified Playwright version")?;
    ensure!(
        actual == facts.chromium,
        "verification recorded browser {browser:?} (Chromium {actual}), the release pins the native Chromium {}",
        facts.chromium
    );
    ensure!(
        playwright == facts.playwright,
        "verification recorded Playwright {playwright}, the release pins {}",
        facts.playwright
    );
    Ok(())
}

/// Extract exactly one version with `parts` numeric components from recorded
/// evidence text.
///
/// The Node producer records the browser's own `--version` output
/// (`"Chromium 157.0.8103.50"`), while a staged manifest records the bare
/// canonical version. Both normalise to one validated numeric version. A
/// partial match, an extra component, a trailing identifier or two different
/// versions are rejected, so a version is never accepted by substring accident.
pub fn recorded_version(value: &str, parts: usize) -> Result<String> {
    ensure!(parts >= 2, "a version needs at least two components");
    let bytes = value.as_bytes();
    let mut found = std::collections::BTreeSet::new();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let boundary_before = index == 0 || {
            let previous = bytes[index - 1];
            !(previous.is_ascii_alphanumeric() || previous == b'.')
        };
        let start = index;
        while index < bytes.len() && (bytes[index].is_ascii_digit() || bytes[index] == b'.') {
            index += 1;
        }
        let boundary_after = bytes
            .get(index)
            .is_none_or(|next| !next.is_ascii_alphanumeric());
        if !boundary_before || !boundary_after {
            continue;
        }
        let run = &value[start..index];
        let components: Vec<&str> = run.split('.').collect();
        let numeric = components.iter().all(|component| {
            !component.is_empty() && component.bytes().all(|byte| byte.is_ascii_digit())
        });
        if components.len() == parts && numeric {
            found.insert(run.to_string());
        }
    }
    ensure!(
        !found.is_empty(),
        "no {parts}-component version in the recorded browser string {value:?}"
    );
    ensure!(
        found.len() == 1,
        "ambiguous versions in the recorded browser string {value:?}: {found:?}"
    );
    Ok(found.into_iter().next().expect("one version"))
}

/// The browser the verification gate actually launched, not the CfT pin.
fn evidence_browser_version(evidence: &Value) -> Option<String> {
    [
        evidence.get("browserVersion"),
        evidence.get("chromium"),
        evidence.get("chromiumVersion"),
        evidence
            .get("versions")
            .and_then(|versions| versions.get("browserVersion")),
        evidence
            .get("versions")
            .and_then(|versions| versions.get("chromium")),
    ]
    .into_iter()
    .flatten()
    .find_map(Value::as_str)
    .map(str::to_string)
    .filter(|value| !value.is_empty())
}

fn evidence_version(evidence: &Value, name: &str) -> Option<String> {
    let direct = evidence.get(name).and_then(Value::as_str);
    let aliased = evidence
        .get(format!("{name}Version"))
        .and_then(Value::as_str);
    let nested = evidence
        .get("versions")
        .and_then(|versions| versions.get(name))
        .and_then(Value::as_str);
    direct
        .or(aliased)
        .or(nested)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
}

fn no_signals(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.trim().is_empty(),
        Value::Array(items) => items.iter().all(|item| match item {
            Value::Null => true,
            Value::String(text) => text.trim().is_empty(),
            _ => false,
        }),
        _ => false,
    }
}

fn check_passed(check: &Value) -> bool {
    match check {
        Value::String(text) => PASS_WORDS.contains(&text.as_str()),
        Value::Object(object) => {
            if let Some(status) = object.get("status").and_then(Value::as_str) {
                return PASS_WORDS.contains(&status);
            }
            if object.get("passed").and_then(Value::as_bool) == Some(true)
                || object.get("ok").and_then(Value::as_bool) == Some(true)
            {
                return true;
            }
            let exit = object
                .get("exitCode")
                .or_else(|| object.get("exit_code"))
                .and_then(Value::as_i64);
            let quiet = ["signal", "signals"]
                .iter()
                .all(|key| object.get(*key).is_none_or(no_signals));
            exit == Some(0) && quiet
        }
        _ => false,
    }
}
