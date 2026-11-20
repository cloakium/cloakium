//! The published JSON Schemas are compiled into the binary so `schema` can
//! never drift from the contract checked into `tests/audit/schema`.

use anyhow::{bail, Result};

pub const NAMES: [&str; 8] = [
    "plan",
    "report",
    "runner",
    "policy",
    "compare",
    "catalog",
    "inventory",
    "execution",
];

pub fn text(name: &str) -> Result<&'static str> {
    Ok(match name {
        "plan" => include_str!("../../../tests/audit/schema/plan.schema.json"),
        "report" => include_str!("../../../tests/audit/schema/report.schema.json"),
        "runner" => include_str!("../../../tests/audit/schema/runner.schema.json"),
        "policy" => include_str!("../../../tests/audit/schema/policy.schema.json"),
        "compare" => include_str!("../../../tests/audit/schema/compare.schema.json"),
        "catalog" => include_str!("../../../tests/audit/schema/catalog.schema.json"),
        "inventory" => include_str!("../../../tests/audit/schema/inventory.schema.json"),
        "execution" => include_str!("../../../tests/audit/schema/execution.schema.json"),
        other => bail!("unknown schema name {other}"),
    })
}

pub fn all() -> Result<serde_json::Value> {
    let mut schemas = serde_json::Map::new();
    for name in NAMES {
        let value: serde_json::Value = serde_json::from_str(text(name)?)?;
        schemas.insert(name.to_string(), value);
    }
    let mut root = serde_json::Map::new();
    root.insert(
        "schema".to_string(),
        serde_json::Value::String("cloakium.audit.schemas/1".to_string()),
    );
    root.insert("schemas".to_string(), serde_json::Value::Object(schemas));
    Ok(serde_json::Value::Object(root))
}
