use super::*;
use serde_json::json;
use std::collections::BTreeSet;

#[test]
fn deep_diff_keeps_array_and_missing_paths() {
    let left = json!({"a": 1, "items": [1, 2], "nested": {"x": true}});
    let right = json!({"a": 2, "items": [1, 3], "nested": {}});
    let diffs = diff_values(&left, &right);
    let paths: BTreeSet<&str> = diffs.iter().map(|diff| diff.path.as_str()).collect();
    assert!(paths.contains("a"));
    assert!(paths.contains("items[1]"));
    assert!(paths.contains("nested.x"));
}

#[test]
fn dotted_paths_and_indices_resolve() {
    let value = json!({"a": {"b": [10, 20]}});
    assert_eq!(value_at_path(&value, "a.b[1]"), Some(&json!(20)));
    assert_eq!(value_at_path(&value, "a.missing"), None);
    assert_eq!(value_at_path(&value, "$"), Some(&value));
}
