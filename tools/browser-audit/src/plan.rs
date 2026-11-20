//! Generate a versioned comparison plan from explicit paths.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};

use crate::model::{
    Configuration, DisplayKind, DisplaySpec, EnvironmentSpec, Identity, Layer, Mode, Plan, Seed,
    Target, PLAN_SCHEMA,
};
use crate::storage;
use crate::time;
use crate::util;

#[derive(Debug, Clone)]
pub struct DisplayOptions {
    pub kind: DisplayKind,
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub dpi: u32,
    pub window_manager: String,
    pub display_name: Option<String>,
    pub xauthority_path: Option<String>,
    pub ownership_manifest_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PlanOptions {
    pub baseline: String,
    pub candidate: String,
    pub baseline_launcher: Option<String>,
    pub candidate_launcher: Option<String>,
    pub client_module: String,
    pub iterations: u32,
    pub environment_id: String,
    pub locale: String,
    pub timezone_id: String,
    pub fontconfig_file: Option<String>,
    pub fontconfig_path: Option<String>,
    pub font_manifest_sha256: Option<String>,
    pub display: DisplayOptions,
    pub notes: Option<String>,
    pub suites: Vec<String>,
    pub probe_ids: Option<Vec<String>>,
    pub scenario_ids: Option<Vec<String>>,
    pub suite_options: serde_json::Map<String, serde_json::Value>,
    pub probe_config: Option<serde_json::Value>,
    pub seed: Option<Seed>,
    pub baseline_layer: Layer,
    pub candidate_layer: Layer,
    pub baseline_identity: Identity,
    pub candidate_identity: Identity,
}

impl PlanOptions {
    pub fn default_display() -> DisplayOptions {
        DisplayOptions {
            kind: DisplayKind::Managed,
            width: 1280,
            height: 800,
            depth: 24,
            dpi: 96,
            window_manager: "none".to_string(),
            display_name: None,
            xauthority_path: None,
            ownership_manifest_path: None,
        }
    }
}

pub fn generate(options: &PlanOptions) -> Result<Plan> {
    if options.iterations == 0 {
        bail!("--iterations must be at least 1");
    }
    if options.iterations > 100 {
        bail!("--iterations must not exceed 100");
    }
    if options.suites.is_empty() {
        bail!("at least one suite is required");
    }
    let plan_id = time::unique_id("plan");
    let mut display = DisplaySpec {
        kind: options.display.kind,
        width: options.display.width,
        height: options.display.height,
        depth: options.display.depth,
        dpi: options.display.dpi,
        window_manager: options.display.window_manager.clone(),
        display_name: options.display.display_name.clone(),
        xauthority_path: options.display.xauthority_path.clone(),
        ownership_manifest_path: options.display.ownership_manifest_path.clone(),
    };
    if display.kind == DisplayKind::Managed && display.ownership_manifest_path.is_none() {
        display.ownership_manifest_path = Some(
            default_ownership_manifest(&plan_id)?
                .to_string_lossy()
                .into_owned(),
        );
    }

    let environment = EnvironmentSpec {
        id: options.environment_id.clone(),
        locale: options.locale.clone(),
        timezone_id: options.timezone_id.clone(),
        fontconfig_file: options.fontconfig_file.clone(),
        fontconfig_path: options.fontconfig_path.clone(),
        font_manifest_sha256: options.font_manifest_sha256.clone(),
        display,
        notes: options.notes.clone(),
    };
    let baseline = build_target(
        "baseline",
        "Baseline",
        &options.baseline,
        options.baseline_launcher.as_deref(),
        &options.client_module,
        options.baseline_layer,
        options.baseline_identity,
    )?;
    let candidate = build_target(
        "candidate",
        "Candidate",
        &options.candidate,
        options.candidate_launcher.as_deref(),
        &options.client_module,
        options.candidate_layer,
        options.candidate_identity,
    )?;

    let mut configurations = Vec::new();
    for target in [&baseline, &candidate] {
        for mode in [Mode::Headless, Mode::Headed] {
            for iteration in 1..=options.iterations {
                configurations.push(Configuration {
                    id: format!("{}-{}-{iteration}", target.id, mode.as_str()),
                    target_id: target.id.clone(),
                    mode,
                    iteration,
                    profile_id: "default".to_string(),
                    seed: options.seed.clone(),
                    args: Vec::new(),
                    context_options: Default::default(),
                    suites: options.suites.clone(),
                    probe_ids: options.probe_ids.clone(),
                    scenario_ids: options.scenario_ids.clone(),
                    suite_options: options.suite_options.clone(),
                    probe_config: options.probe_config.clone(),
                });
            }
        }
    }

    Ok(Plan {
        schema: PLAN_SCHEMA.to_string(),
        id: plan_id,
        environment,
        targets: vec![baseline, candidate],
        configurations,
    })
}

fn default_ownership_manifest(plan_id: &str) -> Result<PathBuf> {
    Ok(storage::state_root()?
        .join("display")
        .join(format!("{plan_id}.ownership.json")))
}

fn build_target(
    id: &str,
    label: &str,
    artifact: &str,
    launcher: Option<&str>,
    client_module: &str,
    layer: Layer,
    identity: Identity,
) -> Result<Target> {
    let artifact = normalized(artifact, "artifact path")?;
    let executable = match launcher {
        Some(value) => normalized(value, "launcher path")?,
        None => artifact.clone(),
    };
    let client = normalized(client_module, "client module")?;
    Ok(Target {
        id: id.to_string(),
        label: label.to_string(),
        artifact_path: artifact,
        executable_path: executable,
        client_module: client,
        layer,
        identity,
        args: Vec::new(),
        headless_args: Vec::new(),
        headed_args: Vec::new(),
    })
}

fn normalized(value: &str, field: &str) -> Result<String> {
    let path = util::absolute(Path::new(value))?;
    let text = path.to_string_lossy().into_owned();
    util::ensure_absolute(&text, field)?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> PlanOptions {
        PlanOptions {
            baseline: "/opt/baseline/chrome".to_string(),
            candidate: "/opt/candidate/chrome".to_string(),
            baseline_launcher: Some("/opt/baseline/launcher".to_string()),
            candidate_launcher: None,
            client_module: "/opt/client/index.js".to_string(),
            iterations: 2,
            environment_id: "test".to_string(),
            locale: "en-US".to_string(),
            timezone_id: "UTC".to_string(),
            fontconfig_file: None,
            fontconfig_path: None,
            font_manifest_sha256: None,
            display: PlanOptions::default_display(),
            notes: None,
            suites: vec!["fingerprint".to_string()],
            probe_ids: None,
            scenario_ids: None,
            suite_options: Default::default(),
            probe_config: None,
            seed: Some(Seed::Text("42424".to_string())),
            baseline_layer: Layer::Engine,
            candidate_layer: Layer::Engine,
            baseline_identity: Identity::Native,
            candidate_identity: Identity::Native,
        }
    }

    #[test]
    fn both_modes_and_both_iterations_are_generated() {
        let plan = generate(&options()).expect("plan");
        assert_eq!(plan.configurations.len(), 8);
        assert!(plan
            .configurations
            .iter()
            .any(|configuration| configuration.mode == Mode::Headless
                && configuration.iteration == 2));
        assert!(plan
            .configurations
            .iter()
            .any(|configuration| configuration.mode == Mode::Headed
                && configuration.target_id == "candidate"));
        assert_eq!(plan.targets[0].executable_path, "/opt/baseline/launcher");
        assert_eq!(plan.targets[1].executable_path, "/opt/candidate/chrome");
        assert_eq!(plan.environment.display.kind, DisplayKind::Managed);
        assert!(plan.environment.display.ownership_manifest_path.is_some());
    }

    #[test]
    fn zero_iterations_is_rejected() {
        let mut options = options();
        options.iterations = 0;
        assert!(generate(&options).is_err());
    }
}
