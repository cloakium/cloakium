//! Skill discovery and per-skill file checks.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::parse;
use crate::{Checker, ALLOWED_COMMANDS, AUDIT_SUBCOMMANDS, EXPECTED, MAX_LINES, PENDING_PATHS};

pub(crate) fn discover(root: &Path, checker: &mut Checker) -> BTreeMap<String, PathBuf> {
    let mut found = BTreeMap::new();
    let Ok(entries) = fs::read_dir(root) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !path.join("SKILL.md").is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            checker.fail(format!("non-UTF-8 skill directory {}", path.display()));
            continue;
        };
        if !parse::is_kebab(name) {
            checker.fail(format!("skill ID {name:?} is not lowercase kebab-case"));
        }
        if name.len() > 64 {
            checker.fail(format!("skill ID {name:?} exceeds 64 characters"));
        }
        found.insert(name.to_string(), path.clone());
    }
    found
}

pub(crate) fn contains_skill_file(directory: &Path) -> bool {
    let Ok(entries) = fs::read_dir(directory) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && contains_skill_file(&path) {
            return true;
        }
        if path.is_file() && path.file_name().is_some_and(|name| name == "SKILL.md") {
            return true;
        }
    }
    false
}

pub(crate) fn validate_skill(
    id: &str,
    directory: &Path,
    repo: &Path,
    checker: &mut Checker,
    names: &mut BTreeMap<String, String>,
    descriptions: &mut BTreeMap<String, String>,
    audit_help: Option<&crate::sources::AuditHelp>,
) {
    let skill_path = directory.join("SKILL.md");
    let body = match fs::read_to_string(&skill_path) {
        Ok(text) => text,
        Err(error) => {
            checker.fail(format!("{id}: cannot read SKILL.md: {error}"));
            return;
        }
    };

    let (top, nested) = match parse::frontmatter(&body) {
        Ok(parts) => parts,
        Err(error) => {
            checker.fail(format!("{id}: {error}"));
            return;
        }
    };
    checker.ok();

    let description = top
        .get("description")
        .map(|value: &String| value.trim())
        .unwrap_or("");
    if description.is_empty() {
        checker.fail(format!("{id}: description is required for advertisement"));
    } else if description.len() > 1024 {
        checker.fail(format!("{id}: description exceeds 1024 characters"));
    }
    match descriptions.get(description) {
        Some(other) if other != id => checker.fail(format!("{id}: description duplicates {other}")),
        Some(_) => {}
        None => {
            descriptions.insert(description.to_string(), id.to_string());
        }
    }

    if let Some(name) = top.get("name").map(|value: &String| value.trim()) {
        if name.is_empty() {
            checker.fail(format!("{id}: name is present but empty"));
        }
        if let Some(other) = names.insert(name.to_string(), id.to_string()) {
            if other != id {
                checker.fail(format!("{id}: display name duplicates {other}"));
            }
        }
    }

    match top
        .get("license")
        .map(|value| value.trim().to_ascii_lowercase())
    {
        Some(value) if value == "mit" => {}
        Some(value) => checker.fail(format!("{id}: license is {value:?}, expected MIT")),
        None => checker.fail(format!("{id}: license: MIT is required")),
    }

    for (key, value) in &nested {
        let key = key.to_ascii_lowercase();
        if key.contains("autoinvoke") && value.trim().eq_ignore_ascii_case("false") {
            checker.fail(format!(
                "{id}: metadata hides the skill from discovery by default"
            ));
        }
    }
    if top
        .get("disable-model-invocation")
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("true"))
    {
        checker.fail(format!(
            "{id}: disable-model-invocation hides the skill by default"
        ));
    }
    checker.ok();

    let mut files = 0;
    let mut too_long = Vec::new();
    if let Err(error) = walk_files(directory, &mut |path| {
        files += 1;
        if let Ok(text) = fs::read_to_string(path) {
            let lines = text.lines().count();
            if lines > MAX_LINES {
                too_long.push(format!("{} has {lines} lines", path.display()));
            }
        }
    }) {
        checker.fail(format!("{id}: cannot walk files: {error}"));
    }
    for message in too_long {
        checker.fail(message);
    }
    println!("PASS {id}: {files} files");

    let fences = parse::code_fences(&body);
    let mut commands = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for (language, lines) in &fences {
        if !matches!(language.as_str(), "sh" | "shell" | "bash") {
            continue;
        }
        for logical in parse::logical_lines(lines) {
            let line = logical.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(command) = parse::first_command(line) {
                commands.insert(command.to_string());
            }
            for token in line.split_whitespace() {
                if let Some(path) = parse::repo_path_token(token) {
                    paths.insert(path);
                }
            }
        }
    }
    for command in &commands {
        if !ALLOWED_COMMANDS.contains(&command.as_str()) {
            checker.fail(format!(
                "{id}: unsupported command {command:?} in a shell example"
            ));
        }
    }
    checker.ok();

    for path in &paths {
        check_repo_path(repo, id, path, checker);
    }
    checker.ok();

    let mut prose_paths = BTreeSet::new();
    for token in body.split_whitespace() {
        if let Some(path) = parse::repo_path_token(token) {
            prose_paths.insert(path);
        }
    }
    for path in &prose_paths {
        check_repo_path(repo, id, path, checker);
    }
    checker.ok();

    let mut relative = BTreeSet::new();
    for token in body.split_whitespace() {
        for prefix in ["references/", "scripts/", "assets/"] {
            if let Some(index) = token.find(prefix) {
                let candidate = &token[index..];
                let cleaned = candidate.trim_matches(|ch: char| {
                    matches!(
                        ch,
                        '`' | '"' | '\'' | ')' | '(' | ']' | '[' | ',' | '.' | ';' | ':' | '|'
                    )
                });
                if !cleaned.is_empty() {
                    relative.insert(cleaned.to_string());
                }
            }
        }
    }
    for path in &relative {
        if path.contains("..") || path.starts_with('/') {
            checker.fail(format!("{id}: unsafe relative reference {path:?}"));
            continue;
        }
        if repo.join(path).exists() {
            continue;
        }
        if !directory.join(path).is_file() {
            checker.fail(format!("{id}: broken reference {path}"));
        }
    }
    checker.ok();

    for mention in parse::mentions(&body, "@cloakium-") {
        if !EXPECTED.contains(&mention.as_str()) {
            checker.fail(format!("{id}: unknown skill reference @{mention}"));
        }
    }
    checker.ok();

    check_external_contracts(id, &body, repo, checker, audit_help);
}

fn check_repo_path(repo: &Path, id: &str, path: &str, checker: &mut Checker) {
    if path.contains('$') || path.contains('*') || path.contains('?') {
        return;
    }
    if PENDING_PATHS
        .iter()
        .any(|pending| path == *pending || path.starts_with(&format!("{pending}/")))
        && !repo.join(path).exists()
    {
        checker.note(format!(
            "{id}: {path} is an integration gate, not yet present"
        ));
        return;
    }
    if !repo.join(path).exists() {
        checker.fail(format!(
            "{id}: documented repository path does not exist: {path}"
        ));
    }
}

fn check_external_contracts(
    id: &str,
    body: &str,
    repo: &Path,
    checker: &mut Checker,
    audit_help: Option<&crate::sources::AuditHelp>,
) {
    let maintain_path = repo.join("tools/maintain/src/main.rs");
    if let Ok(source) = fs::read_to_string(&maintain_path) {
        let subcommands = crate::sources::parse_subcommands(&source);
        let flags = crate::sources::parse_flags(&source);
        for (command, flag) in parse::documented(body, "cloakium-maintain") {
            if let Some(command) = command {
                if subcommands.contains(&command) {
                    checker.ok();
                } else {
                    checker.fail(format!(
                        "{id}: cloakium-maintain {command} is not a source subcommand"
                    ));
                }
            }
            if let Some(flag) = flag {
                if flags.contains(&flag) {
                    checker.ok();
                } else {
                    checker.fail(format!(
                        "{id}: cloakium-maintain {flag} is absent from main.rs"
                    ));
                }
            }
        }
    } else {
        checker.note("cloakium-maintain source is unavailable");
    }

    let audit_directory = repo.join("tools/browser-audit/src");
    let mut audit_source = None;
    let _ = walk_files(&audit_directory, &mut |path| {
        if audit_source.is_none() && path.extension().is_some_and(|ext| ext == "rs") {
            if let Ok(text) = fs::read_to_string(path) {
                if text.contains("enum Commands") {
                    audit_source = Some(text);
                }
            }
        }
    });
    if audit_help.is_none()
        && repo.join("tools/browser-audit/Cargo.toml").exists()
        && audit_source.is_none()
    {
        checker.fail(format!(
            "{id}: cannot locate the cloakium-audit subcommand source under src/"
        ));
    }
    let audit_implemented = audit_help.is_some() || audit_source.is_some();
    let audit_source = audit_source.unwrap_or_default();
    let audit_subcommands = match audit_help {
        Some(help) => help.subcommands.clone(),
        None if audit_implemented => crate::sources::parse_subcommands(&audit_source),
        None => AUDIT_SUBCOMMANDS.iter().map(|id| id.to_string()).collect(),
    };
    let audit_flags = match audit_help {
        Some(help) => help.flags.clone(),
        None if audit_implemented => crate::sources::parse_flags(&audit_source),
        None => BTreeSet::new(),
    };
    for (command, flag) in parse::documented(body, "cloakium-audit") {
        if let Some(command) = command {
            if !audit_subcommands.contains(&command) {
                checker.fail(format!(
                    "{id}: cloakium-audit {command} is outside the verified help"
                ));
            } else if !audit_implemented {
                checker.note("cloakium-audit help was not supplied and no source was located; contract subcommand only");
            } else {
                checker.ok();
            }
        }
        if let Some(flag) = flag {
            if ["--help", "--version"].contains(&flag.as_str()) {
                checker.ok();
            } else if !audit_implemented {
                checker.note("cloakium-audit help was not supplied and no source was located; contract flag only");
            } else if audit_flags.contains(&flag) {
                checker.ok();
            } else {
                checker.fail(format!(
                    "{id}: cloakium-audit {flag} is absent from verified help"
                ));
            }
        }
    }
    if !audit_implemented
        && body.contains("cloakium-audit")
        && !body.to_ascii_lowercase().contains("integration gate")
    {
        checker.fail(format!(
            "{id}: unverified CLI use needs an integration gate section"
        ));
    }
    checker.ok();
}

fn walk_files(directory: &Path, visit: &mut impl FnMut(&Path)) -> std::io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            walk_files(&path, visit)?;
        } else if path.is_file() {
            visit(&path);
        }
    }
    Ok(())
}
