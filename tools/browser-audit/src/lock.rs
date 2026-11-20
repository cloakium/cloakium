//! A kernel-held exclusive seat for the whole run.
//!
//! `flock` is released by the kernel when the process exits, so a crashed run
//! can never leave a stale PID that blocks the next one. The lock is not a
//! vendor seat; it only serializes this audit tool on one host.

use std::fs::{File, OpenOptions};
use std::os::raw::c_int;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

const LOCK_EX: c_int = 2;
const LOCK_NB: c_int = 4;

extern "C" {
    fn flock(file_descriptor: c_int, operation: c_int) -> c_int;
}

#[derive(Debug)]
pub struct AuditLock {
    file: File,
    path: PathBuf,
}

impl AuditLock {
    pub fn acquire(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            crate::storage::create_private_dir_all(parent)?;
        }
        if let Ok(metadata) = std::fs::symlink_metadata(path) {
            if metadata.file_type().is_symlink() {
                bail!("refusing a symlink lock path: {}", path.display());
            }
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("failed to open the audit lock {}", path.display()))?;
        let result = unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::WouldBlock {
                bail!(
                    "another audit run holds the exclusive seat at {}; no browser was launched",
                    path.display()
                );
            }
            return Err(error).with_context(|| format!("failed to lock {}", path.display()));
        }
        Ok(Self {
            file,
            path: path.to_path_buf(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn file(&self) -> &File {
        &self.file
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_open_cannot_take_the_same_seat() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("seat.lock");
        let first = AuditLock::acquire(&path).expect("first lock");
        let error = AuditLock::acquire(&path).unwrap_err().to_string();
        assert!(error.contains("exclusive seat"), "{error}");
        drop(first);
        AuditLock::acquire(&path).expect("lock is released on close");
    }
}
