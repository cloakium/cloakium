//! Release notes and the source flake-lock pin recorded with a release.

use std::fs;
use std::path::Path;

use anyhow::{ensure, Context, Result};
use serde_json::Value;

use crate::util;

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

pub struct FlakeLockFacts {
    pub sha256: String,
    pub content: String,
    pub nixpkgs_revision: String,
}

/// Read and validate the source `flake.lock` that ships with the release.
pub fn flake_lock_facts(root: &Path) -> Result<FlakeLockFacts> {
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
