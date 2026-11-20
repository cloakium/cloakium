//! Source-derived contracts: npm scripts, maintain/audit subcommands, CLI help.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::process::Command;

use crate::Checker;

pub(crate) struct AuditHelp {
    pub(crate) subcommands: BTreeSet<String>,
    pub(crate) flags: BTreeSet<String>,
}

pub(crate) fn audit_help(binary: &Path) -> Result<AuditHelp, String> {
    let top = run_help(binary, &[])?;
    let subcommands = parse_help_commands(&top);
    if subcommands.is_empty() {
        return Err("audit --help did not list any subcommands".into());
    }
    let mut flags = parse_help_flags(&top);
    for subcommand in &subcommands {
        let text = run_help(binary, &[subcommand.as_str()])?;
        flags.extend(parse_help_flags(&text));
    }
    Ok(AuditHelp { subcommands, flags })
}

fn run_help(binary: &Path, subcommand: &[&str]) -> Result<String, String> {
    let output = Command::new(binary)
        .args(subcommand)
        .arg("--help")
        .output()
        .map_err(|error| format!("cannot execute {}: {error}", binary.display()))?;
    if !output.status.success() {
        return Err(format!(
            "{} --help failed: {}",
            binary.display(),
            String::from_utf8_lossy(&output.stderr)
                .lines()
                .next()
                .unwrap_or("no stderr")
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_help_commands(text: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let mut in_commands = false;
    for line in text.lines() {
        if line.trim() == "Commands:" {
            in_commands = true;
            continue;
        }
        if !in_commands {
            continue;
        }
        if line.trim().is_empty() {
            break;
        }
        if !line.starts_with(' ') {
            break;
        }
        let name = line.trim().split_whitespace().next().unwrap_or("");
        if !name.is_empty() && name != "help" && !name.starts_with('-') {
            found.insert(name.to_string());
        }
    }
    found
}

fn parse_help_flags(text: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for word in text.split_whitespace() {
        let cleaned = word.trim_matches(|ch: char| {
            matches!(ch, ',' | '.' | ':' | ')' | '(' | '[' | ']' | '"' | '\'')
        });
        if let Some(rest) = cleaned.strip_prefix("--") {
            if !rest.is_empty()
                && rest
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
            {
                found.insert(format!("--{rest}"));
            }
        }
    }
    found
}

pub(crate) fn validate_cross_references(repo: &Path, checker: &mut Checker) {
    let package = repo.join("package.json");
    let Ok(text) = fs::read_to_string(&package) else {
        checker.note("package.json is unavailable; npm scripts were not checked");
        return;
    };
    let Some(index) = text.find("\"scripts\"") else {
        checker.fail("package.json has no scripts block");
        return;
    };
    let scripts = &text[index..];
    for name in [
        "test",
        "test:node",
        "test:bun",
        "test:driver",
        "test:native",
        "test:parity",
        "test:parity:unit",
        "test:parity:fullscreen",
        "typecheck",
        "build",
        "verify",
    ] {
        if scripts.contains(&format!("\"{name}\":")) {
            checker.ok();
        } else {
            checker.fail(format!("documented npm script is absent: {name}"));
        }
    }
}

pub(crate) fn check_runner_help(repo: &Path, checker: &mut Checker) {
    if !repo.join("node_modules").is_dir() {
        checker.note("node_modules is absent; runner --help was not parsed");
        return;
    }
    let runners = [
        (
            "tests/parity/run.mjs",
            vec![
                "--binary",
                "--output",
                "--repeat",
                "--select",
                "--window-manager",
                "--report-only",
                "--native-defaults",
            ],
        ),
        ("tests/parity/fullscreen.mjs", vec!["--binary", "--output"]),
    ];
    for (script, flags) in runners {
        let output = Command::new("node")
            .arg(script)
            .arg("--help")
            .current_dir(repo)
            .output();
        match output {
            Ok(output) if output.status.success() => {
                let text = String::from_utf8_lossy(&output.stdout);
                for flag in flags {
                    if text.contains(flag) {
                        checker.ok();
                    } else {
                        checker.fail(format!("{script} does not document {flag}"));
                    }
                }
            }
            Ok(output) => checker.fail(format!(
                "{script} --help failed: {}",
                String::from_utf8_lossy(&output.stderr)
                    .lines()
                    .next()
                    .unwrap_or("no stderr")
            )),
            Err(error) => checker.note(format!("cannot execute node for {script}: {error}")),
        }
    }
}

pub(crate) fn parse_subcommands(source: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let Some(start) = source.find("enum Commands {") else {
        return found;
    };
    for line in source[start..].lines().skip(1) {
        let trimmed = line.trim();
        if trimmed == "}" {
            break;
        }
        if trimmed.starts_with("//") || trimmed.is_empty() {
            continue;
        }
        let Some(open) = trimmed.find('(') else {
            continue;
        };
        let name = &trimmed[..open];
        if name
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_uppercase())
        {
            found.insert(kebab_case(name));
        }
    }
    found
}

pub(crate) fn parse_flags(source: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let mut rest = source;
    while let Some(index) = rest.find("\"--") {
        let tail = &rest[index + 1..];
        let end = tail[1..]
            .find(|ch: char| !(ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-'))
            .map(|offset| offset + 1)
            .unwrap_or(tail.len());
        let flag = &tail[..end];
        if flag.len() > 2 {
            found.insert(flag.to_string());
        }
        rest = &tail[end..];
    }
    found
}

fn kebab_case(name: &str) -> String {
    let mut out = String::new();
    for (index, ch) in name.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if index > 0 {
                out.push('-');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}
