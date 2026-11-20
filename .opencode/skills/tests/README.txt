Skill validation
================

validate.rs is the dependency-free Rust crate root; validate/ holds its parse,
skill and sources modules. It checks the three project skills under
.opencode/skills for frontmatter, IDs, unique names and descriptions, MIT
license, advertised-by-default state, file size, relative references, skill
cross-references, shell command names, documented repository paths, npm script
existence, cloakium-maintain subcommands and flags, and the cloakium-audit
contract.

Build and run from the repository root:

  nix develop . -c rustc --edition 2021 -O .opencode/skills/tests/validate.rs -o /tmp/cloakium-skill-validate
  nix develop . -c /tmp/cloakium-skill-validate .opencode/skills --help-check \
    --audit-bin "$(nix build .#audit --print-out-paths)/bin/cloakium-audit"

--help-check parses the real --help of tests/parity/run.mjs and
tests/parity/fullscreen.mjs. --audit-bin parses the built CLI's --help and each
subcommand help, and fails when a documented subcommand or flag is absent from
the real output.

This directory contains no SKILL.md, so it is not an OpenCode skill.
