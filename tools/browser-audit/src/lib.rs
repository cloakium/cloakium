//! Original, vendor-agnostic headless browser audit tooling.
//!
//! * [`inventory`] proves an explicitly selected artifact and launcher without
//!   executing either.
//! * [`plan`] generates a versioned comparison plan.
//! * [`validate`] enforces the plan/report contract and completeness.
//! * [`run`] orchestrates a selected Node runner under one wall-clock deadline.
//! * [`compare`] separates capability/contract differences from ordinary value
//!   variation and classifies headless regressions and iteration instability.
//! * [`catalog`] merges canonical gap rows by feature id with provenance.

pub mod catalog;
pub mod compare;
pub mod difference;
pub mod elf;
pub mod environment;
pub mod finalize;
pub mod hash;
pub mod inventory;
pub mod lock;
pub mod model;
pub mod plan;
pub mod policy;
pub mod process;
pub mod report;
pub mod run;
pub mod schema;
pub mod storage;
pub mod time;
pub mod tree;
pub mod util;
pub mod validate;

pub use model::{Plan, PLAN_SCHEMA};
pub use report::{Report, REPORT_SCHEMA, RUNNER_SCHEMA};
