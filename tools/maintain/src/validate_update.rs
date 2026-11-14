//! Validate an upstream update candidate before the trusted publisher commits
//! it.
//!
//! A candidate is produced by `update` on an untrusted runner. This check runs
//! on trusted code and accepts only the five files an update may rewrite, only
//! the dependency pin inside them, and only a nixpkgs lock refresh.
//!
//! Two shapes are supported:
//!
//! * **Staged directory** — a directory holding only the metadata files. Every
//!   file in it must be an allowed metadata path, so extra staged files and
//!   injected source changes are rejected.
//! * **Full checkout** — a directory with `flake.nix`/`.git`/`.jj`, i.e. what
//!   `--candidate .` sees in a real workspace. Only the five metadata paths are
//!   inspected (each ancestor link is checked too), so build outputs such as
//!   `result-*` GC roots, `node_modules/` and `target/` are ignored instead of
//!   being rejected. Source changes in a checkout are the release workflow's
//!   diff allowlist concern, not this command's.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};
use serde_json::{Map, Value};

use crate::report::Reporter;
use crate::update_candidate::{collect_candidate_files, ensure_candidate_root};
use crate::util;

/// The only paths an upstream update is allowed to touch, in stable order.
pub const ALLOWED_FILES: [&str; 5] = [
    "flake.lock",
    "nix/npm-deps-hash.nix",
    "package-lock.json",
    "package.json",
    "upstream.json",
];

#[derive(Debug, Clone)]
pub struct ValidateUpdateOptions {
    pub base: PathBuf,
    pub candidate: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ValidateUpdateOutcome {
    pub files: Vec<String>,
    pub playwright: String,
    pub chromium: String,
}

#[derive(Default)]
struct Effective {
    upstream: Option<Value>,
    package: Option<Value>,
    lock: Option<Value>,
    npm_hash: Option<String>,
}

/// Check every candidate file and its cross-file consistency.
pub fn prepare(
    options: &ValidateUpdateOptions,
    reporter: &Reporter,
) -> Result<ValidateUpdateOutcome> {
    ensure_candidate_root(&options.candidate)?;
    let base = fs::canonicalize(&options.base)
        .with_context(|| format!("failed to resolve {}", options.base.display()))?;
    let candidate = fs::canonicalize(&options.candidate)
        .with_context(|| format!("failed to resolve {}", options.candidate.display()))?;
    ensure!(base.is_dir(), "--base must be a directory");
    ensure!(candidate.is_dir(), "--candidate must be a directory");

    let files = collect_candidate_files(&base, &candidate)?;
    ensure!(
        !files.is_empty(),
        "the candidate directory contains no update files"
    );
    for file in &files {
        ensure!(
            ALLOWED_FILES.contains(&file.as_str()),
            "the candidate changes a file that updates may not touch: {file}"
        );
    }

    let mut effective = Effective::default();
    for file in &files {
        let candidate_path = candidate.join(file);
        let base_path = base.join(file);
        match file.as_str() {
            "flake.lock" => validate_lock(&base_path, &candidate_path)?,
            "upstream.json" => {
                let value = read_json(&candidate_path)?;
                UpstreamFacts::read(&value)?;
                effective.upstream = Some(value);
            }
            "package.json" => {
                effective.package = Some(validate_package_json(&base_path, &candidate_path)?)
            }
            "package-lock.json" => {
                effective.lock = Some(validate_package_lock(&base_path, &candidate_path)?)
            }
            "nix/npm-deps-hash.nix" => {
                effective.npm_hash = Some(validate_npm_hash(&candidate_path)?)
            }
            other => bail!("unhandled update file: {other}"),
        }
    }

    // Use the effective tree so partial candidates (only the files that
    // actually changed) still cross-check against the base checkout.
    let upstream = effective
        .upstream
        .map(Ok)
        .unwrap_or_else(|| read_json(&base.join("upstream.json")))
        .context("neither the candidate nor the base has upstream.json")?;
    let package = effective
        .package
        .map(Ok)
        .unwrap_or_else(|| read_json(&base.join("package.json")))
        .context("neither the candidate nor the base has package.json")?;
    ensure!(
        base.join("flake.lock").is_file() || files.iter().any(|file| file == "flake.lock"),
        "neither the candidate nor the base has flake.lock"
    );

    let upstream_facts = UpstreamFacts::read(&upstream)?;
    let package_version = package
        .pointer("/devDependencies/playwright-core")
        .and_then(Value::as_str)
        .context("package.json has no devDependencies.playwright-core")?;
    ensure!(
        package_version == upstream_facts.playwright,
        "package.json pins playwright-core {package_version}, but upstream.json records {}",
        upstream_facts.playwright
    );
    if let Some(lock) = &effective.lock {
        let lock_version = lock
            .get("packages")
            .and_then(Value::as_object)
            .and_then(|packages| packages.get(""))
            .and_then(Value::as_object)
            .and_then(|root| root.get("devDependencies"))
            .and_then(Value::as_object)
            .and_then(|dev| dev.get("playwright-core"))
            .and_then(Value::as_str)
            .context("package-lock.json has no root playwright-core dependency")?;
        ensure!(
            lock_version == upstream_facts.playwright,
            "package-lock.json pins playwright-core {lock_version}, but upstream.json records {}",
            upstream_facts.playwright
        );
    }

    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "playwright": upstream_facts.playwright,
            "chromium": upstream_facts.chromium,
            "files": files,
        }))?
    );
    reporter.emit("version", &upstream_facts.playwright)?;
    reporter.emit("playwright", &upstream_facts.playwright)?;
    reporter.emit("chromium", &upstream_facts.chromium)?;
    reporter.emit("files", &files.join(" "))?;

    Ok(ValidateUpdateOutcome {
        files,
        playwright: upstream_facts.playwright,
        chromium: upstream_facts.chromium,
    })
}
fn read_json(path: &Path) -> Result<Value> {
    util::read_json(path).with_context(|| format!("failed to read {}", path.display()))
}

fn validate_lock(base_path: &Path, candidate_path: &Path) -> Result<()> {
    let candidate = read_json(candidate_path)?;
    let revision = candidate
        .pointer("/nodes/nixpkgs/locked/rev")
        .and_then(Value::as_str)
        .context("flake.lock has no nodes.nixpkgs.locked.rev")?;
    ensure!(
        revision.len() == 40 && revision.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "flake.lock has an invalid nixpkgs revision: {revision:?}"
    );
    ensure!(
        candidate
            .pointer("/nodes/nixpkgs/locked/narHash")
            .and_then(Value::as_str)
            .is_some(),
        "flake.lock has no nodes.nixpkgs.locked.narHash"
    );
    ensure!(
        candidate.get("root").and_then(Value::as_str).is_some(),
        "flake.lock has no root node"
    );
    ensure!(
        base_path.is_file(),
        "the base checkout has no flake.lock to compare against"
    );
    let base = read_json(base_path)?;

    let mut masked_base = base.clone();
    let mut masked_candidate = candidate.clone();
    mask_nixpkgs_pin(&mut masked_base);
    mask_nixpkgs_pin(&mut masked_candidate);
    ensure!(
        masked_base == masked_candidate,
        "flake.lock changes more than the nixpkgs pin; updates may only refresh nodes.nixpkgs.locked"
    );
    Ok(())
}

fn mask_nixpkgs_pin(lock: &mut Value) {
    let Some(locked) = lock
        .get_mut("nodes")
        .and_then(Value::as_object_mut)
        .and_then(|nodes| nodes.get_mut("nixpkgs"))
        .and_then(Value::as_object_mut)
        .and_then(|node| node.get_mut("locked"))
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    for key in ["rev", "lastModified", "narHash"] {
        locked.remove(key);
    }
}

struct UpstreamFacts {
    playwright: String,
    chromium: String,
}

impl UpstreamFacts {
    fn read(value: &Value) -> Result<Self> {
        let playwright = value
            .get("playwright")
            .and_then(Value::as_object)
            .context("upstream.json has no playwright block")?;
        let chromium = value
            .get("chromium")
            .and_then(Value::as_object)
            .context("upstream.json has no chromium block")?;
        let version = required_str(playwright, "version", "upstream.playwright")?;
        ensure!(
            util::is_numeric_version(&version, &[3]),
            "upstream.playwright.version is not a stable version: {version:?}"
        );
        let url = required_str(playwright, "url", "upstream.playwright")?;
        let canonical = format!(
            "{}/playwright-core/-/playwright-core-{version}.tgz",
            crate::update::NPM_REGISTRY
        );
        ensure!(
            url == canonical,
            "upstream.playwright.url must be the canonical registry URL {canonical}"
        );
        let hash = required_str(playwright, "hash", "upstream.playwright")?;
        ensure!(
            util::is_sri_sha256(&hash),
            "upstream.playwright.hash is not a sha256 SRI hash"
        );
        let browser_version = required_str(playwright, "chromiumVersion", "upstream.playwright")?;
        ensure!(
            util::is_numeric_version(&browser_version, &[3, 4]),
            "upstream.playwright.chromiumVersion is not a stable version: {browser_version:?}"
        );
        let browser_revision = required_str(playwright, "browserRevision", "upstream.playwright")?;
        ensure!(
            !browser_revision.is_empty()
                && browser_revision.bytes().all(|byte| byte.is_ascii_digit()),
            "upstream.playwright.browserRevision must be numeric"
        );
        let chromium_version = required_str(chromium, "version", "upstream.chromium")?;
        ensure!(
            util::is_numeric_version(&chromium_version, &[3, 4]),
            "upstream.chromium.version is not a stable version: {chromium_version:?}"
        );
        // Two separate pins: the native browser we build and the CfT major the
        // driver bundles. A major jump is informational; the recorded
        // driver+native evidence decides whether the pair is supported.
        if let Some(note) = util::chromium_distance_note(&chromium_version, &browser_version) {
            eprintln!("warning: {note}");
        }
        for (block_name, block) in [("playwright", playwright), ("chromium", chromium)] {
            for (key, entry) in block {
                if matches!(
                    key.as_str(),
                    "version" | "url" | "hash" | "chromiumVersion" | "browserRevision"
                ) {
                    continue;
                }
                ensure_metadata(key, entry, &format!("upstream.{block_name}"))?;
            }
        }
        for (key, entry) in value
            .as_object()
            .expect("upstream.json was checked to be an object")
        {
            if matches!(key.as_str(), "playwright" | "chromium") {
                continue;
            }
            ensure_metadata(key, entry, "upstream")?;
        }
        Ok(Self {
            playwright: version,
            chromium: chromium_version,
        })
    }
}

/// Keys that would imply executable behaviour if anything ever interpreted the
/// metadata file.
const EXECUTABLE_HINTS: [&str; 11] = [
    "script",
    "exec",
    "command",
    "postinstall",
    "preinstall",
    "hook",
    "shell",
    "code",
    "install",
    "cmd",
    "run",
];

fn ensure_metadata(key: &str, value: &Value, context: &str) -> Result<()> {
    let lowered = key.to_ascii_lowercase();
    ensure!(
        !EXECUTABLE_HINTS.iter().any(|hint| lowered.contains(hint)),
        "{context}.{key} looks executable; upstream metadata must stay inert"
    );
    ensure_inert(value, &format!("{context}.{key}"))
}

/// Extra metadata may be recorded, but it must not look like executable code.
fn ensure_inert(value: &Value, context: &str) -> Result<()> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(text) => {
            ensure!(
                !text.contains(['\n', '\r']) && !text.trim_start().starts_with("#!"),
                "{context} looks executable; upstream metadata must stay inert"
            );
            Ok(())
        }
        _ => bail!("{context} must be a scalar value"),
    }
}

fn required_str(object: &Map<String, Value>, key: &str, context: &str) -> Result<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .with_context(|| format!("{context} has no string {key}"))
}

fn validate_package_json(base_path: &Path, candidate_path: &Path) -> Result<Value> {
    let candidate = read_json(candidate_path)?;
    let version = candidate
        .pointer("/devDependencies/playwright-core")
        .and_then(Value::as_str)
        .context("package.json has no devDependencies.playwright-core")?;
    ensure!(
        util::is_numeric_version(version, &[3]),
        "package.json devDependencies.playwright-core must be an exact stable version, got {version:?}"
    );
    ensure!(
        base_path.is_file(),
        "the base checkout has no package.json to compare against"
    );
    let base = read_json(base_path)?;
    ensure!(
        masked_package_json(&base) == masked_package_json(&candidate),
        "package.json may only change devDependencies.playwright-core"
    );
    Ok(candidate)
}

fn masked_package_json(value: &Value) -> Value {
    let mut masked = value.clone();
    if let Some(dev) = masked
        .get_mut("devDependencies")
        .and_then(Value::as_object_mut)
    {
        dev.remove("playwright-core");
    }
    masked
}

fn validate_package_lock(base_path: &Path, candidate_path: &Path) -> Result<Value> {
    let candidate = read_json(candidate_path)?;
    let lockfile_version = candidate
        .get("lockfileVersion")
        .and_then(Value::as_i64)
        .context("package-lock.json has no lockfileVersion")?;
    let packages = candidate
        .get("packages")
        .and_then(Value::as_object)
        .context("package-lock.json has no packages")?;
    let root_version = packages
        .get("")
        .and_then(Value::as_object)
        .and_then(|root| root.get("devDependencies"))
        .and_then(Value::as_object)
        .and_then(|dev| dev.get("playwright-core"))
        .and_then(Value::as_str)
        .context("package-lock.json has no root playwright-core dependency")?;
    ensure!(
        util::is_numeric_version(root_version, &[3]),
        "package-lock.json pins a non-exact playwright-core version: {root_version:?}"
    );
    let entry_version = packages
        .get("node_modules/playwright-core")
        .and_then(Value::as_object)
        .and_then(|entry| entry.get("version"))
        .and_then(Value::as_str)
        .context("package-lock.json has no node_modules/playwright-core entry")?;
    ensure!(
        entry_version == root_version,
        "package-lock.json is inconsistent: root pins {root_version}, the package entry is {entry_version}"
    );
    ensure!(
        base_path.is_file(),
        "the base checkout has no package-lock.json to compare against"
    );
    let base = read_json(base_path)?;
    ensure!(
        base.get("lockfileVersion").and_then(Value::as_i64) == Some(lockfile_version),
        "package-lock.json lockfileVersion changed"
    );
    ensure!(
        masked_package_lock(&base) == masked_package_lock(&candidate),
        "package-lock.json changes more than the playwright-core pin"
    );
    Ok(candidate)
}

fn masked_package_lock(value: &Value) -> Value {
    let mut masked = value.clone();
    if let Some(packages) = masked.get_mut("packages").and_then(Value::as_object_mut) {
        packages.remove("node_modules/playwright-core");
        if let Some(root) = packages.get_mut("").and_then(Value::as_object_mut) {
            if let Some(dev) = root
                .get_mut("devDependencies")
                .and_then(Value::as_object_mut)
            {
                dev.remove("playwright-core");
            }
        }
    }
    if let Some(dependencies) = masked
        .get_mut("dependencies")
        .and_then(Value::as_object_mut)
    {
        dependencies.remove("playwright-core");
    }
    masked
}

fn validate_npm_hash(path: &Path) -> Result<String> {
    let text =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    let hash: String = serde_json::from_str(text.trim())
        .context("nix/npm-deps-hash.nix must contain exactly one Nix string literal")?;
    ensure!(
        util::is_sri_sha256(&hash),
        "nix/npm-deps-hash.nix does not hold a sha256 SRI hash"
    );
    Ok(hash)
}
