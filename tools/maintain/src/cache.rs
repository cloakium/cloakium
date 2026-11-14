//! Signed Nix cache staging as flat GitHub release assets.
//!
//! `nix copy` writes `nar/<file>` plus a `URL: nar/<file>` line in each
//! `.narinfo`. GitHub release assets are flat, so the NAR is moved next to its
//! narinfo and the URL line is rewritten. Narinfo signatures cover the store
//! path and NAR hash, never the URL, so flattening keeps every signature valid.

use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};

use crate::command::{Command, Runner, CACHE_COPY_TIMEOUT};
use crate::util;

/// GitHub rejects any single release asset at or above 2 GiB.
pub const ASSET_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

const NARINFO_SUFFIX: &str = ".narinfo";

/// Move every referenced NAR out of `nar/` and rewrite the narinfo URL lines.
pub fn flatten_cache(directory: &Path) -> Result<()> {
    let mut moved: Vec<PathBuf> = Vec::new();
    for info in narinfo_paths(directory)? {
        let name = asset_name(&info);
        let contents =
            fs::read_to_string(&info).with_context(|| format!("failed to read {name} as text"))?;
        let url = single_url(&contents).with_context(|| format!("invalid cache URL in {name}"))?;
        let source = PathBuf::from(&url);
        let file_name =
            nar_file_name(&source).with_context(|| format!("unexpected cache asset URL: {url}"))?;
        if !moved.contains(&source) {
            let original = directory.join(&source);
            let metadata = fs::symlink_metadata(&original)
                .with_context(|| format!("cache asset is missing: {url}"))?;
            ensure!(
                metadata.is_file() && !metadata.file_type().is_symlink(),
                "cache asset is missing or not a regular file: {url}"
            );
            let target = directory.join(&file_name);
            ensure!(
                fs::symlink_metadata(&target).is_err(),
                "duplicate cache asset: {}",
                file_name.to_string_lossy()
            );
            fs::rename(&original, &target)
                .with_context(|| format!("failed to move {url} to {}", target.display()))?;
            moved.push(source.clone());
        }
        let flattened = rewrite_url_line(&contents, &url, &file_name.to_string_lossy());
        fs::write(&info, flattened).with_context(|| format!("failed to rewrite {name}"))?;
    }

    let nar_directory = directory.join("nar");
    if fs::symlink_metadata(&nar_directory).is_ok() {
        fs::remove_dir(&nar_directory).with_context(|| {
            format!(
                "failed to remove {}; every NAR must be referenced by a narinfo",
                nar_directory.display()
            )
        })?;
    }
    remove_store_bookkeeping(directory)?;
    Ok(())
}

/// Nix file stores create bookkeeping directories next to the assets:
/// `log/`, `realisations/` and, since Nix 2.34, `build-trace-v2/`. None of them
/// can be a flat GitHub release asset and none is needed to substitute an
/// input-addressed output, so they are pruned. `nar/` must already be empty,
/// and non-empty `realisations/` is refused rather than silently dropped.
pub fn remove_store_bookkeeping(directory: &Path) -> Result<()> {
    let mut directories = Vec::new();
    for entry in fs::read_dir(directory)
        .with_context(|| format!("failed to list {}", directory.display()))?
    {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            directories.push(entry.path());
        }
    }
    for path in directories {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        match name.as_str() {
            "nar" => {
                ensure!(
                    is_empty_directory(&path)?,
                    "the release cache is not flattened: {} is not empty",
                    path.display()
                );
                fs::remove_dir(&path)
                    .with_context(|| format!("failed to remove {}", path.display()))?;
            }
            "realisations" => {
                ensure!(
                    is_empty_directory(&path)?,
                    "the staged cache contains content-addressed realisations, which cannot be published as flat release assets"
                );
                fs::remove_dir(&path)
                    .with_context(|| format!("failed to remove {}", path.display()))?;
            }
            _ => fs::remove_dir_all(&path)
                .with_context(|| format!("failed to remove {}", path.display()))?,
        }
    }
    Ok(())
}

fn is_empty_directory(path: &Path) -> Result<bool> {
    Ok(fs::read_dir(path)
        .with_context(|| format!("failed to list {}", path.display()))?
        .next()
        .is_none())
}

/// Copy `paths` into a fresh cache at `output`, then flatten it.
///
/// With a signing key the cache is signed by `nix copy`; without one it is an
/// unsigned staging cache for the trusted publisher to sign later.
pub fn stage_cache(
    paths: &[PathBuf],
    output: &Path,
    signing_key: Option<&Path>,
    runner: &mut dyn Runner,
) -> Result<PathBuf> {
    ensure!(!paths.is_empty(), "no Nix store paths were given to stage");
    let output = util::absolute(output)?;
    ensure!(
        !output.exists(),
        "refuse to reuse release directory: {}",
        output.display()
    );
    let signing_key = match signing_key {
        Some(key) => {
            let key = util::absolute(key)?;
            ensure!(key.is_file(), "a Nix cache signing key file is required");
            Some(key)
        }
        None => None,
    };
    fs::create_dir_all(&output)
        .with_context(|| format!("failed to create {}", output.display()))?;

    let store_url = format!("file://{}", util::percent_encode(&output.to_string_lossy()));
    let destination = match &signing_key {
        Some(key) => format!(
            "{store_url}?compression=xz&secret-key={}",
            util::percent_encode(&key.to_string_lossy())
        ),
        None => format!("{store_url}?compression=xz"),
    };
    let description = match &signing_key {
        Some(_) => format!("nix copy --to {store_url} (signing key redacted)"),
        None => format!("nix copy --to {store_url}"),
    };
    let mut arguments = vec!["copy".to_string(), "--to".to_string(), destination];
    arguments.extend(paths.iter().map(|path| path.display().to_string()));
    runner.run(
        &Command::new("nix", arguments)
            .timeout(CACHE_COPY_TIMEOUT)
            .describe(description),
    )?;

    flatten_cache(&output)?;
    match signing_key {
        Some(_) => verify_signed(&output)?,
        None => {
            // Dependencies substituted from upstream caches arrive signed;
            // normalise before insisting the staging cache is unsigned.
            strip_inherited_signatures(&output)?;
            verify_unsigned(&output)?;
        }
    }
    Ok(output)
}

/// Remove signatures inherited from upstream caches.
///
/// `nix copy` only signs when a secret key is supplied; without one it keeps
/// the signatures the substituter already had (for example the signatures
/// cache.nixos.org placed on glibc). An unsigned staging cache must be
/// normalised by dropping those lines, keeping every other field byte for byte
/// so URLs, file hashes, NAR hashes and references are untouched.
pub fn strip_inherited_signatures(directory: &Path) -> Result<usize> {
    let mut stripped = 0;
    for path in narinfo_paths(directory)? {
        let text = fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        if !has_signature_line(&text) {
            continue;
        }
        fs::write(&path, crate::narinfo::strip_signatures(&text))
            .with_context(|| format!("failed to rewrite {}", path.display()))?;
        stripped += 1;
    }
    Ok(stripped)
}

pub fn has_signature_line(text: &str) -> bool {
    text.lines()
        .any(|line| line.starts_with("Sig: ") || line.trim_end() == "Sig:")
}

/// Every narinfo must carry at least one signature line.
pub fn verify_signed(directory: &Path) -> Result<()> {
    for info in narinfo_paths(directory)? {
        let contents = fs::read_to_string(&info)
            .with_context(|| format!("failed to read {}", info.display()))?;
        ensure!(
            contents.lines().any(signature_line),
            "unsigned Nix cache entry: {}",
            asset_name(&info)
        );
    }
    Ok(())
}

/// The untrusted staging cache must not carry signatures at all.
pub fn verify_unsigned(directory: &Path) -> Result<()> {
    for info in narinfo_paths(directory)? {
        let contents = fs::read_to_string(&info)
            .with_context(|| format!("failed to read {}", info.display()))?;
        ensure!(
            !contents
                .lines()
                .any(|line| line.trim_end() == "Sig:" || line.starts_with("Sig: ")),
            "unexpected signature in {}: an unsigned staging cache must not be signed",
            asset_name(&info)
        );
    }
    Ok(())
}

/// Write `SHA256SUMS` covering every other asset, in stable name order.
pub fn write_checksums(directory: &Path) -> Result<()> {
    let mut entries: Vec<(String, PathBuf)> = Vec::new();
    for entry in fs::read_dir(directory)
        .with_context(|| format!("failed to list {}", directory.display()))?
    {
        let entry = entry?;
        entries.push((
            entry.file_name().to_string_lossy().into_owned(),
            entry.path(),
        ));
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));

    let mut sums = String::new();
    for (name, path) in entries {
        if name == "SHA256SUMS" {
            continue;
        }
        let metadata =
            fs::symlink_metadata(&path).with_context(|| format!("failed to inspect {name}"))?;
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "release assets must be regular files: {name}"
        );
        ensure!(
            is_safe_asset_name(&name),
            "unsafe release asset filename: {name}"
        );
        ensure!(
            metadata.len() < ASSET_LIMIT,
            "asset exceeds GitHub's 2 GiB limit: {name}"
        );
        sums.push_str(&format!("{}  {}\n", util::digest(&path)?, name));
    }
    fs::write(directory.join("SHA256SUMS"), sums)
        .with_context(|| format!("failed to write {}", directory.join("SHA256SUMS").display()))?;
    Ok(())
}

/// Sum of every regular file below `directory`, used to check transport limits.
pub fn total_size(directory: &Path) -> Result<u64> {
    let mut total = 0u64;
    let mut pending = vec![directory.to_path_buf()];
    while let Some(current) = pending.pop() {
        for entry in fs::read_dir(&current)
            .with_context(|| format!("failed to list {}", current.display()))?
        {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            ensure!(
                !metadata.file_type().is_symlink(),
                "release assets must not be symlinks: {}",
                entry.path().display()
            );
            if metadata.is_dir() {
                pending.push(entry.path());
            } else {
                total = total
                    .checked_add(metadata.len())
                    .context("release size overflow")?;
            }
        }
    }
    Ok(total)
}

pub fn narinfo_paths(directory: &Path) -> Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = fs::read_dir(directory)
        .with_context(|| format!("failed to list {}", directory.display()))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    files.retain(|path| asset_name(path).ends_with(NARINFO_SUFFIX));
    files.sort();
    Ok(files)
}

fn asset_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn single_url(contents: &str) -> Result<String> {
    let urls: Vec<&str> = contents
        .lines()
        .filter_map(|line| line.strip_prefix("URL: "))
        .filter(|value| !value.is_empty())
        .collect();
    match urls.as_slice() {
        [url] => Ok((*url).to_string()),
        _ => bail!("expected exactly one URL line, found {}", urls.len()),
    }
}

/// Accept only `nar/<name>`: no absolute paths, no traversal, no extra
/// components, no remote URLs.
fn nar_file_name(source: &Path) -> Result<std::ffi::OsString> {
    let components: Vec<Component<'_>> = source.components().collect();
    ensure!(
        components.len() == 2 && components[0] == Component::Normal(OsStr::new("nar")),
        "expected nar/<name>"
    );
    match components[1] {
        Component::Normal(name) => Ok(name.to_os_string()),
        _ => bail!("expected a plain NAR file name"),
    }
}

fn rewrite_url_line(contents: &str, url: &str, file_name: &str) -> String {
    let expected = format!("URL: {url}");
    let mut rewritten = String::with_capacity(contents.len());
    let mut replaced = false;
    for segment in contents.split_inclusive('\n') {
        let (line, newline) = match segment.strip_suffix('\n') {
            Some(line) => (line, "\n"),
            None => (segment, ""),
        };
        let (body, carriage_return) = match line.strip_suffix('\r') {
            Some(body) => (body, "\r"),
            None => (line, ""),
        };
        if !replaced && body == expected {
            rewritten.push_str("URL: ");
            rewritten.push_str(file_name);
            rewritten.push_str(carriage_return);
            rewritten.push_str(newline);
            replaced = true;
        } else {
            rewritten.push_str(segment);
        }
    }
    rewritten
}

fn signature_line(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("Sig: ") else {
        return false;
    };
    if rest.is_empty() || rest.chars().any(char::is_whitespace) {
        return false;
    }
    match rest.split_once(':') {
        Some((name, signature)) => !name.is_empty() && !signature.is_empty(),
        None => false,
    }
}

pub fn is_safe_asset_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}
