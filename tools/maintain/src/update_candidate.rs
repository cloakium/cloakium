//! Locating the candidate files to validate.
//!
//! A candidate is either a *staged* directory holding only the metadata files
//! an update rewrites, or a *full checkout* as `--candidate .` sees in a real
//! workspace. The staged shape is validated strictly (nothing but the five
//! files may exist); the checkout shape inspects exactly those five paths, so
//! build outputs such as `result-*` GC roots, `node_modules/` and `target/`
//! never fail a legitimate local run.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{ensure, Context, Result};

use crate::util;
use crate::validate_update::ALLOWED_FILES;

/// A checkout contains at least one of these markers; a staged candidate holds
/// only the five metadata files.
const PROJECT_MARKERS: [&str; 3] = ["flake.nix", ".git", ".jj"];

/// Reject a candidate whose root is itself a symlink, before the canonicaliser
/// resolves it.
pub fn ensure_candidate_root(path: &Path) -> Result<()> {
    let absolute = util::absolute(path)?;
    let metadata = fs::symlink_metadata(&absolute)
        .with_context(|| format!("failed to inspect {}", absolute.display()))?;
    ensure!(
        !metadata.file_type().is_symlink(),
        "the candidate root must not be a symlink: {}",
        absolute.display()
    );
    ensure!(metadata.is_dir(), "--candidate must be a directory");
    Ok(())
}

pub fn is_project_checkout(root: &Path) -> bool {
    PROJECT_MARKERS
        .iter()
        .any(|marker| fs::symlink_metadata(root.join(marker)).is_ok())
}

/// The metadata files to validate, in stable order.
pub fn collect_candidate_files(base: &Path, candidate: &Path) -> Result<Vec<String>> {
    if is_project_checkout(candidate) {
        collect_project_metadata(base, candidate)
    } else {
        collect_staged_files(candidate)
    }
}

/// Inspect exactly the five metadata paths of a full checkout.
fn collect_project_metadata(base: &Path, candidate: &Path) -> Result<Vec<String>> {
    let mut files = Vec::new();
    for relative in ALLOWED_FILES {
        let in_candidate = metadata_file(candidate, relative, "candidate")?;
        let in_base = metadata_file(base, relative, "base")?;
        ensure!(!in_base || in_candidate, "the candidate deletes {relative}");
        if in_candidate {
            files.push(relative.to_string());
        }
    }
    files.sort();
    Ok(files)
}

/// Walk the chain from the root to `relative`, rejecting any symlink. Returns
/// whether the file exists as a regular file.
fn metadata_file(root: &Path, relative: &str, role: &str) -> Result<bool> {
    let mut current = root.to_path_buf();
    let components: Vec<&str> = relative.split('/').collect();
    for (index, component) in components.iter().enumerate() {
        current.push(component);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to inspect {}", current.display()))
            }
        };
        ensure!(
            !metadata.file_type().is_symlink(),
            "the {role} {relative} path contains a symlink: {}",
            current.display()
        );
        if index + 1 == components.len() {
            ensure!(
                metadata.is_file(),
                "the {role} {relative} is not a regular file"
            );
            return Ok(true);
        }
        ensure!(
            metadata.is_dir(),
            "the {role} {relative} parent is not a directory: {}",
            current.display()
        );
    }
    Ok(false)
}

/// A staged candidate must contain nothing but the allowed metadata files.
fn collect_staged_files(root: &Path) -> Result<Vec<String>> {
    let mut found = Vec::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let directory = root.join(&relative);
        for entry in fs::read_dir(&directory)
            .with_context(|| format!("failed to list {}", directory.display()))?
        {
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            ensure!(
                !metadata.file_type().is_symlink(),
                "the candidate contains a symlink: {}",
                entry.file_name().to_string_lossy()
            );
            let child = relative.join(entry.file_name());
            if metadata.is_dir() {
                pending.push(child);
                continue;
            }
            ensure!(
                metadata.is_file(),
                "the candidate contains an unsupported entry: {}",
                child.display()
            );
            found.push(util::relative_key(&path, root)?);
        }
    }
    found.sort();
    Ok(found)
}
