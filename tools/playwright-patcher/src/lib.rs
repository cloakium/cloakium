//! Deterministic, strict replay of the Cloakium `playwright-core` patch set.
//!
//! The tool only understands the unified-diff subset that the Cloakium patch
//! files use: one file header pair, `@@` hunks with exact context, `-`/`+`
//! lines and no trailing-newline markers. Anything outside that subset is a
//! hard error rather than a guess, so a patch can never be applied with fuzz,
//! reversed, or at a guessed location.

pub mod apply;
pub mod document;
pub mod failure;
pub mod fsutil;
pub mod manifest;
pub mod metadata;
pub mod patchfile;
pub mod sha256;

pub use failure::{Failure, Result};
