//! Small shared helpers: JSON files, digests, path resolution, root discovery.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Directory that marks a Cloakium checkout.
const ROOT_MARKER: &str = "flake.nix";

pub fn read_json(path: &Path) -> Result<Value> {
    let text =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("failed to parse {}", path.display()))
}

pub fn write_json(path: &Path, value: &Value) -> Result<()> {
    let text = serde_json::to_string_pretty(value)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    fs::write(path, format!("{text}\n"))
        .with_context(|| format!("failed to write {}", path.display()))
}

/// Turn a possibly relative path into an absolute one without touching the
/// filesystem beyond the current directory query.
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

fn normalize(path: &Path) -> PathBuf {
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

/// Absolute flake reference for a checkout.
///
/// No `path:` prefix on purpose: Nix then resolves a colocated Git/JJ checkout
/// through the git fetcher, which copies tracked files only, so `target/`,
/// `node_modules/` and staged release artifacts never inflate the flake input.
/// A directory without `.git` still works, because Nix falls back to the path
/// fetcher on its own.
pub fn flake_reference(root: &Path) -> String {
    root.display().to_string()
}

/// Resolve the checkout root: an explicit `--root` wins, otherwise the nearest
/// ancestor of the working directory that contains a `flake.nix`.
pub fn resolve_root(explicit: Option<&Path>) -> Result<PathBuf> {
    let root = match explicit {
        Some(path) => {
            let candidate = absolute(path)?;
            if !candidate.join(ROOT_MARKER).is_file() {
                bail!(
                    "{} is not a Cloakium checkout: it has no {}",
                    candidate.display(),
                    ROOT_MARKER
                );
            }
            candidate
        }
        None => {
            let start = std::env::current_dir().context("failed to read the current directory")?;
            discover_root_from(&start)?
        }
    };
    Ok(root)
}

/// Search `start` and every ancestor for the checkout marker.
pub fn discover_root_from(start: &Path) -> Result<PathBuf> {
    let mut current = Some(start);
    while let Some(directory) = current {
        if directory.join(ROOT_MARKER).is_file() {
            return Ok(directory.to_path_buf());
        }
        current = directory.parent();
    }
    bail!(
        "could not find a Cloakium checkout: no {} in {} or any parent directory",
        ROOT_MARKER,
        start.display()
    )
}

/// Dotted numeric version with an allowed number of components.
pub fn is_numeric_version(value: &str, lengths: &[usize]) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    lengths.contains(&parts.len())
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

/// Leading numeric component of a dotted version.
pub fn version_major(value: &str) -> Option<u64> {
    value.split('.').next()?.parse().ok()
}

/// Informational major distance between the browser Playwright bundles and the
/// native browser Cloakium builds. Positive means the bundled major is newer.
///
/// This is deliberately **not** a compatibility verdict: whether a pair works is
/// decided by the real driver+native integration tests recorded in the
/// verification evidence, not by a version heuristic.
pub fn chromium_major_distance(native: &str, playwright_browser: &str) -> Option<i64> {
    let native = version_major(native)?;
    let bundled = version_major(playwright_browser)?;
    Some(bundled as i64 - native as i64)
}

/// Human-readable informational note, or `None` when the majors match.
pub fn chromium_distance_note(native: &str, playwright_browser: &str) -> Option<String> {
    let distance = chromium_major_distance(native, playwright_browser)?;
    if distance == 0 {
        return None;
    }
    Some(format!(
        "Playwright bundles Chromium {playwright_browser} while the native build is {native} \
         ({distance:+} major); this is informational only — support is decided by the recorded \
         driver+native integration evidence"
    ))
}

/// `sha256-<43 base64 characters>=`, the form `prefetch-npm-deps` and Nix
/// fixed-output derivations use.
pub fn is_sri_sha256(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("sha256-") else {
        return false;
    };
    if rest.len() != 44 || !rest.ends_with('=') {
        return false;
    }
    rest[..43]
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
}

/// Lowercase hex SHA-256 of a file, streamed so large assets stay in bounded
/// memory.
pub fn digest(path: &Path) -> Result<String> {
    let mut file =
        File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
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
    Ok(hex_encode(&hasher.finalize()))
}

pub fn hex_encode(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(char::from_digit((byte >> 4) as u32, 16).expect("nibble"));
        text.push(char::from_digit((byte & 0xf) as u32, 16).expect("nibble"));
    }
    text
}

/// Percent-encoding equivalent to Python's `urllib.parse.quote` with the
/// default safe set (`/`, letters, digits, `_.-~`).
pub fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'.' | b'-' | b'~');
        if keep {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(
                char::from_digit((byte >> 4) as u32, 16)
                    .unwrap()
                    .to_ascii_uppercase(),
            );
            encoded.push(
                char::from_digit((byte & 0xf) as u32, 16)
                    .unwrap()
                    .to_ascii_uppercase(),
            );
        }
    }
    encoded
}

/// POSIX-style path relative to `base`, used as a JSON map key.
pub fn relative_key(path: &Path, base: &Path) -> Result<String> {
    let relative = path
        .strip_prefix(base)
        .with_context(|| format!("{} is not inside {}", path.display(), base.display()))?;
    let parts: Vec<String> = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    Ok(parts.join("/"))
}

/// Every regular file below `directory` with the given extension, sorted.
pub fn files_with_extension(directory: &Path, extension: &str) -> Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    if !directory.exists() {
        return Ok(found);
    }
    let mut pending = vec![directory.to_path_buf()];
    while let Some(current) = pending.pop() {
        let entries = fs::read_dir(&current)
            .with_context(|| format!("failed to list {}", current.display()))?;
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() && path.extension() == Some(extension.as_ref()) {
                found.push(path);
            }
        }
    }
    found.sort();
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encoding_matches_python_quote() {
        assert_eq!(percent_encode("/home/user/key"), "/home/user/key");
        assert_eq!(
            percent_encode("/home/user/a b+key"),
            "/home/user/a%20b%2Bkey"
        );
        assert_eq!(percent_encode("k?x=1&y=2"), "k%3Fx%3D1%26y%3D2");
    }

    #[test]
    fn hex_encoding_is_lowercase() {
        assert_eq!(hex_encode(&[0x00, 0xab, 0xff]), "00abff");
    }

    #[test]
    fn digest_matches_known_sha256() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("hello");
        fs::write(&path, "hello\n").expect("write");
        assert_eq!(
            digest(&path).expect("digest"),
            "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
        );
    }

    #[test]
    fn normalization_removes_relative_segments() {
        assert_eq!(
            normalize(Path::new("/a/./b/../c/d")),
            PathBuf::from("/a/c/d")
        );
    }

    #[test]
    fn flake_references_are_bare_absolute_paths() {
        assert_eq!(
            flake_reference(Path::new("/work/cloakium")),
            "/work/cloakium"
        );
        assert!(!flake_reference(Path::new("/work/cloakium")).starts_with("path:"));
    }

    #[test]
    fn sri_sha256_hashes_are_validated() {
        let valid = format!("sha256-{}=", "A".repeat(43));
        assert!(is_sri_sha256(&valid));
        assert!(!is_sri_sha256(&valid.replace('=', "")));
        assert!(!is_sri_sha256("sha256-abc="));
        assert!(!is_sri_sha256("md5-abc"));
        assert!(!is_sri_sha256(""));
    }

    #[test]
    fn numeric_versions_are_bounded_by_component_count() {
        assert!(is_numeric_version("1.65.0", &[3]));
        assert!(!is_numeric_version("157.0.8103.50", &[3]));
        assert!(is_numeric_version("157.0.8103.50", &[3, 4]));
        assert!(!is_numeric_version("1.65.0-beta", &[3]));
        assert!(!is_numeric_version("", &[3]));
    }

    #[test]
    fn chromium_major_distance_is_informational() {
        assert_eq!(
            chromium_major_distance("157.0.8103.50", "159.0.8154.6"),
            Some(2)
        );
        assert_eq!(
            chromium_major_distance("157.0.8103.50", "158.0.8127.18"),
            Some(1)
        );
        assert_eq!(
            chromium_major_distance("158.0.8127.18", "158.0.8127.18"),
            Some(0)
        );
        assert_eq!(
            chromium_major_distance("159.0.8154.6", "157.0.8103.50"),
            Some(-2)
        );
        assert_eq!(chromium_major_distance("", "158.0.8127.18"), None);
        assert_eq!(
            chromium_major_distance("157.0.8103.50", "not-a-version"),
            None
        );
    }

    #[test]
    fn distance_notes_only_appear_when_majors_differ() {
        assert!(chromium_distance_note("157.0.8103.50", "157.0.8103.50").is_none());
        let note = chromium_distance_note("157.0.8103.50", "159.0.8154.6").expect("note");
        assert!(note.contains("informational only"), "{note}");
        assert!(note.contains("+2 major"), "{note}");
        assert!(chromium_distance_note("", "159.0.8154.6").is_none());
    }
}
