export const HOST = '127.0.0.1:41001';

export function fakeLab() {
  const handle = (port, extra = {}) => {
    const state = { tick: 0 };
    const accepted = [{
      kind: extra.socks ? 'socks5-connect' : 'absolute',
      targetHost: '127.0.0.1', targetPort: 41001, localPort: 40000,
      openedAt: Date.now() - 5000, connectedAt: Date.now() - 5000, closedAt: null,
      path: '/echo', auth: 'not-required'
    }];
    return {
      url: extra.socks ? `socks5://127.0.0.1:${port}` : `http://127.0.0.1:${port}`,
      port, requireAuth: Boolean(extra.credentials), credentials: extra.credentials ?? null,
      stats: () => {
        state.tick += 1;
        return {
          absoluteRequests: state.tick, connects: state.tick, authOk: state.tick, rejectedAuth: 0,
          authFail: 0, greetings: state.tick, udpAssociateRequests: 0, targets: [], relayPorts: [],
          offeredMethods: {}, atypCounts: { domain: state.tick },
          accepted, acceptedTotal: accepted.length, acceptedTruncated: 0,
          coverage: { complete: true, records: accepted.length, total: accepted.length, truncated: 0 }
        };
      }
    };
  };
  return {
    origin: `http://${HOST}`, crossOrigin: 'http://[::1]:41001',
    crossOriginMode: 'ipv6-loopback-same-port', port: 41001,
    proxy: {
      http: handle(41002),
      httpAuth: handle(41003, { credentials: { username: 'u', password: 'p' } }),
      socks5: handle(41004, { socks: true }),
      socks5Auth: handle(41005, { socks: true, credentials: { username: 'u', password: 'p' } })
    },
    stun: { url: 'stun:127.0.0.1:41006', stats: () => ({ requests: 0, responses: 0, sourcePorts: [], nonLoopbackSources: 0 }) },
    dns: { stats: () => ({ queries: [] }) },
    tap: { url: 'https://localhost:41007', port: 41007, stats: () => ({ captured: 0, last: null }) },
    tls: { available: false }, http2: { available: false }, h3: { available: false },
    doh: { available: false }, transparentProxy: { available: false },
    originStats: () => ({ hits: {}, requests: [] }),
    close: async () => ({ closed: true, resources: 0, closedResources: 0, errors: [] })
  };
}
