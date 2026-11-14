//! Workflow outputs: stdout plus `$GITHUB_OUTPUT`.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use anyhow::{ensure, Context, Result};

/// Destination for `name=value` workflow outputs.
#[derive(Debug, Clone, Default)]
pub struct Reporter {
    github_output: Option<PathBuf>,
    echo: bool,
}

impl Reporter {
    /// Read `$GITHUB_OUTPUT` the way a workflow step expects.
    pub fn from_env() -> Self {
        let github_output = std::env::var_os("GITHUB_OUTPUT")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        Self {
            github_output,
            echo: true,
        }
    }

    pub fn new(github_output: Option<PathBuf>, echo: bool) -> Self {
        Self {
            github_output,
            echo,
        }
    }

    /// Discard everything; handy for tests and for library callers.
    pub fn silent() -> Self {
        Self::default()
    }

    /// Compact progress line on stdout; never written to `$GITHUB_OUTPUT`.
    pub fn note(&self, message: &str) {
        if self.echo {
            println!("{message}");
        }
    }

    pub fn emit(&self, name: &str, value: &str) -> Result<()> {
        ensure!(!name.is_empty(), "an output name cannot be empty");
        ensure!(
            !name.contains(['\n', '\r', '=']),
            "an output name cannot contain newlines or '='"
        );
        ensure!(
            !value.contains(['\n', '\r']),
            "the value of output {name} cannot contain newlines"
        );
        if self.echo {
            println!("{name}={value}");
        }
        if let Some(path) = &self.github_output {
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .with_context(|| format!("failed to open {}", path.display()))?;
            writeln!(file, "{name}={value}")
                .with_context(|| format!("failed to append to {}", path.display()))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outputs_are_appended_and_can_be_read_back() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("github-output");
        let reporter = Reporter::new(Some(path.clone()), false);
        reporter.emit("changed", "true").expect("emit");
        reporter.emit("playwright", "1.65.0").expect("emit");
        let text = std::fs::read_to_string(path).expect("read");
        assert_eq!(text, "changed=true\nplaywright=1.65.0\n");
    }

    #[test]
    fn newline_injection_is_rejected() {
        let reporter = Reporter::silent();
        assert!(reporter.emit("changed", "true\ninjected=x").is_err());
        assert!(reporter.emit("bad=name", "true").is_err());
    }
}
