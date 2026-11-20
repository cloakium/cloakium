//! Resolve declared environment labels into filesystem and host provenance.
//!
//! No arbitrary environment variables are read or recorded. The only values in
//! the result are the declared locale, timezone and file paths, plus facts read
//! from `/etc/os-release`, `/proc/sys/kernel/osrelease` and `stat`.

use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};

use crate::hash;
use crate::model::{DisplayKind, EnvironmentSpec};
use crate::report::{
    DisplayFacts, EnvironmentPolicy, FontconfigFacts, LocaleFacts, OsFacts, ResolvedEnvironment,
    ResolvedFacts, TimezoneFacts,
};
use crate::util;

pub fn resolve(spec: &EnvironmentSpec) -> Result<ResolvedEnvironment> {
    if spec.timezone_id.is_empty()
        || spec.timezone_id.starts_with('/')
        || spec.timezone_id.split('/').any(|part| part == "..")
    {
        bail!(
            "timezoneId is not a safe IANA zone name: {}",
            spec.timezone_id
        );
    }
    let zoneinfo = PathBuf::from("/usr/share/zoneinfo").join(&spec.timezone_id);
    let zoneinfo_exists = zoneinfo.is_file();
    let timezone = TimezoneFacts {
        id: spec.timezone_id.clone(),
        zoneinfo_path: zoneinfo.to_string_lossy().into_owned(),
        exists: zoneinfo_exists,
    };

    let fontconfig = match &spec.fontconfig_file {
        Some(file) => Some(resolve_fontconfig(
            file,
            spec.fontconfig_path.as_deref(),
            spec.font_manifest_sha256.as_deref(),
        )?),
        None => None,
    };

    let display = resolve_display(&spec.display)?;
    let mut applied = BTreeSet::new();
    for key in [
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "TMPDIR",
        "TZ",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_RUNTIME_DIR",
    ] {
        applied.insert(key.to_string());
    }
    if spec.fontconfig_file.is_some() {
        applied.insert("FONTCONFIG_FILE".to_string());
    }
    // Rust never sets DISPLAY/XAUTHORITY: the selected display helper resolves
    // headed placeholders in the runner's own child environment.
    let display_keys: Vec<String> = Vec::new();

    Ok(ResolvedEnvironment {
        id: spec.id.clone(),
        locale: spec.locale.clone(),
        timezone_id: spec.timezone_id.clone(),
        fontconfig_file: spec.fontconfig_file.clone(),
        fontconfig_path: spec.fontconfig_path.clone(),
        font_manifest_sha256: spec.font_manifest_sha256.clone(),
        display: spec.display.clone(),
        notes: spec.notes.clone(),
        resolved: ResolvedFacts {
            os: resolve_os(),
            timezone,
            fontconfig,
            display,
            locale: LocaleFacts {
                declared: spec.locale.clone(),
                source: "plan".to_string(),
                process_lang: "C.UTF-8".to_string(),
                process_lc_all: "C.UTF-8".to_string(),
            },
            environment: EnvironmentPolicy {
                mode: "cleared+allowlist".to_string(),
                inherited: false,
                applied_keys: applied.into_iter().collect(),
                display_keys,
                headless_display: "not-set".to_string(),
            },
        },
        diagnostics: None,
        environment_receipt: None,
    })
}

fn resolve_fontconfig(
    file: &str,
    declared_path: Option<&str>,
    declared_sha: Option<&str>,
) -> Result<FontconfigFacts> {
    util::ensure_absolute(file, "fontconfigFile")?;
    let path = Path::new(file);
    let canonical = fs::canonicalize(path)
        .with_context(|| format!("fontconfigFile is not accessible: {file}"))?;
    if !canonical.is_file() {
        bail!("fontconfigFile must be a regular file: {file}");
    }
    let sha256 = hash::file(&canonical)?;
    if let Some(expected) = declared_sha {
        if !hash::is_sha256(expected) {
            bail!("fontManifestSha256 is not a lowercase SHA-256 digest");
        }
        if expected != sha256 {
            bail!("fontconfigFile digest does not match fontManifestSha256: {file}");
        }
    }
    let (declared_path, path_real_path, path_exists) = match declared_path {
        Some(value) => {
            util::ensure_absolute(value, "fontconfigPath")?;
            let resolved = fs::canonicalize(value).ok();
            (
                Some(value.to_string()),
                resolved.map(|path| path.to_string_lossy().into_owned()),
                Some(Path::new(value).exists()),
            )
        }
        None => (None, None, None),
    };
    Ok(FontconfigFacts {
        declared_file: file.to_string(),
        real_path: canonical.to_string_lossy().into_owned(),
        exists: true,
        sha256,
        declared_path,
        path_real_path,
        path_exists,
    })
}

fn resolve_display(display: &crate::model::DisplaySpec) -> Result<DisplayFacts> {
    if display.kind == DisplayKind::ExternalOwned {
        let Some(path) = &display.ownership_manifest_path else {
            bail!("an external-owned display requires ownershipManifestPath");
        };
        if Path::new(path).file_name().and_then(|name| name.to_str()) != Some("display.json") {
            bail!("external-owned ownershipManifestPath basename must be display.json");
        }
    }
    let mut facts = DisplayFacts {
        kind: match display.kind {
            DisplayKind::ExternalOwned => "external-owned",
            DisplayKind::Managed => "managed",
        }
        .to_string(),
        display_name: display.display_name.clone(),
        socket_path: None,
        socket_exists: None,
        xauthority_path: display.xauthority_path.clone(),
        xauthority_real_path: None,
        xauthority_exists: None,
        xauthority_mode: None,
        ownership_manifest_path: display.ownership_manifest_path.clone(),
        ownership_manifest_real_path: None,
        ownership_manifest_exists: None,
        ownership_manifest_sha256: None,
    };

    if let Some(name) = &display.display_name {
        if let Some(number) = local_display_number(name) {
            let socket = format!("/tmp/.X11-unix/X{number}");
            facts.socket_exists = Some(Path::new(&socket).exists());
            facts.socket_path = Some(socket);
        }
    }

    if let Some(path) = &display.xauthority_path {
        util::ensure_absolute(path, "display.xauthorityPath")?;
        // Xauthority contains cookies; only its metadata is inspected.
        let candidate = Path::new(path);
        if let Ok(metadata) = fs::symlink_metadata(candidate) {
            facts.xauthority_exists = Some(true);
            facts.xauthority_mode = Some(util::mode_string(metadata.mode() & 0o7777));
            facts.xauthority_real_path = fs::canonicalize(candidate)
                .ok()
                .map(|value| value.to_string_lossy().into_owned());
        } else {
            facts.xauthority_exists = Some(false);
        }
    }

    if let Some(path) = &display.ownership_manifest_path {
        util::ensure_absolute(path, "display.ownershipManifestPath")?;
        let candidate = Path::new(path);
        if let Ok(metadata) = fs::symlink_metadata(candidate) {
            facts.ownership_manifest_exists = Some(true);
            facts.ownership_manifest_real_path = fs::canonicalize(candidate)
                .ok()
                .map(|value| value.to_string_lossy().into_owned());
            if metadata.is_file() {
                facts.ownership_manifest_sha256 = Some(hash::file(candidate)?);
            }
        } else {
            facts.ownership_manifest_exists = Some(false);
        }
    }

    Ok(facts)
}

fn local_display_number(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(':')?;
    let number = rest.split('.').next()?;
    if !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()) {
        Some(number)
    } else {
        None
    }
}

fn resolve_os() -> OsFacts {
    let values = fs::read_to_string("/etc/os-release")
        .map(|text| parse_os_release(&text))
        .unwrap_or_default();
    let kernel = fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    OsFacts {
        id: value(&values, "ID"),
        name: value(&values, "NAME"),
        version_id: value(&values, "VERSION_ID"),
        pretty_name: value(&values, "PRETTY_NAME"),
        build_id: value(&values, "BUILD_ID"),
        kernel,
        arch: std::env::consts::ARCH.to_string(),
    }
}

fn value(values: &std::collections::BTreeMap<String, String>, key: &str) -> String {
    values
        .get(key)
        .cloned()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn parse_os_release(text: &str) -> std::collections::BTreeMap<String, String> {
    let mut values = std::collections::BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, raw)) = line.split_once('=') else {
            continue;
        };
        let value = raw
            .trim()
            .trim_matches('"')
            .replace("\\\"", "\"")
            .replace("\\\\", "\\");
        values.insert(key.trim().to_string(), value);
    }
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DisplayKind, DisplaySpec};

    fn spec() -> EnvironmentSpec {
        EnvironmentSpec {
            id: "test".to_string(),
            locale: "C.UTF-8".to_string(),
            timezone_id: "UTC".to_string(),
            fontconfig_file: None,
            fontconfig_path: None,
            font_manifest_sha256: None,
            display: DisplaySpec {
                kind: DisplayKind::Managed,
                width: 1280,
                height: 800,
                depth: 24,
                dpi: 96,
                window_manager: "none".to_string(),
                display_name: Some(":99".to_string()),
                xauthority_path: None,
                ownership_manifest_path: None,
            },
            notes: None,
        }
    }

    #[test]
    fn resolved_provenance_has_no_environment_values() {
        let resolved = resolve(&spec()).expect("resolve");
        assert_eq!(resolved.id, "test");
        assert!(!resolved.resolved.environment.inherited);
        assert!(resolved
            .resolved
            .environment
            .applied_keys
            .contains(&"PATH".to_string()));
        assert_eq!(
            resolved.resolved.display.socket_path.as_deref(),
            Some("/tmp/.X11-unix/X99")
        );
        assert!(resolved.resolved.os.arch == std::env::consts::ARCH);
    }

    #[test]
    fn timezone_traversal_is_rejected() {
        let mut spec = spec();
        spec.timezone_id = "../../etc/passwd".to_string();
        assert!(resolve(&spec).is_err());
    }

    #[test]
    fn external_owned_display_requires_a_display_manifest() {
        let mut spec = spec();
        spec.display.kind = DisplayKind::ExternalOwned;
        spec.display.ownership_manifest_path = None;
        assert!(resolve(&spec).is_err());
        spec.display.ownership_manifest_path =
            Some("/private/display/not-display.json".to_string());
        assert!(resolve(&spec).is_err());
        spec.display.ownership_manifest_path = Some("/private/display/display.json".to_string());
        assert!(resolve(&spec).is_ok());
    }

    #[test]
    fn managed_display_does_not_need_a_rust_owned_manifest() {
        let mut spec = spec();
        spec.display.kind = DisplayKind::Managed;
        spec.display.ownership_manifest_path = None;
        assert!(resolve(&spec).is_ok());
    }
}
