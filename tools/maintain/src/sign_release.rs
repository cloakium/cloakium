//! Sign a staged, unprivileged release with the trusted publisher key.
//!
//! The staged bytes are validated first (see [`crate::sign_validate`]), then
//! signatures are stripped and regenerated with the official Nix CLI, and the
//! result is re-verified with `nix store verify` against the release public
//! key. Nothing from the staging directory is ever executed, and the signing
//! key only travels as a key file or on stdin — never in argv or logs.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{ensure, Context, Result};
use base64::Engine;
use serde_json::{json, Value};

use crate::cache;
use crate::command::{Command, Runner, CACHE_COPY_TIMEOUT};
use crate::narinfo;
use crate::release::{self, MANIFEST_ASSET, NOTES_ASSET, PUBLIC_KEY_ASSET};
use crate::report::Reporter;
use crate::sign_assets::{scan_assets, verify_checksums};
use crate::sign_validate::{load_narinfos, validate_evidence, validate_manifest, Facts};
use crate::util;

#[derive(Debug, Clone)]
pub struct SignReleaseOptions {
    pub input: PathBuf,
    pub output: Option<PathBuf>,
    pub revision: String,
    pub signing_key: PathBuf,
    pub public_key: PathBuf,
}

#[derive(Debug, Clone)]
pub struct SignReleaseOutcome {
    pub tag: String,
    pub assets: PathBuf,
    pub narinfos: usize,
    pub manifest: Value,
}

struct PublicKey {
    text: String,
    name: String,
}

/// Re-verify and sign a staged release.
pub fn prepare(
    options: &SignReleaseOptions,
    runner: &mut dyn Runner,
    reporter: &Reporter,
) -> Result<SignReleaseOutcome> {
    release::validate_revision(&options.revision)?;
    let input = fs::canonicalize(&options.input)
        .with_context(|| format!("failed to resolve {}", options.input.display()))?;
    ensure!(
        input.is_dir(),
        "--input must be a release directory: {}",
        input.display()
    );
    ensure_release_layout(&input)?;

    let public_key = read_public_key(&util::absolute(&options.public_key)?)?;
    let signing_key = util::absolute(&options.signing_key)?;
    ensure!(
        signing_key.is_file(),
        "the Nix cache signing key {} does not exist",
        signing_key.display()
    );
    let derived = derive_public_key(&signing_key, runner)?;
    ensure!(
        derived == public_key.text,
        "--signing-key does not derive the provided --public-key"
    );

    let target = match &options.output {
        Some(output) => {
            let output = util::absolute(output)?;
            ensure!(
                !output.exists(),
                "refuse to reuse release directory: {}",
                output.display()
            );
            copy_flat(&input, &output)?;
            fs::canonicalize(&output)?
        }
        None => input,
    };

    let assets = scan_assets(&target)?;
    verify_checksums(&target, &assets)?;
    let manifest = util::read_json(&target.join(MANIFEST_ASSET))
        .context("the staged release has no readable manifest.json")?;
    let facts = validate_manifest(&manifest, &options.revision, &target)?;
    validate_evidence(&target.join(release::EVIDENCE_ASSET), &facts)?;

    let narinfos = load_narinfos(&target, &facts)?;
    for (info, _) in narinfos.values() {
        info.verify_payload(&target)
            .with_context(|| format!("payload verification failed for {}", info.store_path))?;
    }
    for (_, path) in narinfos.values() {
        strip_file_signatures(path)?;
    }

    sign(&target, &signing_key, &facts.outputs, runner)?;
    verify_with_public_key(&target, &public_key.text, &facts.outputs, runner)?;
    ensure!(
        all_narinfos_signed(&target)?,
        "signing did not add a signature to every narinfo"
    );
    // `nix store sign` and `nix store verify` reopen the cache for writing and
    // recreate their bookkeeping directories; they are not release assets.
    cache::remove_cache_bookkeeping(&target)?;

    let narinfo_count = narinfos.len();
    fs::write(
        target.join(NOTES_ASSET),
        trusted_notes(&facts, &public_key.name),
    )
    .context("failed to rewrite release-notes.md")?;

    let mut manifest = manifest;
    let object = manifest
        .as_object_mut()
        .context("manifest.json is not an object")?;
    object.insert("signed".into(), Value::Bool(true));
    object.insert(
        "signing".into(),
        json!({
            "publicKey": public_key.text,
            "narinfos": narinfo_count,
            "verified": true,
        }),
    );
    util::write_json(&target.join(MANIFEST_ASSET), &manifest)?;
    fs::write(
        target.join(PUBLIC_KEY_ASSET),
        format!("{}\n", public_key.text),
    )
    .context("failed to write cache-public-key.txt")?;
    cache::write_checksums(&target)?;

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "tag": facts.tag,
            "assets": target.display().to_string(),
            "signed": true,
            "narinfos": narinfo_count,
        }))?
    );
    reporter.emit("tag", &facts.tag)?;
    reporter.emit("version", &facts.playwright)?;
    reporter.emit("playwright", &facts.playwright)?;
    reporter.emit("chromium", &facts.chromium)?;
    reporter.emit("assets", &target.display().to_string())?;

    Ok(SignReleaseOutcome {
        tag: facts.tag,
        assets: target,
        narinfos: narinfo_count,
        manifest,
    })
}

fn read_public_key(path: &Path) -> Result<PublicKey> {
    let text = fs::read_to_string(path)
        .with_context(|| format!("failed to read {}", path.display()))?
        .trim()
        .to_string();
    let (name, encoded) = text
        .split_once(':')
        .context("a Nix public key is written as name:base64")?;
    let name = name.to_string();
    ensure!(!name.is_empty(), "the public key has an empty name");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("the public key is not valid base64")?;
    ensure!(
        bytes.len() == 32,
        "a Nix public key decodes to 32 bytes, got {}",
        bytes.len()
    );
    Ok(PublicKey { text, name })
}

/// Ask `nix` to derive the public key; the secret only travels on stdin.
fn derive_public_key(signing_key: &Path, runner: &mut dyn Runner) -> Result<String> {
    let output = runner.run(
        &Command::new("nix", ["key", "convert-secret-to-public"])
            .stdin_file(signing_key)
            .describe("nix key convert-secret-to-public (secret key hidden)"),
    )?;
    let derived = output.stdout_trimmed().to_string();
    ensure!(
        !derived.is_empty(),
        "nix key convert-secret-to-public returned no public key"
    );
    Ok(derived)
}

fn copy_flat(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)
        .with_context(|| format!("failed to create {}", destination.display()))?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "release assets must be regular files: {}",
            entry.file_name().to_string_lossy()
        );
        fs::copy(entry.path(), destination.join(entry.file_name()))?;
    }
    Ok(())
}

fn strip_file_signatures(path: &Path) -> Result<()> {
    let text =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    fs::write(path, narinfo::strip_signatures(&text))
        .with_context(|| format!("failed to rewrite {}", path.display()))
}

fn store_url(directory: &Path) -> String {
    format!(
        "file://{}",
        util::percent_encode(&directory.to_string_lossy())
    )
}

/// Sign the cache narinfos. Only `nix` reads the key file; no cache payload is
/// ever executed or imported into the local store.
fn sign(
    directory: &Path,
    signing_key: &Path,
    store_paths: &[String],
    runner: &mut dyn Runner,
) -> Result<()> {
    let url = store_url(directory);
    let mut arguments = vec![
        "store".to_string(),
        "sign".to_string(),
        "--store".to_string(),
        url.clone(),
        "--key-file".to_string(),
        signing_key.display().to_string(),
    ];
    arguments.extend(store_paths.iter().cloned());
    runner.run(
        &Command::new("nix", arguments)
            .timeout(CACHE_COPY_TIMEOUT)
            .describe(format!(
                "nix store sign --store {url} (signing key redacted)"
            )),
    )?;
    Ok(())
}

/// `nix store verify` re-reads each payload from the cache, so this proves both
/// the signature and the NAR hash of the bytes being published.
fn verify_with_public_key(
    directory: &Path,
    public_key: &str,
    store_paths: &[String],
    runner: &mut dyn Runner,
) -> Result<()> {
    let url = store_url(directory);
    let mut arguments = vec![
        "store".to_string(),
        "verify".to_string(),
        "--store".to_string(),
        url.clone(),
        "--sigs-needed".to_string(),
        "1".to_string(),
        "--option".to_string(),
        "trusted-public-keys".to_string(),
        public_key.to_string(),
    ];
    arguments.extend(store_paths.iter().cloned());
    runner.run(
        &Command::new("nix", arguments)
            .timeout(CACHE_COPY_TIMEOUT)
            .describe(format!(
                "nix store verify --store {url} (signature and payload check)"
            )),
    )?;
    Ok(())
}

fn all_narinfos_signed(directory: &Path) -> Result<bool> {
    for info in cache::narinfo_paths(directory)? {
        let text = fs::read_to_string(&info)?;
        if !text
            .lines()
            .any(|line| line.starts_with("Sig: ") || line.trim_end() == "Sig:")
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn trusted_notes(facts: &Facts, key_name: &str) -> String {
    let mut notes = release::release_notes(
        &facts.chromium,
        &facts.playwright,
        &facts.revision,
        &facts.system,
        &facts.packages[0],
        &facts.packages[1],
        true,
    );
    notes.push_str(&format!(
        "\n## Provenance\n\nThis release was staged by an unprivileged build job and signed here, \
         by the trusted publisher, only after re-checking every asset hash, every NAR hash from \
         the cache payloads, the recorded verification evidence for source `{}` and the \
         `source-flake.lock` pin. Cache public key: `{key_name}`.\n\nNo code from the staged \
         artifacts was executed while signing.\n",
        facts.revision
    ));
    notes
}

/// Reject an input directory that is a binary cache rather than a release.
fn ensure_release_layout(directory: &Path) -> Result<()> {
    use crate::release::{EVIDENCE_ASSET, FLAKE_LOCK_ASSET, SUMS_ASSET};
    for name in [MANIFEST_ASSET, SUMS_ASSET, EVIDENCE_ASSET, FLAKE_LOCK_ASSET] {
        ensure!(
            directory.join(name).is_file(),
            "the release directory is missing {name}"
        );
    }
    if directory.join("nar").exists() {
        anyhow::bail!("the release cache is not flattened: a nar/ directory is present");
    }
    Ok(())
}
