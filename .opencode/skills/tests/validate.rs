//! Structural validation for the three project-local skills.
//!
//! No dependencies. Build and run from the repository root:
//!
//!   rustc --edition 2021 -O .opencode/skills/tests/validate.rs -o /tmp/cloakium-skill-validate
//!   /tmp/cloakium-skill-validate .opencode/skills
//!
//! `--help-check` additionally parses the real `--help` of the parity runners
//! when Node and an installed `node_modules` are available.

#[path = "validate/parse.rs"]
mod parse;
#[path = "validate/skill.rs"]
mod skill;
#[path = "validate/sources.rs"]
mod sources;

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

pub(crate) const EXPECTED: [&str; 3] = [
    "cloakium-audit-private",
    "cloakium-discover-browsers",
    "cloakium-update-chromium",
];

pub(crate) const AUDIT_SUBCOMMANDS: [&str; 8] = [
    "inventory",
    "plan",
    "validate",
    "run",
    "finalize",
    "compare",
    "catalog",
    "schema",
];

pub(crate) const ALLOWED_COMMANDS: [&str; 34] = [
    "command",
    "nix",
    "node",
    "npm",
    "bun",
    "jq",
    "sha256sum",
    "realpath",
    "file",
    "env",
    "mkdir",
    "chmod",
    "mktemp",
    "mv",
    "cp",
    "rm",
    "jj",
    "direnv",
    "cloakium-audit",
    "cloakium-audit-display",
    "cloakium-maintain",
    "true",
    "false",
    "echo",
    "printf",
    "grep",
    "sed",
    "sort",
    "cut",
    "head",
    "wc",
    "test",
    "umask",
    "export",
];

pub(crate) const REPO_PREFIXES: [&str; 6] =
    ["tests/", "docs/", "nix/", "tools/", "scripts/", "patches/"];

pub(crate) const PENDING_PATHS: [&str; 0] = [];

pub(crate) const MAX_LINES: usize = 500;

pub(crate) struct Checker {
    errors: Vec<String>,
    notes: Vec<String>,
    passed: usize,
}

impl Checker {
    pub(crate) fn fail(&mut self, message: impl Into<String>) {
        self.errors.push(message.into());
    }

    pub(crate) fn note(&mut self, message: impl Into<String>) {
        self.notes.push(message.into());
    }

    pub(crate) fn ok(&mut self) {
        self.passed += 1;
    }
}

fn main() -> ExitCode {
    let mut help_check = false;
    let mut root_arg = None;
    let mut audit_bin = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help-check" => help_check = true,
            "--audit-bin" => match args.next() {
                Some(value) => audit_bin = Some(PathBuf::from(value)),
                None => {
                    println!("FAIL --audit-bin needs a value");
                    return ExitCode::FAILURE;
                }
            },
            "--help" | "-h" => {
                println!("usage: validate [skills-root] [--help-check] [--audit-bin PATH]");
                return ExitCode::SUCCESS;
            }
            other => root_arg = Some(PathBuf::from(other)),
        }
    }
    let root = root_arg.unwrap_or_else(|| PathBuf::from(".opencode/skills"));
    let mut checker = Checker {
        errors: Vec::new(),
        notes: Vec::new(),
        passed: 0,
    };
    if let Err(error) = validate(&root, help_check, audit_bin.as_deref(), &mut checker) {
        checker.fail(error);
    }
    for note in &checker.notes {
        println!("SKIP {note}");
    }
    for error in &checker.errors {
        println!("FAIL {error}");
    }
    println!(
        "{} checks passed, {} failed",
        checker.passed,
        checker.errors.len()
    );
    if checker.errors.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn validate(
    root: &Path,
    help_check: bool,
    audit_bin: Option<&Path>,
    checker: &mut Checker,
) -> Result<(), String> {
    let root = fs::canonicalize(root)
        .map_err(|error| format!("cannot resolve skills root {}: {error}", root.display()))?;
    let repo = root
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "skills root has no repository parent".to_string())?
        .to_path_buf();

    let audit_help = match audit_bin {
        Some(path) => match sources::audit_help(path) {
            Ok(help) => Some(help),
            Err(error) => {
                checker.fail(error);
                None
            }
        },
        None => None,
    };

    let directories = skill::discover(&root, checker);
    let discovered: BTreeSet<String> = directories.keys().cloned().collect();
    let expected: BTreeSet<String> = EXPECTED.iter().map(|id| id.to_string()).collect();
    for missing in expected.difference(&discovered) {
        checker.fail(format!("missing skill directory {missing}"));
    }
    for extra in discovered.difference(&expected) {
        checker.fail(format!("unexpected skill directory {extra}"));
    }
    checker.ok();

    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.is_file() && path.extension().is_some_and(|ext| ext == "md") {
            checker.fail(format!(
                "flat skill file is not used here: {}",
                path.display()
            ));
        }
    }
    if root.join("tests/SKILL.md").exists() || skill::contains_skill_file(&root.join("tests")) {
        checker.fail("a SKILL.md exists under skills/tests; test fixtures must not be skills");
    }
    checker.ok();

    let mut names = BTreeMap::new();
    let mut descriptions = BTreeMap::new();
    for (id, directory) in &directories {
        skill::validate_skill(
            id,
            directory,
            &repo,
            checker,
            &mut names,
            &mut descriptions,
            audit_help.as_ref(),
        );
    }
    sources::validate_cross_references(&repo, checker);
    if help_check {
        sources::check_runner_help(&repo, checker);
    }
    Ok(())
}
