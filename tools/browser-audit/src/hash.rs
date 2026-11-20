//! SHA-256 helpers. Digests are lowercase hex, never truncated.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

pub fn bytes(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    encode(&hasher.finalize())
}

pub fn file(path: &Path) -> Result<String> {
    let mut file = File::open(path)
        .with_context(|| format!("failed to open {} for hashing", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("failed to read {}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(encode(&hasher.finalize()))
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn encode(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(char::from_digit((byte >> 4) as u32, 16).expect("nibble"));
        text.push(char::from_digit((byte & 0xf) as u32, 16).expect("nibble"));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn known_vector() {
        assert_eq!(
            bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn files_hash_like_bytes() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("input");
        std::fs::File::create(&path)
            .expect("create")
            .write_all(b"abc")
            .expect("write");
        assert_eq!(file(&path).expect("hash"), bytes(b"abc"));
    }

    #[test]
    fn digest_shape_is_enforced() {
        assert!(is_sha256(&"a".repeat(64)));
        assert!(!is_sha256(&"A".repeat(64)));
        assert!(!is_sha256("abc"));
    }
}
