//! `npm pack` invocation and result validation.

use std::path::{Component, Path};

use anyhow::{ensure, Context, Result};

use crate::command::{Command, Runner, NETWORK_TIMEOUT};

/// Run `npm pack --ignore-scripts` and return the produced asset name.
pub fn pack(directory: &Path, output: &Path, runner: &mut dyn Runner) -> Result<String> {
    ensure!(
        directory.is_dir(),
        "npm package directory does not exist: {}",
        directory.display()
    );
    let result = runner.run(
        &Command::new(
            "npm",
            vec![
                "pack".to_string(),
                "--json".to_string(),
                "--ignore-scripts".to_string(),
                "--pack-destination".to_string(),
                output.display().to_string(),
                directory.display().to_string(),
            ],
        )
        .timeout(NETWORK_TIMEOUT),
    )?;
    let parsed: serde_json::Value =
        serde_json::from_str(result.stdout_trimmed()).context("npm pack did not return JSON")?;
    let entries = parsed
        .as_array()
        .filter(|entries| entries.len() == 1)
        .context("unexpected npm pack result: expected exactly one tarball")?;
    let filename = entries[0]
        .get("filename")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.is_empty())
        .context("npm pack did not report a filename")?;
    let mut components = Path::new(filename).components();
    let plain =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    ensure!(plain, "unexpected npm pack filename: {filename}");
    Ok(filename.to_string())
}
