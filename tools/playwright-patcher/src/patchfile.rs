use crate::failure::{Failure, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Context,
    Remove,
    Add,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HunkLine {
    pub kind: LineKind,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    pub old_start: usize,
    pub old_len: usize,
    pub new_start: usize,
    pub new_len: usize,
    pub lines: Vec<HunkLine>,
}

impl Hunk {
    /// Lines that must already exist in the source document, in order.
    pub fn old_lines(&self) -> Vec<&str> {
        self.lines
            .iter()
            .filter(|line| line.kind != LineKind::Add)
            .map(|line| line.text.as_str())
            .collect()
    }

    /// Lines that replace `old_lines` in the destination document.
    pub fn new_lines(&self) -> Vec<&str> {
        self.lines
            .iter()
            .filter(|line| line.kind != LineKind::Remove)
            .map(|line| line.text.as_str())
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchFile {
    pub name: String,
    pub target: String,
    pub hunks: Vec<Hunk>,
}

impl PatchFile {
    pub fn parse(name: &str, content: &str) -> Result<Self> {
        let lines: Vec<&str> = content.split('\n').collect();
        let mut index = 0usize;
        let mut target: Option<String> = None;
        let mut hunks = Vec::new();

        while index < lines.len() {
            let line = lines[index];

            if line.starts_with("--- ") {
                let old = strip_prefix_path(line, "--- ")?;
                index += 1;
                let new_line = lines
                    .get(index)
                    .ok_or_else(|| Failure::new(format!("{name}: missing +++ header after --- ")))?;
                if !new_line.starts_with("+++ ") {
                    crate::fail!("{name}: expected '+++ ' header, found {:?}", truncate(new_line));
                }
                let new = strip_prefix_path(new_line, "+++ ")?;
                if target.is_some() {
                    crate::fail!("{name}: multiple file headers are not supported");
                }
                if basename(old) != basename(new) {
                    crate::fail!(
                        "{name}: source and destination file names differ ({:?} vs {:?})",
                        old,
                        new
                    );
                }
                target = Some(join_patch_path(old, new));
                index += 1;
                continue;
            }

            if line.starts_with("@@") {
                if target.is_none() {
                    crate::fail!("{name}: hunk before file header");
                }
                let (hunk, next) = parse_hunk(name, &lines, index)?;
                hunks.push(hunk);
                index = next;
                continue;
            }

            if line.starts_with("\\ No newline") {
                crate::fail!(
                    "{name}: 'no newline at end of file' markers are not supported by this tool"
                );
            }

            // Tolerate blank trailing line produced by the final newline.
            if line.is_empty() {
                index += 1;
                continue;
            }

            crate::fail!("{name}: unexpected line {}: {:?}", index + 1, truncate(line));
        }

        let target = target
            .ok_or_else(|| Failure::new(format!("{name}: no '--- ' / '+++ ' file header found")))?;
        if hunks.is_empty() {
            crate::fail!("{name}: no hunks found");
        }

        Ok(Self {
            name: name.to_string(),
            target,
            hunks,
        })
    }
}

fn parse_hunk(name: &str, lines: &[&str], start: usize) -> Result<(Hunk, usize)> {
    let header = lines[start];
    let (old_start, old_len, new_start, new_len) = parse_hunk_header(name, header)?;
    let mut index = start + 1;
    let mut collected: Vec<HunkLine> = Vec::new();
    let mut consumed_old = 0usize;
    let mut consumed_new = 0usize;

    while index < lines.len() && (consumed_old < old_len || consumed_new < new_len) {
        let line = lines[index];
        if line.is_empty() {
            // Trailing newline artifact: the hunk body ended early.
            break;
        }
        if line.starts_with("\\ No newline") {
            crate::fail!(
                "{name}: 'no newline at end of file' markers are not supported by this tool"
            );
        }
        let mut chars = line.chars();
        let marker = chars.next();
        let text = chars.as_str().to_string();
        let kind = match marker {
            Some(' ') => LineKind::Context,
            Some('-') => LineKind::Remove,
            Some('+') => LineKind::Add,
            _ => crate::fail!(
                "{name}: hunk at line {} has invalid line {:?}",
                start + 1,
                truncate(line)
            ),
        };
        match kind {
            LineKind::Context => {
                consumed_old += 1;
                consumed_new += 1;
            }
            LineKind::Remove => consumed_old += 1,
            LineKind::Add => consumed_new += 1,
        }
        if consumed_old > old_len || consumed_new > new_len {
            crate::fail!("{name}: hunk at line {} exceeds its declared size", start + 1);
        }
        collected.push(HunkLine { kind, text });
        index += 1;
    }

    if consumed_old != old_len || consumed_new != new_len {
        crate::fail!(
            "{name}: hunk at line {} is truncated (expected -{old_len}/+{new_len}, got -{consumed_old}/+{consumed_new})",
            start + 1
        );
    }

    Ok((
        Hunk {
            old_start,
            old_len,
            new_start,
            new_len,
            lines: collected,
        },
        index,
    ))
}

fn parse_hunk_header(name: &str, header: &str) -> Result<(usize, usize, usize, usize)> {
    // "@@ -12,7 +12,9 @@ optional section heading"
    let rest = header
        .strip_prefix("@@ ")
        .ok_or_else(|| Failure::new(format!("{name}: malformed hunk header {:?}", truncate(header))))?;
    let end = rest
        .find(" @@")
        .ok_or_else(|| Failure::new(format!("{name}: malformed hunk header {:?}", truncate(header))))?;
    let ranges = &rest[..end];
    let mut parts = ranges.split(' ');
    let old = parts
        .next()
        .ok_or_else(|| Failure::new(format!("{name}: malformed hunk header {:?}", truncate(header))))?;
    let new = parts
        .next()
        .ok_or_else(|| Failure::new(format!("{name}: malformed hunk header {:?}", truncate(header))))?;
    if parts.next().is_some() {
        crate::fail!("{name}: malformed hunk header {:?}", truncate(header));
    }
    let (old_start, old_len) = parse_range(name, old, '-')?;
    let (new_start, new_len) = parse_range(name, new, '+')?;
    Ok((old_start, old_len, new_start, new_len))
}

fn parse_range(name: &str, value: &str, sign: char) -> Result<(usize, usize)> {
    let body = value.strip_prefix(sign).ok_or_else(|| {
        Failure::new(format!("{name}: hunk range {value:?} is missing its {sign} prefix"))
    })?;
    let (start, len) = match body.split_once(',') {
        Some((start, len)) => (start, len),
        None => (body, "1"),
    };
    let start: usize = start
        .parse()
        .map_err(|_| Failure::new(format!("{name}: invalid hunk start {start:?}")))?;
    let len: usize = len
        .parse()
        .map_err(|_| Failure::new(format!("{name}: invalid hunk length {len:?}")))?;
    // A zero-length range still carries a meaningful insertion point.
    let start = if start == 0 && len == 0 { 1 } else { start };
    Ok((start, len))
}

fn strip_prefix_path<'a>(line: &'a str, prefix: &str) -> Result<&'a str> {
    let path = line[prefix.len()..].trim_end();
    let path = path.split('\t').next().unwrap_or(path).trim();
    if path.is_empty() {
        crate::fail!("empty path in header {line:?}");
    }
    Ok(path)
}

/// `a/lib/coreBundle.js` + `b/lib/coreBundle.js` -> `lib/coreBundle.js`.
fn join_patch_path(old: &str, new: &str) -> String {
    if old == "/dev/null" {
        return new.to_string();
    }
    old.strip_prefix("a/")
        .or_else(|| old.strip_prefix("b/"))
        .unwrap_or(old)
        .to_string()
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn truncate(value: &str) -> String {
    if value.chars().count() <= 120 {
        return value.to_string();
    }
    let truncated: String = value.chars().take(120).collect();
    format!("{truncated}...")
}

#[cfg(test)]
mod tests {
    use super::{LineKind, PatchFile};

    #[test]
    fn parses_a_simple_patch() {
        let text = "\
--- a/lib/x.js
+++ b/lib/x.js
@@ -2,3 +2,4 @@
 two
-three
+THREE
+extra
 four
";
        let patch = PatchFile::parse("p.patch", text).expect("parse");
        assert_eq!(patch.target, "lib/x.js");
        assert_eq!(patch.hunks.len(), 1);
        let hunk = &patch.hunks[0];
        assert_eq!((hunk.old_start, hunk.old_len, hunk.new_start, hunk.new_len), (2, 3, 2, 4));
        assert_eq!(hunk.old_lines(), vec!["two", "three", "four"]);
        assert_eq!(hunk.new_lines(), vec!["two", "THREE", "extra", "four"]);
        assert_eq!(hunk.lines[0].kind, LineKind::Context);
        assert_eq!(hunk.lines[1].kind, LineKind::Remove);
        assert_eq!(hunk.lines[2].kind, LineKind::Add);
    }

    #[test]
    fn rejects_no_newline_markers() {
        let text = "\
--- a/x
+++ b/x
@@ -1 +1 @@
-a
+b
\\ No newline at end of file
";
        let error = PatchFile::parse("p.patch", text).expect_err("must reject");
        assert!(error.message().contains("no newline"), "{error}");
    }

    #[test]
    fn rejects_truncated_hunk() {
        let text = "\
--- a/x
+++ b/x
@@ -1,3 +1,3 @@
 a
-b
+c
";
        let error = PatchFile::parse("p.patch", text).expect_err("must reject");
        assert!(error.message().contains("truncated"), "{error}");
    }

    #[test]
    fn rejects_mismatched_targets() {
        let text = "\
--- a/one.js
+++ b/two.js
@@ -1 +1 @@
-a
+b
";
        let error = PatchFile::parse("p.patch", text).expect_err("must reject");
        assert!(error.message().contains("differ"), "{error}");
    }
}
