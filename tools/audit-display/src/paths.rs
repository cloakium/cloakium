//! Path safety: ancestry without symlinks, exclusive creation, and log files
//! that never follow a pre-seeded symlink.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

extern "C" {
    fn geteuid() -> u32;
}

pub fn euid() -> u32 {
    unsafe { geteuid() }
}

pub fn is_ours(meta: &fs::Metadata) -> bool {
    meta.uid() == euid()
}

/// Walk every component from `/`: no symlinks, no `..`, existing components must
/// be directories, missing ones are created `0700`. The leaf must be a `0700`
/// directory owned by this uid.
pub fn ensure_dir(root: &Path) -> Result<(), String> {
    if !root.is_absolute() {
        return Err(format!("state dir must be absolute: {}", root.display()));
    }
    let mut cur = PathBuf::from("/");
    for comp in root.components() {
        match comp {
            Component::RootDir | Component::Prefix(_) | Component::CurDir => continue,
            Component::ParentDir => {
                return Err(format!(
                    "state dir must not contain '..': {}",
                    root.display()
                ))
            }
            Component::Normal(name) => {
                cur.push(name);
                match fs::symlink_metadata(&cur) {
                    Ok(meta) => {
                        if meta.file_type().is_symlink() {
                            return Err(format!("path component is a symlink: {}", cur.display()));
                        }
                        if !meta.is_dir() {
                            return Err(format!(
                                "path component is not a directory: {}",
                                cur.display()
                            ));
                        }
                        if cur == root {
                            if !is_ours(&meta) {
                                return Err(format!(
                                    "state dir is not owned by uid {}: {}",
                                    euid(),
                                    cur.display()
                                ));
                            }
                            let mode = meta.permissions().mode() & 0o777;
                            if mode != 0o700 {
                                return Err(format!(
                                    "state dir mode is {:04o}, expected 0700: {}",
                                    mode,
                                    cur.display()
                                ));
                            }
                        }
                    }
                    Err(_) => {
                        fs::create_dir(&cur).map_err(|e| format!("{}: {}", cur.display(), e))?;
                        fs::set_permissions(&cur, fs::Permissions::from_mode(0o700))
                            .map_err(|e| format!("{}: {}", cur.display(), e))?;
                    }
                }
            }
        }
    }
    Ok(())
}

/// Create (or accept) a leaf directory we own, refusing symlinks.
pub fn private_dir(p: &Path) -> Result<(), String> {
    match fs::symlink_metadata(p) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(format!("directory path is a symlink: {}", p.display()));
            }
            if !meta.is_dir() {
                return Err(format!("not a directory: {}", p.display()));
            }
            if !is_ours(&meta) {
                return Err(format!("not owned by this uid: {}", p.display()));
            }
            let mode = meta.permissions().mode() & 0o777;
            if mode != 0o700 {
                return Err(format!(
                    "mode is {:04o}, expected 0700: {}",
                    mode,
                    p.display()
                ));
            }
            Ok(())
        }
        Err(_) => {
            fs::create_dir(p).map_err(|e| format!("{}: {}", p.display(), e))?;
            fs::set_permissions(p, fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("{}: {}", p.display(), e))
        }
    }
}

/// `O_CREAT|O_EXCL`: never follows a symlink, never truncates an existing file.
pub(crate) fn open_exclusive(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| match e.kind() {
            io::ErrorKind::AlreadyExists => {
                format!("refusing to overwrite an existing path: {}", path.display())
            }
            _ => format!("{}: {}", path.display(), e),
        })
}

/// Replace one of our own regular files before recreating it. A symlink or a
/// foreign file at the path is refused rather than followed or unlinked.
pub(crate) fn clear_stale(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(format!("path is a symlink: {}", path.display()));
            }
            if !meta.is_file() || !is_ours(&meta) {
                return Err(format!("path is not our regular file: {}", path.display()));
            }
            fs::remove_file(path).map_err(|e| format!("{}: {}", path.display(), e))
        }
        Err(_) => Ok(()),
    }
}

/// Fresh log file: clear our own previous log, create exclusively.
pub fn open_log(path: &Path) -> io::Result<File> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("log path is a symlink: {}", path.display()),
            ));
        }
        if !meta.is_file() || !is_ours(&meta) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("log path is not our regular file: {}", path.display()),
            ));
        }
        fs::remove_file(path)?;
    }
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

/// Per-process, per-call nonce for temporary names.
pub(crate) fn nonce() -> String {
    let mut bytes = [0u8; 8];
    let ok = File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .is_ok();
    if !ok {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        bytes = (t ^ ((std::process::id() as u64) << 32)).to_le_bytes();
    }
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}
