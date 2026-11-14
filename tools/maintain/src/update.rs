//! Prepare an upstream candidate.
//!
//! This step only rewrites local files: it never publishes anything. A caller
//! commits the result to a candidate branch, builds it, and promotes it in a
//! separate, verified operation.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};
use serde_json::{Map, Value};

use crate::command::{Command, Runner, NETWORK_TIMEOUT};
use crate::report::Reporter;
use crate::util;

pub const NPM_PACKAGE: &str = "playwright-core";
pub const NPM_REGISTRY: &str = "https://registry.npmjs.org";

#[derive(Debug, Clone)]
pub struct UpdateOptions {
    pub root: PathBuf,
    pub refresh_toolchain: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateOutcome {
    pub changed: bool,
    pub playwright: String,
    pub chromium: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserMetadata {
    pub chromium_version: String,
    pub browser_revision: String,
}

/// Accept only a plain `major.minor.patch` release; prereleases and tags are
/// deliberately rejected so the candidate is always a stable upstream release.
pub fn stable_version(value: &str) -> Result<String> {
    let parts: Vec<&str> = value.split('.').collect();
    let stable = parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
    if !stable {
        bail!("not a stable Playwright version: {value:?}");
    }
    Ok(value.to_string())
}

/// Read Chromium's pin straight out of the published `playwright-core` tarball.
pub fn browser_metadata(archive: &Path) -> Result<BrowserMetadata> {
    let file =
        fs::File::open(archive).with_context(|| format!("failed to open {}", archive.display()))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    let mut body: Option<Vec<u8>> = None;
    for entry in tar.entries().context("failed to read the npm tarball")? {
        let mut entry = entry.context("failed to read an npm tarball entry")?;
        let path = entry
            .path()
            .context("invalid npm tarball entry name")?
            .into_owned();
        if is_browsers_json(&path) {
            let mut contents = Vec::new();
            entry
                .read_to_end(&mut contents)
                .context("failed to read browsers.json")?;
            body = Some(contents);
            break;
        }
    }
    let Some(body) = body else {
        bail!("playwright-core is missing browsers.json");
    };
    let value: Value = serde_json::from_slice(&body).context("browsers.json is not valid JSON")?;
    let browsers = value
        .get("browsers")
        .and_then(Value::as_array)
        .context("browsers.json has no browsers array")?;
    let chromium: Vec<&Value> = browsers
        .iter()
        .filter(|entry| entry.get("name").and_then(Value::as_str) == Some("chromium"))
        .collect();
    ensure!(
        chromium.len() == 1,
        "expected exactly one Chromium browser entry, found {}",
        chromium.len()
    );
    let entry = chromium[0];
    let version = entry
        .get("browserVersion")
        .and_then(Value::as_str)
        .context("the Chromium browser entry has no browserVersion")?;
    let revision = match entry.get("revision") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => bail!("the Chromium browser entry has no revision"),
    };
    Ok(BrowserMetadata {
        chromium_version: version.to_string(),
        browser_revision: revision,
    })
}

fn is_browsers_json(path: &Path) -> bool {
    matches!(
        path.to_string_lossy().as_ref(),
        "package/browsers.json" | "./package/browsers.json"
    )
}

/// Run the whole candidate preparation.
pub fn prepare(
    options: &UpdateOptions,
    runner: &mut dyn Runner,
    reporter: &Reporter,
) -> Result<UpdateOutcome> {
    let root = fs::canonicalize(&options.root)
        .with_context(|| format!("failed to resolve {}", options.root.display()))?;
    let reference = util::flake_reference(&root);
    let lock_path = root.join("flake.lock");
    let previous_lock = fs::read(&lock_path).with_context(|| {
        format!(
            "failed to read {}; pass --root pointing at the Cloakium checkout",
            lock_path.display()
        )
    })?;
    let metadata_path = root.join("upstream.json");
    let mut metadata = if metadata_path.is_file() {
        util::read_json(&metadata_path)?
    } else {
        Value::Object(Map::new())
    };

    let previous_chromium = nix_eval(&reference, "chromium.version", &root, runner)?;
    let latest = runner.run(
        &Command::new(
            "npm",
            vec![
                "view".to_string(),
                format!("{NPM_PACKAGE}@latest"),
                "version".to_string(),
            ],
        )
        .cwd(&root),
    )?;
    let version = stable_version(latest.stdout_trimmed())?;
    runner.run(
        &Command::new("nix", ["flake", "update", "nixpkgs", "--flake", &reference])
            .cwd(&root)
            .timeout(NETWORK_TIMEOUT),
    )?;
    let chromium = nix_eval(&reference, "chromium.version", &root, runner)?;

    let previous_playwright = metadata
        .get("playwright")
        .and_then(|playwright| playwright.get("version"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // The native browser pin is separate from Playwright's bundled CfT pin.
    // A missing or stale pin is repaired even when nothing else moved.
    let recorded_chromium = metadata
        .get("chromium")
        .and_then(|chromium| chromium.get("version"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let chromium_pin_current = recorded_chromium.as_deref() == Some(chromium.as_str());
    let versions_unchanged = version == previous_playwright && chromium == previous_chromium;

    if versions_unchanged && chromium_pin_current {
        if !options.refresh_toolchain {
            fs::write(&lock_path, &previous_lock)
                .with_context(|| format!("failed to restore {}", lock_path.display()))?;
            return report(reporter, false, &version, &chromium);
        }
        let refreshed = fs::read(&lock_path)
            .with_context(|| format!("failed to read {}", lock_path.display()))?;
        if refreshed == previous_lock {
            return report(reporter, false, &version, &chromium);
        }
    }

    if version != previous_playwright {
        update_playwright(
            &root,
            &reference,
            &mut metadata,
            &version,
            &chromium,
            runner,
        )?;
    }
    let chromium_entry = object_mut(&mut metadata, "chromium")?;
    chromium_entry.insert("version".into(), Value::String(chromium.clone()));
    util::write_json(&metadata_path, &metadata)?;
    report(reporter, true, &version, &chromium)
}

fn report(
    reporter: &Reporter,
    changed: bool,
    playwright: &str,
    chromium: &str,
) -> Result<UpdateOutcome> {
    reporter.emit("changed", if changed { "true" } else { "false" })?;
    reporter.emit("playwright", playwright)?;
    reporter.emit("version", playwright)?;
    reporter.emit("chromium", chromium)?;
    Ok(UpdateOutcome {
        changed,
        playwright: playwright.to_string(),
        chromium: chromium.to_string(),
    })
}

fn update_playwright(
    root: &Path,
    reference: &str,
    metadata: &mut Value,
    version: &str,
    native_chromium: &str,
    runner: &mut dyn Runner,
) -> Result<()> {
    let url = format!("{NPM_REGISTRY}/{NPM_PACKAGE}/-/{NPM_PACKAGE}-{version}.tgz");
    let fetched = runner.run(
        &Command::new("nix", ["store", "prefetch-file", "--json", &url])
            .cwd(root)
            .timeout(NETWORK_TIMEOUT),
    )?;
    let fetched: Value = serde_json::from_str(fetched.stdout_trimmed())
        .context("nix store prefetch-file did not return JSON")?;
    let hash = json_string(&fetched, "hash")?;
    let store_path = json_string(&fetched, "storePath")?;
    let browsers = browser_metadata(Path::new(&store_path))?;
    // The bundled CfT major and the native major are independent pins; a jump
    // is reported for information only, because the real driver+native tests
    // decide whether the pair works.
    if let Some(note) = util::chromium_distance_note(native_chromium, &browsers.chromium_version) {
        eprintln!("warning: {note}");
    }

    let playwright = object_mut(metadata, "playwright")?;
    playwright.insert("version".into(), Value::String(version.to_string()));
    playwright.insert("url".into(), Value::String(url));
    playwright.insert("hash".into(), Value::String(hash));
    playwright.insert(
        "chromiumVersion".into(),
        Value::String(browsers.chromium_version),
    );
    playwright.insert(
        "browserRevision".into(),
        Value::String(browsers.browser_revision),
    );

    let package_path = root.join("package.json");
    let mut package = util::read_json(&package_path)?;
    object_mut(&mut package, "devDependencies")?
        .insert("playwright-core".into(), Value::String(version.to_string()));
    util::write_json(&package_path, &package)?;

    runner.run(
        &Command::new(
            "npm",
            [
                "install",
                "--package-lock-only",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
            ],
        )
        .cwd(root)
        .timeout(NETWORK_TIMEOUT),
    )?;

    let npm_hash = runner.run(
        &Command::new(
            "nix",
            [
                "run",
                "--inputs-from",
                reference,
                "nixpkgs#prefetch-npm-deps",
                "--",
                "package-lock.json",
            ],
        )
        .cwd(root)
        .timeout(NETWORK_TIMEOUT),
    )?;
    let npm_hash = npm_hash.stdout_trimmed().to_string();
    ensure!(
        util::is_sri_sha256(&npm_hash),
        "invalid npm dependency hash: {npm_hash:?}"
    );
    let hash_path = root.join("nix/npm-deps-hash.nix");
    if let Some(parent) = hash_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    fs::write(
        &hash_path,
        format!("{}\n", serde_json::to_string(&npm_hash)?),
    )
    .with_context(|| format!("failed to write {}", hash_path.display()))?;
    Ok(())
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

fn json_string(value: &Value, key: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .with_context(|| format!("nix store prefetch-file did not report {key}"))
}

fn object_mut<'a>(value: &'a mut Value, key: &str) -> Result<&'a mut Map<String, Value>> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    let object = value.as_object_mut().expect("just ensured an object");
    if !object.contains_key(key) {
        object.insert(key.to_string(), Value::Object(Map::new()));
    }
    match object.get_mut(key) {
        Some(Value::Object(entry)) => Ok(entry),
        _ => bail!("{key} must be a JSON object"),
    }
}
