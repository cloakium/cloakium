//! Read-only artifact and launcher inventory.
//!
//! An inventory proves what a path *is* before a run: a native Linux ELF
//! executable, its real path, its digest before and after inspection, and its
//! filesystem permission facts. Nothing here executes or opens the target for
//! data; a non-ELF or non-executable path is rejected before hashing so a
//! mistyped secret file is not silently digested.

use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::elf::{self, ElfMetadata};
use crate::hash;
use crate::model::{Identity, Layer, Plan, Target};
use crate::time;
use crate::util;

pub const INVENTORY_SCHEMA: &str = "cloakium.audit.inventory/1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SandboxFacts {
    pub filesystem_only: bool,
    pub setuid: bool,
    pub setgid: bool,
    pub world_writable: bool,
    pub runtime_exercised: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum FileKind {
    #[default]
    Elf,
    Script,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileIdentity {
    #[serde(default)]
    pub kind: FileKind,
    pub original_path: String,
    pub real_path: String,
    pub symlink: bool,
    pub sha256_before: String,
    pub sha256_after: String,
    pub unchanged: bool,
    pub size: u64,
    pub mode: String,
    pub mode_bits: u32,
    pub uid: u32,
    pub gid: u32,
    pub executable: bool,
    pub permissions: SandboxFacts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elf: Option<ElfMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InventoryRecord {
    pub id: String,
    pub label: String,
    pub artifact_path: String,
    pub executable_path: String,
    pub client_module: String,
    pub layer: Layer,
    pub identity: Identity,
    pub args: Vec<String>,
    pub headless_args: Vec<String>,
    pub headed_args: Vec<String>,
    pub artifact: FileIdentity,
    pub executable: FileIdentity,
    pub same_real_path: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InventoryBundle {
    pub schema: String,
    pub generated_at: String,
    pub targets: Vec<InventoryRecord>,
}

pub fn from_plan(plan: &Plan) -> Result<InventoryBundle> {
    let targets = plan
        .targets
        .iter()
        .map(inventory_target)
        .collect::<Result<Vec<_>>>()?;
    Ok(InventoryBundle {
        schema: INVENTORY_SCHEMA.to_string(),
        generated_at: time::now_rfc3339(),
        targets,
    })
}

pub fn inventory_target(target: &Target) -> Result<InventoryRecord> {
    let artifact = identify(&target.artifact_path, "artifactPath", false)?;
    let executable = identify(&target.executable_path, "executablePath", true)?;
    Ok(InventoryRecord {
        id: target.id.clone(),
        label: target.label.clone(),
        artifact_path: target.artifact_path.clone(),
        executable_path: target.executable_path.clone(),
        client_module: target.client_module.clone(),
        layer: target.layer,
        identity: target.identity,
        args: target.args.clone(),
        headless_args: target.headless_args.clone(),
        headed_args: target.headed_args.clone(),
        same_real_path: artifact.real_path == executable.real_path,
        artifact,
        executable,
    })
}

fn identify(path: &str, field: &str, launcher: bool) -> Result<FileIdentity> {
    util::ensure_absolute(path, field)?;
    let original = Path::new(path);
    let link = fs::symlink_metadata(original)
        .with_context(|| format!("{field} is not accessible: {path}"))?;
    if link.file_type().is_dir() {
        bail!("{field} must be a file, not a directory: {path}");
    }
    let symlink = link.file_type().is_symlink();
    let canonical = fs::canonicalize(original)
        .with_context(|| format!("{field} cannot be resolved: {path}"))?;
    let metadata = fs::metadata(&canonical)
        .with_context(|| format!("{field} metadata is unavailable: {path}"))?;
    if !metadata.is_file() {
        bail!("{field} must be a regular file: {path}");
    }
    if metadata.mode() & 0o111 == 0 {
        bail!("{field} is not executable; refusing to hash it: {path}");
    }

    // Classification happens before hashing. A trusted launcher may be the
    // current Nix bash wrapper; only its shebang and permission bits are read,
    // never its body or interpreter path.
    let elf_metadata = match elf::inspect(&canonical) {
        Ok(value) => {
            elf::ensure_native_linux(&canonical, &value)?;
            Some(value)
        }
        Err(error) => {
            if launcher && is_shebang(&canonical)? {
                None
            } else {
                return Err(error);
            }
        }
    };
    let kind = if elf_metadata.is_some() {
        FileKind::Elf
    } else {
        FileKind::Script
    };

    let sha256_before = hash::file(&canonical)?;
    let after_metadata = fs::metadata(&canonical)
        .with_context(|| format!("{field} metadata disappeared during inventory: {path}"))?;
    let elf_after = if kind == FileKind::Elf {
        Some(elf::inspect(&canonical)?)
    } else if is_shebang(&canonical)? {
        None
    } else {
        bail!("{field} stopped being an executable shebang script: {path}");
    };
    let sha256_after = hash::file(&canonical)?;
    if sha256_before != sha256_after
        || elf_metadata != elf_after
        || metadata.len() != after_metadata.len()
    {
        bail!("{field} changed while it was being inventoried: {path}");
    }

    let mode_bits = after_metadata.mode();
    Ok(FileIdentity {
        kind,
        original_path: path.to_string(),
        real_path: canonical.to_string_lossy().into_owned(),
        symlink,
        sha256_before,
        sha256_after: sha256_after.clone(),
        unchanged: true,
        size: after_metadata.len(),
        mode: util::mode_string(mode_bits & 0o7777),
        mode_bits: mode_bits & 0o7777,
        uid: after_metadata.uid(),
        gid: after_metadata.gid(),
        executable: mode_bits & 0o111 != 0,
        permissions: SandboxFacts {
            filesystem_only: true,
            setuid: mode_bits & 0o4000 != 0,
            setgid: mode_bits & 0o2000 != 0,
            world_writable: mode_bits & 0o002 != 0,
            runtime_exercised: false,
        },
        elf: elf_metadata,
    })
}

fn is_shebang(path: &Path) -> Result<bool> {
    use std::io::Read;
    let mut file =
        fs::File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut prefix = [0u8; 2];
    match file.read_exact(&mut prefix) {
        Ok(()) => Ok(&prefix == b"#!"),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(error) => Err(error).with_context(|| format!("failed to inspect {}", path.display())),
    }
}

pub fn verify_unchanged(record: &InventoryRecord) -> Result<()> {
    for identity in [&record.artifact, &record.executable] {
        let canonical = fs::canonicalize(&identity.original_path)
            .with_context(|| format!("target disappeared: {}", identity.original_path))?;
        if canonical.to_string_lossy() != identity.real_path {
            bail!(
                "target real path changed: {} -> {}",
                identity.real_path,
                canonical.display()
            );
        }
        let digest = hash::file(&canonical)?;
        if digest != identity.sha256_after {
            bail!(
                "target digest changed during the run: {}",
                identity.original_path
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn current_binary_inventories_as_native_elf() {
        let exe = std::env::current_exe().expect("exe");
        let identity = identify(&exe.to_string_lossy(), "artifactPath", false).expect("identify");
        assert!(identity.unchanged);
        assert!(identity.executable);
        assert_eq!(identity.sha256_before, identity.sha256_after);
        assert!(!identity.permissions.runtime_exercised);
    }

    #[test]
    fn non_elf_executable_is_rejected_before_hash() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("secret-like");
        std::fs::write(&path, b"not a binary").expect("write");
        std::fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("mode");
        let error = identify(&path.to_string_lossy(), "artifactPath", false)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not an ELF"), "{error}");
    }

    #[test]
    fn non_executable_elf_is_rejected() {
        let exe = std::env::current_exe().expect("exe");
        let directory = tempfile::tempdir().expect("tempdir");
        let copy = directory.path().join("copy");
        std::fs::copy(&exe, &copy).expect("copy");
        std::fs::set_permissions(&copy, fs::Permissions::from_mode(0o600)).expect("mode");
        let error = identify(&copy.to_string_lossy(), "artifactPath", false)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not executable"), "{error}");
    }
}

#[cfg(test)]
mod launcher_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn script(directory: &tempfile::TempDir, name: &str, body: &str, mode: u32) -> PathBuf {
        let path = directory.path().join(name);
        std::fs::write(&path, body).expect("write");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).expect("mode");
        path
    }

    #[test]
    fn native_artifact_accepts_a_trusted_script_launcher() {
        let directory = tempfile::tempdir().expect("tempdir");
        let exe = std::env::current_exe().expect("exe");
        let launcher = script(
            &directory,
            "launcher",
            "#!/nix/store/private-bash/bin/bash\nexec /private/real \"$@\"\n",
            0o755,
        );
        let target = Target {
            id: "subject".to_string(),
            label: "Subject".to_string(),
            artifact_path: exe.to_string_lossy().into_owned(),
            executable_path: launcher.to_string_lossy().into_owned(),
            client_module: "/client/index.js".to_string(),
            layer: Layer::Engine,
            identity: Identity::Native,
            args: Vec::new(),
            headless_args: Vec::new(),
            headed_args: Vec::new(),
        };
        let record = inventory_target(&target).expect("inventory");
        assert_eq!(record.artifact.kind, FileKind::Elf);
        assert!(record.artifact.elf.is_some());
        assert_eq!(record.executable.kind, FileKind::Script);
        assert!(record.executable.elf.is_none());
        assert_eq!(
            record.executable.sha256_before,
            record.executable.sha256_after
        );
        let rendered = serde_json::to_string(&record).expect("json");
        assert!(!rendered.contains("private-bash"));
        assert!(!rendered.contains("exec /private/real"));
    }

    #[test]
    fn a_script_artifact_is_refused() {
        let directory = tempfile::tempdir().expect("tempdir");
        let artifact = script(&directory, "artifact", "#!/bin/sh\nexit 0\n", 0o755);
        let error = identify(&artifact.to_string_lossy(), "artifactPath", false)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not an ELF"), "{error}");
    }

    #[test]
    fn a_private_mode_0600_file_is_refused_as_both_roles() {
        let directory = tempfile::tempdir().expect("tempdir");
        let file = script(&directory, "secret", "not a target\n", 0o600);
        for launcher in [false, true] {
            let error = identify(&file.to_string_lossy(), "target", launcher)
                .unwrap_err()
                .to_string();
            assert!(error.contains("not executable"), "{error}");
        }
    }

    #[test]
    fn an_executable_non_shebang_non_elf_file_is_refused() {
        let directory = tempfile::tempdir().expect("tempdir");
        let file = script(&directory, "opaque", "not a script", 0o755);
        assert!(identify(&file.to_string_lossy(), "executablePath", true).is_err());
    }
}
