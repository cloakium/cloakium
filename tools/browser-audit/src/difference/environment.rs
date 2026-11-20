//! Fixture-origin and mode-seed provenance helpers.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::model::{Configuration, Seed};
use crate::report::Report;

pub(crate) fn seed_label(configuration: &Configuration) -> String {
    match &configuration.seed {
        Some(Seed::Text(value)) => format!("text:{value}"),
        Some(Seed::Number(value)) => format!("number:{value}"),
        None => "none".to_string(),
    }
}

pub(crate) fn fixture_origins(report: &Report, target_id: &str) -> BTreeSet<String> {
    let mut values = BTreeSet::new();
    for run in report
        .runs
        .iter()
        .filter(|run| run.configuration.target_id == target_id)
    {
        if let Some(diagnostics) = &run.environment.diagnostics {
            collect_fixture_diagnostics(diagnostics, &mut values);
        }
    }
    if let Some(diagnostics) = &report.environment.diagnostics {
        collect_fixture_diagnostics(diagnostics, &mut values);
    }
    values
}

fn collect_fixture_diagnostics(value: &Value, values: &mut BTreeSet<String>) {
    let Some(object) = value.as_object() else {
        return;
    };
    for key in ["fixture", "sharedProbeFixture"] {
        if let Some(fixture) = object.get(key) {
            collect_fixture_node(fixture, values);
        }
    }
    if let Some(sessions) = object.get("sessions").and_then(Value::as_array) {
        for session in sessions {
            if let Some(diagnostics) = session.get("diagnostics") {
                collect_fixture_diagnostics(diagnostics, values);
            }
            if let Some(fixture) = session.get("fixture") {
                collect_fixture_node(fixture, values);
            }
        }
    }
}

fn collect_fixture_node(value: &Value, values: &mut BTreeSet<String>) {
    match value {
        Value::Object(object) => {
            for key in ["origin", "crossOrigin"] {
                if let Some(text) = object.get(key).and_then(Value::as_str) {
                    values.insert(format!("{key}={text}"));
                }
            }
            for key in ["url", "urls"] {
                match object.get(key) {
                    Some(Value::String(text)) => {
                        values.insert(format!("url={text}"));
                    }
                    Some(Value::Array(items)) => {
                        for item in items.iter().filter_map(Value::as_str) {
                            values.insert(format!("url={item}"));
                        }
                    }
                    _ => {}
                }
            }
            for key in ["receipt", "fixture", "sharedProbeFixture"] {
                if let Some(child) = object.get(key) {
                    collect_fixture_node(child, values);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_fixture_node(item, values);
            }
        }
        _ => {}
    }
}

pub(crate) type SeedKey = (String, String, u32);
type ModeSeedPair = (Option<String>, Option<String>);

pub(crate) fn mode_seed_mismatch(report: &Report, target_id: &str) -> Option<(String, String)> {
    let mut pairs: BTreeMap<SeedKey, ModeSeedPair> = BTreeMap::new();
    for run in report
        .runs
        .iter()
        .filter(|run| run.configuration.target_id == target_id)
    {
        let key = (
            run.configuration.profile_id.clone(),
            run.configuration.scenario_signature(),
            run.configuration.iteration,
        );
        let pair = pairs.entry(key).or_default();
        let label = seed_label(&run.configuration);
        match run.configuration.mode {
            crate::model::Mode::Headless => pair.0 = Some(label),
            crate::model::Mode::Headed => pair.1 = Some(label),
        }
    }
    for (headless, headed) in pairs.values() {
        if let (Some(headless), Some(headed)) = (headless, headed) {
            if headless != headed {
                return Some((headless.clone(), headed.clone()));
            }
        }
    }
    None
}
