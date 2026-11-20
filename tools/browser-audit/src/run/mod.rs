//! Whole-plan run orchestration.
//!
//! Rust holds the seat, inventories before launch, clears the environment, owns
//! one Node process and its detached descendants, and validates the report.

mod orchestrator;
mod support;
#[cfg(test)]
mod support_tests;

pub use orchestrator::execute;
pub(crate) use support::invalid_fragment_summary;
pub use support::{RunOptions, RunOutcome};
