//! Cloakium maintenance tooling.
//!
//! The commands are deliberately separate so an untrusted build job never runs
//! with the signing key:
//!
//! * [`update`] prepares an upstream candidate and never publishes anything.
//! * [`validate_update`] accepts only the pin changes an update may make.
//! * [`release`] stages a flat Nix cache, unsigned when asked.
//! * [`sign_release`] re-verifies a staged release and signs it with the
//!   trusted publisher key.
//! * [`verify_publication`] cross-checks an already published release without
//!   any network access.
//!
//! [`cache`] holds the Nix cache staging logic on its own so it can be tested
//! without a store, and [`command`] abstracts subprocess execution so tests can
//! drive every step without invoking real tools.

pub mod cache;
pub mod command;
pub mod evidence;
pub mod narinfo;
pub mod npm_pack;
pub mod release;
pub mod release_meta;
pub mod report;
pub mod sign_assets;
pub mod sign_release;
pub mod sign_validate;
pub mod update;
pub mod update_candidate;
pub mod util;
pub mod validate_update;
pub mod verify_publication;

pub use command::{Command, MockRunner, Output, ProcessRunner, Runner};
pub use report::Reporter;
