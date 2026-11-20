//! Private evidence storage: owner-only directories, 0600 files, atomic writes.
//!
//! Outputs are not allowed to follow a symlink or replace a non-regular file.
//! Existing files require an explicit `force` and are replaced atomically.

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;

pub fn state_root() -> Result<PathBuf> {
    if let Some(value) = std::env::var_os("XDG_STATE_HOME") {
        let path = PathBuf::from(value);
        if path.is_absolute() {
            return Ok(path.join("cloakium-audit"));
        }
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME or XDG_STATE_HOME is required for the default private state directory")?;
    if !home.is_absolute() {
        bail!("HOME must be absolute");
    }
    Ok(home.join(".local/state/cloakium-audit"))
}

pub fn default_run_dir(run_id: &str) -> Result<PathBuf> {
    Ok(state_root()?.join("runs").join(run_id))
}

pub fn default_lock_path() -> Result<PathBuf> {
    if let Some(value) = std::env::var_os("XDG_RUNTIME_DIR") {
        let path = PathBuf::from(value);
        if path.is_absolute() {
            return Ok(path.join("cloakium-audit/seat.lock"));
        }
    }
    Ok(state_root()?.join("seat.lock"))
}

pub fn create_private_dir_all(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        bail!(
            "private output directory must be absolute: {}",
            path.display()
        );
    }
    let mut current = PathBuf::from("/");
    for component in path.components().skip(1) {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    bail!(
                        "refusing a symlink in the private output path: {}",
                        current.display()
                    );
                }
                if !metadata.is_dir() {
                    bail!("{} is not a directory", current.display());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut builder = DirBuilder::new();
                builder.mode(0o700);
                builder
                    .create(&current)
                    .with_context(|| format!("failed to create {}", current.display()))?;
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to inspect {}", current.display()));
            }
        }
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("failed to set owner-only mode on {}", path.display()))?;
    Ok(())
}

pub fn ensure_fresh_dir(path: &Path, force: bool) -> Result<()> {
    if !path.is_absolute() {
        bail!("--output must be absolute: {}", path.display());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                bail!("refusing a symlink output directory: {}", path.display());
            }
            if !metadata.is_dir() {
                bail!("{} is not a directory", path.display());
            }
            let mut entries =
                fs::read_dir(path).with_context(|| format!("failed to read {}", path.display()))?;
            if entries.next().is_some() {
                bail!(
                    "output directory is not empty: {}; use a fresh directory",
                    path.display()
                );
            }
            if force {
                fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                    .with_context(|| format!("failed to secure {}", path.display()))?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            create_private_dir_all(path)?;
        }
        Err(error) => {
            return Err(error).with_context(|| format!("failed to inspect {}", path.display()));
        }
    }
    Ok(())
}

pub fn write_private(path: &Path, bytes: &[u8], force: bool) -> Result<()> {
    if let Some(parent) = path.parent() {
        create_private_dir_all(parent)?;
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                bail!("refusing to overwrite a symlink: {}", path.display());
            }
            if !metadata.is_file() {
                bail!(
                    "refusing to overwrite a non-regular file: {}",
                    path.display()
                );
            }
            if !force {
                bail!(
                    "{} already exists; pass --force to replace it",
                    path.display()
                );
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| format!("failed to inspect {}", path.display()));
        }
    }
    let parent = path
        .parent()
        .context("an output file needs a parent directory")?;
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .context("an output file needs a name")?;
    let temporary = parent.join(format!(
        ".{name}.tmp-{}-{}",
        std::process::id(),
        crate::time::unix_millis()
    ));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .with_context(|| format!("failed to create {}", temporary.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("failed to write {}", temporary.display()))?;
        file.flush()?;
        file.sync_all()?;
        fs::rename(&temporary, path)
            .with_context(|| format!("failed to install {}", path.display()))?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn write_private_json<T: Serialize>(path: &Path, value: &T, force: bool) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    write_private(path, &bytes, force)
}

pub fn freeze(path: &Path) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o400))
        .with_context(|| format!("failed to make {} read-only", path.display()))?;
    Ok(())
}

pub fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).with_context(|| format!("failed to read {}", path.display()))
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = read_bytes(path)?;
    serde_json::from_slice(&bytes)
        .with_context(|| format!("failed to parse {} as JSON", path.display()))
}

pub fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

pub fn create_empty_file(path: &Path) -> Result<File> {
    if let Some(parent) = path.parent() {
        create_private_dir_all(parent)?;
    }
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("failed to create {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    #[test]
    fn private_directories_and_files_are_owner_only() {
        let directory = tempfile::tempdir().expect("tempdir");
        let output = directory.path().join("a/b");
        create_private_dir_all(&output).expect("dirs");
        assert_eq!(
            fs::metadata(&output).expect("metadata").mode() & 0o777,
            0o700
        );
        let path = output.join("report.json");
        write_private_json(&path, &serde_json::json!({"ok": true}), false).expect("write");
        assert_eq!(fs::metadata(&path).expect("metadata").mode() & 0o777, 0o600);
        freeze(&path).expect("freeze");
        assert_eq!(fs::metadata(&path).expect("metadata").mode() & 0o777, 0o400);
    }

    #[test]
    fn existing_files_need_force_and_symlinks_are_rejected() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("file");
        write_private(&path, b"one", false).expect("write");
        assert!(write_private(&path, b"two", false).is_err());
        write_private(&path, b"two", true).expect("force");
        assert_eq!(fs::read(&path).expect("read"), b"two");

        let link = directory.path().join("link");
        std::os::unix::fs::symlink(&path, &link).expect("symlink");
        let error = write_private(&link, b"three", true)
            .unwrap_err()
            .to_string();
        assert!(error.contains("symlink"), "{error}");
    }

    #[test]
    fn non_empty_output_directory_is_rejected() {
        let directory = tempfile::tempdir().expect("tempdir");
        let output = directory.path().join("out");
        create_private_dir_all(&output).expect("dir");
        write_private(&output.join("existing"), b"x", false).expect("write");
        let error = ensure_fresh_dir(&output, true).unwrap_err().to_string();
        assert!(error.contains("not empty"), "{error}");
    }
}
