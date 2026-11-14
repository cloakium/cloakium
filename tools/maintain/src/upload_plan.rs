//! The local signed release tree and the resumption plan for a draft.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{ensure, Context, Result};
use serde_json::Value;

use crate::cache;
use crate::release::{MANIFEST_ASSET, SUMS_ASSET};
use crate::sign_assets::{scan_assets, verify_checksums};
use crate::upload_remote::RemoteAsset;
use crate::util;
use crate::verify_publication::{parse_checksums, REQUIRED_ASSETS};

/// One local release file with the size and digest it must have on the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalAsset {
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct LocalRelease {
    pub tag: String,
    pub assets: BTreeMap<String, LocalAsset>,
}

/// What has to happen to one asset so the draft ends up complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// The server already has the exact bytes.
    Skip,
    /// The server has this asset id with different bytes: delete it first.
    Replace { asset_id: u64 },
    /// The server does not have the asset at all.
    Upload,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub name: String,
    pub action: Action,
}

/// Validate the signed tree and hash every payload against `SHA256SUMS`.
pub fn load(input: &Path, revision: &str, tag: &str) -> Result<LocalRelease> {
    ensure!(
        input.is_dir(),
        "--input must be a signed release directory: {}",
        input.display()
    );
    let sizes = scan_assets(input)?;
    for name in REQUIRED_ASSETS {
        ensure!(
            sizes.contains_key(name),
            "the release directory is missing {name}"
        );
    }

    let manifest = util::read_json(&input.join(MANIFEST_ASSET))
        .context("the release has no readable manifest.json")?;
    ensure!(
        manifest.get("schemaVersion").and_then(Value::as_u64) == Some(1),
        "manifest.json has an unsupported schemaVersion"
    );
    let source_revision = manifest
        .get("sourceRevision")
        .and_then(Value::as_str)
        .context("manifest.json has no sourceRevision")?;
    ensure!(
        source_revision == revision,
        "manifest sourceRevision {source_revision} does not match --revision {revision}"
    );
    let manifest_tag = manifest
        .get("tag")
        .and_then(Value::as_str)
        .context("manifest.json has no tag")?;
    ensure!(
        manifest_tag == tag,
        "manifest tag {manifest_tag} does not match --tag {tag}"
    );
    ensure!(
        manifest.get("signed").and_then(Value::as_bool) == Some(true),
        "the release is not marked signed; only a signed tree may be uploaded"
    );
    validate_tag(tag, revision)?;
    cache::verify_signed(input)?;
    // Hash every payload now: a tampered local file must never make this command
    // delete a known-good server asset.
    verify_checksums(input, &sizes)?;

    let checksums = parse_checksums(
        &std::fs::read_to_string(input.join(SUMS_ASSET))
            .context("the release has no readable SHA256SUMS")?,
    )?;
    ensure!(
        !checksums.contains_key(SUMS_ASSET),
        "{SUMS_ASSET} must not list itself"
    );

    let mut assets = BTreeMap::new();
    for (name, size) in &sizes {
        let sha256 = match checksums.get(name) {
            Some(digest) => digest.clone(),
            // Only SHA256SUMS is absent from its own listing.
            None => util::digest(&input.join(name))?,
        };
        assets.insert(
            name.clone(),
            LocalAsset {
                name: name.clone(),
                path: input.join(name),
                size: *size,
                sha256,
            },
        );
    }
    Ok(LocalRelease {
        tag: tag.to_string(),
        assets,
    })
}

/// Plan the smallest set of content operations that completes the draft.
pub fn plan(local: &LocalRelease, remote: &[RemoteAsset]) -> Result<Vec<Step>> {
    // Never delete content the signed tree does not cover.
    for asset in remote {
        ensure!(
            local.assets.contains_key(&asset.name),
            "the draft release has the asset {}, which {SUMS_ASSET} does not cover; \
             remove it deliberately instead of letting this command delete unverified content",
            asset.name
        );
    }

    let mut steps = Vec::with_capacity(local.assets.len());
    for (name, asset) in &local.assets {
        let action = match remote.iter().find(|remote| &remote.name == name) {
            None => Action::Upload,
            Some(remote) if remote.complete(asset.size, &asset.sha256) => Action::Skip,
            Some(remote) => Action::Replace {
                asset_id: remote.id,
            },
        };
        steps.push(Step {
            name: name.clone(),
            action,
        });
    }
    Ok(steps)
}

/// Release tags are `chromium-<version>-pw-<version>-<10 hex>`, suffix = revision.
pub fn validate_tag(tag: &str, revision: &str) -> Result<()> {
    let rest = tag
        .strip_prefix("chromium-")
        .with_context(|| format!("--tag must start with chromium-, got {tag:?}"))?;
    let (chromium, rest) = rest
        .split_once("-pw-")
        .with_context(|| format!("--tag must contain -pw-, got {tag:?}"))?;
    let (playwright, suffix) = rest
        .rsplit_once('-')
        .with_context(|| format!("--tag must end with the source revision, got {tag:?}"))?;
    ensure!(
        version_like(chromium) && version_like(playwright),
        "--tag must name two dotted versions, got {tag:?}"
    );
    ensure!(
        suffix.len() == 10
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "--tag must end with 10 lowercase hex characters, got {tag:?}"
    );
    ensure!(
        revision.starts_with(suffix),
        "--tag {tag} does not name --revision {revision}"
    );
    Ok(())
}

fn version_like(value: &str) -> bool {
    value.contains('.')
        && value
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_name_the_revision_they_publish() {
        let revision = "0123456789abcdef0123456789abcdef01234567";
        validate_tag("chromium-157.0.8103.50-pw-1.65.0-0123456789", revision).expect("valid");
        for invalid in [
            "157.0.8103.50-pw-1.65.0-0123456789",
            "chromium-157.0.8103.50-1.65.0-0123456789",
            "chromium-157.0.8103.50-pw-1.65.0",
            "chromium-157.0.8103.50-pw-1.65.0-0123456789A",
            "chromium-157.0.8103.50-pw-1.65.0-012345678a",
        ] {
            assert!(validate_tag(invalid, revision).is_err(), "{invalid}");
        }
    }

    #[test]
    fn version_like_rejects_empty_and_malformed_segments() {
        assert!(version_like("1.65.0"));
        assert!(!version_like("1"));
        assert!(!version_like("1..0"));
        assert!(!version_like(""));
    }

    fn local(names: &[(&str, u64, &str)]) -> LocalRelease {
        let mut assets = BTreeMap::new();
        for (name, size, sha256) in names {
            assets.insert(
                name.to_string(),
                LocalAsset {
                    name: name.to_string(),
                    path: PathBuf::from(name),
                    size: *size,
                    sha256: sha256.to_string(),
                },
            );
        }
        LocalRelease {
            tag: "t".into(),
            assets,
        }
    }

    fn remote(id: u64, name: &str, size: u64, digest: Option<&str>, state: &str) -> RemoteAsset {
        RemoteAsset {
            id,
            name: name.to_string(),
            size,
            digest: digest.map(str::to_string),
            state: state.to_string(),
        }
    }

    #[test]
    fn complete_assets_are_skipped_and_missing_ones_uploaded() {
        let local = local(&[("a", 3, "aa"), ("b", 4, "bb")]);
        let remote = vec![remote(9, "a", 3, Some("aa"), "uploaded")];
        let steps = plan(&local, &remote).expect("plan");
        assert_eq!(
            steps,
            [
                Step {
                    name: "a".into(),
                    action: Action::Skip
                },
                Step {
                    name: "b".into(),
                    action: Action::Upload
                },
            ]
        );
    }

    #[test]
    fn a_mismatched_asset_is_replaced_by_its_exact_id() {
        let local = local(&[("a", 3, "aa")]);
        for remote_asset in [
            remote(9, "a", 3, Some("bb"), "uploaded"),
            remote(9, "a", 4, Some("aa"), "uploaded"),
            remote(9, "a", 3, None, "uploaded"),
            remote(9, "a", 3, Some("aa"), "starter"),
        ] {
            let steps = plan(&local, &[remote_asset]).expect("plan");
            assert_eq!(steps[0].action, Action::Replace { asset_id: 9 });
        }
    }

    #[test]
    fn an_uncovered_remote_asset_is_refused() {
        let local = local(&[("a", 3, "aa")]);
        let remote = vec![remote(9, "stowaway", 1, Some("cc"), "uploaded")];
        let error = plan(&local, &remote).expect_err("uncovered");
        assert!(format!("{error:#}").contains("does not cover"), "{error:#}");
    }
}
