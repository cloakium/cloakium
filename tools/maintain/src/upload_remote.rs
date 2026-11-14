//! `gh` invocations and parsing for draft release assets.

use std::path::Path;

use anyhow::{ensure, Context, Result};
use serde_json::Value;

use crate::cache;
use crate::command::Command;

/// `databaseId` is the numeric release id the asset endpoints address.
pub const RELEASE_FIELDS: &str = "databaseId,isDraft,isImmutable,tagName";
pub const PAGE_SIZE: usize = 100;

/// An authenticated draft release that may still be changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    pub id: u64,
    pub tag: String,
}

/// One asset the server reports for the release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteAsset {
    pub id: u64,
    pub name: String,
    pub size: u64,
    /// Lowercase sha256 from the server, or `None` when unverifiable.
    pub digest: Option<String>,
    pub state: String,
}

impl RemoteAsset {
    /// True when the asset on the server is exactly the local bytes.
    pub fn complete(&self, size: u64, sha256: &str) -> bool {
        self.state == "uploaded" && self.size == size && self.digest.as_deref() == Some(sha256)
    }
}

/// How a failed `gh` invocation should be treated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// Secondary or primary rate limit: wait before any further request.
    RateLimited,
    /// The asset name already exists: re-read it instead of posting twice.
    Duplicate,
    /// Transport or server-side failure: re-read the asset, then retry.
    Transient,
    /// The asset or release is already gone.
    NotFound,
    /// Anything else, including authorization failures: never retried.
    Permanent,
}

/// Classify a `gh` error message; permissions stay [`Failure::Permanent`].
pub fn classify(message: &str) -> Failure {
    let text = message.to_ascii_lowercase();
    let mentions = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    if mentions(&[
        "secondary rate limit",
        "api rate limit exceeded",
        "rate limit",
        "abuse detection",
        "too many requests",
    ]) {
        return Failure::RateLimited;
    }
    if mentions(&["already_exists", "already exists", "http 422"]) {
        return Failure::Duplicate;
    }
    if mentions(&["http 404", "not found", "gone (410)"]) {
        return Failure::NotFound;
    }
    if mentions(&[
        "http 502",
        "bad gateway",
        "http 503",
        "http 504",
        "gateway timeout",
        "timed out",
        "timeout",
        "connection reset",
        "connection refused",
        "broken pipe",
        "unexpected eof",
        "tls handshake",
        "exceeded its deadline",
    ]) {
        return Failure::Transient;
    }
    Failure::Permanent
}

/// Builds the `gh` commands for one repository.
#[derive(Debug, Clone)]
pub struct Gh<'a> {
    repository: &'a str,
}

impl<'a> Gh<'a> {
    pub fn new(repository: &'a str) -> Self {
        Self { repository }
    }

    pub fn view(&self, tag: &str) -> Command {
        Command::new(
            "gh",
            [
                "release",
                "view",
                tag,
                "--repo",
                self.repository,
                "--json",
                RELEASE_FIELDS,
            ],
        )
        .describe(format!("gh release view {tag} --json {RELEASE_FIELDS}"))
    }

    /// One paginated read of every asset on the release.
    pub fn assets(&self, release_id: u64) -> Command {
        let endpoint = format!(
            "repos/{}/releases/{release_id}/assets?per_page={PAGE_SIZE}",
            self.repository
        );
        Command::new("gh", ["api", "--paginate", "--slurp", &endpoint]).describe(format!(
            "gh api --paginate --slurp repos/{}/releases/{release_id}/assets",
            self.repository
        ))
    }

    pub fn upload(&self, tag: &str, path: &Path) -> Command {
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        Command::new(
            "gh",
            [
                "release",
                "upload",
                tag,
                &path.display().to_string(),
                "--repo",
                self.repository,
            ],
        )
        .describe(format!(
            "gh release upload {tag} {name} --repo {}",
            self.repository
        ))
    }

    pub fn delete(&self, asset_id: u64) -> Command {
        Command::new(
            "gh",
            [
                "api",
                "--method",
                "DELETE",
                &format!("repos/{}/releases/assets/{asset_id}", self.repository),
                "--silent",
            ],
        )
        .describe(format!("gh api --method DELETE releases/assets/{asset_id}"))
    }
}

/// Parse `gh release view --json {RELEASE_FIELDS}`; only a mutable draft passes.
pub fn parse_draft(text: &str, tag: &str) -> Result<Draft> {
    let value: Value = serde_json::from_str(text).context("gh release view did not return JSON")?;
    let id = value
        .get("databaseId")
        .and_then(Value::as_u64)
        .context("the release view has no numeric databaseId")?;
    let tag_name = value
        .get("tagName")
        .and_then(Value::as_str)
        .context("the release view has no tagName")?;
    ensure!(
        tag_name == tag,
        "the release view describes tag {tag_name}, expected {tag}"
    );
    let draft = value
        .get("isDraft")
        .and_then(Value::as_bool)
        .context("the release view has no isDraft")?;
    ensure!(
        draft,
        "release {tag} is already published; refusing to change a published release"
    );
    let immutable = value
        .get("isImmutable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    ensure!(
        !immutable,
        "release {tag} is immutable; its assets can no longer be replaced"
    );
    Ok(Draft {
        id,
        tag: tag.to_string(),
    })
}

/// Parse `gh api --paginate --slurp` output (an array of page arrays).
pub fn parse_assets(text: &str) -> Result<Vec<RemoteAsset>> {
    let value: Value =
        serde_json::from_str(text).context("gh api did not return JSON for the asset list")?;
    let items = value
        .as_array()
        .context("the asset list is not a JSON array")?;
    let entries: Vec<&Value> = if items.iter().all(Value::is_array) {
        items.iter().filter_map(Value::as_array).flatten().collect()
    } else {
        items.iter().collect()
    };
    let mut assets: Vec<RemoteAsset> = Vec::with_capacity(entries.len());
    for entry in entries {
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .context("a release asset has no name")?;
        ensure!(
            cache::is_safe_asset_name(name),
            "the release has an unsafe asset name: {name}"
        );
        let id = entry
            .get("id")
            .and_then(Value::as_u64)
            .with_context(|| format!("the release asset {name} has no numeric id"))?;
        let size = entry
            .get("size")
            .and_then(Value::as_u64)
            .with_context(|| format!("the release asset {name} has no size"))?;
        let digest = server_digest(entry, name)?;
        let state = entry
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("uploaded")
            .to_string();
        ensure!(
            !assets.iter().any(|asset| asset.name == name),
            "the release lists the asset {name} more than once"
        );
        assets.push(RemoteAsset {
            id,
            name: name.to_string(),
            size,
            digest,
            state,
        });
    }
    Ok(assets)
}

/// GitHub reports `sha256:<hex>`; an `md5:` or missing digest is unverifiable.
fn server_digest(asset: &Value, name: &str) -> Result<Option<String>> {
    let Some(raw) = asset.get("digest").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Some(rest) = raw.strip_prefix("sha256:") else {
        return Ok(None);
    };
    ensure!(
        rest.len() == 64 && rest.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "the release asset {name} has an invalid sha256 digest"
    );
    Ok(Some(rest.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limits_and_permissions_are_classified_differently() {
        assert_eq!(
            classify(
                "gh: HTTP 403: You have exceeded a secondary rate limit. \
                 Please wait a few minutes before you try again."
            ),
            Failure::RateLimited
        );
        assert_eq!(
            classify("gh: HTTP 429: Too Many Requests"),
            Failure::RateLimited
        );
        assert_eq!(
            classify("gh: HTTP 403: Resource not accessible by integration"),
            Failure::Permanent
        );
        assert_eq!(
            classify("gh: HTTP 422: Validation Failed (already_exists)"),
            Failure::Duplicate
        );
        assert_eq!(classify("gh: Not Found (HTTP 404)"), Failure::NotFound);
        assert_eq!(classify("gh: HTTP 502: Bad Gateway"), Failure::Transient);
    }

    #[test]
    fn a_published_release_is_refused() {
        let text = r#"{"databaseId":7,"isDraft":false,"isImmutable":false,"tagName":"t"}"#;
        let error = parse_draft(text, "t").expect_err("published");
        assert!(format!("{error:#}").contains("already published"));
    }

    #[test]
    fn an_immutable_draft_is_refused() {
        let text = r#"{"databaseId":7,"isDraft":true,"isImmutable":true,"tagName":"t"}"#;
        let error = parse_draft(text, "t").expect_err("immutable");
        assert!(format!("{error:#}").contains("immutable"));
    }

    #[test]
    fn slurped_pages_are_flattened() {
        let digest = format!("sha256:{}", "a".repeat(64));
        let text = serde_json::json!([
            [{"id": 1, "name": "a.narinfo", "size": 4, "digest": digest, "state": "uploaded"}],
            [{"id": 2, "name": "b.narinfo", "size": 5, "state": "starter"}]
        ])
        .to_string();
        let assets = parse_assets(&text).expect("assets");
        assert_eq!(assets.len(), 2);
        assert_eq!(assets[0].digest.as_deref(), Some("a".repeat(64).as_str()));
        assert_eq!(assets[1].digest, None);
        assert_eq!(assets[1].state, "starter");
    }

    #[test]
    fn md5_digests_are_not_accepted_as_sha256() {
        let text = r#"[{"id":1,"name":"a.narinfo","size":4,"digest":"md5:abcd"}]"#;
        let assets = parse_assets(text).expect("assets");
        assert_eq!(assets[0].digest, None);
        assert!(!assets[0].complete(4, "abcd"));
    }

    #[test]
    fn an_unsafe_asset_name_is_rejected() {
        let text = r#"[{"id":1,"name":"../evil","size":4,"digest":"sha256:aa"}]"#;
        let error = parse_assets(text).expect_err("unsafe");
        assert!(format!("{error:#}").contains("unsafe asset name"));
    }

    #[test]
    fn a_duplicate_asset_entry_is_rejected() {
        let text = r#"[
            [{"id":1,"name":"a","size":4}],
            [{"id":2,"name":"a","size":4}]
        ]"#;
        let error = parse_assets(text).expect_err("duplicate");
        assert!(format!("{error:#}").contains("more than once"));
    }

    #[test]
    fn the_asset_list_uses_the_documented_pagination_only() {
        let gh = Gh::new("owner/repo");
        let command = gh.assets(444_977_957);
        assert_eq!(command.program, "gh");
        assert_eq!(
            command.args,
            [
                "api",
                "--paginate",
                "--slurp",
                "repos/owner/repo/releases/444977957/assets?per_page=100"
            ]
        );
        assert!(
            !command.args.iter().any(|arg| arg.contains("name=")),
            "the list endpoint has no documented name filter"
        );
    }

    #[test]
    fn upload_commands_carry_no_secret_and_one_file() {
        let gh = Gh::new("owner/repo");
        let command = gh.upload("t", Path::new("/tmp/assets/a.narinfo"));
        assert_eq!(command.program, "gh");
        assert_eq!(command.args[0], "release");
        assert_eq!(command.args[1], "upload");
        assert!(
            !command.display().contains("token"),
            "{}",
            command.display()
        );
        assert!(!command.args.iter().any(|arg| arg == "--clobber"));
    }
}
