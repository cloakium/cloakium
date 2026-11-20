//! Run support: tool selection, strict environment and protocol parsing.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

use crate::hash;
use crate::model::Plan;
use crate::process::{self, ProcessSpec};
use crate::report::{AuditError, ErrorKind, ResolvedEnvironment, RunnerReport, RUNNER_SCHEMA};
use crate::storage;
use crate::util;

#[derive(Debug, Clone)]
pub struct RunOptions {
    pub plan: PathBuf,
    pub node: PathBuf,
    pub runner: PathBuf,
    pub output: Option<PathBuf>,
    pub timeout: Duration,
    pub suite_manifest: Option<PathBuf>,
    pub lock: Option<PathBuf>,
}

#[derive(Debug)]
pub struct RunOutcome {
    pub report_path: PathBuf,
    pub complete: bool,
    pub run_count: usize,
    pub error_count: usize,
    pub plan_hash: String,
}

pub(crate) struct Tool {
    pub(crate) path: PathBuf,
    pub(crate) sha256: String,
}

pub(crate) struct EntryFacts {
    pub(crate) path: PathBuf,
    pub(crate) sha256: String,
}

pub(crate) struct RuntimeEnv {
    pub(crate) h3_bin: Option<PathBuf>,
    pub(crate) display_bin: Option<PathBuf>,
    pub(crate) fc_list_bin: Option<PathBuf>,
    pub(crate) openssl_bin: Option<PathBuf>,
}

pub(crate) fn identify_regular(path: &Path, field: &str) -> Result<PathBuf> {
    let absolute = util::absolute(path)?;
    let metadata = fs::metadata(&absolute)
        .with_context(|| format!("{field} is not accessible: {}", absolute.display()))?;
    if !metadata.is_file() {
        bail!("{field} must be a regular file: {}", absolute.display());
    }
    fs::canonicalize(&absolute)
        .with_context(|| format!("{field} cannot be resolved: {}", absolute.display()))
}

pub(crate) fn identify_tool(path: &Path, field: &str, executable: bool) -> Result<Tool> {
    let canonical = identify_regular(path, field)?;
    if executable {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&canonical)?.permissions().mode();
        if mode & 0o111 == 0 {
            bail!("{field} is not executable: {}", canonical.display());
        }
    }
    Ok(Tool {
        sha256: hash::file(&canonical)?,
        path: canonical,
    })
}

pub(crate) fn target_entries(plan: &Plan) -> Result<BTreeMap<String, EntryFacts>> {
    let mut entries = BTreeMap::new();
    for target in &plan.targets {
        let path = identify_regular(Path::new(&target.client_module), "client module")?;
        entries.insert(
            target.id.clone(),
            EntryFacts {
                sha256: hash::file(&path)?,
                path,
            },
        );
    }
    Ok(entries)
}

pub(crate) fn runtime_env() -> Result<RuntimeEnv> {
    let h3_bin = optional_tool_env("CLOAKIUM_H3_BIN")?;
    let display_bin = optional_tool_env("CLOAKIUM_AUDIT_DISPLAY_BIN")?;
    let fc_list_bin = optional_tool_env("CLOAKIUM_FC_LIST_BIN")?;
    let openssl_bin = optional_tool_env("OPENSSL_BIN")?;
    Ok(RuntimeEnv {
        h3_bin,
        display_bin,
        fc_list_bin,
        openssl_bin,
    })
}

pub(crate) fn optional_tool_env(name: &str) -> Result<Option<PathBuf>> {
    let Some(value) = std::env::var_os(name) else {
        return Ok(None);
    };
    if value.is_empty() {
        return Ok(None);
    }
    let path = util::absolute(Path::new(&value))?;
    let canonical = identify_regular(&path, name)?;
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(&canonical)?.permissions().mode();
    if mode & 0o111 == 0 {
        bail!("{name} is not executable: {}", canonical.display());
    }
    Ok(Some(canonical))
}

pub(crate) fn node_version(
    node: &Tool,
    output: &Path,
    plan: &Plan,
    deadline: Instant,
    runtime_env: &RuntimeEnv,
) -> Result<String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    let timeout = remaining.min(Duration::from_secs(10));
    if timeout.is_zero() {
        bail!("wall-clock budget was exhausted before node --version");
    }
    let logs = output.join("node");
    storage::create_private_dir_all(&logs)?;
    let outcome = process::run(&ProcessSpec {
        program: node.path.clone(),
        args: vec!["--version".to_string()],
        env: minimal_env(plan, output, runtime_env, None),
        cwd: output.to_path_buf(),
        stdout_path: logs.join("version.stdout"),
        stderr_path: logs.join("version.stderr"),
        timeout,
    })?;
    if !outcome.success() {
        bail!(
            "node selection failed: {} (private log under node/)",
            outcome.summary()
        );
    }
    let version = outcome.stdout.trim().to_string();
    if version.is_empty() || outcome.stdout_truncated {
        bail!("node --version did not produce a usable version");
    }
    Ok(version)
}

pub(crate) fn minimal_env(
    plan: &Plan,
    output: &Path,
    runtime_env: &RuntimeEnv,
    suite_manifest_sha256: Option<&str>,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for directory in ["home", "tmp", "cache", "config", "runtime"] {
        let _ = storage::create_private_dir_all(&output.join(directory));
    }
    env.insert(
        "HOME".to_string(),
        output.join("home").to_string_lossy().into_owned(),
    );
    env.insert(
        "TMPDIR".to_string(),
        output.join("tmp").to_string_lossy().into_owned(),
    );
    env.insert(
        "XDG_CACHE_HOME".to_string(),
        output.join("cache").to_string_lossy().into_owned(),
    );
    env.insert(
        "XDG_CONFIG_HOME".to_string(),
        output.join("config").to_string_lossy().into_owned(),
    );
    env.insert(
        "XDG_RUNTIME_DIR".to_string(),
        output.join("runtime").to_string_lossy().into_owned(),
    );
    env.insert(
        "PATH".to_string(),
        "/run/current-system/sw/bin:/usr/bin:/bin".to_string(),
    );
    // Browser locale travels in contextOptions; the child POSIX locale stays a
    // valid fixed C.UTF-8 so Node/libc never sees a BCP 47 tag as LANG.
    env.insert("LANG".to_string(), "C.UTF-8".to_string());
    env.insert("LC_ALL".to_string(), "C.UTF-8".to_string());
    env.insert("TZ".to_string(), plan.environment.timezone_id.clone());
    // Tells the selected runner that Rust already holds the global flock seat.
    env.insert("CLOAKIUM_AUDIT_SEAT_RUST".to_string(), "1".to_string());
    if let Some(digest) = suite_manifest_sha256 {
        env.insert(
            "CLOAKIUM_AUDIT_SUITE_MANIFEST_SHA256".to_string(),
            digest.to_string(),
        );
    }
    if let Some(font) = &plan.environment.fontconfig_file {
        env.insert("FONTCONFIG_FILE".to_string(), font.clone());
    }
    if let Some(path) = &runtime_env.h3_bin {
        env.insert(
            "CLOAKIUM_H3_BIN".to_string(),
            path.to_string_lossy().into_owned(),
        );
    }
    if let Some(path) = &runtime_env.display_bin {
        env.insert(
            "CLOAKIUM_AUDIT_DISPLAY_BIN".to_string(),
            path.to_string_lossy().into_owned(),
        );
    }
    if let Some(path) = &runtime_env.fc_list_bin {
        env.insert(
            "CLOAKIUM_FC_LIST_BIN".to_string(),
            path.to_string_lossy().into_owned(),
        );
    }
    if let Some(path) = &runtime_env.openssl_bin {
        env.insert(
            "OPENSSL_BIN".to_string(),
            path.to_string_lossy().into_owned(),
        );
    }
    // Rust never forwards an ambient or plan DISPLAY/XAUTHORITY. The selected
    // display helper resolves headed placeholders inside the runner.
    env
}

pub(crate) fn read_fragment(output: &Path, stdout: &str) -> Result<RunnerReport> {
    for name in ["runner-report.json", "report.json", "runner.json"] {
        let path = output.join(name);
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!("{name} is not a regular file");
        }
        let bytes = fs::read(&path)?;
        if bytes.is_empty() {
            continue;
        }
        let fragment: RunnerReport =
            serde_json::from_slice(&bytes).with_context(|| format!("failed to parse {name}"))?;
        if fragment.schema != RUNNER_SCHEMA {
            bail!("{name} schema is {}", fragment.schema);
        }
        let copy = output.join("runner-report.json");
        if path != copy {
            storage::write_private(&copy, &bytes, true)?;
        }
        let _ = storage::freeze(&copy);
        return Ok(fragment);
    }
    let text = stdout.trim();
    if text.is_empty() {
        bail!("runner produced neither runner-report.json nor a stdout protocol fragment");
    }
    if !text.starts_with('{') {
        bail!("stdout is progress output, not a protocol fragment; write runner-report.json");
    }
    let fragment: RunnerReport = serde_json::from_str(text)
        .context("failed to parse runner stdout as a protocol fragment")?;
    if fragment.schema != RUNNER_SCHEMA {
        bail!("runner stdout schema is {}", fragment.schema);
    }
    Ok(fragment)
}

pub(crate) fn client_path_matches(reported: &str, entry: &Path) -> bool {
    let reported_path = Path::new(reported);
    if reported_path == entry {
        return true;
    }
    if let (Ok(left), Ok(right)) = (fs::canonicalize(reported_path), fs::canonicalize(entry)) {
        if left == right {
            return true;
        }
        if entry.starts_with(&left) {
            return true;
        }
    }
    entry.to_string_lossy().starts_with(&format!("{reported}/"))
}

pub(crate) fn merge_environment(
    base: &ResolvedEnvironment,
    returned: &ResolvedEnvironment,
) -> Result<ResolvedEnvironment, String> {
    if returned.id != base.id {
        return Err("environment id differs from the plan".to_string());
    }
    if returned.locale != base.locale || returned.timezone_id != base.timezone_id {
        return Err("locale or timezone differs from the plan".to_string());
    }
    if returned.display != base.display {
        return Err("display differs from the plan".to_string());
    }
    let mut merged = base.clone();
    merged.diagnostics = returned
        .diagnostics
        .clone()
        .or_else(|| base.diagnostics.clone());
    merged.environment_receipt = returned
        .environment_receipt
        .clone()
        .or_else(|| base.environment_receipt.clone());
    Ok(merged)
}

pub(crate) fn sanitized_error(error: &AuditError) -> bool {
    !error.message.trim().is_empty()
        && error.message.len() <= 512
        && !error
            .message
            .chars()
            .any(|character| character.is_control())
        && !crate::validate::looks_like_raw_error(&error.message)
}

pub(crate) fn error(
    kind: ErrorKind,
    phase: &str,
    configuration_id: Option<String>,
    message: impl Into<String>,
) -> AuditError {
    AuditError {
        kind,
        phase: phase.to_string(),
        configuration_id,
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

#[allow(clippy::too_many_arguments)]
pub(crate) fn write_execution_context(
    output: &Path,
    run_id: &str,
    plan_id: &str,
    plan_hash: &str,
    suite_manifest_sha256: &str,
    node_sha256: &str,
    runner_sha256: &str,
    timeout_ms: u128,
) -> Result<()> {
    storage::write_private_json(
        &output.join("execution.json"),
        &serde_json::json!({
            "schema": "cloakium.audit.execution/1",
            "runId": run_id,
            "planId": plan_id,
            "planHash": plan_hash,
            "suiteManifestSha256": suite_manifest_sha256,
            "nodeSha256": node_sha256,
            "runnerSha256": runner_sha256,
            "timeoutMs": timeout_ms,
        }),
        false,
    )
}

pub(crate) fn verify_inventory(
    inventory: &crate::inventory::InventoryBundle,
    errors: &mut Vec<AuditError>,
) -> bool {
    let mut stable = true;
    for record in &inventory.targets {
        if let Err(problem) = crate::inventory::verify_unchanged(record) {
            stable = false;
            errors.push(error(
                ErrorKind::Inventory,
                "inventory",
                None,
                format!("inventory is no longer immutable: {problem}"),
            ));
        }
    }
    stable
}

pub(crate) fn build_suite(
    manifest_sha256: String,
    probes: Vec<crate::report::ProbeRecord>,
    runner: &Tool,
    node: &Tool,
    node_version: String,
) -> crate::report::SuiteRecord {
    crate::report::SuiteRecord {
        manifest_sha256,
        probes,
        runner: crate::report::RunnerFacts {
            path: runner.path.to_string_lossy().into_owned(),
            sha256: runner.sha256.clone(),
        },
        node: crate::report::NodeFacts {
            path: node.path.to_string_lossy().into_owned(),
            sha256: node.sha256.clone(),
            version: node_version,
        },
    }
}

pub(crate) fn invalid_fragment_summary(
    output: &Path,
    validation: &crate::validate::Validation,
) -> String {
    let codes: Vec<String> = validation
        .findings
        .iter()
        .filter(|finding| finding.severity == crate::validate::Severity::Error)
        .map(|finding| finding.code.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let count = validation
        .findings
        .iter()
        .filter(|finding| finding.severity == crate::validate::Severity::Error)
        .count();
    let detail = serde_json::json!({
        "schema": "cloakium.audit.validation-findings/1",
        "errorCount": count,
        "codes": codes,
        "fragmentPreserved": "runner-report.json",
        "message": "raw finding text is private; only stable codes are recorded"
    });
    let _ = storage::write_private_json(
        &output.join("runner-report.validation.json"),
        &detail,
        false,
    );
    let code_text = detail["codes"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    let mut summary = format!("invalid runner-report.json: {count} validation error(s)");
    if !code_text.is_empty() {
        summary.push_str(" [");
        summary.push_str(&code_text);
        summary.push(']');
    }
    if summary.len() > 500 {
        summary.truncate(500);
    }
    summary
}
