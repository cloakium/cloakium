//! `/proc/<pid>/stat` ownership tracking for detached browser descendants.
//! Identity-guarded pid+starttime only; never reads cmdline, environ or names.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::raw::c_int;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const SIGTERM: c_int = 15;
const SIGKILL: c_int = 9;
const SAMPLE_SLICE: Duration = Duration::from_millis(100);

extern "C" {
    fn kill(process: c_int, signal: c_int) -> c_int;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct OwnedProcess {
    pub pid: u32,
    pub start_ticks: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignalRecord {
    pub pid: u32,
    pub start_ticks: u64,
    pub signal: i32,
    pub delivered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCleanup {
    pub root_pid: u32,
    pub root_start_ticks: u64,
    pub discovered: Vec<OwnedProcess>,
    pub signalled: Vec<SignalRecord>,
    pub residual: Vec<OwnedProcess>,
    pub clean: bool,
}

struct Stat {
    ppid: u32,
    start_ticks: u64,
}

struct Snapshot {
    stats: BTreeMap<u32, Stat>,
    unavailable: BTreeSet<u32>,
    scan_failed: bool,
}

enum StatRead {
    Found(Stat),
    Gone,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessStatus {
    Live,
    Gone,
    Unavailable,
}

pub struct ProcessTree {
    root: OwnedProcess,
    known: BTreeMap<u32, OwnedProcess>,
    history: BTreeMap<(u32, u64), OwnedProcess>,
    signalled: Vec<SignalRecord>,
    initial_group: i32,
    uncertain: bool,
}

impl ProcessTree {
    pub fn new(root_pid: u32) -> Option<Self> {
        let stat = read_stat(root_pid)?;
        Some(Self {
            root: OwnedProcess {
                pid: root_pid,
                start_ticks: stat.start_ticks,
            },
            known: BTreeMap::new(),
            history: BTreeMap::new(),
            signalled: Vec::new(),
            initial_group: -(root_pid as i32),
            uncertain: false,
        })
    }

    pub fn sample(&mut self) {
        let snapshot = scan();
        if snapshot.scan_failed || !snapshot.unavailable.is_empty() {
            self.uncertain = true;
        }
        if snapshot.unavailable.contains(&self.root.pid) {
            self.uncertain = true;
        }
        for pid in self.known.keys() {
            if snapshot.unavailable.contains(pid) {
                self.uncertain = true;
            }
        }
        let retained: Vec<OwnedProcess> = if snapshot.scan_failed {
            self.known.values().cloned().collect()
        } else {
            self.known
                .values()
                .filter(|identity| snapshot.unavailable.contains(&identity.pid))
                .cloned()
                .collect()
        };
        let discovered = if snapshot.scan_failed {
            BTreeSet::new()
        } else {
            discover_owned(&snapshot.stats, &self.root, &self.known)
        };
        self.known.clear();
        for identity in discovered.into_iter().chain(retained) {
            self.history
                .insert((identity.pid, identity.start_ticks), identity.clone());
            self.known.insert(identity.pid, identity);
        }
    }

    pub fn terminate(&mut self, grace: Duration) {
        self.sample();
        let root_alive = identity_matches(self.root.pid, self.root.start_ticks);
        if root_alive {
            self.signal_group(SIGTERM);
        }
        for identity in self.live_descendants() {
            self.signal(identity, SIGTERM);
        }
        let deadline = Instant::now() + grace;
        while Instant::now() < deadline {
            thread::sleep(SAMPLE_SLICE);
            self.sample();
            if !root_alive && self.live_descendants().is_empty() {
                break;
            }
        }
        self.sample();
        if identity_matches(self.root.pid, self.root.start_ticks) {
            self.signal_group(SIGKILL);
        }
        for identity in self.live_descendants() {
            self.signal(identity, SIGKILL);
        }
        thread::sleep(SAMPLE_SLICE);
        self.sample();
    }

    /// The runner exited normally. Any detached descendant still alive is an
    /// owned orphan; give it a short graceful shutdown instead of leaving it.
    pub fn finish_normal(&mut self) {
        self.sample();
        if !self.live_descendants().is_empty() {
            self.terminate(Duration::from_millis(500));
        }
    }

    pub fn receipt(self) -> ProcessCleanup {
        let mut this = self;
        this.sample();
        let residual = this.live_descendants();
        ProcessCleanup {
            root_pid: this.root.pid,
            root_start_ticks: this.root.start_ticks,
            discovered: this.history.values().cloned().collect(),
            signalled: this.signalled,
            residual: residual.clone(),
            clean: residual.is_empty() && !this.uncertain,
        }
    }

    fn live_descendants(&self) -> Vec<OwnedProcess> {
        self.known
            .values()
            .filter(|identity| identity_matches(identity.pid, identity.start_ticks))
            .cloned()
            .collect()
    }

    fn signal_group(&mut self, signal: c_int) {
        if !identity_matches(self.root.pid, self.root.start_ticks) {
            return;
        }
        let delivered = unsafe { kill(self.initial_group, signal) } == 0;
        self.signalled.push(SignalRecord {
            pid: self.root.pid,
            start_ticks: self.root.start_ticks,
            signal,
            delivered,
        });
    }

    fn signal(&mut self, identity: OwnedProcess, signal: c_int) {
        if !identity_matches(identity.pid, identity.start_ticks) {
            return;
        }
        let delivered = unsafe { kill(identity.pid as c_int, signal) } == 0;
        self.signalled.push(SignalRecord {
            pid: identity.pid,
            start_ticks: identity.start_ticks,
            signal,
            delivered,
        });
    }
}

pub fn pid_is_live(pid: u32) -> bool {
    process_status(pid) == ProcessStatus::Live
}

pub fn process_status(pid: u32) -> ProcessStatus {
    match read_stat_status(pid) {
        StatRead::Found(_) => ProcessStatus::Live,
        StatRead::Gone => ProcessStatus::Gone,
        StatRead::Unavailable => ProcessStatus::Unavailable,
    }
}

pub fn start_ticks(pid: u32) -> Option<u64> {
    read_stat(pid).map(|stat| stat.start_ticks)
}

fn identity_matches(pid: u32, start_ticks: u64) -> bool {
    read_stat(pid).is_some_and(|stat| stat.start_ticks == start_ticks)
}

fn discover_owned(
    snapshot: &BTreeMap<u32, Stat>,
    root: &OwnedProcess,
    known: &BTreeMap<u32, OwnedProcess>,
) -> BTreeSet<OwnedProcess> {
    let mut tracked: BTreeSet<u32> = BTreeSet::new();
    if snapshot
        .get(&root.pid)
        .is_some_and(|stat| stat.start_ticks == root.start_ticks)
    {
        tracked.insert(root.pid);
    }
    for (pid, identity) in known {
        if snapshot
            .get(pid)
            .is_some_and(|stat| stat.start_ticks == identity.start_ticks)
        {
            tracked.insert(*pid);
        }
    }
    loop {
        let before = tracked.len();
        for (pid, stat) in snapshot {
            if tracked.contains(&stat.ppid) {
                tracked.insert(*pid);
            }
        }
        if tracked.len() == before {
            break;
        }
    }
    tracked.remove(&root.pid);
    tracked
        .into_iter()
        .filter_map(|pid| {
            snapshot.get(&pid).map(|stat| OwnedProcess {
                pid,
                start_ticks: stat.start_ticks,
            })
        })
        .collect()
}

fn scan() -> Snapshot {
    let mut snapshot = Snapshot {
        stats: BTreeMap::new(),
        unavailable: BTreeSet::new(),
        scan_failed: false,
    };
    let entries = match fs::read_dir("/proc") {
        Ok(entries) => entries,
        Err(_) => {
            snapshot.scan_failed = true;
            return snapshot;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                snapshot.scan_failed = true;
                continue;
            }
        };
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        match read_stat_status(pid) {
            StatRead::Found(stat) => {
                snapshot.stats.insert(pid, stat);
            }
            StatRead::Gone => {}
            StatRead::Unavailable => {
                snapshot.unavailable.insert(pid);
            }
        }
    }
    snapshot
}

fn read_stat(pid: u32) -> Option<Stat> {
    match read_stat_status(pid) {
        StatRead::Found(stat) => Some(stat),
        StatRead::Gone | StatRead::Unavailable => None,
    }
}

fn read_stat_status(pid: u32) -> StatRead {
    let text = match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return StatRead::Gone,
        Err(_) => return StatRead::Unavailable,
    };
    let Some(close) = text.rfind(')') else {
        return StatRead::Unavailable;
    };
    let Some(rest) = text.get(close + 1..) else {
        return StatRead::Unavailable;
    };
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // After comm: state(3) ppid(4) pgrp(5) session(6) ... starttime(22).
    let Some(ppid) = fields.get(1).and_then(|value| value.parse().ok()) else {
        return StatRead::Unavailable;
    };
    let Some(start_ticks) = fields.get(19).and_then(|value| value.parse().ok()) else {
        return StatRead::Unavailable;
    };
    StatRead::Found(Stat { ppid, start_ticks })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stat(ppid: u32, start_ticks: u64) -> Stat {
        Stat { ppid, start_ticks }
    }

    #[test]
    fn reused_root_never_adopts_foreign_children() {
        let root = OwnedProcess {
            pid: 1,
            start_ticks: 10,
        };
        let snapshot = BTreeMap::from([(1, stat(0, 20)), (2, stat(1, 20)), (3, stat(2, 20))]);
        assert!(discover_owned(&snapshot, &root, &BTreeMap::new()).is_empty());
    }

    #[test]
    fn reused_known_child_never_adopts_foreign_grandchildren() {
        let root = OwnedProcess {
            pid: 1,
            start_ticks: 10,
        };
        let known = BTreeMap::from([(
            2,
            OwnedProcess {
                pid: 2,
                start_ticks: 30,
            },
        )]);
        let snapshot = BTreeMap::from([(2, stat(1, 31)), (3, stat(2, 31))]);
        assert!(discover_owned(&snapshot, &root, &known).is_empty());
    }

    #[test]
    fn same_instance_orphan_keeps_its_new_descendants() {
        let root = OwnedProcess {
            pid: 1,
            start_ticks: 10,
        };
        let known = BTreeMap::from([(
            2,
            OwnedProcess {
                pid: 2,
                start_ticks: 30,
            },
        )]);
        let snapshot = BTreeMap::from([(2, stat(1, 30)), (3, stat(2, 40))]);
        let discovered = discover_owned(&snapshot, &root, &known);
        assert!(discovered.contains(&OwnedProcess {
            pid: 2,
            start_ticks: 30
        }));
        assert!(discovered.contains(&OwnedProcess {
            pid: 3,
            start_ticks: 40
        }));
    }

    #[test]
    fn history_is_preserved_but_not_used_for_live_ownership() {
        let pid = std::process::id();
        let start = read_stat(pid).expect("stat").start_ticks;
        let mut tree = ProcessTree {
            root: OwnedProcess {
                pid,
                start_ticks: start,
            },
            known: BTreeMap::new(),
            history: BTreeMap::from([(
                (424_242, 7),
                OwnedProcess {
                    pid: 424_242,
                    start_ticks: 7,
                },
            )]),
            signalled: Vec::new(),
            initial_group: -(pid as i32),
            uncertain: false,
        };
        tree.sample();
        let receipt = tree.receipt();
        assert!(receipt.discovered.contains(&OwnedProcess {
            pid: 424_242,
            start_ticks: 7
        }));
    }

    #[test]
    fn uncertain_scan_is_not_clean() {
        let pid = std::process::id();
        let start = read_stat(pid).expect("stat").start_ticks;
        let tree = ProcessTree {
            root: OwnedProcess {
                pid,
                start_ticks: start,
            },
            known: BTreeMap::new(),
            history: BTreeMap::new(),
            signalled: Vec::new(),
            initial_group: -(pid as i32),
            uncertain: true,
        };
        assert!(!tree.receipt().clean);
    }

    #[test]
    fn current_process_has_a_stable_identity() {
        let pid = std::process::id();
        let first = read_stat(pid).expect("stat");
        let second = read_stat(pid).expect("stat");
        assert_eq!(first.start_ticks, second.start_ticks);
        assert!(identity_matches(pid, first.start_ticks));
        assert!(!identity_matches(pid, first.start_ticks.saturating_add(1)));
    }
}

#[cfg(test)]
mod signal_tests {
    use super::*;
    use std::path::PathBuf;

    fn which(name: &str) -> Option<PathBuf> {
        for directory in std::env::split_paths(&std::env::var_os("PATH")?) {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }

    #[test]
    fn a_reused_pid_identity_is_not_signalled() {
        let Some(sleep) = which("sleep") else {
            return;
        };
        let mut child = std::process::Command::new(sleep)
            .arg("30")
            .spawn()
            .expect("sleep");
        let mut tree = ProcessTree::new(child.id()).expect("tree");
        tree.root.start_ticks = tree.root.start_ticks.saturating_add(1);
        tree.signal_group(SIGTERM);
        assert!(pid_is_live(child.id()));
        let _ = child.kill();
        let _ = child.wait();
    }
}
