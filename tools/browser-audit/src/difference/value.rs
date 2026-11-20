//! Deep JSON value comparison and dotted-path resolution.

use std::collections::BTreeSet;

use serde_json::Value;

use super::ValueDiff;

pub fn diff_values(baseline: &Value, candidate: &Value) -> Vec<ValueDiff> {
    let mut differences = Vec::new();
    diff_at("", Some(baseline), Some(candidate), &mut differences);
    differences
}

fn diff_at(
    path: &str,
    baseline: Option<&Value>,
    candidate: Option<&Value>,
    out: &mut Vec<ValueDiff>,
) {
    match (baseline, candidate) {
        (None, None) => {}
        (Some(Value::Object(left)), Some(Value::Object(right))) => {
            let keys: BTreeSet<&String> = left.keys().chain(right.keys()).collect();
            for key in keys {
                let child = join_key(path, key);
                diff_at(&child, left.get(key), right.get(key), out);
            }
        }
        (Some(Value::Array(left)), Some(Value::Array(right))) => {
            let length = left.len().max(right.len());
            for index in 0..length {
                let child = format!("{path}[{index}]");
                diff_at(&child, left.get(index), right.get(index), out);
            }
        }
        (Some(left), Some(right)) if left == right => {}
        (left, right) => out.push(ValueDiff {
            path: if path.is_empty() {
                "$".to_string()
            } else {
                path.to_string()
            },
            baseline: left.cloned(),
            candidate: right.cloned(),
        }),
    }
}

fn join_key(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

/// Resolve a dotted path with optional `[index]` array selectors.
pub fn value_at_path<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = root;
    for segment in split_path(path)? {
        match segment {
            Segment::Key(key) => current = current.get(key)?,
            Segment::Index(index) => current = current.get(index)?,
        }
    }
    Some(current)
}

#[derive(Debug)]
enum Segment<'a> {
    Key(&'a str),
    Index(usize),
}

fn split_path(path: &str) -> Option<Vec<Segment<'_>>> {
    if path.is_empty() || path == "$" {
        return Some(Vec::new());
    }
    let mut segments = Vec::new();
    for part in path.split('.') {
        if part.is_empty() {
            return None;
        }
        if let Some(open) = part.find('[') {
            let key = &part[..open];
            if !key.is_empty() {
                segments.push(Segment::Key(key));
            }
            let rest = &part[open..];
            let mut rest = rest;
            while let Some(value) = rest.strip_prefix('[') {
                let close = value.find(']')?;
                let index = value[..close].parse().ok()?;
                segments.push(Segment::Index(index));
                rest = &value[close + 1..];
                if rest.is_empty() {
                    break;
                }
                if !rest.starts_with('[') {
                    return None;
                }
            }
        } else {
            segments.push(Segment::Key(part));
        }
    }
    Some(segments)
}
