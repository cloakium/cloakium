//! Asset scanning and checksum verification for a staged release.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use anyhow::{ensure, Context, Result};

use crate::cache::{self, ASSET_LIMIT};
use crate::release::SUMS_ASSET;
use crate::util;

/// Every entry must be a safe, regular file below the GitHub size limit.
pub fn scan_assets(directory: &Path) -> Result<BTreeMap<String, u64>> {
    let mut assets = BTreeMap::new();
    for entry in fs::read_dir(directory)
        .with_context(|| format!("failed to list {}", directory.display()))?
    {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let metadata = fs::symlink_metadata(entry.path())?;
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "release assets must be regular files: {name}"
        );
        ensure!(
            cache::is_safe_asset_name(&name),
            "unsafe release asset filename: {name}"
        );
        ensure!(
            metadata.len() < ASSET_LIMIT,
            "asset exceeds GitHub's 2 GiB limit: {name}"
        );
        assets.insert(name, metadata.len());
    }
    Ok(assets)
}

/// `SHA256SUMS` must cover exactly the scanned assets and match their bytes.
pub fn verify_checksums(directory: &Path, assets: &BTreeMap<String, u64>) -> Result<()> {
    let path = directory.join(SUMS_ASSET);
    let text = fs::read_to_string(&path)
        .with_context(|| format!("the staged release has no readable {SUMS_ASSET}"))?;
    let mut listed = BTreeMap::new();
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
            listed
                .insert(name.to_string(), digest.to_string())
                .is_none(),
            "duplicate {SUMS_ASSET} entry: {name}"
        );
    }

    let expected: std::collections::BTreeSet<&String> =
        assets.keys().filter(|name| *name != SUMS_ASSET).collect();
    let listed_names: std::collections::BTreeSet<&String> = listed.keys().collect();
    ensure!(
        expected == listed_names,
        "{SUMS_ASSET} does not cover exactly the staged assets (missing {:?}, unexpected {:?})",
        expected.difference(&listed_names).collect::<Vec<_>>(),
        listed_names.difference(&expected).collect::<Vec<_>>()
    );
    for (name, digest) in &listed {
        let actual = util::digest(&directory.join(name))?;
        ensure!(
            actual == *digest,
            "asset {name} does not match {SUMS_ASSET}"
        );
    }
    Ok(())
}
