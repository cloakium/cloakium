//! Frontmatter, code fences and documentation token parsing.

use std::collections::{BTreeMap, BTreeSet};

const STOPWORDS: [&str; 12] = [
    "has", "is", "does", "was", "will", "and", "or", "the", "a", "an", "not", "no",
];

pub(crate) fn frontmatter(
    body: &str,
) -> Result<(BTreeMap<String, String>, BTreeMap<String, String>), String> {
    let mut lines = body.lines();
    match lines.next().map(str::trim) {
        Some("---") => {}
        _ => return Err("SKILL.md must start with YAML frontmatter".to_string()),
    }
    let mut top = BTreeMap::new();
    let mut nested = BTreeMap::new();
    let mut closed = false;
    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if indented {
            nested.insert(key.trim().to_string(), unquote(value));
        } else {
            top.insert(key.trim().to_string(), unquote(value));
        }
    }
    if !closed {
        return Err("frontmatter is not closed".to_string());
    }
    Ok((top, nested))
}

fn unquote(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string()
}

pub(crate) fn is_kebab(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        })
}

pub(crate) fn code_fences(body: &str) -> Vec<(String, Vec<String>)> {
    let mut fences = Vec::new();
    let mut current: Option<(String, Vec<String>)> = None;
    for line in body.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("```") {
            match current.take() {
                Some(fence) => fences.push(fence),
                None => current = Some((rest.trim().to_ascii_lowercase(), Vec::new())),
            }
        } else if let Some((_, lines)) = current.as_mut() {
            lines.push(line.to_string());
        }
    }
    fences
}

pub(crate) fn logical_lines(lines: &[String]) -> Vec<String> {
    let mut result = Vec::new();
    let mut buffer = String::new();
    for line in lines {
        if let Some(head) = line.strip_suffix('\\') {
            buffer.push_str(head);
            buffer.push(' ');
        } else {
            buffer.push_str(line);
            result.push(buffer.trim().to_string());
            buffer.clear();
        }
    }
    if !buffer.trim().is_empty() {
        result.push(buffer.trim().to_string());
    }
    result
}

pub(crate) fn first_command(line: &str) -> Option<&str> {
    let line = line.trim_start_matches("$ ").trim();
    for token in line.split_whitespace() {
        if token.starts_with('|') || token.starts_with("&&") || token == "\\" {
            return None;
        }
        if is_assignment(token) {
            if token.contains("$(") {
                return None;
            }
            continue;
        }
        if token.starts_with('"') || token.starts_with('\'') || token.starts_with('$') {
            return None;
        }
        return Some(token);
    }
    None
}

fn is_assignment(token: &str) -> bool {
    let Some((name, _)) = token.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

pub(crate) fn repo_path_token(token: &str) -> Option<String> {
    let cleaned = token.trim_matches(|ch: char| {
        matches!(
            ch,
            '`' | '"' | '\'' | ')' | '(' | ']' | '[' | ',' | '.' | ';' | ':' | '|'
        )
    });
    if crate::REPO_PREFIXES
        .iter()
        .any(|prefix| cleaned.starts_with(prefix))
    {
        Some(cleaned.to_string())
    } else {
        None
    }
}

pub(crate) fn mentions(text: &str, prefix: &str) -> Vec<String> {
    let mut found = BTreeSet::new();
    let mut rest = text;
    while let Some(index) = rest.find(prefix) {
        let tail = &rest[index + prefix.len()..];
        let end = tail
            .char_indices()
            .find(|(_, ch)| !(ch.is_ascii_lowercase() || ch.is_ascii_digit() || *ch == '-'))
            .map(|(index, _)| index)
            .unwrap_or(tail.len());
        let name = &tail[..end];
        if !name.is_empty() {
            found.insert(name.to_string());
        }
        rest = &tail[end..];
    }
    found.into_iter().collect()
}

/// Returns each plausible `(subcommand, flag)` invocation found in shell fences
/// and inline code spans, never from ordinary prose.
pub(crate) fn documented(body: &str, binary: &str) -> Vec<(Option<String>, Option<String>)> {
    let mut result = Vec::new();
    for (language, lines) in code_fences(body) {
        if !matches!(language.as_str(), "sh" | "shell" | "bash") {
            continue;
        }
        for line in logical_lines(&lines) {
            if let Some(invocation) = invocation(&line, binary) {
                result.push(invocation);
            }
        }
    }
    for (index, span) in body.split('`').enumerate() {
        if index % 2 == 1 {
            if let Some(invocation) = invocation(span, binary) {
                result.push(invocation);
            }
        }
    }
    result
}

fn invocation(text: &str, binary: &str) -> Option<(Option<String>, Option<String>)> {
    let start = text.find(binary)?;
    let before_ok = start == 0
        || text[..start]
            .chars()
            .last()
            .is_some_and(|ch| ch.is_whitespace());
    if !before_ok {
        return None;
    }
    let line_tail = text[start + binary.len()..]
        .split('\n')
        .next()
        .unwrap_or("");
    if line_tail.starts_with('-') && !line_tail.starts_with("--") {
        return None;
    }
    let mut command = None;
    let mut flag = None;
    for token in line_tail.split_whitespace().take(3) {
        let cleaned = token.trim_matches(|ch: char| {
            matches!(
                ch,
                '`' | '"' | '\'' | ')' | '(' | ']' | '[' | ',' | '.' | ';' | ':' | '|'
            )
        });
        if cleaned == "--" {
            continue;
        }
        if cleaned.starts_with("--") {
            flag = Some(cleaned.to_string());
            break;
        }
        if cleaned.is_empty()
            || cleaned.starts_with('{')
            || cleaned.starts_with('<')
            || STOPWORDS.contains(&cleaned)
        {
            continue;
        }
        command = Some(cleaned.to_string());
        break;
    }
    if command.is_none() && flag.is_none() {
        None
    } else {
        Some((command, flag))
    }
}
