use std::fmt;

/// A patch-replay failure with a human readable, actionable message.
///
/// The tool deliberately has a single error type: every failure is fatal and
/// is printed verbatim by the CLI, so the message must say what was expected
/// and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    message: String,
}

impl Failure {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn with_context(self, context: &str) -> Self {
        Self {
            message: format!("{context}: {}", self.message),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Failure {}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        Self::new(error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Failure>;

#[macro_export]
macro_rules! fail {
    ($($arg:tt)*) => {
        return Err($crate::Failure::new(format!($($arg)*)))
    };
}
