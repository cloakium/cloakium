# Private outputs, ownership and launch environment

These are the contracts behind `tests/audit/lib/secure-io.mjs`,
`tests/audit/lib/processes.mjs` and `tests/audit/lib/environment.mjs`. Use the
helpers; do not reimplement their semantics.

## Directories

`privateDirectory(directory)` creates the directory with mode 0700, then `lstat`s
it and refuses anything that is not an owned regular directory: symlinks, a
non-directory, a different uid, or any group/other permission bit. An output
root outside the checkout is required; a public or repository path is rejected.

## Fresh artifact: exclusive create, fsync, hardlink

`atomicJson(file, value)` with the default `overwrite: false`:

1. refuses if the final path already exists (`Refusing to overwrite audit
   artifact`);
2. opens `<file>.<pid>.<uuid>.tmp` with `wx` and mode 0600 in the same directory;
3. writes the serialized JSON plus a newline, calls `fsync`, closes;
4. `link(temp, final)` — an exclusive create that fails with `EEXIST` if another
   writer won the race — then unlinks the temporary name.

The visible artifact therefore appears only complete, at mode 0600, and two
concurrent writers cannot both succeed. The unit test "exclusive atomic writes
cannot race to replace each other" proves exactly one fulfillment.

Do not substitute `writeFile(final)`, `copyFile`, or `rename` for a fresh
artifact: all three replace silently.

## Rolling owner report: verified rename

`atomicJson(file, value, { overwrite: true })` is only for the current run's
rolling report. It verifies that an existing file is an owned, non-symlink
regular file, writes and fsyncs a 0600 temporary, then `rename`s it into place.
Rename is atomic but replaces, so it is restricted to a file the same owner run
already owns. A report consumed by another process must use the fresh path.

Payload handling is shared by both modes:

- `serializable` rejects cycles, preserves non-finite numbers as `$number` and
  bigints as `$bigint`, ISO-formats dates, and redacts credential-shaped field
  names (`password`, `authorization`, `proxy-authorization`, `secret`,
  `access_token`, `refresh_token`, `license_key`, `privateKey`);
- `redactText` removes bearer tokens, proxy URL credentials and token/key query
  parameters;
- `safeError` keeps only an operation, a name, a category and a small allowlist
  of error codes; raw target or driver text is omitted because it may contain
  credentials or page output.

The CLI's private writers follow the same rule. `--force` is the explicit
rolling replacement; without it, an existing `inventory`, `plan`, `compare` or
`catalog` output is refused.

## Process ownership

`processIdentity(pid)` reads `/proc/<pid>/stat`, parses after the last `)`, and
records state, parent and `startTicks` (field 22). A process is identified by
`<pid>:<startTicks>`, never by PID alone.

`createProcessTracker(rootPid)`:

- tracks only descendants reachable from the root and already-tracked
  identities;
- keys every row by `pid:startTicks`; a resample whose `startTicks` differs is a
  replaced PID and is not adopted;
- `terminate` signals only a live, same-instance, non-zombie row;
- `waitGone` is bounded by a wall clock;
- unreadable `/proc` state becomes an `unverified` row or a recorded limitation,
  never a silent clean result.

`createChildLease(parentPid)` snapshots identities before the launch and excludes
them, so cleanup never signals the parent or a fixture that existed earlier.
Reusing a checkpoint after a restart therefore requires a matching PID and
start-ticks pair; a matching PID with a different pair is a different process.

## Headless and headed environments

`launchEnvironment` builds an explicit env, not an inherited one:

- `PATH=/run/current-system/sw/bin:/usr/bin:/bin`, `HOME`, `TMPDIR`,
  `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_RUNTIME_DIR`, all
  under the private root;
- `LANG`, `LC_ALL` and `TZ` from the declared profile;
- optional `FONTCONFIG_FILE` and `FONTCONFIG_PATH`, both realpath-resolved and
  hashed.

Headless adds none of `DISPLAY`, `WAYLAND_DISPLAY`, `WAYLAND_SOCKET`,
`XAUTHORITY`. There is no local X dependency and no fallback to a user session.
Headed adds `DISPLAY`, `XAUTHORITY` and `XDG_SESSION_TYPE=x11` only from a
verified owned display whose manifest records an authenticated, reachable Xvfb
and the expected window-manager policy. A placeholder such as
`{display.display}` is rejected outside owned headed mode.

`environmentReceipt` records the env key names, the ambient endpoint keys that
are absent, fontconfig hashes and the display manifest digest. It never records
values that could carry a secret.

`fontInventory` goes beyond labels: it runs the selected `fc-list` with
`--format %{file}`, records each real path with its SHA-256 and byte size, a
digest of the sorted set, and the tool path and hash. Status is `measured`,
`empty` or `unavailable`, with the stated scope that it covers files visible to
fontconfig in the supplied launch environment.

The Nix wrapper sets public fixture-tool paths as environment variables. They are
tool locations, not license or credential values, and the Rust environment
allowlist accepts only the declared keys.

## Shared seat lease

Both the Rust driver and a direct Node run take one lease directory:
`/tmp/opencode/cloakium-audit-seat-<uid>`, created with `mkdir` and never
stolen. `owner.json` is a private 0600 record of `pid` and `startTicks`; release
verifies the directory inode/device and the same instance before removing it.
Rust also takes an outer `flock` around the run (`run --lock PATH`).

`recoverStaleSeat` is manual. Owner death is not sufficient: recovery requires
`ownedChildrenVerifiedGone: true`, re-reads the owner record, and refuses if the
identity changed. There is no automatic stale-PID recovery.

## Socket witness

`socket-witness.mjs` samples `/proc/<pid>/fd` socket inodes and correlates them
with `/proc/<pid>/net/{tcp,tcp6,udp,udp6}` for tracked own processes only. Its
receipt is schema `cloakium.audit.socket-witness/1`, coverage
`sampled-owned-socket-metadata`, and always `absenceEstablished: false`.

Absence of a sampled socket is never zero-egress proof: short-lived or
unattributed sockets, unbound UDP, shared sockets and unowned user processes are
outside the sample. Report the sampled attribution and its limitations, not an
absence claim.

## Report ownership

Node writes `<output>/runner-report.json` with schema
`cloakium.audit.runner/1`. Rust freezes that fragment and writes the final
`<output>/report.json` with schema `cloakium.audit.report/1`. Only the owner
writes the final report; a runner must not create it.

## Credentials

- Never put a license key, proxy password or bearer token in `env` or `argv`.
  Use the client or proxy API for the scoped call.
- Never hash, log, store or print key material; hashes of secrets are still
  disclosures.
- Never feed a key to `redactText` and keep the result; redaction is for output,
  not for storage.
- A raw launch error is fixture-only. Use `safeError` for anything persistent.
