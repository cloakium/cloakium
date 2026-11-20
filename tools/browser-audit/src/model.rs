//! Canonical plan and configuration types shared by every command.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const PLAN_SCHEMA: &str = "cloakium.audit.plan/1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Seed {
    Text(String),
    Number(u64),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DisplayKind {
    ExternalOwned,
    Managed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplaySpec {
    pub kind: DisplayKind,
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub dpi: u32,
    pub window_manager: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xauthority_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ownership_manifest_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvironmentSpec {
    pub id: String,
    pub locale: String,
    pub timezone_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fontconfig_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fontconfig_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_manifest_sha256: Option<String>,
    pub display: DisplaySpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Layer {
    Engine,
    Launcher,
    Product,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Identity {
    Native,
    Persona,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub id: String,
    pub label: String,
    pub artifact_path: String,
    pub executable_path: String,
    pub client_module: String,
    pub layer: Layer,
    pub identity: Identity,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub headless_args: Vec<String>,
    #[serde(default)]
    pub headed_args: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum Mode {
    Headless,
    Headed,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Headless => "headless",
            Self::Headed => "headed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    pub id: String,
    pub target_id: String,
    pub mode: Mode,
    pub iteration: u32,
    pub profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<Seed>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub context_options: Map<String, Value>,
    #[serde(default)]
    pub suites: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe_ids: Option<Vec<String>>,
    /// Exact scenario selection within the named suites. Omit to let the
    /// runner expand every scenario in each suite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario_ids: Option<Vec<String>>,
    /// Suite-specific settings (for example local fixture ports). Never
    /// credentials.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub suite_options: Map<String, Value>,
    /// Arbitrary probe configuration supplied to the selected runner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe_config: Option<Value>,
}

impl Configuration {
    /// Stable key used to pair baseline and candidate configurations. Scenario
    /// and suite selection is part of the key so unlike matrices never pair
    /// silently.
    pub fn match_key(&self) -> (Mode, u32, String, String) {
        (
            self.mode,
            self.iteration,
            self.profile_id.clone(),
            self.scenario_signature(),
        )
    }

    pub fn scenario_signature(&self) -> String {
        let suites = self.suites.join(",");
        let probes = self
            .probe_ids
            .as_ref()
            .map(|values| values.join(","))
            .unwrap_or_default();
        let scenarios = self
            .scenario_ids
            .as_ref()
            .map(|values| values.join(","))
            .unwrap_or_default();
        let options = serde_json::to_string(&self.suite_options).unwrap_or_default();
        let probe_config = self
            .probe_config
            .as_ref()
            .map(|value| serde_json::to_string(value).unwrap_or_default())
            .unwrap_or_default();
        format!("{suites}|{probes}|{scenarios}|{options}|{probe_config}")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub schema: String,
    pub id: String,
    pub environment: EnvironmentSpec,
    pub targets: Vec<Target>,
    pub configurations: Vec<Configuration>,
}

impl Plan {
    pub fn target(&self, id: &str) -> Option<&Target> {
        self.targets.iter().find(|target| target.id == id)
    }

    pub fn configuration(&self, id: &str) -> Option<&Configuration> {
        self.configurations
            .iter()
            .find(|configuration| configuration.id == id)
    }
}

pub fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}
