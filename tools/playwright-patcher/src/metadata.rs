//! Derives the `cloakium` marker inside the packaged `package.json`.
//!
//! Nothing about the upstream release is baked into the patch set: the version,
//! package name and tarball URL are read from the package that is actually being
//! patched, so a Playwright bump only needs re-validation of the code hunks.

use serde_json::{Map, Value};

use crate::failure::{Failure, Result};

/// Values recorded in `CLOAKIUM-PATCHES.json` and in the package marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Marker {
    pub file: String,
    pub package: String,
    pub version: String,
    pub patch_set: String,
    pub source: String,
}

/// Insert (or replace) the `cloakium` object and return the new file contents.
pub fn expand(source: &str, file: &str, patch_set: &str) -> Result<(String, Marker)> {
    if patch_set.trim().is_empty() {
        crate::fail!("--patch-set must not be empty");
    }

    let mut value: Value = serde_json::from_str(source)
        .map_err(|error| Failure::new(format!("{file}: not valid JSON: {error}")))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| Failure::new(format!("{file}: expected a JSON object at the top level")))?;

    let package = require_string(object, file, "name")?;
    let version = require_string(object, file, "version")?;
    validate_package_name(file, &package)?;
    validate_version(file, &version)?;

    let source_url = tarball_url(&package, &version);
    let package_license = object
        .get("license")
        .and_then(Value::as_str)
        .map(str::to_string);

    let mut marker = Map::new();
    marker.insert("patched".to_string(), Value::Bool(true));
    marker.insert("version".to_string(), Value::String(version.clone()));
    marker.insert("upstream".to_string(), Value::String(version.clone()));
    marker.insert("patchSet".to_string(), Value::String(patch_set.to_string()));
    marker.insert("source".to_string(), Value::String(source_url.clone()));
    if let Some(license) = &package_license {
        marker.insert("license".to_string(), Value::String(license.clone()));
    }
    marker.insert("patches".to_string(), Value::String("MIT".to_string()));

    insert_after(object, "version", "cloakium", Value::Object(marker));

    let mut rendered = serde_json::to_string_pretty(&value)
        .map_err(|error| Failure::new(format!("{file}: cannot serialise JSON: {error}")))?;
    rendered.push('\n');

    Ok((
        rendered,
        Marker {
            file: file.to_string(),
            package,
            version,
            patch_set: patch_set.to_string(),
            source: source_url,
        },
    ))
}

fn require_string(object: &Map<String, Value>, file: &str, key: &str) -> Result<String> {
    match object.get(key) {
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(value.clone()),
        Some(_) => crate::fail!("{file}: field {key:?} must be a non-empty string"),
        None => crate::fail!("{file}: field {key:?} is missing"),
    }
}

fn validate_package_name(file: &str, name: &str) -> Result<()> {
    let valid = name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '@' | '/' | '-' | '_' | '.'));
    if !valid {
        crate::fail!("{file}: implausible package name {name:?}");
    }
    Ok(())
}

fn validate_version(file: &str, version: &str) -> Result<()> {
    let valid = version
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+'));
    let looks_like_semver = version.starts_with(|character: char| character.is_ascii_digit())
        && version.contains('.');
    if !valid || !looks_like_semver {
        crate::fail!("{file}: implausible package version {version:?}");
    }
    Ok(())
}

/// Canonical npm registry tarball URL for a package version.
pub fn tarball_url(package: &str, version: &str) -> String {
    let file_stem = package.rsplit('/').next().unwrap_or(package);
    format!("https://registry.npmjs.org/{package}/-/{file_stem}-{version}.tgz")
}

/// Keep the source order intact and place the marker right after `anchor`.
fn insert_after(object: &mut Map<String, Value>, anchor: &str, key: &str, value: Value) {
    let existing: Vec<(String, Value)> = std::mem::take(object).into_iter().collect();
    let mut rebuilt = Map::new();
    let mut inserted = false;
    for (name, entry) in existing {
        let is_anchor = name == anchor;
        if name == key {
            continue;
        }
        rebuilt.insert(name, entry);
        if is_anchor {
            rebuilt.insert(key.to_string(), value.clone());
            inserted = true;
        }
    }
    if !inserted {
        rebuilt.insert(key.to_string(), value);
    }
    *object = rebuilt;
}

#[cfg(test)]
mod tests {
    use super::{expand, tarball_url};

    const PACKAGE: &str = "{\n  \"name\": \"playwright-core\",\n  \"version\": \"1.66.0\",\n  \"license\": \"Apache-2.0\",\n  \"bin\": {\n    \"playwright-core\": \"cli.js\"\n  }\n}\n";

    #[test]
    fn derives_marker_from_the_package_being_patched() {
        let (rendered, marker) = expand(PACKAGE, "package.json", "playwright-1.66.0").expect("expand");
        let value: serde_json::Value = serde_json::from_str(&rendered).expect("valid json");
        let cloakium = value.get("cloakium").expect("marker").as_object().expect("object");

        assert_eq!(cloakium.get("patched"), Some(&serde_json::Value::Bool(true)));
        assert_eq!(cloakium.get("version"), Some(&serde_json::Value::String("1.66.0".into())));
        assert_eq!(cloakium.get("upstream"), Some(&serde_json::Value::String("1.66.0".into())));
        assert_eq!(cloakium.get("patchSet"), Some(&serde_json::Value::String("playwright-1.66.0".into())));
        assert_eq!(cloakium.get("license"), Some(&serde_json::Value::String("Apache-2.0".into())));
        assert_eq!(marker.version, "1.66.0");
        assert_eq!(marker.package, "playwright-core");
        assert_eq!(
            marker.source,
            "https://registry.npmjs.org/playwright-core/-/playwright-core-1.66.0.tgz"
        );
        assert!(!rendered.contains("1.65.0"), "must not leak a hardcoded release");
        // Key order: name, version, cloakium, license, bin
        let keys: Vec<&String> = value.as_object().expect("object").keys().collect();
        assert_eq!(keys, vec!["name", "version", "cloakium", "license", "bin"]);
    }

    #[test]
    fn scoped_packages_use_the_unscoped_tarball_name() {
        assert_eq!(
            tarball_url("@scope/pkg", "1.2.3"),
            "https://registry.npmjs.org/@scope/pkg/-/pkg-1.2.3.tgz"
        );
    }

    #[test]
    fn rejects_implausible_metadata() {
        let error = expand("{\"name\":\"playwright-core\"}", "package.json", "set").expect_err("missing version");
        assert!(error.message().contains("version"), "{error}");

        let error = expand("{\"name\":\"x\",\"version\":\"not a version\"}", "package.json", "set")
            .expect_err("bad version");
        assert!(error.message().contains("implausible"), "{error}");

        let error = expand("[]", "package.json", "set").expect_err("not an object");
        assert!(error.message().contains("JSON object"), "{error}");
    }
}