// Passive socket witness: attributes sockets to the processes a tracker owns.
//
// It samples `/proc/<pid>/fd` for `socket:[inode]` links and correlates those
// inodes with `/proc/<pid>/net/{tcp,tcp6,udp,udp6}`. It never reads file
// bodies, argv, environment, credentials or profiles, and it never claims that
// absence of a sampled socket means no egress happened.

import fs from 'node:fs/promises';

export const SOCKET_WITNESS_SCHEMA = 'cloakium.audit.socket-witness/1';
export const SOCKET_WITNESS_COVERAGE = 'sampled-owned-socket-metadata';
export const SOCKET_WITNESS_SUPPORTED = process.platform === 'linux';

const LIMITS = {
  processes: 64,
  fdsPerProcess: 1024,
  tableRows: 8192,
  sockets: 4096,
  errors: 64,
  readlinkBatch: 64,
  procTimeoutMs: 1500,
  trackerTimeoutMs: 3000,
  closeTimeoutMs: 5000,
};

const LIMITATIONS = [
  'sampling: sockets created and closed between samples, or before the first sample, are invisible',
  'short-lived connections may never appear because the witness samples metadata instead of observing packets',
  'process discovery races: a process that exits between tracker.sample() and the /proc read is skipped',
  'UDP sendto sockets that are not bound, shared sockets and DoH hostnames are not attributed',
  'UDP rows carry the kernel st value (normally CLOSE); it is not a connection state',
  'payload content, TLS session state and remote hostnames are never observed',
  'no OS-wide absence proof: this witness reports sampled owned-socket metadata only',
];

const TLS_LIKE_PORTS = new Set([443, 8443]);
const STATE_NAMES = {
  '01': 'ESTABLISHED',
  '02': 'SYN_SENT',
  '03': 'SYN_RECV',
  '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2',
  '06': 'TIME_WAIT',
  '07': 'CLOSE',
  '08': 'CLOSE_WAIT',
  '09': 'LAST_ACK',
  '0A': 'LISTEN',
  '0B': 'CLOSING',
  '0C': 'NEW_SYN_RECV',
};

export function tcpStateName(code) {
  if (typeof code !== 'string') return 'UNKNOWN';
  return STATE_NAMES[code.toUpperCase()] ?? `UNKNOWN(${code})`;
}

export function parseHexPort(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{1,4}$/.test(hex)) return null;
  const port = parseInt(hex, 16);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

export function formatIPv6(bytes) {
  if (!bytes || bytes.length !== 16) return null;
  const mapped =
    bytes.every((b, i) => (i < 10 ? b === 0 : true)) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) {
    return `::ffff:${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  }
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i] === 0) {
      if (runStart < 0) runStart = i;
      runLen += 1;
      if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = runStart;
      }
    } else {
      runStart = -1;
      runLen = 0;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

// Linux prints IPv4 as one little-endian 32-bit word, IPv6 as four such words.
export function parseHexAddress(hex, family) {
  if (typeof hex !== 'string') return null;
  if (family === 'ipv4') {
    if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null;
    const b = [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return b.join('.');
  }
  if (family === 'ipv6') {
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
    const bytes = [];
    for (let word = 0; word < 4; word += 1) {
      const chunk = hex.slice(word * 8, word * 8 + 8);
      for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(chunk.slice(i, i + 2), 16));
    }
    return formatIPv6(bytes);
  }
  return null;
}

/**
 * Parse one /proc/<pid>/net table. Rows with inode 0 cannot be attributed and
 * are skipped; malformed rows produce an explicit error rather than vanishing.
 */
export function parseProcNetTable(text, { protocol, family }) {
  const rows = [];
  const errors = [];
  const table = `${protocol}${family === 'ipv6' ? '6' : ''}`;
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\s*sl\s+local_address/i.test(line)) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) {
      errors.push({ code: 'malformed-table-row', phase: 'table-parse', table, line: i + 1 });
      continue;
    }
    const [, local, remote, stateCode, , , , , , inodeRaw] = fields;
    const [localHex, localPortHex] = String(local).split(':');
    const [remoteHex, remotePortHex] = String(remote).split(':');
    const localAddress = parseHexAddress(localHex, family);
    const remoteAddress = parseHexAddress(remoteHex, family);
    const localPort = parseHexPort(localPortHex);
    const remotePort = parseHexPort(remotePortHex);
    const inode = Number(inodeRaw);
    if (localAddress === null || remoteAddress === null || localPort === null || remotePort === null) {
      errors.push({ code: 'malformed-address', phase: 'table-parse', table, line: i + 1 });
      continue;
    }
    if (!Number.isInteger(inode) || inode < 0) {
      errors.push({ code: 'malformed-inode', phase: 'table-parse', table, line: i + 1 });
      continue;
    }
    if (inode === 0) continue;
    rows.push({
      protocol,
      family,
      inode,
      localAddress,
      localPort,
      remoteAddress,
      remotePort,
      state: tcpStateName(stateCode),
      stateCode: String(stateCode).toUpperCase(),
      mayCarryHostname: TLS_LIKE_PORTS.has(remotePort),
    });
  }
  return { rows, errors };
}

export async function readProcessStartTicks(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const ticks = stat.slice(close + 1).trim().split(/\s+/)[19];
    const value = Number(ticks);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function errorRecord(code, phase, extra = {}) {
  return { code, phase, ...extra };
}

function withTimeout(promise, ms, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

function normalizeIdentities(output) {
  const raw = Array.isArray(output)
    ? output
    : output?.processes ?? output?.identities ?? output?.pids ?? [];
  return Array.isArray(raw) ? raw : [];
}

export function startSocketWitness({ tracker, intervalMs = 100 } = {}) {
  if (!SOCKET_WITNESS_SUPPORTED) {
    const error = new Error('socket witness requires Linux /proc');
    error.code = 'unsupported-platform';
    throw error;
  }
  if (!tracker || typeof tracker.sample !== 'function') {
    throw new TypeError('startSocketWitness requires a tracker with sample()');
  }
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 100;

  const started = new Date().toISOString();
  const sockets = new Map();
  const instances = new Set();
  const errors = [];
  const truncations = [];
  let omittedErrors = 0;
  let truncationsOmitted = 0;
  let samples = 0;
  let closed = false;
  let finalReport = null;
  let inflight = null;

  function recordError(record) {
    if (errors.length < LIMITS.errors) errors.push(record);
    else omittedErrors += 1;
  }

  function recordTruncation(kind, dropped, extra = {}) {
    if (truncations.length >= 32) {
      truncationsOmitted += 1;
      return;
    }
    truncations.push({ kind, dropped, ...extra });
  }

  async function captureProcess(pid, startTicks, perProcess) {
    let names;
    try {
      names = await withTimeout(fs.readdir(`/proc/${pid}/fd`), LIMITS.procTimeoutMs, 'proc-timeout');
    } catch (e) {
      const code =
        e?.code === 'ENOENT'
          ? 'process-vanished'
          : e?.code === 'EACCES'
            ? 'fd-directory-denied'
            : e?.code === 'proc-timeout'
              ? 'proc-timeout'
              : 'fd-directory-error';
      recordError(errorRecord(code, 'fd-scan', { pid }));
      return null;
    }
    if (names.length > LIMITS.fdsPerProcess) {
      recordTruncation('fds', names.length - LIMITS.fdsPerProcess, { pid });
      names = names.slice(0, LIMITS.fdsPerProcess);
    }

    const inodes = new Set();
    for (let i = 0; i < names.length; i += LIMITS.readlinkBatch) {
      const batch = names.slice(i, i + LIMITS.readlinkBatch);
      const links = await Promise.all(
        batch.map(async (name) => {
          try {
            return await withTimeout(
              fs.readlink(`/proc/${pid}/fd/${name}`),
              LIMITS.procTimeoutMs,
              'proc-timeout',
            );
          } catch (e) {
            if (e?.code !== 'ENOENT' && e?.code !== 'ESRCH') {
              recordError(
                errorRecord(e?.code === 'proc-timeout' ? 'proc-timeout' : 'fd-readlink-error', 'fd-scan', {
                  pid,
                }),
              );
            }
            return null;
          }
        }),
      );
      for (const link of links) {
        const match = typeof link === 'string' ? /^socket:\[(\d+)\]$/.exec(link) : null;
        if (match) inodes.add(Number(match[1]));
      }
    }

    const afterTicks = await withTimeout(
      readProcessStartTicks(pid),
      LIMITS.procTimeoutMs,
      'proc-timeout',
    ).catch(() => null);
    if (afterTicks !== startTicks) {
      recordError(errorRecord('identity-mismatch', 'identity-check', { pid }));
      return null;
    }

    perProcess.set(`${pid}:${startTicks}`, { pid, startTicks, inodes });
    return pid;
  }

  async function readTables(pid, inodes, collectedAt) {
    const tables = [
      ['tcp', 'tcp', 'ipv4'],
      ['tcp6', 'tcp', 'ipv6'],
      ['udp', 'udp', 'ipv4'],
      ['udp6', 'udp', 'ipv6'],
    ];
    for (const [file, protocol, family] of tables) {
      let text;
      try {
        text = await withTimeout(
          fs.readFile(`/proc/${pid}/net/${file}`, 'utf8'),
          LIMITS.procTimeoutMs,
          'proc-timeout',
        );
      } catch (e) {
        const code =
          e?.code === 'ENOENT'
            ? 'table-unavailable'
            : e?.code === 'EACCES'
              ? 'table-denied'
              : e?.code === 'proc-timeout'
                ? 'proc-timeout'
                : 'table-error';
        if (code !== 'table-unavailable') {
          recordError(errorRecord(code, 'table-read', { pid, table: file }));
        }
        continue;
      }
      const parsed = parseProcNetTable(text, { protocol, family });
      for (const error of parsed.errors) recordError({ ...error, pid });
      const rows = parsed.rows.length > LIMITS.tableRows ? parsed.rows.slice(0, LIMITS.tableRows) : parsed.rows;
      if (parsed.rows.length > LIMITS.tableRows) {
        recordTruncation('tableRows', parsed.rows.length - LIMITS.tableRows, { pid, table: file });
      }
      for (const row of rows) {
        if (!inodes.has(row.inode)) continue;
        const key = `${pid}:${collectedAt.startTicks}:${row.inode}`;
        const existing = sockets.get(key);
        if (existing) {
          existing.lastSeen = collectedAt.at;
          existing.state = row.state;
          existing.remoteAddress = row.remoteAddress;
          existing.remotePort = row.remotePort;
          continue;
        }
        if (sockets.size >= LIMITS.sockets) {
          recordTruncation('sockets', 1, { pid });
          continue;
        }
        sockets.set(key, {
          owner: { pid, startTicks: collectedAt.startTicks },
          inode: row.inode,
          protocol: row.protocol,
          family: row.family,
          localAddress: row.localAddress,
          localPort: row.localPort,
          remoteAddress: row.remoteAddress,
          remotePort: row.remotePort,
          state: row.state,
          firstSeen: collectedAt.at,
          lastSeen: collectedAt.at,
        });
      }
    }
  }

  async function sampleOnce() {
    const at = new Date().toISOString();
    let output;
    try {
      output = await withTimeout(
        Promise.resolve(tracker.sample()),
        LIMITS.trackerTimeoutMs,
        'tracker-timeout',
      );
    } catch (e) {
      recordError(errorRecord(e?.code === 'tracker-timeout' ? 'tracker-timeout' : 'tracker-error', 'tracker'));
      samples += 1;
      return { sampledAt: at, processInstances: instances.size, sockets: sockets.size };
    }

    let identities = normalizeIdentities(output);
    if (identities.length > LIMITS.processes) {
      recordTruncation('processes', identities.length - LIMITS.processes);
      identities = identities.slice(0, LIMITS.processes);
    }
    const perProcess = new Map();
    const seen = new Set();
    for (const raw of identities) {
      const pid = Number(raw?.pid);
      const startTicks = Number(raw?.startTicks);
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(startTicks) || startTicks < 0) {
        recordError(errorRecord('invalid-identity', 'tracker'));
        continue;
      }
      const key = `${pid}:${startTicks}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const before = await withTimeout(
        readProcessStartTicks(pid),
        LIMITS.procTimeoutMs,
        'proc-timeout',
      ).catch(() => null);
      if (before === null) {
        recordError(errorRecord('process-unavailable', 'identity-check', { pid }));
        continue;
      }
      if (before !== startTicks) {
        recordError(errorRecord('identity-mismatch', 'identity-check', { pid }));
        continue;
      }
      instances.add(key);
      await captureProcess(pid, startTicks, perProcess);
    }

    for (const entry of perProcess.values()) {
      await readTables(entry.pid, entry.inodes, { at, startTicks: entry.startTicks });
    }
    if (sockets.size > LIMITS.sockets) {
      recordTruncation('sockets', sockets.size - LIMITS.sockets);
    }
    samples += 1;
    return {
      sampledAt: at,
      processInstances: instances.size,
      sockets: perProcess.size,
    };
  }

  function sample() {
    if (closed) return Promise.resolve(finalReport ?? null);
    if (inflight) return inflight;
    inflight = sampleOnce()
      .catch((e) => {
        recordError(errorRecord('sample-failed', 'sample', { detail: String(e?.code ?? 'error') }));
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  const timer = setInterval(() => {
    if (!inflight) void sample();
  }, period);
  if (typeof timer.unref === 'function') timer.unref();

  async function close() {
    if (finalReport) return finalReport;
    closed = true;
    clearInterval(timer);
    if (inflight) {
      await Promise.race([
        inflight,
        new Promise((resolve) => {
          const t = setTimeout(resolve, LIMITS.closeTimeoutMs);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
    }
    const listed = [...sockets.values()].slice(0, LIMITS.sockets);
    finalReport = {
      schema: SOCKET_WITNESS_SCHEMA,
      coverage: SOCKET_WITNESS_COVERAGE,
      started,
      finished: new Date().toISOString(),
      samples,
      processInstances: instances.size,
      sockets: listed,
      errors,
      limitations: [...LIMITATIONS],
      absenceEstablished: false,
      truncations,
      truncationsOmitted,
      errorsOmitted: omittedErrors,
    };
    return finalReport;
  }

  return { sample, close };
}
