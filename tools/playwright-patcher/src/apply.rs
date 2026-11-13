use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::document::Document;
use crate::failure::{Failure, Result};
use crate::metadata::{self, Marker};
use crate::patchfile::{Hunk, PatchFile};
use crate::sha256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedPatch {
    pub name: String,
    pub sha256: String,
    pub file: PatchFile,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    pub path: String,
    pub sha256_before: String,
    pub sha256_after: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub patches: Vec<LoadedPatch>,
    pub files: Vec<FileChange>,
    pub marker: Option<Marker>,
}

/// How a patch set is replayed into a package tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayConfig {
    /// Recorded in the package marker and in `CLOAKIUM-PATCHES.json`.
    pub patch_set: String,
    /// File that receives the `cloakium` marker; `None` disables the step.
    pub marker_file: Option<String>,
    /// Optional diagnostic bound; by default hunks are searched file-wide.
    pub max_offset: Option<usize>,
}

impl Default for ReplayConfig {
    fn default() -> Self {
        Self {
            patch_set: "playwright".to_string(),
            marker_file: Some("package.json".to_string()),
            max_offset: None,
        }
    }
}

/// Patches applied in lexicographic file-name order.
pub fn load_patches(patches_dir: &Path) -> Result<Vec<LoadedPatch>> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(patches_dir)
        .map_err(|error| {
            Failure::new(format!(
                "cannot read patch directory {}: {error}",
                patches_dir.display()
            ))
        })?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("patch"))
        .collect();
    entries.sort();

    if entries.is_empty() {
        crate::fail!("no '*.patch' files found in {}", patches_dir.display());
    }

    let mut patches = Vec::with_capacity(entries.len());
    for path in entries {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| Failure::new(format!("invalid patch file name {}", path.display())))?
            .to_string();
        let bytes = std::fs::read(&path)
            .map_err(|error| Failure::new(format!("cannot read {}: {error}", path.display())))?;
        let text = String::from_utf8(bytes.clone())
            .map_err(|_| Failure::new(format!("{} is not valid UTF-8", path.display())))?;
        let file = PatchFile::parse(&name, &text)?;
        patches.push(LoadedPatch {
            name,
            sha256: sha256::hex(&bytes),
            file,
        });
    }

    Ok(patches)
}

/// Apply every patch and the package marker in memory.
///
/// `read` resolves a repository-relative path (for example
/// `lib/coreBundle.js`) to its original text.
pub fn replay<F>(
    patches: &[LoadedPatch],
    mut read: F,
    config: &ReplayConfig,
) -> Result<(Report, BTreeMap<String, String>)>
where
    F: FnMut(&str) -> Result<String>,
{
    let mut documents: BTreeMap<String, Document> = BTreeMap::new();
    let mut original: BTreeMap<String, String> = BTreeMap::new();

    for patch in patches {
        let target = patch.file.target.clone();
        if !documents.contains_key(&target) {
            let source = read(&target)
                .map_err(|error| error.with_context(&format!("{} targets {target}", patch.name)))?;
            original.insert(target.clone(), source.clone());
            documents.insert(target.clone(), Document::parse(&source));
        }

        let document = documents
            .get_mut(&target)
            .ok_or_else(|| Failure::new(format!("internal: missing document for {target}")))?;

        let mut offset: isize = 0;
        let mut previous_end: Option<usize> = None;
        for (index, hunk) in patch.file.hunks.iter().enumerate() {
            if let Some(previous_end) = previous_end {
                if hunk.old_start < previous_end {
                    crate::fail!(
                        "{}: hunk {} overlaps the previous hunk in {target}",
                        patch.name,
                        index + 1
                    );
                }
            }
            previous_end = Some(hunk.old_start + hunk.old_len.max(1));
            offset = apply_hunk(document, &patch.name, index, hunk, offset, config.max_offset)?;
        }
    }

    let mut files: Vec<FileChange> = Vec::new();
    let mut contents: BTreeMap<String, String> = BTreeMap::new();
    for (path, document) in documents {
        let rendered = document.render();
        files.push(FileChange {
            sha256_before: sha256::hex(
                original
                    .get(&path)
                    .ok_or_else(|| Failure::new(format!("internal: missing digest for {path}")))?
                    .as_bytes(),
            ),
            sha256_after: sha256::hex(rendered.as_bytes()),
            path: path.clone(),
        });
        contents.insert(path, rendered);
    }

    let marker = if let Some(marker_file) = config.marker_file.as_deref() {
        let current = match contents.get(marker_file) {
            Some(text) => text.clone(),
            None => read(marker_file).map_err(|error| {
                error.with_context("cannot add the cloakium marker")
            })?,
        };
        let before_hash = match original.get(marker_file) {
            Some(text) => sha256::hex(text.as_bytes()),
            None => sha256::hex(current.as_bytes()),
        };
        let (rendered, marker) = metadata::expand(&current, marker_file, &config.patch_set)?;
        let after_hash = sha256::hex(rendered.as_bytes());
        match files.iter_mut().find(|file| file.path == marker_file) {
            Some(file) => file.sha256_after = after_hash,
            None => files.push(FileChange {
                path: marker_file.to_string(),
                sha256_before: before_hash,
                sha256_after: after_hash,
            }),
        }
        contents.insert(marker_file.to_string(), rendered);
        Some(marker)
    } else {
        None
    };

    files.sort_by(|left, right| left.path.cmp(&right.path));

    Ok((
        Report {
            patches: patches.to_vec(),
            files,
            marker,
        },
        contents,
    ))
}

fn apply_hunk(
    document: &mut Document,
    patch_name: &str,
    hunk_index: usize,
    hunk: &Hunk,
    offset: isize,
    max_offset: Option<usize>,
) -> Result<isize> {
    let old_lines = hunk.old_lines();
    if old_lines.is_empty() {
        crate::fail!(
            "{patch_name}: hunk {} has no source lines to anchor on",
            hunk_index + 1
        );
    }

    let expected = (hunk.old_start.saturating_sub(1) as isize + offset).max(0) as usize;
    let matches = find_matches(document, expected, &old_lines, max_offset);

    if matches.is_empty() {
        let new_lines = hunk.new_lines();
        let reversed = find_matches(document, 0, &new_lines, None);
        if !reversed.is_empty() {
            crate::fail!(
                "{patch_name}: hunk {} at line {} looks already applied or reversed (replacement text found at line {})",
                hunk_index + 1,
                hunk.old_start,
                reversed[0] + 1
            );
        }
        let unbounded = find_matches(document, expected, &old_lines, None);
        if !unbounded.is_empty() {
            crate::fail!(
                "{patch_name}: hunk {} matches at line {} but not within --max-offset {} of line {}",
                hunk_index + 1,
                unbounded[0] + 1,
                max_offset.unwrap_or(0),
                hunk.old_start
            );
        }
        let detail = first_difference(document, expected, &old_lines);
        crate::fail!(
            "{patch_name}: hunk {} no longer matches the target file ({detail})",
            hunk_index + 1
        );
    }

    if matches.len() > 1 {
        let positions: Vec<String> = matches.iter().take(5).map(|p| (p + 1).to_string()).collect();
        crate::fail!(
            "{patch_name}: hunk {} is ambiguous in the target file (matches at lines {})",
            hunk_index + 1,
            positions.join(", ")
        );
    }

    let position = matches[0];
    let new_lines = hunk.new_lines();
    document.remove_lines(position, old_lines.len());
    document.insert_lines(position, &new_lines);

    Ok(offset + (hunk.new_len as isize - hunk.old_len as isize))
}

/// Exact, fuzz-free matches for `block`.
///
/// By default the whole file is searched and exactly one match is required;
/// `max_offset` narrows that to a diagnostic window around `expected`.
fn find_matches(
    document: &Document,
    expected: usize,
    block: &[&str],
    max_offset: Option<usize>,
) -> Vec<usize> {
    let last = document.line_count();
    let (low, high) = match max_offset {
        Some(offset) => (
            expected.saturating_sub(offset),
            expected.saturating_add(offset).min(last),
        ),
        None => (0, last),
    };
    let mut matches = Vec::new();
    for position in low..=high {
        if block_matches(document, position, block) {
            matches.push(position);
        }
    }
    matches
}

fn block_matches(document: &Document, position: usize, expected: &[&str]) -> bool {
    if position + expected.len() > document.line_count() {
        return false;
    }
    expected
        .iter()
        .enumerate()
        .all(|(index, line)| document.line(position + index) == Some(*line))
}

/// Human readable first mismatch, used only to build the error message.
fn first_difference(document: &Document, expected_at: usize, expected: &[&str]) -> String {
    for (index, line) in expected.iter().enumerate() {
        let actual = document.line(expected_at + index);
        if actual != Some(*line) {
            let actual = actual.unwrap_or("<end of file>");
            return format!(
                "line {} expected {:?} but found {:?}",
                expected_at + index + 1,
                truncate(line),
                truncate(actual)
            );
        }
    }
    "no differing line found".to_string()
}

fn truncate(value: &str) -> String {
    let value = value.replace('\r', "");
    if value.chars().count() <= 90 {
        return value;
    }
    let truncated: String = value.chars().take(90).collect();
    format!("{truncated}...")
}