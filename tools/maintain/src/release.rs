//! Build, package and record an immutable Cloakium release.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Map, Value};

use crate::cache;
use crate::command::{Command, Runner, NETWORK_TIMEOUT};
use crate::npm_pack::pack;
use crate::report::Reporter;
use crate::util;

pub const BROWSER_PACKAGE: &str = "@cloakium/browser";
pub const BROWSER_PACKAGE_DIR: &str = "lib/node_modules/@cloakium/browser";
pub const DEFAULT_CORES: u32 = 16;
pub const DEFAULT_BUILD_TIMEOUT: Duration = Duration::from_secs(4 * 60 * 60);

/// Release asset names that are not produced by the Nix cache itself.
pub const MANIFEST_ASSET: &str = "manifest.json";
pub const SUMS_ASSET: &str = "SHA256SUMS";
pub const EVIDENCE_ASSET: &str = "verification.json";
pub const NOTES_ASSET: &str = "release-notes.md";
pub const PUBLIC_KEY_ASSET: &str = "cache-public-key.txt";
pub const FLAKE_LOCK_ASSET: &str = "source-flake.lock";
pub const CLOSURE_ASSET: &str = "closure.json";

/// Flake attributes that make up a release, in dependency order.
pub const INSTALLABLES: [&str; 3] = ["chromium", "playwright", "browser"];

#[derive(Debug, Clone)]
pub struct ReleaseOptions {
    pub root: PathBuf,
    pub revision: String,
    pub output: PathBuf,
    /// Absent for `--unsigned`, where the trusted publisher signs later.
    pub signing_key: Option<PathBuf>,
    pub unsigned: bool,
    pub public_key: Option<PathBuf>,
    pub evidence: Option<PathBuf>,
    pub build: bool,
    pub cores: u32,
    pub build_timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct ReleaseOutcome {
    pub tag: String,
    pub assets: PathBuf,
    pub manifest: Value,
}

impl Default for ReleaseOptions {
    fn default() -> Self {
        Self {
            root: PathBuf::from("."),
            revision: String::new(),
            output: PathBuf::from("artifacts/release"),
            signing_key: None,
            unsigned: false,
            public_key: None,
            evidence: None,
            build: false,
            cores: DEFAULT_CORES,
            build_timeout: DEFAULT_BUILD_TIMEOUT,
        }
    }
}

/// Releases are pinned to an immutable, full commit ID.
pub fn validate_revision(revision: &str) -> Result<()> {
    let valid = revision.len() == 40
        && revision
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    ensure!(
        valid,
        "--revision must be a full, immutable commit ID (40 lowercase hex characters), got {revision:?}"
    );
    Ok(())
}

pub fn release_tag(chromium: &str, playwright: &str, revision: &str) -> String {
    format!("chromium-{chromium}-pw-{playwright}-{}", &revision[..10])
}

/// Unsigned staging travels through the official Actions cache, which allows
/// 10 GiB per repository. Keep a 1 GiB margin so the upload never truncates.
pub const UNSIGNED_STAGING_LIMIT: u64 = 9 * 1024 * 1024 * 1024;

/// Reject an unsigned staging tree that cannot fit the Actions cache.
pub fn ensure_staging_fits(total: u64) -> Result<()> {
    ensure!(
        total <= UNSIGNED_STAGING_LIMIT,
        "the unsigned staging cache is {:.2} GiB, above the {} GiB Actions cache limit \
         (10 GiB per repository with a 1 GiB margin); publish this release from the build \
         host instead of transporting it",
        total as f64 / (1024.0 * 1024.0 * 1024.0),
        UNSIGNED_STAGING_LIMIT / (1024 * 1024 * 1024)
    );
    Ok(())
}

/// Where release assets are staged when `--output` is omitted.
pub fn default_output(root: &Path) -> PathBuf {
    root.join("artifacts/release")
}

/// Stage the whole release directory.
pub fn prepare(
    options: &ReleaseOptions,
    runner: &mut dyn Runner,
    reporter: &Reporter,
) -> Result<ReleaseOutcome> {
    validate_revision(&options.revision)?;
    validate_options(options)?;
    let root = fs::canonicalize(&options.root)
        .with_context(|| format!("failed to resolve {}", options.root.display()))?;
    let reference = util::flake_reference(&root);
    let system = current_system(&root, runner)?;
    let output = util::absolute(&options.output)?;
    ensure!(
        !output.exists(),
        "refuse to reuse release directory: {}",
        output.display()
    );

    if options.build {
        // Building is the caller's separate step unless it is requested here.
        let mut arguments = vec![
            "build".to_string(),
            "--no-link".to_string(),
            "--max-jobs".to_string(),
            "1".to_string(),
            "--cores".to_string(),
            options.cores.to_string(),
        ];
        arguments.extend(
            INSTALLABLES
                .iter()
                .map(|name| format!("{reference}#{name}")),
        );
        runner.run(
            &Command::new("nix", arguments)
                .cwd(&root)
                .timeout(options.build_timeout)
                .capture(false),
        )?;
    }

    let mut outputs = Map::new();
    for name in INSTALLABLES {
        let path = nix_eval(
            &reference,
            &format!("packages.{system}.{name}.outPath"),
            &root,
            runner,
        )?;
        outputs.insert(name.to_string(), Value::String(path));
    }
    let store_paths: Vec<PathBuf> = outputs
        .values()
        .filter_map(Value::as_str)
        .map(PathBuf::from)
        .collect();
    cache::stage_cache(
        &store_paths,
        &output,
        options.signing_key.as_deref(),
        runner,
    )?;
    if options.unsigned {
        // The unsigned tree is transported through the Actions cache, which is
        // sized per repository; the signed path has no such budget.
        ensure_staging_fits(cache::total_size(&output)?)?;
    }

    if let Some(public_key) = &options.public_key {
        fs::copy(public_key, output.join(PUBLIC_KEY_ASSET)).with_context(|| {
            format!(
                "failed to copy the public key {} into the release",
                public_key.display()
            )
        })?;
    }

    let upstream = util::read_json(&root.join("upstream.json"))?;
    let playwright = upstream
        .get("playwright")
        .and_then(|entry| entry.get("version"))
        .and_then(Value::as_str)
        .context("upstream.json has no playwright.version")?
        .to_string();
    let chromium = nix_eval(&reference, "chromium.version", &root, runner)?;

    // Two separate pins: the native Chromium we build, and the CfT major
    // Playwright bundles. They never have to match; only the major must be
    // inside the documented one-major compatibility window.
    let upstream_browser = upstream
        .get("playwright")
        .and_then(|entry| entry.get("chromiumVersion"))
        .and_then(Value::as_str)
        .context("upstream.json has no playwright.chromiumVersion; run update")?;
    let pinned_chromium = upstream
        .get("chromium")
        .and_then(|entry| entry.get("version"))
        .and_then(Value::as_str)
        .context("upstream.json has no chromium.version; run update to repair the native pin")?;
    ensure!(
        pinned_chromium == chromium,
        "upstream.json pins Chromium {pinned_chromium} but the flake builds {chromium}; run update to repair the native pin"
    );
    ensure!(
        util::chromium_compatible(&chromium, upstream_browser),
        "the native Chromium {chromium} is outside the compatibility window for Playwright's bundled Chromium {upstream_browser}: \
         the native major must be the bundled major or exactly one major older"
    );

    let browser_source =
        Path::new(outputs["browser"].as_str().expect("browser path")).join(BROWSER_PACKAGE_DIR);
    let browser_package = pack(&browser_source, &output, runner)?;
    let playwright_lib = nix_eval(&reference, "playwright.libPath", &root, runner)?;
    let playwright_package = pack(Path::new(&playwright_lib), &output, runner)?;

    let mut patches = Map::new();
    for patch in util::files_with_extension(&root.join("patches"), "patch")? {
        patches.insert(
            util::relative_key(&patch, &root)?,
            Value::String(util::digest(&patch)?),
        );
    }

    // The source lock is part of the release so a consumer can reproduce the
    // exact nixpkgs pin the artifacts were built against.
    let flake_lock = flake_lock_facts(&root)?;
    fs::copy(root.join("flake.lock"), output.join(FLAKE_LOCK_ASSET))
        .context("failed to copy flake.lock into the release")?;
    let package = util::read_json(&root.join("package.json"))?;
    let package_version = package
        .get("version")
        .and_then(Value::as_str)
        .context("package.json has no version")?
        .to_string();
    ensure!(
        util::is_numeric_version(&package_version, &[3]),
        "package.json version is not a stable release version: {package_version:?}"
    );
    ensure!(
        util::is_numeric_version(&chromium, &[3, 4]),
        "the flake chromium.version is not a stable version: {chromium:?}"
    );
    ensure!(
        util::is_numeric_version(&playwright, &[3]),
        "upstream.json playwright.version is not a stable version: {playwright:?}"
    );

    let tag = release_tag(&chromium, &playwright, &options.revision);
    let signed = options.signing_key.is_some();
    let manifest = json!({
        "schemaVersion": 1,
        "sourceRevision": options.revision,
        "tag": tag,
        "system": system,
        "chromium": chromium,
        "playwright": playwright,
        "packageVersion": package_version,
        "upstream": upstream,
        "outputs": Value::Object(outputs),
        "packages": {
            "browser": browser_package,
            "playwright": playwright_package,
        },
        "patches": Value::Object(patches),
        "flakeLock": {
            "asset": FLAKE_LOCK_ASSET,
            "sha256": flake_lock.sha256,
            "content": flake_lock.content,
            "nixpkgsRevision": flake_lock.nixpkgs_revision,
        },
        "signed": signed,
    });
    util::write_json(&output.join(MANIFEST_ASSET), &manifest)?;

    let mut closure_arguments = vec![
        "path-info".to_string(),
        "--json".to_string(),
        "--recursive".to_string(),
    ];
    closure_arguments.extend(store_paths.iter().map(|path| path.display().to_string()));
    let closure = runner.run(
        &Command::new("nix", closure_arguments)
            .cwd(&root)
            .timeout(NETWORK_TIMEOUT),
    )?;
    let closure = closure.stdout_trimmed().to_string();
    ensure!(!closure.is_empty(), "nix path-info returned no closure");
    fs::write(output.join(CLOSURE_ASSET), format!("{closure}\n"))
        .context("failed to write closure.json")?;

    if let Some(evidence) = &options.evidence {
        ensure!(
            evidence.is_file(),
            "the requested test evidence file does not exist: {}",
            evidence.display()
        );
        fs::copy(evidence, output.join(EVIDENCE_ASSET))
            .context("failed to copy the verification evidence")?;
    }

    fs::write(
        output.join(NOTES_ASSET),
        release_notes(
            &chromium,
            &playwright,
            &options.revision,
            &system,
            &browser_package,
            &playwright_package,
            signed,
        ),
    )
    .context("failed to write release-notes.md")?;

    cache::write_checksums(&output)?;

    let summary = json!({
        "tag": tag,
        "assets": output.display().to_string(),
        "manifest": manifest,
    });
    println!("{}", serde_json::to_string_pretty(&summary)?);

    reporter.emit("tag", &tag)?;
    reporter.emit("version", &playwright)?;
    reporter.emit("playwright", &playwright)?;
    reporter.emit("chromium", &chromium)?;
    reporter.emit("assets", &output.display().to_string())?;

    Ok(ReleaseOutcome {
        tag,
        assets: output,
        manifest,
    })
}

/// Release notes for a staged or signed release.
pub fn release_notes(
    chromium: &str,
    playwright: &str,
    revision: &str,
    system: &str,
    browser_package: &str,
    playwright_package: &str,
    signed: bool,
) -> String {
    let status = if signed {
        "This release is a signed Nix binary cache, not a portable non-Nix browser. See the \
         repository README for installation and the fingerprint coverage matrix."
    } else {
        "This staging build is an unsigned Nix binary cache. It is not installable until the \
         trusted publisher re-verifies every asset and signs the cache narinfos. See the \
         repository README for installation and the fingerprint coverage matrix."
    };
    format!(
        "# Cloakium {chromium} / Playwright {playwright}\n\n\
         Source: `{revision}`; platform: `{system}`.\n\n\
         Original Cloakium code and patches are MIT licensed. Chromium, Playwright and their \
         dependencies retain their upstream licenses. No proprietary browser is included.\n\n\
         {status}\n\n\
         Node/Bun packages: `{browser_package}`, `{playwright_package}`. Install both packages \
         from this same release.\n\n\
         `manifest.json` identifies source pins, the `source-flake.lock` pin and patch hashes; \
         `SHA256SUMS` covers all assets.\n"
    )
}

struct FlakeLockFacts {
    sha256: String,
    content: String,
    nixpkgs_revision: String,
}

/// Read and validate the source `flake.lock` that ships with the release.
fn flake_lock_facts(root: &Path) -> Result<FlakeLockFacts> {
    let path = root.join("flake.lock");
    let content =
        fs::read_to_string(&path).with_context(|| format!("failed to read {}", path.display()))?;
    let value: Value = serde_json::from_str(&content)
        .with_context(|| format!("failed to parse {}", path.display()))?;
    let revision = value
        .get("nodes")
        .and_then(|nodes| nodes.get("nixpkgs"))
        .and_then(|node| node.get("locked"))
        .and_then(|locked| locked.get("rev"))
        .and_then(Value::as_str)
        .context("flake.lock has no nodes.nixpkgs.locked.rev")?;
    ensure!(
        revision.len() == 40 && revision.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "flake.lock has an invalid nixpkgs revision: {revision:?}"
    );
    Ok(FlakeLockFacts {
        sha256: util::digest(&path)?,
        content,
        nixpkgs_revision: revision.to_string(),
    })
}

fn current_system(root: &Path, runner: &mut dyn Runner) -> Result<String> {
    let output = runner.run(
        &Command::new(
            "nix",
            [
                "eval",
                "--impure",
                "--raw",
                "--expr",
                "builtins.currentSystem",
            ],
        )
        .cwd(root),
    )?;
    let system = output.stdout_trimmed().to_string();
    ensure!(!system.is_empty(), "nix eval returned an empty system");
    Ok(system)
}

fn nix_eval(
    reference: &str,
    attribute: &str,
    root: &Path,
    runner: &mut dyn Runner,
) -> Result<String> {
    let output = runner.run(
        &Command::new(
            "nix",
            vec![
                "eval".to_string(),
                "--raw".to_string(),
                format!("{reference}#{attribute}"),
            ],
        )
        .cwd(root),
    )?;
    let value = output.stdout_trimmed().to_string();
    ensure!(
        !value.is_empty(),
        "nix eval returned an empty value for {attribute}"
    );
    Ok(value)
}

/// Validate options before any expensive work. Missing inputs are reported
/// here so a ten-hour build is never followed by a trivial path error.
pub fn validate_options(options: &ReleaseOptions) -> Result<()> {
    if options.cores == 0 {
        bail!("--cores must be at least 1");
    }
    ensure!(
        !options.build_timeout.is_zero(),
        "--build-timeout must be greater than zero"
    );
    match (&options.signing_key, options.unsigned) {
        (Some(_), true) => bail!("--unsigned cannot be combined with --signing-key"),
        (None, false) => bail!("--signing-key is required unless --unsigned is given"),
        (Some(key), false) => ensure!(
            key.is_file(),
            "the Nix cache signing key {} does not exist",
            key.display()
        ),
        (None, true) => {}
    }
    if let Some(public_key) = &options.public_key {
        ensure!(
            public_key.is_file(),
            "the public key {} does not exist",
            public_key.display()
        );
    }
    if let Some(evidence) = &options.evidence {
        ensure!(
            evidence.is_file(),
            "the requested test evidence file does not exist: {}",
            evidence.display()
        );
    }
    Ok(())
}
