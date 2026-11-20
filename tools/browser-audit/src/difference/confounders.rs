//! Confounder detection.

use std::collections::{BTreeMap, BTreeSet};

use crate::hash;
use crate::inventory::InventoryRecord;

use crate::report::Report;

use super::environment::{fixture_origins, mode_seed_mismatch, seed_label};
use super::Confounder;

pub fn confounders(
    baseline: &Report,
    candidate: &Report,
    baseline_target: &InventoryRecord,
    candidate_target: &InventoryRecord,
) -> Vec<Confounder> {
    let mut items = Vec::new();
    let baseline_versions = version_set(baseline, &baseline_target.id);
    let candidate_versions = version_set(candidate, &candidate_target.id);
    if baseline_versions != candidate_versions {
        items.push(Confounder {
            axis: "browser-version".to_string(),
            baseline: join_set(&baseline_versions),
            candidate: join_set(&candidate_versions),
        });
    }
    let baseline_clients = client_set(baseline, &baseline_target.id);
    let candidate_clients = client_set(candidate, &candidate_target.id);
    if baseline_clients != candidate_clients {
        items.push(Confounder {
            axis: "client".to_string(),
            baseline: join_set(&baseline_clients),
            candidate: join_set(&candidate_clients),
        });
    }
    let baseline_font = font_label(baseline);
    let candidate_font = font_label(candidate);
    if baseline_font != candidate_font {
        items.push(Confounder {
            axis: "font".to_string(),
            baseline: baseline_font.clone(),
            candidate: candidate_font.clone(),
        });
    }
    let baseline_receipt_font = receipt_set(
        baseline,
        &baseline_target.id,
        &["fontManifestSha256", "fontconfigSha256"],
    );
    let candidate_receipt_font = receipt_set(
        candidate,
        &candidate_target.id,
        &["fontManifestSha256", "fontconfigSha256"],
    );
    if baseline_receipt_font != candidate_receipt_font
        && (!baseline_receipt_font.is_empty() || !candidate_receipt_font.is_empty())
        && baseline_font == candidate_font
    {
        items.push(Confounder {
            axis: "font".to_string(),
            baseline: join_or_unavailable(&baseline_receipt_font),
            candidate: join_or_unavailable(&candidate_receipt_font),
        });
    }
    let baseline_config = receipt_set(baseline, &baseline_target.id, &["configSha256"]);
    let candidate_config = receipt_set(candidate, &candidate_target.id, &["configSha256"]);
    if baseline_config != candidate_config
        && (!baseline_config.is_empty() || !candidate_config.is_empty())
    {
        items.push(Confounder {
            axis: "config".to_string(),
            baseline: join_or_unavailable(&baseline_config),
            candidate: join_or_unavailable(&candidate_config),
        });
    }
    probe_confounders(
        baseline,
        candidate,
        &baseline_target.id,
        &candidate_target.id,
        &mut items,
    );
    let baseline_origin = fixture_origins(baseline, &baseline_target.id);
    let candidate_origin = fixture_origins(candidate, &candidate_target.id);
    if baseline_origin != candidate_origin
        && (!baseline_origin.is_empty() || !candidate_origin.is_empty())
    {
        items.push(Confounder {
            axis: "fixture-origin".to_string(),
            baseline: join_or_unavailable(&baseline_origin),
            candidate: join_or_unavailable(&candidate_origin),
        });
    }
    let baseline_display = display_label(baseline);
    let candidate_display = display_label(candidate);
    if baseline_display != candidate_display {
        items.push(Confounder {
            axis: "display".to_string(),
            baseline: baseline_display,
            candidate: candidate_display,
        });
    }
    let baseline_os = os_label(baseline);
    let candidate_os = os_label(candidate);
    if baseline_os != candidate_os {
        items.push(Confounder {
            axis: "os".to_string(),
            baseline: baseline_os,
            candidate: candidate_os,
        });
    }
    if baseline.environment.locale != candidate.environment.locale {
        items.push(Confounder {
            axis: "locale".to_string(),
            baseline: baseline.environment.locale.clone(),
            candidate: candidate.environment.locale.clone(),
        });
    }
    if baseline.environment.timezone_id != candidate.environment.timezone_id {
        items.push(Confounder {
            axis: "timezone".to_string(),
            baseline: baseline.environment.timezone_id.clone(),
            candidate: candidate.environment.timezone_id.clone(),
        });
    }
    let baseline_seeds = seed_set(baseline, &baseline_target.id);
    let candidate_seeds = seed_set(candidate, &candidate_target.id);
    if baseline_seeds != candidate_seeds {
        items.push(Confounder {
            axis: "seed".to_string(),
            baseline: join_set(&baseline_seeds),
            candidate: join_set(&candidate_seeds),
        });
    } else if let Some((baseline_seed, candidate_seed)) =
        mode_seed_mismatch(baseline, &baseline_target.id)
            .or_else(|| mode_seed_mismatch(candidate, &candidate_target.id))
    {
        items.push(Confounder {
            axis: "seed".to_string(),
            baseline: baseline_seed,
            candidate: candidate_seed,
        });
    }
    let baseline_args = args_set(baseline, baseline_target);
    let candidate_args = args_set(candidate, candidate_target);
    if baseline_args != candidate_args {
        items.push(Confounder {
            axis: "config-args".to_string(),
            baseline: join_set(&baseline_args),
            candidate: join_set(&candidate_args),
        });
    }
    if format!("{:?}", baseline_target.identity) != format!("{:?}", candidate_target.identity) {
        items.push(Confounder {
            axis: "identity".to_string(),
            baseline: format!("{:?}", baseline_target.identity),
            candidate: format!("{:?}", candidate_target.identity),
        });
    }
    if format!("{:?}", baseline_target.layer) != format!("{:?}", candidate_target.layer) {
        items.push(Confounder {
            axis: "layer".to_string(),
            baseline: format!("{:?}", baseline_target.layer),
            candidate: format!("{:?}", candidate_target.layer),
        });
    }
    items
}

pub fn causal_attribution(confounders: &[Confounder]) -> &'static str {
    let has_version = confounders
        .iter()
        .any(|item| item.axis == "browser-version" || item.axis == "client");
    let has_environment = confounders.iter().any(|item| {
        matches!(
            item.axis.as_str(),
            "font"
                | "probe-source"
                | "runner"
                | "fixture-origin"
                | "display"
                | "os"
                | "locale"
                | "timezone"
                | "config"
        )
    });
    let has_profile = confounders.iter().any(|item| {
        matches!(
            item.axis.as_str(),
            "seed" | "identity" | "layer" | "config-args"
        )
    });
    match (has_version, has_environment, has_profile) {
        (false, false, false) => "unconfounded",
        (true, false, false) => "version-confounded",
        (false, true, false) => "environment-confounded",
        (false, false, true) => "profile-policy-confounded",
        _ => "mixed-confounded",
    }
}

fn version_set(report: &Report, target_id: &str) -> BTreeSet<String> {
    report
        .runs
        .iter()
        .filter(|run| run.configuration.target_id == target_id)
        .map(|run| run.version.clone())
        .collect()
}

fn client_set(report: &Report, target_id: &str) -> BTreeSet<String> {
    report
        .runs
        .iter()
        .filter(|run| run.configuration.target_id == target_id)
        .map(|run| {
            format!(
                "{}@{}@{}@{}@{}",
                run.client.version,
                run.client.sha256,
                run.client.package_sha256.as_deref().unwrap_or("none"),
                run.client
                    .patch_manifest_sha256
                    .as_deref()
                    .unwrap_or("none"),
                run.client.entry_sha256.as_deref().unwrap_or("none")
            )
        })
        .collect()
}

fn args_set(report: &Report, target: &InventoryRecord) -> BTreeSet<String> {
    report
        .runs
        .iter()
        .filter(|run| run.configuration.target_id == target.id)
        .map(|run| {
            let mut args = target.args.clone();
            match run.configuration.mode {
                crate::model::Mode::Headless => args.extend(target.headless_args.clone()),
                crate::model::Mode::Headed => args.extend(target.headed_args.clone()),
            }
            args.extend(run.configuration.args.clone());
            let digest = hash::bytes(args.join("\u{1f}").as_bytes());
            format!("{}:{}", args.len(), &digest[..16])
        })
        .collect()
}

fn seed_set(report: &Report, target_id: &str) -> BTreeSet<String> {
    report
        .runs
        .iter()
        .filter(|run| run.configuration.target_id == target_id)
        .map(|run| seed_label(&run.configuration))
        .collect()
}

fn font_label(report: &Report) -> String {
    report
        .environment
        .resolved
        .fontconfig
        .as_ref()
        .map(|font| font.sha256.clone())
        .unwrap_or_else(|| "unavailable".to_string())
}

fn display_label(report: &Report) -> String {
    let display = &report.environment.display;
    format!(
        "{}:{}x{}x{}@{}:{}:{}",
        match display.kind {
            crate::model::DisplayKind::ExternalOwned => "external-owned",
            crate::model::DisplayKind::Managed => "managed",
        },
        display.width,
        display.height,
        display.depth,
        display.dpi,
        display.window_manager,
        display
            .display_name
            .clone()
            .unwrap_or_else(|| "none".to_string())
    )
}

fn os_label(report: &Report) -> String {
    let os = &report.environment.resolved.os;
    format!("{}:{}:{}:{}", os.id, os.version_id, os.kernel, os.arch)
}

fn join_set(values: &BTreeSet<String>) -> String {
    values.iter().cloned().collect::<Vec<_>>().join(",")
}

pub fn observed_feature_ids(report: &Report, target_id: &str) -> BTreeSet<String> {
    report
        .runs
        .iter()
        .filter(|run| run.configuration.target_id == target_id)
        .flat_map(|run| {
            run.observations
                .iter()
                .map(|observation| observation.id.clone())
        })
        .collect()
}

pub fn observed_families(report: &Report, target_id: &str) -> BTreeMap<String, String> {
    let mut families = BTreeMap::new();
    for run in report
        .runs
        .iter()
        .filter(|run| run.configuration.target_id == target_id)
    {
        for observation in &run.observations {
            families
                .entry(observation.id.clone())
                .or_insert_with(|| observation.family.clone());
        }
    }
    families
}

fn receipt_set(report: &Report, target_id: &str, keys: &[&str]) -> BTreeSet<String> {
    let mut values = BTreeSet::new();
    for run in report
        .runs
        .iter()
        .filter(|run| run.configuration.target_id == target_id)
    {
        let receipt = run
            .environment
            .environment_receipt
            .as_ref()
            .or(report.environment.environment_receipt.as_ref());
        let Some(receipt) = receipt.and_then(|value| value.as_object()) else {
            continue;
        };
        for key in keys {
            if let Some(value) = receipt.get(*key).and_then(|value| value.as_str()) {
                values.insert(format!("{key}={value}"));
            }
        }
    }
    values
}

fn join_or_unavailable(values: &BTreeSet<String>) -> String {
    if values.is_empty() {
        "unavailable".to_string()
    } else {
        join_set(values)
    }
}

fn probe_confounders(
    baseline: &Report,
    candidate: &Report,
    baseline_target: &str,
    candidate_target: &str,
    items: &mut Vec<Confounder>,
) {
    let baseline_features = observed_feature_ids(baseline, baseline_target);
    let candidate_features = observed_feature_ids(candidate, candidate_target);
    let baseline_probes = selected_probe_hashes(baseline, &baseline_features);
    let candidate_probes = selected_probe_hashes(candidate, &candidate_features);
    let keys: BTreeSet<&String> = baseline_probes
        .keys()
        .chain(candidate_probes.keys())
        .collect();
    let mut baseline_changes = Vec::new();
    let mut candidate_changes = Vec::new();
    for key in keys {
        let left = baseline_probes
            .get(key)
            .map(String::as_str)
            .unwrap_or("missing");
        let right = candidate_probes
            .get(key)
            .map(String::as_str)
            .unwrap_or("missing");
        if left != right {
            baseline_changes.push(format!("{key}={left}"));
            candidate_changes.push(format!("{key}={right}"));
        }
    }
    if !baseline_changes.is_empty() {
        items.push(Confounder {
            axis: "probe-source".to_string(),
            baseline: baseline_changes.join(";"),
            candidate: candidate_changes.join(";"),
        });
    }
    if baseline.suite.manifest_sha256 != candidate.suite.manifest_sha256 {
        items.push(Confounder {
            axis: "probe-source".to_string(),
            baseline: baseline.suite.manifest_sha256.clone(),
            candidate: candidate.suite.manifest_sha256.clone(),
        });
    }
    if baseline.suite.runner.sha256 != candidate.suite.runner.sha256 {
        items.push(Confounder {
            axis: "runner".to_string(),
            baseline: baseline.suite.runner.sha256.clone(),
            candidate: candidate.suite.runner.sha256.clone(),
        });
    }
}

fn selected_probe_hashes(report: &Report, features: &BTreeSet<String>) -> BTreeMap<String, String> {
    report
        .suite
        .probes
        .iter()
        .filter(|probe| features.contains(&probe.id))
        .map(|probe| (probe.id.clone(), probe.sha256.clone()))
        .collect()
}
