use std::path::Path;

use crate::failure::{Failure, Result};

pub fn read_text(path: &Path) -> Result<String> {
    std::fs::read_to_string(path)
        .map_err(|error| Failure::new(format!("cannot read {}: {error}", path.display())))
}

pub fn write_text(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            Failure::new(format!("cannot create {}: {error}", parent.display()))
        })?;
    }
    std::fs::write(path, content)
        .map_err(|error| Failure::new(format!("cannot write {}: {error}", path.display())))
}

pub fn is_empty_dir(path: &Path) -> Result<bool> {
    let mut entries = std::fs::read_dir(path)
        .map_err(|error| Failure::new(format!("cannot read {}: {error}", path.display())))?;
    Ok(entries.next().is_none())
}

/// Recursively copy `source` into `target`, preserving permissions and links.
pub fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    std::fs::create_dir_all(target)
        .map_err(|error| Failure::new(format!("cannot create {}: {error}", target.display())))?;

    let mut entries: Vec<_> = std::fs::read_dir(source)
        .map_err(|error| Failure::new(format!("cannot read {}: {error}", source.display())))?
        .filter_map(|entry| entry.ok())
        .collect();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let from = entry.path();
        let to = target.join(entry.file_name());
        let metadata = std::fs::symlink_metadata(&from)
            .map_err(|error| Failure::new(format!("cannot stat {}: {error}", from.display())))?;
        if metadata.file_type().is_symlink() {
            copy_symlink(&from, &to)?;
        } else if metadata.is_dir() {
            copy_tree(&from, &to)?;
            std::fs::set_permissions(&to, metadata.permissions()).ok();
        } else {
            std::fs::copy(&from, &to).map_err(|error| {
                Failure::new(format!(
                    "cannot copy {} to {}: {error}",
                    from.display(),
                    to.display()
                ))
            })?;
            std::fs::set_permissions(&to, metadata.permissions()).ok();
        }
    }
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(from: &Path, to: &Path) -> Result<()> {
    let destination = std::fs::read_link(from)
        .map_err(|error| Failure::new(format!("cannot read link {}: {error}", from.display())))?;
    std::os::unix::fs::symlink(&destination, to)
        .map_err(|error| Failure::new(format!("cannot create symlink {}: {error}", to.display())))
}

#[cfg(not(unix))]
fn copy_symlink(from: &Path, to: &Path) -> Result<()> {
    std::fs::copy(from, to)
        .map(|_| ())
        .map_err(|error| Failure::new(format!("cannot copy {}: {error}", from.display())))
}
