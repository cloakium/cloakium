//! Pacing, retry backoff and the injected wall clock for release uploads.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use anyhow::{bail, Result};

/// Spacing between content-generating operations (upload POST, asset DELETE).
pub const PACE_INTERVAL: Duration = Duration::from_secs(8);
pub const PACE_WINDOW: Duration = Duration::from_secs(3600);
/// Hard cap on content operations in one rolling hour, below GitHub's 500.
pub const PACE_WINDOW_LIMIT: usize = 440;
/// Documented fallback when a secondary rate limit arrives without a header.
pub const RATE_LIMIT_FALLBACK: Duration = Duration::from_secs(60);
/// First wait for a transport failure that is not a rate limit.
pub const TRANSIENT_FALLBACK: Duration = Duration::from_secs(15);
pub const MAX_BACKOFF: Duration = Duration::from_secs(900);
/// Time held back from the deadline so a command can still run after a wait.
pub const DEADLINE_MARGIN: Duration = Duration::from_secs(10);

/// Wall clock used for pacing and the whole-command deadline.
///
/// `now` is absolute elapsed time; a [`Pacer`] deadline is measured from the
/// clock's origin, which precedes any local validation work.
pub trait Clock {
    fn now(&self) -> Duration;
    fn sleep(&mut self, duration: Duration);
}

/// Real elapsed time and real sleeps.
#[derive(Debug)]
pub struct SystemClock {
    started: Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.started.elapsed()
    }

    fn sleep(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

/// Virtual time: sleeps are recorded and skipped so tests never wait.
#[derive(Debug, Default)]
pub struct ManualClock {
    elapsed: Duration,
    sleeps: Vec<Duration>,
}

impl ManualClock {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn sleeps(&self) -> &[Duration] {
        &self.sleeps
    }

    pub fn total_slept(&self) -> Duration {
        self.sleeps.iter().copied().sum()
    }

    /// Move virtual time forward without recording a sleep.
    pub fn advance(&mut self, duration: Duration) {
        self.elapsed += duration;
    }
}

impl Clock for ManualClock {
    fn now(&self) -> Duration {
        self.elapsed
    }

    fn sleep(&mut self, duration: Duration) {
        self.sleeps.push(duration);
        self.elapsed += duration;
    }
}

/// Enforces spacing, the rolling-window cap and the whole-command deadline.
#[derive(Debug)]
pub struct Pacer {
    deadline: Duration,
    interval: Duration,
    window: Duration,
    window_limit: usize,
    recent: VecDeque<Duration>,
    next_allowed: Duration,
    operations: usize,
}

impl Pacer {
    /// `deadline` is absolute elapsed time since the clock's origin.
    pub fn new(deadline: Duration) -> Self {
        Self {
            deadline,
            interval: PACE_INTERVAL,
            window: PACE_WINDOW,
            window_limit: PACE_WINDOW_LIMIT,
            recent: VecDeque::new(),
            next_allowed: Duration::ZERO,
            operations: 0,
        }
    }

    /// Content-generating operations performed so far.
    pub fn operations(&self) -> usize {
        self.operations
    }

    /// Timeout for the next child command, clipped by what is left of the deadline.
    pub fn budget(&self, clock: &dyn Clock, cap: Duration) -> Result<Duration> {
        let now = clock.now();
        ensure_time(now + DEADLINE_MARGIN, self.deadline)?;
        Ok(self.deadline.saturating_sub(now).min(cap))
    }

    /// Wait until GitHub pacing allows another content-generating operation.
    pub fn before_content(&mut self, clock: &mut dyn Clock) -> Result<()> {
        while let Some(oldest) = self.recent.front().copied() {
            if clock.now().saturating_sub(oldest) >= self.window {
                self.recent.pop_front();
            } else {
                break;
            }
        }
        if self.recent.len() >= self.window_limit {
            let oldest = *self.recent.front().expect("window is not empty");
            self.wait_until(&mut *clock, oldest + self.window)?;
        }
        let next_allowed = self.next_allowed;
        self.wait_until(clock, next_allowed)
    }

    /// Record a content-generating operation so the next one is spaced.
    pub fn after_content(&mut self, clock: &mut dyn Clock) {
        let now = clock.now();
        self.next_allowed = now + self.interval;
        self.recent.push_back(now);
        self.operations += 1;
    }

    /// Exponential backoff. Attempt 0 is the first wait after a failure.
    pub fn backoff(
        &mut self,
        clock: &mut dyn Clock,
        attempt: usize,
        rate_limited: bool,
    ) -> Result<()> {
        let base = if rate_limited {
            RATE_LIMIT_FALLBACK
        } else {
            TRANSIENT_FALLBACK
        };
        let delay = base.saturating_mul(1 << attempt.min(4)).min(MAX_BACKOFF);
        let target = clock.now() + delay;
        self.wait_until(clock, target)
    }

    fn wait_until(&mut self, clock: &mut dyn Clock, target: Duration) -> Result<()> {
        let now = clock.now();
        if target <= now {
            return Ok(());
        }
        ensure_time(target + DEADLINE_MARGIN, self.deadline)?;
        clock.sleep(target - now);
        Ok(())
    }
}

fn ensure_time(required: Duration, deadline: Duration) -> Result<()> {
    if required > deadline {
        bail!(
            "the upload deadline of {}s would be exceeded waiting for GitHub pacing; \
             pass a larger --timeout and resume (already complete assets are skipped)",
            deadline.as_secs()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_operations_are_spaced_by_the_interval() {
        let mut clock = ManualClock::new();
        let mut pacer = Pacer::new(Duration::from_secs(600));
        for _ in 0..3 {
            pacer.before_content(&mut clock).expect("pace");
            pacer.after_content(&mut clock);
        }
        assert_eq!(clock.sleeps(), [PACE_INTERVAL, PACE_INTERVAL]);
        assert_eq!(pacer.operations(), 3);
    }

    #[test]
    fn the_rolling_window_cap_forces_a_full_window_wait() {
        let mut clock = ManualClock::new();
        let mut pacer = Pacer::new(Duration::from_secs(100_000));
        pacer.window_limit = 2;
        pacer.interval = Duration::from_secs(1);
        for _ in 0..2 {
            pacer.before_content(&mut clock).expect("pace");
            pacer.after_content(&mut clock);
        }
        pacer.before_content(&mut clock).expect("pace");
        assert_eq!(
            clock.sleeps().last().copied(),
            Some(PACE_WINDOW - Duration::from_secs(1))
        );
    }

    #[test]
    fn rate_limits_back_off_exponentially_from_a_minute() {
        let mut clock = ManualClock::new();
        let mut pacer = Pacer::new(Duration::from_secs(10_000));
        pacer.backoff(&mut clock, 0, true).expect("backoff");
        pacer.backoff(&mut clock, 1, true).expect("backoff");
        pacer.backoff(&mut clock, 2, true).expect("backoff");
        assert_eq!(
            clock.sleeps(),
            [
                Duration::from_secs(60),
                Duration::from_secs(120),
                Duration::from_secs(240)
            ]
        );
    }

    #[test]
    fn the_deadline_bounds_every_wait() {
        let mut clock = ManualClock::new();
        let mut pacer = Pacer::new(Duration::from_secs(90));
        let error = pacer.backoff(&mut clock, 1, true).expect_err("deadline");
        assert!(format!("{error:#}").contains("deadline"), "{error:#}");
        assert!(clock.sleeps().is_empty());
    }

    #[test]
    fn budgets_shrink_towards_the_deadline() {
        let mut clock = ManualClock::new();
        let pacer = Pacer::new(Duration::from_secs(600));
        assert_eq!(
            pacer.budget(&clock, CRATE_CAP).expect("budget"),
            Duration::from_secs(600)
        );
        clock.advance(Duration::from_secs(580));
        assert_eq!(
            pacer.budget(&clock, CRATE_CAP).expect("budget"),
            Duration::from_secs(20)
        );
        clock.advance(Duration::from_secs(30));
        assert!(pacer.budget(&clock, CRATE_CAP).is_err());
    }

    const CRATE_CAP: Duration = Duration::from_secs(3600);
}
