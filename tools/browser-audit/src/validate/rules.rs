//! Shared validation rules.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::hash;
use crate::inventory::InventoryRecord;
use crate::model::{is_safe_id, Configuration, DisplayKind, EnvironmentSpec};
use crate::report::ResolvedEnvironment;
use crate::util;

use super::Validation;

pub(crate) fn validate_environment_spec(spec: &EnvironmentSpec, validation: &mut Validation) {
    if !is_safe_id(&spec.id) {
        validation.error(
            "environment.id",
            "environment id must be a safe ASCII identifier",
        );
    }
    if !is_bcp47_locale(&spec.locale) {
        validation.error(
            "environment.locale",
            "locale must be a BCP 47 browser locale such as en-US, not a POSIX locale",
        );
    }
    if spec.timezone_id.is_empty()
        || spec.timezone_id.starts_with('/')
        || spec.timezone_id.split('/').any(|part| part == "..")
    {
        validation.error(
            "environment.timezoneId",
            "timezoneId must be a safe IANA zone name",
        );
    }
    for (field, value) in [
        ("fontconfigFile", &spec.fontconfig_file),
        ("fontconfigPath", &spec.fontconfig_path),
    ] {
        if let Some(value) = value {
            if let Err(error) = util::ensure_absolute(value, field) {
                validation.error("environment.path", error.to_string());
            }
        }
    }
    if let Some(value) = &spec.font_manifest_sha256 {
        if !hash::is_sha256(value) {
            validation.error(
                "environment.fontManifestSha256",
                "fontManifestSha256 must be a lowercase SHA-256 digest",
            );
        }
    }
    validate_display_spec(spec, validation);
}

pub(crate) fn validate_display_spec(spec: &EnvironmentSpec, validation: &mut Validation) {
    let display = &spec.display;
    for (field, value) in [
        ("display.width", display.width),
        ("display.height", display.height),
        ("display.depth", display.depth),
        ("display.dpi", display.dpi),
    ] {
        if value == 0 {
            validation.error(
                "display.dimension",
                format!("{field} must be greater than zero"),
            );
        }
    }
    if display.window_manager.trim().is_empty() {
        validation.error("display.windowManager", "windowManager cannot be empty");
    }
    if display.kind == DisplayKind::ExternalOwned {
        match &display.ownership_manifest_path {
            None => validation.error(
                "display.ownership",
                "external-owned display needs ownershipManifestPath",
            ),
            Some(path) => {
                if std::path::Path::new(path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    != Some("display.json")
                {
                    validation.error(
                        "display.ownership",
                        "external-owned ownershipManifestPath basename must be display.json",
                    );
                }
            }
        }
    }
    if let Some(value) = &display.xauthority_path {
        if let Err(error) = util::ensure_absolute(value, "display.xauthorityPath") {
            validation.error("display.path", error.to_string());
        }
    }
    if let Some(value) = &display.ownership_manifest_path {
        if let Err(error) = util::ensure_absolute(value, "display.ownershipManifestPath") {
            validation.error("display.path", error.to_string());
        }
    }
}

pub(crate) fn validate_resolved_environment(
    environment: &ResolvedEnvironment,
    validation: &mut Validation,
) {
    if !is_safe_id(&environment.id) {
        validation.error("environment.id", "resolved environment id is not safe");
    }
    if environment.locale.trim().is_empty() {
        validation.error("environment.locale", "resolved locale cannot be empty");
    }
    if environment.resolved.os.arch.trim().is_empty() {
        validation.error("environment.os.arch", "resolved OS arch cannot be empty");
    }
    if environment.resolved.os.kernel.trim().is_empty() {
        validation.error("environment.os.kernel", "resolved kernel cannot be empty");
    }
    if let Err(error) = util::ensure_absolute(
        &environment.resolved.timezone.zoneinfo_path,
        "resolved.timezone.zoneinfoPath",
    ) {
        validation.error("environment.timezone", error.to_string());
    }
    if let Some(font) = &environment.resolved.fontconfig {
        if !hash::is_sha256(&font.sha256) {
            validation.error("environment.fontconfig", "fontconfig sha256 is invalid");
        }
        if let Err(error) = util::ensure_absolute(&font.real_path, "fontconfig.realPath") {
            validation.error("environment.fontconfig", error.to_string());
        }
    }
    if let Some(diagnostics) = &environment.diagnostics {
        validate_diagnostics(diagnostics, validation);
    }
    if let Some(receipt) = &environment.environment_receipt {
        if !receipt.is_object() {
            validation.error(
                "environment.receipt",
                "environmentReceipt must be a JSON object",
            );
        }
        validate_diagnostics(receipt, validation);
    }
}

pub(crate) fn validate_diagnostics(value: &Value, validation: &mut Validation) {
    const SENSITIVE: [&str; 8] = [
        "password",
        "passwd",
        "secret",
        "token",
        "cookie",
        "credential",
        "privatekey",
        "apikey",
    ];
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                if SENSITIVE.iter().any(|needle| normalized.contains(needle)) {
                    validation.error(
                        "diagnostics.secret",
                        format!("diagnostics key looks sensitive and is not allowed: {key}"),
                    );
                }
                validate_diagnostics(child, validation);
            }
        }
        Value::Array(items) => {
            for item in items {
                validate_diagnostics(item, validation);
            }
        }
        _ => {}
    }
}

pub(crate) fn validate_targets(targets: &[InventoryRecord], validation: &mut Validation) {
    let mut ids = BTreeSet::new();
    for target in targets {
        if !is_safe_id(&target.id) {
            validation.error("target.id", "inventory target id is not safe");
        }
        if !ids.insert(target.id.clone()) {
            validation.error(
                "target.duplicate",
                format!("duplicate inventory target {}", target.id),
            );
        }
        if target.same_real_path != (target.artifact.real_path == target.executable.real_path) {
            validation.error(
                "target.sameRealPath",
                format!("target {} sameRealPath is inconsistent", target.id),
            );
        }
        for (field, identity) in [
            ("artifact", &target.artifact),
            ("executable", &target.executable),
        ] {
            if !hash::is_sha256(&identity.sha256_before)
                || !hash::is_sha256(&identity.sha256_after)
                || !identity.unchanged
                || identity.sha256_before != identity.sha256_after
            {
                validation.error(
                    "inventory.digest",
                    format!("target {} {field} digest is inconsistent", target.id),
                );
            }
            if identity.mode_bits & 0o7777 != mode_from_string(&identity.mode).unwrap_or(u32::MAX) {
                validation.error(
                    "inventory.mode",
                    format!(
                        "target {} {field} mode string does not match bits",
                        target.id
                    ),
                );
            }
            if identity.permissions.setuid != (identity.mode_bits & 0o4000 != 0)
                || identity.permissions.setgid != (identity.mode_bits & 0o2000 != 0)
                || identity.permissions.world_writable != (identity.mode_bits & 0o002 != 0)
            {
                validation.error(
                    "inventory.permissions",
                    format!(
                        "target {} {field} permission facts are inconsistent",
                        target.id
                    ),
                );
            }
            for (path_field, path) in [
                ("originalPath", &identity.original_path),
                ("realPath", &identity.real_path),
            ] {
                if let Err(error) = util::ensure_absolute(path, path_field) {
                    validation.error("inventory.path", format!("target {}: {error}", target.id));
                }
            }
            match (identity.kind, &identity.elf) {
                (crate::inventory::FileKind::Elf, Some(elf)) => {
                    if elf.class != "ELF64" && elf.class != "ELF32" {
                        validation.error(
                            "inventory.elf",
                            format!("target {} {field} is not an ELF executable", target.id),
                        );
                    }
                }
                (crate::inventory::FileKind::Elf, None) => validation.error(
                    "inventory.elf",
                    format!(
                        "target {} {field} claims ELF without ELF metadata",
                        target.id
                    ),
                ),
                (crate::inventory::FileKind::Script, Some(_)) => validation.error(
                    "inventory.elf",
                    format!(
                        "target {} {field} claims a script with ELF metadata",
                        target.id
                    ),
                ),
                (crate::inventory::FileKind::Script, None) => {}
            }
            if field == "artifact" && identity.kind != crate::inventory::FileKind::Elf {
                validation.error(
                    "inventory.artifact",
                    format!("target {} artifact must be a native ELF", target.id),
                );
            }
        }
    }
}

pub(crate) fn mode_from_string(value: &str) -> Option<u32> {
    u32::from_str_radix(value, 8).ok()
}

pub(crate) fn validate_suite(
    manifest: &str,
    probes: &[crate::report::ProbeRecord],
    validation: &mut Validation,
) {
    if !hash::is_sha256(manifest) {
        validation.error(
            "suite.manifest",
            "suite manifest hash is not a SHA-256 digest",
        );
    }
    let mut ids = BTreeSet::new();
    for probe in probes {
        if probe.id.trim().is_empty() {
            validation.error("suite.probe", "probe id cannot be empty");
        }
        if !ids.insert(probe.id.clone()) {
            validation.error(
                "suite.probe.duplicate",
                format!("duplicate probe id {}", probe.id),
            );
        }
        if !hash::is_sha256(&probe.sha256) {
            validation.error(
                "suite.probe.sha256",
                format!("probe {} sha256 is invalid", probe.id),
            );
        }
    }
}

pub(crate) fn validate_configuration(
    configuration: &Configuration,
    target_ids: &BTreeSet<String>,
    validation: &mut Validation,
) {
    if !is_safe_id(&configuration.id) {
        validation.error(
            "configuration.id",
            "configuration id must be a safe ASCII identifier",
        );
    }
    if !target_ids.is_empty() && !target_ids.contains(&configuration.target_id) {
        validation.error(
            "configuration.target",
            format!(
                "configuration {} references an unknown target",
                configuration.id
            ),
        );
    }
    if configuration.iteration == 0 {
        validation.error(
            "configuration.iteration",
            format!(
                "configuration {} iteration must be at least 1",
                configuration.id
            ),
        );
    }
    if !is_safe_id(&configuration.profile_id) {
        validation.error(
            "configuration.profileId",
            format!("configuration {} profileId is not safe", configuration.id),
        );
    }
    if configuration.suites.is_empty() {
        validation.incomplete(format!(
            "configuration {} selects no suites",
            configuration.id
        ));
    }
    if !unique_nonempty(&configuration.suites) {
        validation.error(
            "configuration.suites",
            format!(
                "configuration {} suites must be unique and non-empty",
                configuration.id
            ),
        );
    }
    if let Some(probe_ids) = &configuration.probe_ids {
        if !unique_nonempty(probe_ids) {
            validation.error(
                "configuration.probeIds",
                format!(
                    "configuration {} probeIds must be unique and non-empty",
                    configuration.id
                ),
            );
        }
    }
    if let Some(scenario_ids) = &configuration.scenario_ids {
        if !unique_nonempty(scenario_ids) {
            validation.error(
                "configuration.scenarioIds",
                format!(
                    "configuration {} scenarioIds must be unique and non-empty",
                    configuration.id
                ),
            );
        }
    }
    for key in configuration.suite_options.keys() {
        if key.trim().is_empty() {
            validation.error(
                "configuration.suiteOptions",
                format!(
                    "configuration {} has an empty suite option key",
                    configuration.id
                ),
            );
        }
    }
    validate_diagnostics(
        &Value::Object(configuration.suite_options.clone()),
        validation,
    );
    if let Some(probe_config) = &configuration.probe_config {
        validate_diagnostics(probe_config, validation);
    }
    validate_args(
        &configuration.args,
        &format!("configuration {}", configuration.id),
        validation,
    );
    if let Some(seed) = &configuration.seed {
        match seed {
            crate::model::Seed::Text(value) if value.trim().is_empty() => validation.error(
                "configuration.seed",
                format!("configuration {} seed cannot be empty", configuration.id),
            ),
            _ => {}
        }
    }
}

pub(crate) fn validate_args(args: &[String], context: &str, validation: &mut Validation) {
    for arg in args {
        if arg.contains('\0') {
            validation.error("args.nul", format!("{context} contains a NUL byte"));
        }
    }
}

pub(crate) fn unique_nonempty(values: &[String]) -> bool {
    let mut seen = BTreeSet::new();
    values
        .iter()
        .all(|value| !value.trim().is_empty() && seen.insert(value.clone()))
}

pub(crate) fn is_bcp47_locale(value: &str) -> bool {
    let mut parts = value.split('-');
    let Some(language) = parts.next() else {
        return false;
    };
    if !(2..=3).contains(&language.len())
        || !language.bytes().all(|byte| byte.is_ascii_alphabetic())
    {
        return false;
    }
    let mut count = 1;
    for part in parts {
        if part.is_empty()
            || part.len() > 8
            || !part.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            return false;
        }
        count += 1;
    }
    count <= 8 && !matches!(value, "C" | "POSIX")
}

pub(crate) fn validate_process_cleanup(
    cleanup: &crate::tree::ProcessCleanup,
    validation: &mut Validation,
) {
    if cleanup.clean && !cleanup.residual.is_empty() {
        validation.error(
            "processCleanup.clean",
            "processCleanup clean cannot have residual owned processes",
        );
    }
    if !cleanup.clean {
        if cleanup.residual.is_empty() {
            validation.incomplete(
                "process cleanup evidence is uncertain or not clean; no residual ids were invented",
            );
        } else {
            validation.incomplete("Rust process cleanup left residual owned processes");
        }
    }
}
