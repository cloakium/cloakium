import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fixtureEnv, privateRoot, withDeadline } from "./util.mjs";

const run = promisify(execFile);
const OPENSSL_TIMEOUT_MS = 30_000;

let cachedOpenssl;

/**
 * Resolve an OpenSSL CLI from OPENSSL_BIN or PATH only. No filesystem scan: a
 * bounded, explicit lookup that cannot walk the store or inherit ambient state.
 */
export function resolveOpenssl() {
  if (cachedOpenssl !== undefined) return cachedOpenssl;
  const candidates = [];
  if (process.env.OPENSSL_BIN) candidates.push(process.env.OPENSSL_BIN);
  candidates.push("openssl");
  cachedOpenssl =
    candidates.find((candidate) => {
      try {
        const probe = spawnSync(candidate, ["version"], {
          timeout: 5_000,
          stdio: "ignore",
          env: fixtureEnv(),
        });
        return probe.status === 0;
      } catch {
        return false;
      }
    }) ?? null;
  return cachedOpenssl;
}

export const EXTENSION_CONFIG = [
  "basicConstraints=CA:FALSE",
  "keyUsage=critical,digitalSignature,keyEncipherment",
  "extendedKeyUsage=serverAuth",
  "subjectAltName=IP:127.0.0.1,DNS:localhost",
  "",
].join("\n");

/**
 * Ephemeral CA + leaf certificate for loopback TLS fixtures.
 * Keys live only in a throwaway directory under the lab temp root.
 */
export async function createTlsMaterial() {
  const openssl = resolveOpenssl();
  if (!openssl) return { available: false, reason: "no OpenSSL CLI resolved (set OPENSSL_BIN)" };

  let dir;
  try {
    dir = await mkdtemp(path.join(privateRoot(), "cloakium-lab-tls-"));
  } catch (error) {
    return { available: false, reason: `temp dir failed: ${error.message}` };
  }

  const at = (name) => path.join(dir, name);
  const steps = [
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "2",
      "-keyout",
      at("ca-key.pem"),
      "-out",
      at("ca-cert.pem"),
      "-subj",
      "/CN=Cloakium Lab CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-keyout",
      at("leaf-key.pem"),
      "-out",
      at("leaf.csr"),
      "-subj",
      "/CN=127.0.0.1",
    ],
  ];

  try {
    await writeFile(at("ext.cnf"), EXTENSION_CONFIG, "utf8");
    for (const args of steps) {
      await withDeadline(
        run(openssl, args, { timeout: OPENSSL_TIMEOUT_MS, env: fixtureEnv(), cwd: dir }),
        OPENSSL_TIMEOUT_MS,
        "openssl req",
      );
    }
    await withDeadline(
      run(
        openssl,
        [
          "x509",
          "-req",
          "-in",
          at("leaf.csr"),
          "-CA",
          at("ca-cert.pem"),
          "-CAkey",
          at("ca-key.pem"),
          "-CAcreateserial",
          "-days",
          "2",
          "-sha256",
          "-extfile",
          at("ext.cnf"),
          "-out",
          at("leaf-cert.pem"),
        ],
        { timeout: OPENSSL_TIMEOUT_MS, env: fixtureEnv(), cwd: dir },
      ),
      OPENSSL_TIMEOUT_MS,
      "openssl x509",
    );
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return { available: false, reason: `openssl failed: ${error.message}` };
  }

  const [key, cert] = await Promise.all([readFile(at("leaf-key.pem"), "utf8"), readFile(at("leaf-cert.pem"), "utf8")]);
  return {
    available: true,
    dir,
    caFile: at("ca-cert.pem"),
    keyFile: at("leaf-key.pem"),
    certFile: at("leaf-cert.pem"),
    key,
    cert,
    async close() {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
