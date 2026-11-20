# Recovery after a failed update

## First, separate the states

`update` refreshes the nixpkgs lock before it decides whether anything changed,
and restores the previous lock itself on a no-op without `--refresh-toolchain`.
A failure can still leave a mix of new lock, old metadata or a partially written
package file.

Inspect before touching anything:

```sh
jj status
jj diff --stat
jj diff -- flake.lock upstream.json package.json package-lock.json nix/npm-deps-hash.nix
```

Write down which of the five paths changed. The candidate directory is separate
evidence and is never deleted to make the working copy look clean.

## A rejected candidate

The validator rejected the candidate, not the base. Keep
`artifacts/candidate` and its validator output. Fix the cause in the updater or
the upstream patch, then re-run `update` from the unchanged base. Do not hand-edit
the candidate to satisfy the validator; the validator exists to catch exactly
that.

## A partially written working copy

Discarding is a user decision. When the user agrees, discard only the five
metadata paths, never the whole working copy:

```sh
jj restore --from @- -- flake.lock upstream.json package.json package-lock.json nix/npm-deps-hash.nix
```

This overwrites any user edits on those paths, so check `jj diff` first and get
explicit agreement. Do not use `jj restore` without paths, and do not reset the
working copy.

## A native build failure

Keep the log, not a retry loop:

```sh
nix log .#chromium
```

Distinguish capacity from code: a missing builder, disk exhaustion or OOM is a
blocked gate and needs a builder; a compiler error is a code or toolchain
failure. Do not re-run a cold build on a host that already failed for capacity.
Do not disable the sandbox or the patch check to get past it.

## A parity failure

Read the report, do not average it. Identify whether the difference is:

- an engine behaviour change (present in both profile variants);
- a Playwright implicit default (disappears with `--native-defaults`);
- an intentional fail-closed path (WebRTC, proxy, key protection);
- a declared diagnostic (X11 physical-window effects, window-manager insets);
- an unstable observation (order or timing dependent).

Only the first is an engine regression. Preserve the others and document them;
never add an arbitrary property exclusion or a page getter override.

## A network or registry failure

A failed `npm view`, `nix flake update` or unavailable registry is not an
unchanged pair. Retain the output, report the exact failing command and stop.
Re-running later is a new attempt, not a resumed success.
