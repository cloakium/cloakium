//! Data-only verification of an already published release.
//!
//! The workflow resolves the tag, downloads the immutable `SHA256SUMS` and
//! `manifest.json`, and passes the REST release JSON. This command then checks
//! that the published assets, their server-side digests, the checksums file and
//! the manifest all agree. It performs no network access and compares no
//! timestamps, so re-running it against an existing release is safe.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{ensure, Context, Result};
use serde_json::Value;

use crate::cache::{self, ASSET_LIMIT};
use crate::release::{self, EVIDENCE_ASSET, MANIFEST_ASSET, SUMS_ASSET};
use crate::report::Reporter;
use crate::util;

pub const CACHE_INFO_ASSET: &str = "nix-cache-info";

/// Names a published release must always provide.
pub const REQUIRED_ASSETS: [&str; 4] =
    [SUMS_ASSET, MANIFEST_ASSET, EVIDENCE_ASSET, CACHE_INFO_ASSET];

#[derive(Debug, Clone)]
pub struct VerifyPublicationOptions {
    pub release_json: PathBuf,
    pub checksums: PathBuf,
    pub manifest: PathBuf,
    pub revision: String,
}

#[derive(Debug, Clone)]
pub struct VerifyPublicationOutcome {
    pub tag: String,
    pub assets: usize,
}

struct PublishedAsset {
    size: u64,
    digest: String,
}

/// Cross-check an existing release against its own published metadata.
pub fn prepare(
    options: &VerifyPublicationOptions,
    reporter: &Reporter,
) -> Result<VerifyPublicationOutcome> {
    release::validate_revision(&options.revision)?;
    let release_json = util::read_json(&options.release_json)
        .context("failed to read the release JSON from the API")?;
    verify_release(
        &release_json,
        &options.checksums,
        &options.manifest,
        &options.revision,
        reporter,
    )
}

/// Verify an already decoded release JSON. `upload-release` builds the same
/// JSON from the asset list it re-reads after uploading, so both commands
/// share one definition of a complete publication.
pub fn verify_release(
    release_json: &Value,
    checksums_path: &Path,
    manifest_path: &Path,
    revision: &str,
    reporter: &Reporter,
) -> Result<VerifyPublicationOutcome> {
    let published = published_assets(release_json)?;
    let checksums = parse_checksums(
        &fs::read_to_string(checksums_path)
            .with_context(|| format!("failed to read {}", checksums_path.display()))?,
    )?;

    // The checksums file cannot list itself, so its integrity comes from the
    // server-side digest of the published asset.
    let sums_asset = published
        .get(SUMS_ASSET)
        .with_context(|| format!("the published release has no {SUMS_ASSET} asset"))?;
    ensure!(
        util::digest(checksums_path)? == sums_asset.digest,
        "the downloaded {SUMS_ASSET} does not match the published asset digest"
    );
    ensure!(
        file_size(checksums_path)? == sums_asset.size,
        "the downloaded {SUMS_ASSET} is not the published size"
    );

    for name in REQUIRED_ASSETS {
        ensure!(
            published.contains_key(name),
            "the published release is missing {name}"
        );
    }

    // Every checksum entry must name one published asset with the same digest.
    for (name, digest) in &checksums {
        let asset = published.get(name).with_context(|| {
            format!("{SUMS_ASSET} lists {name}, which the published release does not have")
        })?;
        ensure!(
            asset.digest.eq_ignore_ascii_case(digest),
            "the published digest for {name} does not match {SUMS_ASSET}"
        );
        ensure!(
            asset.size < ASSET_LIMIT,
            "the published asset {name} is at or above GitHub's 2 GiB limit"
        );
    }
    // ... and every published asset must be covered, so a partial or stale
    // upload is rejected instead of silently published. The checksums file
    // itself is the one exception, since it cannot list itself.
    ensure!(
        !checksums.contains_key(SUMS_ASSET),
        "{SUMS_ASSET} must not list itself"
    );
    for name in published.keys() {
        if name == SUMS_ASSET {
            continue;
        }
        ensure!(
            checksums.contains_key(name),
            "the release publishes {name}, which {SUMS_ASSET} does not cover"
        );
    }

    let manifest_digest = util::digest(manifest_path)?;
    ensure!(
        checksums.get(MANIFEST_ASSET).map(String::as_str) == Some(manifest_digest.as_str()),
        "the downloaded {MANIFEST_ASSET} does not match {SUMS_ASSET}"
    );
    ensure!(
        file_size(manifest_path)? == published.get(MANIFEST_ASSET).expect("required asset").size,
        "the downloaded {MANIFEST_ASSET} is not the published size"
    );

    let manifest = util::read_json(manifest_path)?;
    let source_revision = manifest
        .get("sourceRevision")
        .and_then(Value::as_str)
        .context("the published manifest has no sourceRevision")?;
    ensure!(
        source_revision == revision,
        "the published release records source {source_revision}, expected {revision}"
    );
    let tag = manifest
        .get("tag")
        .and_then(Value::as_str)
        .context("the published manifest has no tag")?
        .to_string();
    if let Some(release_tag) = release_json.get("tag_name").and_then(Value::as_str) {
        ensure!(
            release_tag == tag,
            "the published tag {release_tag} does not match the manifest tag {tag}"
        );
    }

    // The verification evidence is immutable; only its presence and hash are
    // relevant, never its timestamp.
    ensure!(
        checksums.contains_key(EVIDENCE_ASSET),
        "{SUMS_ASSET} does not cover {EVIDENCE_ASSET}"
    );

    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "verified": true,
            "tag": tag,
            "revision": revision,
            "assets": published.len(),
        }))?
    );
    reporter.emit("verified", "true")?;
    reporter.emit("tag", &tag)?;
    reporter.emit("revision", revision)?;
    reporter.emit("assets", &published.len().to_string())?;

    Ok(VerifyPublicationOutcome {
        tag,
        assets: published.len(),
    })
}

fn published_assets(release: &Value) -> Result<BTreeMap<String, PublishedAsset>> {
    let assets = release
        .get("assets")
        .and_then(Value::as_array)
        .context("the release JSON has no assets array")?;
    let mut published = BTreeMap::new();
    for asset in assets {
        let name = asset
            .get("name")
            .and_then(Value::as_str)
            .context("a published asset has no name")?;
        ensure!(
            cache::is_safe_asset_name(name),
            "unsafe published asset name: {name}"
        );
        let size = asset
            .get("size")
            .and_then(Value::as_u64)
            .with_context(|| format!("the published asset {name} has no size"))?;
        ensure!(
            size < ASSET_LIMIT,
            "the published asset {name} is at or above GitHub's 2 GiB limit"
        );
        let digest = asset
            .get("digest")
            .and_then(Value::as_str)
            .with_context(|| format!("the published asset {name} has no server digest"))?;
        let digest = digest
            .strip_prefix("sha256:")
            .with_context(|| format!("the published asset {name} is not sha256 addressed"))?;
        ensure!(
            digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "the published asset {name} has an invalid digest"
        );
        ensure!(
            published
                .insert(
                    name.to_string(),
                    PublishedAsset {
                        size,
                        digest: digest.to_ascii_lowercase(),
                    }
                )
                .is_none(),
            "the release JSON lists {name} more than once"
        );
    }
    Ok(published)
}

/// Parse `SHA256SUMS`: `<64 hex>  <asset name>` per line, unique names.
pub fn parse_checksums(text: &str) -> Result<BTreeMap<String, String>> {
    let mut checksums = BTreeMap::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let (digest, name) = line
            .split_once("  ")
            .with_context(|| format!("invalid {SUMS_ASSET} line: {line:?}"))?;
        ensure!(
            digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "invalid digest in {SUMS_ASSET}: {line:?}"
        );
        ensure!(
            cache::is_safe_asset_name(name),
            "unsafe asset name in {SUMS_ASSET}: {name}"
        );
        ensure!(
            checksums
                .insert(name.to_string(), digest.to_ascii_lowercase())
                .is_none(),
            "{SUMS_ASSET} lists {name} more than once"
        );
    }
    ensure!(!checksums.is_empty(), "{SUMS_ASSET} is empty");
    Ok(checksums)
}

fn file_size(path: &Path) -> Result<u64> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect {}", path.display()))?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "{} must be a regular file",
        path.display()
    );
    Ok(metadata.len())
}
