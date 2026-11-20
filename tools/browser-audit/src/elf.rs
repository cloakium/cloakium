//! Read-only ELF header inspection.
//!
//! Only the ELF ident, the file header and the program header table are read.
//! No section contents, strings, resources or executable code are inspected.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

const PT_INTERP: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ElfMetadata {
    pub class: String,
    pub endianness: String,
    pub os_abi: String,
    pub abi_version: u8,
    pub elf_type: String,
    pub machine: String,
    pub machine_code: u16,
    pub entry: u64,
    pub program_headers: u16,
    pub section_headers: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interpreter: Option<String>,
}

#[derive(Debug)]
enum Endian {
    Little,
    Big,
}

impl Endian {
    fn u16(&self, bytes: &[u8]) -> u16 {
        let pair = [bytes[0], bytes[1]];
        match self {
            Self::Little => u16::from_le_bytes(pair),
            Self::Big => u16::from_be_bytes(pair),
        }
    }

    fn u32(&self, bytes: &[u8]) -> u32 {
        let word = [bytes[0], bytes[1], bytes[2], bytes[3]];
        match self {
            Self::Little => u32::from_le_bytes(word),
            Self::Big => u32::from_be_bytes(word),
        }
    }

    fn u64(&self, bytes: &[u8]) -> u64 {
        let mut word = [0u8; 8];
        word.copy_from_slice(&bytes[..8]);
        match self {
            Self::Little => u64::from_le_bytes(word),
            Self::Big => u64::from_be_bytes(word),
        }
    }
}

pub fn inspect(path: &Path) -> Result<ElfMetadata> {
    let mut file =
        File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let size = file.metadata()?.len();
    if size < 4 {
        bail!(
            "{} is not an ELF file; refusing to hash a non-ELF target",
            path.display()
        );
    }
    let read_length = size.min(64) as usize;
    let mut ident = [0u8; 64];
    file.read_exact(&mut ident[..read_length])
        .with_context(|| format!("failed to read the ELF header of {}", path.display()))?;
    if &ident[..4] != b"\x7fELF" {
        bail!(
            "{} is not an ELF file; refusing to hash a non-ELF target",
            path.display()
        );
    }
    if size < 64 {
        bail!("{} has a truncated ELF header", path.display());
    }
    let class = match ident[4] {
        1 => 32,
        2 => 64,
        other => bail!("{} has unsupported ELF class {other}", path.display()),
    };
    let endian = match ident[5] {
        1 => Endian::Little,
        2 => Endian::Big,
        other => bail!(
            "{} has unsupported ELF data encoding {other}",
            path.display()
        ),
    };
    let os_abi_code = ident[7];
    let os_abi = match os_abi_code {
        0 => "system-v".to_string(),
        3 => "linux".to_string(),
        other => format!("other-{other}"),
    };
    let (elf_type_raw, machine_code, entry, phoff, phentsize, phnum, shnum) = match class {
        64 => (
            endian.u16(&ident[16..18]),
            endian.u16(&ident[18..20]),
            endian.u64(&ident[24..32]),
            endian.u64(&ident[32..40]),
            endian.u16(&ident[54..56]),
            endian.u16(&ident[56..58]),
            endian.u16(&ident[60..62]),
        ),
        _ => (
            endian.u16(&ident[16..18]),
            endian.u16(&ident[18..20]),
            endian.u32(&ident[24..28]) as u64,
            endian.u32(&ident[28..32]) as u64,
            endian.u16(&ident[42..44]),
            endian.u16(&ident[44..46]),
            endian.u16(&ident[48..50]),
        ),
    };

    // A PT_INTERP segment is only read to distinguish a PIE from a shared
    // object; the path itself is metadata, never executed.
    let mut interpreter = None;
    let expected = if class == 64 { 56 } else { 32 };
    if phnum > 0 && phentsize as usize == expected && phoff < size {
        for index in 0..phnum as u64 {
            let offset = phoff.saturating_add(index.saturating_mul(phentsize as u64));
            if offset.saturating_add(expected as u64) > size {
                break;
            }
            let mut header = [0u8; 56];
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(&mut header[..expected]).with_context(|| {
                format!("failed to read a program header of {}", path.display())
            })?;
            let kind = endian.u32(&header[0..4]);
            if kind != PT_INTERP {
                continue;
            }
            let (file_offset, file_size) = if class == 64 {
                (endian.u64(&header[8..16]), endian.u64(&header[32..40]))
            } else {
                (
                    endian.u32(&header[4..8]) as u64,
                    endian.u32(&header[16..20]) as u64,
                )
            };
            let length = file_size.min(4096) as usize;
            if length == 0 || file_offset.saturating_add(length as u64) > size {
                continue;
            }
            let mut raw = vec![0u8; length];
            file.seek(SeekFrom::Start(file_offset))?;
            file.read_exact(&mut raw)?;
            let end = raw.iter().position(|byte| *byte == 0).unwrap_or(raw.len());
            if end > 0 {
                interpreter = Some(String::from_utf8_lossy(&raw[..end]).into_owned());
            }
            break;
        }
    }

    let elf_type = match (elf_type_raw, interpreter.is_some()) {
        (2, _) => "executable".to_string(),
        (3, true) => "pie".to_string(),
        (3, false) => "shared-object".to_string(),
        (1, _) => "relocatable".to_string(),
        (4, _) => "core".to_string(),
        (other, _) => format!("unknown-{other}"),
    };

    Ok(ElfMetadata {
        class: if class == 64 { "ELF64" } else { "ELF32" }.to_string(),
        endianness: match endian {
            Endian::Little => "little",
            Endian::Big => "big",
        }
        .to_string(),
        os_abi,
        abi_version: ident[8],
        elf_type,
        machine: machine_name(machine_code).to_string(),
        machine_code,
        entry,
        program_headers: phnum,
        section_headers: shnum,
        interpreter,
    })
}

pub fn ensure_native_linux(path: &Path, metadata: &ElfMetadata) -> Result<()> {
    if metadata.os_abi != "system-v" && metadata.os_abi != "linux" {
        bail!(
            "{} uses ELF OS ABI {}; only native Linux ELF targets are supported",
            path.display(),
            metadata.os_abi
        );
    }
    if !matches!(metadata.elf_type.as_str(), "executable" | "pie") {
        bail!(
            "{} is an ELF {}; only an executable or PIE target is supported",
            path.display(),
            metadata.elf_type
        );
    }
    let expected = host_machine();
    if metadata.machine != expected {
        bail!(
            "{} targets {} but this host is {}; foreign-platform targets are unsupported, not absent",
            path.display(),
            metadata.machine,
            expected
        );
    }
    Ok(())
}

fn host_machine() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        "x86" => "x86",
        "arm" => "arm",
        "riscv64" => "riscv",
        "powerpc64" => "powerpc64",
        "s390x" => "s390x",
        other => other,
    }
}

fn machine_name(code: u16) -> &'static str {
    match code {
        3 => "x86",
        8 => "mips",
        20 => "powerpc",
        21 => "powerpc64",
        22 => "s390",
        40 => "arm",
        62 => "x86_64",
        183 => "aarch64",
        243 => "riscv",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_binary_is_native_elf() {
        let path = std::env::current_exe().expect("current exe");
        let metadata = inspect(&path).expect("inspect");
        assert_eq!(metadata.class, "ELF64");
        assert_eq!(metadata.machine, host_machine());
        assert!(metadata.program_headers > 0);
        ensure_native_linux(&path, &metadata).expect("native");
    }

    #[test]
    fn script_is_rejected_before_any_hash() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("script");
        std::fs::write(&path, b"#!/bin/sh\nexit 0\n").expect("write");
        let error = inspect(&path).unwrap_err().to_string();
        assert!(error.contains("not an ELF"), "{error}");
    }
}
