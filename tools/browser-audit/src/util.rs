//! Small path and formatting helpers.

use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};

pub fn absolute(path: &Path) -> Result<PathBuf> {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .context("failed to read the current directory")?
            .join(path)
    };
    Ok(normalize(&joined))
}

pub fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

/// Plans carry normalized absolute paths so a run cannot be redirected by the
/// caller's working directory.
pub fn ensure_absolute(path: &str, field: &str) -> Result<()> {
    if path.is_empty() {
        bail!("{field} cannot be empty");
    }
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        bail!("{field} must be absolute: {path}");
    }
    if normalize(candidate) != candidate {
        bail!("{field} must not contain '.' or '..' components: {path}");
    }
    Ok(())
}

pub fn mode_string(bits: u32) -> String {
    format!("{bits:04o}")
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_paths_are_normalized() {
        assert_eq!(normalize(Path::new("/a/./b/../c")), PathBuf::from("/a/c"));
        assert!(ensure_absolute("/a/b", "path").is_ok());
        assert!(ensure_absolute("a/b", "path").is_err());
        assert!(ensure_absolute("/a/../b", "path").is_err());
    }
}
