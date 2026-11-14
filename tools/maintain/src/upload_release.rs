//! Resume a partially uploaded draft release with paced, verified uploads.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};

use crate::command::{Runner, QUERY_TIMEOUT};
use crate::release::{validate_revision, MANIFEST_ASSET, SUMS_ASSET};
use crate::report::Reporter;
use crate::upload_pace::{Clock, Pacer};
use crate::upload_plan::{self, Action, LocalAsset};
use crate::upload_remote::{classify, parse_assets, parse_draft, Draft, Failure, Gh, RemoteAsset};
use crate::verify_publication;

/// Whole-command deadline (three hours). The publisher job timeout is separate.
pub const DEFAULT_TIMEOUT_SECS: u64 = 10_800;
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(DEFAULT_TIMEOUT_SECS);
/// Ceiling for a single asset upload (a release asset may be up to 2 GiB).
pub const UPLOAD_COMMAND_TIMEOUT: Duration = Duration::from_secs(3600);
pub const DELETE_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// Attempts per asset, including the first one.
pub const MAX_ASSET_ATTEMPTS: usize = 4;
/// Progress is reported on stdout after this many processed assets.
pub const PROGRESS_INTERVAL: usize = 20;

#[derive(Debug, Clone)]
pub struct UploadOptions {
    pub input: PathBuf,
    pub repository: String,
    pub tag: String,
    pub revision: String,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
pub struct UploadOutcome {
    pub tag: String,
    pub release_id: u64,
    pub assets: usize,
    /// Assets the server reported at the end, all digest-verified.
    pub verified_assets: usize,
    pub skipped: usize,
    pub replaced: usize,
    pub uploaded: Vec<String>,
    pub content_operations: usize,
}

/// Validate options before any network access or local hashing.
pub fn validate_options(options: &UploadOptions) -> Result<()> {
    validate_revision(&options.revision)?;
    validate_repository(&options.repository)?;
    ensure!(
        !options.timeout.is_zero(),
        "--timeout must be greater than zero"
    );
    upload_plan::validate_tag(&options.tag, &options.revision)
}

fn validate_repository(repository: &str) -> Result<()> {
    let mut parts = repository.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    ensure!(
        parts.next().is_none() && !owner.is_empty() && !name.is_empty(),
        "--repository must be owner/repo, got {repository:?}"
    );
    ensure!(
        repository
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/')),
        "--repository has unexpected characters: {repository:?}"
    );
    Ok(())
}

/// Bring the draft to a verified complete state.
pub fn prepare(
    options: &UploadOptions,
    runner: &mut dyn Runner,
    clock: &mut dyn Clock,
    reporter: &Reporter,
) -> Result<UploadOutcome> {
    // The deadline starts at entry, so local hashing is inside the same budget.
    let mut pacer = Pacer::new(options.timeout);
    validate_options(options)?;
    let input = std::fs::canonicalize(&options.input)
        .with_context(|| format!("failed to resolve {}", options.input.display()))?;
    let local = upload_plan::load(&input, &options.revision, &options.tag)?;
    let gh = Gh::new(&options.repository);

    let draft = fetch_draft(&gh, options, runner, clock, &pacer)?;
    let remote = fetch_assets(&gh, draft.id, runner, clock, &pacer)?;
    let steps = upload_plan::plan(&local, &remote)?;

    let mut uploaded = Vec::new();
    let mut replaced = 0usize;
    let mut skipped = 0usize;
    let mut processed = 0usize;
    let to_upload = steps
        .iter()
        .filter(|step| step.action == Action::Upload)
        .count();
    let to_replace = steps
        .iter()
        .filter(|step| matches!(step.action, Action::Replace { .. }))
        .count();
    let complete = steps
        .iter()
        .filter(|step| step.action == Action::Skip)
        .count();
    reporter.note(&format!(
        "upload-release: {} assets; {to_upload} to upload, {to_replace} to replace, \
         {complete} already complete",
        steps.len()
    ));
    for step in &steps {
        let asset = local
            .assets
            .get(&step.name)
            .expect("every plan step names a local asset");
        match step.action {
            Action::Skip => skipped += 1,
            Action::Replace { asset_id } => {
                delete_asset(&gh, &mut pacer, runner, clock, asset_id)?;
                upload_asset(&gh, &mut pacer, runner, clock, options, draft.id, asset)?;
                replaced += 1;
                uploaded.push(step.name.clone());
            }
            Action::Upload => {
                upload_asset(&gh, &mut pacer, runner, clock, options, draft.id, asset)?;
                uploaded.push(step.name.clone());
            }
        }
        processed += 1;
        if processed % PROGRESS_INTERVAL == 0 {
            reporter.note(&format!(
                "upload-release: {processed}/{} assets processed; {} uploaded, {} skipped",
                steps.len(),
                uploaded.len(),
                skipped
            ));
        }
    }

    let published = fetch_assets(&gh, draft.id, runner, clock, &pacer)?;
    // A release published mid-run must never be treated as a resumable draft.
    let confirmed = fetch_draft(&gh, options, runner, clock, &pacer)?;
    ensure!(
        confirmed.id == draft.id,
        "the draft release changed identity during the run ({} became {}); \
         stop and inspect the release before resuming",
        draft.id,
        confirmed.id
    );
    verify(&published, &input, options, reporter)?;

    let outcome = UploadOutcome {
        tag: options.tag.clone(),
        release_id: draft.id,
        assets: local.assets.len(),
        verified_assets: published.len(),
        skipped,
        replaced,
        uploaded,
        content_operations: pacer.operations(),
    };
    report(&outcome, reporter)?;
    Ok(outcome)
}

fn fetch_draft(
    gh: &Gh<'_>,
    options: &UploadOptions,
    runner: &mut dyn Runner,
    clock: &mut dyn Clock,
    pacer: &Pacer,
) -> Result<Draft> {
    let budget = pacer.budget(&*clock, QUERY_TIMEOUT)?;
    let output = runner.run(&gh.view(&options.tag).timeout(budget))?;
    parse_draft(&output.stdout, &options.tag)
}

/// One paginated read of every asset; only server digests and sizes are compared.
fn fetch_assets(
    gh: &Gh<'_>,
    release_id: u64,
    runner: &mut dyn Runner,
    clock: &mut dyn Clock,
    pacer: &Pacer,
) -> Result<Vec<RemoteAsset>> {
    let budget = pacer.budget(&*clock, QUERY_TIMEOUT)?;
    let output = runner.run(&gh.assets(release_id).timeout(budget))?;
    parse_assets(&output.stdout)
}

/// Re-read the whole asset list and pick one name client-side.
fn current_asset(
    gh: &Gh<'_>,
    pacer: &mut Pacer,
    runner: &mut dyn Runner,
    clock: &mut dyn Clock,
    release_id: u64,
    name: &str,
) -> Result<Option<RemoteAsset>> {
    let assets = fetch_assets(gh, release_id, runner, clock, pacer)?;
    Ok(assets.into_iter().find(|asset| asset.name == name))
}

fn upload_asset(
    gh: &Gh<'_>,
    pacer: &mut Pacer,
    runner: &mut dyn Runner,
    clock: &mut dyn Clock,
    options: &UploadOptions,
    release_id: u64,
    asset: &LocalAsset,
) -> Result<()> {
    let mut attempt = 0usize;
    loop {
        pacer.before_content(clock)?;
        let budget = pacer.budget(&*clock, UPLOAD_COMMAND_TIMEOUT)?;
        let result = runner.run(&gh.upload(&options.tag, &asset.path).timeout(budget));
        pacer.after_content(clock);
        let error = match result {
            Ok(_) => return Ok(()),
            Err(error) => error,
        };
        let message = format!("{error:#}");
        let kind = classify(&message);
        if kind == Failure::Permanent {
            bail!("refusing to retry the upload of {}: {message}", asset.name);
        }
        attempt += 1;
        if attempt >= MAX_ASSET_ATTEMPTS {
            bail!(
                "uploading {} failed after {MAX_ASSET_ATTEMPTS} attempts: {message}",
                asset.name
            );
        }
        if kind == Failure::RateLimited {
            // No further request may precede this wait.
            pacer.backoff(clock, attempt - 1, true)?;
        }
        // The POST may have landed before the transport failed; re-reading the
        // list prevents a second POST of the same bytes.
        if let Some(remote) = current_asset(gh, pacer, runner, clock, release_id, &asset.name)? {
            if remote.complete(asset.size, &asset.sha256) {
                return Ok(());
            }
            delete_asset(gh, pacer, runner, clock, remote.id)?;
        }
        if kind != Failure::RateLimited {
            pacer.backoff(clock, attempt - 1, false)?;
        }
    }
}

fn delete_asset(
    gh: &Gh<'_>,
    pacer: &mut Pacer,
    runner: &mut dyn Runner,
    clock: &mut dyn Clock,
    asset_id: u64,
) -> Result<()> {
    let mut attempt = 0usize;
    loop {
        pacer.before_content(clock)?;
        let budget = pacer.budget(&*clock, DELETE_COMMAND_TIMEOUT)?;
        let result = runner.run(&gh.delete(asset_id).timeout(budget));
        pacer.after_content(clock);
        let error = match result {
            Ok(_) => return Ok(()),
            Err(error) => error,
        };
        let message = format!("{error:#}");
        let kind = classify(&message);
        match kind {
            // Another attempt already removed it.
            Failure::NotFound => return Ok(()),
            Failure::RateLimited | Failure::Transient => {
                attempt += 1;
                ensure!(
                    attempt < MAX_ASSET_ATTEMPTS,
                    "deleting release asset {asset_id} failed after {MAX_ASSET_ATTEMPTS} attempts: \
                     {message}"
                );
                pacer.backoff(clock, attempt - 1, kind == Failure::RateLimited)?;
            }
            _ => bail!("refusing to retry deleting release asset {asset_id}: {message}"),
        }
    }
}

/// Prove every server digest against the local signed metadata.
fn verify(
    published: &[RemoteAsset],
    input: &Path,
    options: &UploadOptions,
    reporter: &Reporter,
) -> Result<()> {
    let assets: Vec<Value> = published
        .iter()
        .map(|asset| {
            let mut entry = serde_json::Map::new();
            entry.insert("name".into(), json!(asset.name));
            entry.insert("size".into(), json!(asset.size));
            if let Some(digest) = &asset.digest {
                entry.insert("digest".into(), json!(format!("sha256:{digest}")));
            }
            Value::Object(entry)
        })
        .collect();
    let release = json!({ "tag_name": options.tag, "assets": assets });
    verify_publication::verify_release(
        &release,
        &input.join(SUMS_ASSET),
        &input.join(MANIFEST_ASSET),
        &options.revision,
        reporter,
    )?;
    Ok(())
}

fn report(outcome: &UploadOutcome, reporter: &Reporter) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "verified": true,
            "tag": outcome.tag,
            "releaseId": outcome.release_id,
            "assets": outcome.assets,
            "verifiedAssets": outcome.verified_assets,
            "skipped": outcome.skipped,
            "replaced": outcome.replaced,
            "uploaded": outcome.uploaded,
            "contentOperations": outcome.content_operations,
        }))?
    );
    reporter.emit("release_id", &outcome.release_id.to_string())?;
    reporter.emit("skipped", &outcome.skipped.to_string())?;
    reporter.emit("replaced", &outcome.replaced.to_string())?;
    reporter.emit("uploaded", &outcome.uploaded.len().to_string())?;
    reporter.emit(
        "content_operations",
        &outcome.content_operations.to_string(),
    )?;
    Ok(())
}
