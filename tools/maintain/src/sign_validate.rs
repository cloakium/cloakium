//! Validation of a staged release before the trusted publisher signs it.
//!
//! Everything here works from the staged bytes only: asset checksums, the
//! manifest pins, the recorded verification evidence, the flake lock pin and
//! every NAR payload hash. Nothing is executed.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{ensure, Context, Result};
use serde_json::{Map, Value};

use crate::cache;
use crate::narinfo::NarInfo;
use crate::release::{self, FLAKE_LOCK_ASSET, INSTALLABLES};
use crate::update::stable_version;
use crate::util;

/// Facts a signed release is built from, all re-derived from the staged files.
#[derive(Debug, Clone)]
pub struct Facts {
    pub chromium: String,
    pub playwright: String,
    pub tag: String,
    pub system: String,
    pub revision: String,
    pub outputs: Vec<String>,
    pub packages: Vec<String>,
}

pub fn validate_manifest(manifest: &Value, revision: &str, directory: &Path) -> Result<Facts> {
    ensure!(
        manifest.get("schemaVersion").and_then(Value::as_u64) == Some(1),
        "manifest.json has an unsupported schemaVersion"
    );
    let source_revision = string_field(manifest, "sourceRevision", "manifest")?;
    ensure!(
        source_revision == revision,
        "manifest sourceRevision {source_revision} does not match --revision {revision}"
    );
    ensure!(
        manifest.get("signed").and_then(Value::as_bool) == Some(false),
        "the staged release is already marked signed; refusing to sign twice"
    );

    let system = string_field(manifest, "system", "manifest")?;
    let chromium = string_field(manifest, "chromium", "manifest")?;
    let playwright = string_field(manifest, "playwright", "manifest")?;
    let package_version = string_field(manifest, "packageVersion", "manifest")?;
    let tag = string_field(manifest, "tag", "manifest")?;
    ensure!(
        util::is_numeric_version(&chromium, &[3, 4]),
        "manifest chromium is not a stable version: {chromium:?}"
    );
    stable_version(&playwright)?;
    ensure!(
        util::is_numeric_version(&package_version, &[3]),
        "manifest packageVersion is not a stable version: {package_version:?}"
    );
    ensure!(
        tag == release::release_tag(&chromium, &playwright, revision),
        "manifest tag {tag} does not match the release versions and revision"
    );

    let upstream = manifest
        .get("upstream")
        .and_then(Value::as_object)
        .context("manifest.json has no upstream block")?;
    let bundled_chromium = validate_upstream(upstream, &chromium, &playwright)?;

    let outputs = manifest
        .get("outputs")
        .and_then(Value::as_object)
        .context("manifest.json has no outputs block")?;
    ensure!(
        outputs.len() == INSTALLABLES.len(),
        "manifest outputs must list exactly {} packages",
        INSTALLABLES.len()
    );
    let mut store_paths = Vec::new();
    for name in INSTALLABLES {
        let path = outputs
            .get(name)
            .and_then(Value::as_str)
            .with_context(|| format!("manifest outputs has no {name}"))?;
        ensure!(
            path.starts_with("/nix/store/") && !path.contains(".."),
            "invalid output path for {name}: {path}"
        );
        store_paths.push(path.to_string());
    }
    ensure!(
        outputs
            .keys()
            .all(|name| INSTALLABLES.contains(&name.as_str())),
        "manifest outputs lists an unexpected package"
    );

    let packages = manifest
        .get("packages")
        .and_then(Value::as_object)
        .context("manifest.json has no packages block")?;
    ensure!(
        packages.len() == 2,
        "manifest packages must list exactly the browser and driver tarballs"
    );
    let mut package_names = Vec::new();
    for name in ["browser", "playwright"] {
        let file = packages
            .get(name)
            .and_then(Value::as_str)
            .with_context(|| format!("manifest packages has no {name}"))?;
        ensure!(
            cache::is_safe_asset_name(file) && directory.join(file).is_file(),
            "manifest packages {name} names a missing or unsafe asset: {file}"
        );
        package_names.push(file.to_string());
    }

    let patches = manifest
        .get("patches")
        .and_then(Value::as_object)
        .context("manifest.json has no patches block")?;
    for (path, digest) in patches {
        ensure!(
            !path.starts_with('/') && !path.split('/').any(|part| part == ".."),
            "manifest patches contains an unsafe path: {path}"
        );
        ensure!(
            digest.as_str().is_some_and(
                |value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            ),
            "manifest patches has an invalid digest for {path}"
        );
    }

    let flake_lock = manifest
        .get("flakeLock")
        .and_then(Value::as_object)
        .context("manifest.json has no flakeLock block")?;
    validate_flake_lock(flake_lock, directory)?;
    if let Some(compatibility) = manifest.get("compatibility").and_then(Value::as_object) {
        validate_compatibility(compatibility, &chromium, &bundled_chromium)?;
    }

    Ok(Facts {
        chromium,
        playwright,
        tag,
        system,
        revision: revision.to_string(),
        outputs: store_paths,
        packages: package_names,
    })
}

fn validate_upstream(
    upstream: &Map<String, Value>,
    chromium: &str,
    playwright: &str,
) -> Result<String> {
    let entry = upstream
        .get("playwright")
        .and_then(Value::as_object)
        .context("upstream.json has no playwright block")?;
    let version = string_field_from(entry, "version", "upstream.playwright")?;
    let url = string_field_from(entry, "url", "upstream.playwright")?;
    let hash = string_field_from(entry, "hash", "upstream.playwright")?;
    let browser_version = string_field_from(entry, "chromiumVersion", "upstream.playwright")?;
    let revision = string_field_from(entry, "browserRevision", "upstream.playwright")?;
    ensure!(
        version == playwright,
        "upstream.playwright.version {version} does not match manifest playwright {playwright}"
    );
    let canonical = format!(
        "{}/playwright-core/-/playwright-core-{version}.tgz",
        crate::update::NPM_REGISTRY
    );
    ensure!(
        url == canonical,
        "upstream.playwright.url must be the canonical registry URL {canonical}"
    );
    ensure!(
        util::is_sri_sha256(&hash),
        "upstream.playwright.hash is not a sha256 SRI hash"
    );
    ensure!(
        util::is_numeric_version(&browser_version, &[3, 4]),
        "upstream.playwright.chromiumVersion is not a stable version: {browser_version:?}"
    );
    ensure!(
        !revision.is_empty() && revision.bytes().all(|byte| byte.is_ascii_digit()),
        "upstream.playwright.browserRevision must be numeric"
    );
    let chromium_entry = upstream
        .get("chromium")
        .and_then(Value::as_object)
        .context("upstream.json has no chromium block")?;
    ensure!(
        string_field_from(chromium_entry, "version", "upstream.chromium")? == chromium,
        "upstream.chromium.version does not match the actual manifest chromium {chromium}"
    );
    Ok(browser_version)
}

/// The recorded distance is informational; it is only checked for internal
/// consistency, never used to accept or reject a release.
fn validate_compatibility(
    compatibility: &Map<String, Value>,
    chromium: &str,
    bundled: &str,
) -> Result<()> {
    ensure!(
        string_field_from(compatibility, "nativeChromium", "manifest.compatibility")? == chromium,
        "manifest.compatibility.nativeChromium does not match the release pin"
    );
    ensure!(
        string_field_from(
            compatibility,
            "playwrightChromium",
            "manifest.compatibility"
        )? == bundled,
        "manifest.compatibility.playwrightChromium does not match upstream.json"
    );
    if let Some(distance) = util::chromium_major_distance(chromium, bundled) {
        let recorded = compatibility.get("majorsApart").and_then(Value::as_i64);
        ensure!(
            recorded == Some(distance),
            "manifest.compatibility.majorsApart is inconsistent with the recorded versions"
        );
    }
    Ok(())
}

fn validate_flake_lock(lock: &Map<String, Value>, directory: &Path) -> Result<()> {
    ensure!(
        string_field_from(lock, "asset", "manifest.flakeLock")? == FLAKE_LOCK_ASSET,
        "manifest flakeLock.asset must be {FLAKE_LOCK_ASSET}"
    );
    let path = directory.join(FLAKE_LOCK_ASSET);
    ensure!(
        path.is_file(),
        "the release is missing its {FLAKE_LOCK_ASSET} pin"
    );
    let digest = string_field_from(lock, "sha256", "manifest.flakeLock")?;
    ensure!(
        digest == util::digest(&path)?,
        "{FLAKE_LOCK_ASSET} does not match manifest flakeLock.sha256"
    );
    let content = string_field_from(lock, "content", "manifest.flakeLock")?;
    let on_disk = fs::read_to_string(&path)?;
    ensure!(
        content == on_disk,
        "manifest flakeLock.content does not match {FLAKE_LOCK_ASSET}"
    );
    let parsed: Value = serde_json::from_str(&content).context("flake.lock is not valid JSON")?;
    let revision = string_field_from(lock, "nixpkgsRevision", "manifest.flakeLock")?;
    ensure!(
        revision.len() == 40 && revision.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "manifest flakeLock.nixpkgsRevision is not a full revision"
    );
    let locked_revision = parsed
        .get("nodes")
        .and_then(|nodes| nodes.get("nixpkgs"))
        .and_then(|node| node.get("locked"))
        .and_then(|locked| locked.get("rev"))
        .and_then(Value::as_str)
        .context("flake.lock has no nodes.nixpkgs.locked.rev")?;
    ensure!(
        locked_revision == revision,
        "manifest flakeLock.nixpkgsRevision does not match flake.lock"
    );
    ensure!(
        parsed
            .get("nodes")
            .and_then(|nodes| nodes.get("root"))
            .and_then(|root| root.get("inputs"))
            .and_then(|inputs| inputs.get("nixpkgs"))
            .is_some(),
        "flake.lock does not follow a root nixpkgs input"
    );
    Ok(())
}
pub fn load_narinfos(
    directory: &Path,
    facts: &Facts,
) -> Result<BTreeMap<String, (NarInfo, PathBuf)>> {
    let mut found = BTreeMap::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".narinfo") {
            continue;
        }
        let text =
            fs::read_to_string(entry.path()).with_context(|| format!("failed to read {name}"))?;
        let info = NarInfo::parse(&text).with_context(|| format!("failed to parse {name}"))?;
        ensure!(
            info.payload_path(directory)?.is_file(),
            "{name} references a payload that is not in the release"
        );
        ensure!(
            found
                .insert(info.store_path.clone(), (info, entry.path()))
                .is_none(),
            "duplicate narinfo entries for one store path"
        );
    }
    // Every manifest output must have a narinfo. Extra narinfos belong to the
    // runtime closure substituted from upstream caches and are validated too,
    // but they are not signed with the release key.
    for output in &facts.outputs {
        ensure!(
            found.contains_key(output),
            "the release has no narinfo for {output}"
        );
    }
    ensure!(!found.is_empty(), "the release has no narinfos");
    Ok(found)
}

pub fn string_field(value: &Value, key: &str, context: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .with_context(|| format!("{context} has no string {key}"))
}

pub fn string_field_from(value: &Map<String, Value>, key: &str, context: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .with_context(|| format!("{context} has no string {key}"))
}
