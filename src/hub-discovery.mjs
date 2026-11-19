// Loopback hub endpoint discovery for DSH Desktop / random-port instances.
//
// On Windows (and multi-instance setups) DSH Desktop often binds an ephemeral
// localhost port rather than 3080. The hub plugin publishes its active loopback
// URL + PID to ~/.config/dsh-crew/hub.json, and the MCP client checks it
// dynamically whenever probing or reconnecting after a restart.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_DISCOVERY_FILE = join(homedir(), '.config', 'dsh-crew', 'hub.json');

function decodeMapped127Ipv4(bareHost) {
  const dotted = /^::ffff:(127(?:\.\d{1,3}){3})$/.exec(bareHost);
  if (dotted) return dotted[1];
  // WHATWG URL converts `::ffff:127.0.0.1` into `::ffff:7f00:1`.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bareHost);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  if ((hi >> 8) !== 127) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * Validate and canonicalize a loopback hub URL (`http://` or `https://` with
 * an explicit port). Wildcard bind hosts (`0.0.0.0`, `::`) and IPv4-mapped
 * loopback addresses normalize to `127.0.0.1`. Any non-loopback host,
 * credentialed URL, or missing port returns `null`.
 */
export function normalizeLoopbackHubUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '' || /[\x00-\x1f\x7f]/.test(trimmed)) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;

  const authority = trimmed.replace(/^https?:\/\//i, '').split(/[/\\?#]/, 1)[0];
  const authMatch = /^(?:\[[^\]]+\]|[^:@/\\?#]+):(\d+)$/.exec(authority);
  if (!authMatch) return null;
  const explicitPort = authMatch[1];
  const portNum = Number(explicitPort);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null;

  const defaultPort = parsed.protocol === 'https:' ? 443 : 80;
  const parsedPort = parsed.port !== '' ? Number(parsed.port) : defaultPort;
  if (parsedPort !== portNum) return null;

  const isLoopbackIpv4 = (host) => {
    const parts = host.split('.');
    if (parts.length !== 4 || parts[0] !== '127') return false;
    return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
  };

  const rawHost = parsed.hostname.toLowerCase();
  const bare = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const mapped = decodeMapped127Ipv4(bare);

  let normalizedHost = null;
  if (bare === 'localhost' || bare === 'localhost.') {
    normalizedHost = 'localhost';
  } else if (isLoopbackIpv4(bare)) {
    normalizedHost = bare;
  } else if (bare === '::1') {
    normalizedHost = '[::1]';
  } else if (bare === '0.0.0.0' || bare === '::') {
    normalizedHost = '127.0.0.1';
  } else if (mapped !== null && isLoopbackIpv4(mapped)) {
    normalizedHost = mapped;
  }

  if (normalizedHost === null) return null;

  return `${parsed.protocol}//${normalizedHost}:${portNum}`;
}

/**
 * Check whether `pid` is currently alive via signal-0 probing. Returns `true`
 * if alive (or EPERM), `false` if ESRCH, or `null` when `pid` is invalid or
 * probing is inconclusive.
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code === 'EPERM') return true;
    return null;
  }
}

/**
 * Read and validate ~/.config/dsh-crew/hub.json. Never throws; malformed,
 * missing, or non-loopback entries return `null`.
 */
export function readHubDiscovery({ file = DEFAULT_DISCOVERY_FILE } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const url = normalizeLoopbackHubUrl(parsed.url);
    if (url === null) return null;
    const pid = Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
    const startedAt = typeof parsed.startedAt === 'string' && parsed.startedAt !== '' ? parsed.startedAt : null;
    const updatedAt = typeof parsed.updatedAt === 'string' && parsed.updatedAt !== '' ? parsed.updatedAt : null;
    return { url, pid, startedAt, updatedAt };
  } catch {
    return null;
  }
}

/**
 * Persist the active loopback hub URL and owning PID atomically.
 */
export function writeHubDiscovery({ url, pid = process.pid, startedAt, file = DEFAULT_DISCOVERY_FILE } = {}) {
  const normalized = normalizeLoopbackHubUrl(url);
  if (normalized === null) {
    throw new Error('hub discovery URL must be a loopback http(s) URL with an explicit port');
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('hub discovery pid must be a positive integer');
  }
  const now = new Date().toISOString();
  const entry = {
    url: normalized,
    pid,
    startedAt: typeof startedAt === 'string' && startedAt !== '' ? startedAt : now,
    updatedAt: now,
  };
  const payload = JSON.stringify(entry, null, 2) + '\n';
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tmp, payload, { flag: 'wx', mode: 0o600 });
    try {
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, payload, { mode: 0o600 });
    }
  } finally {
    try { rmSync(tmp, { force: true }); } catch {}
  }
  return entry;
}

/**
 * Delete the discovery file only if it is still owned by `pid` (and matches
 * `url` when given). Returns `false` if `url` is supplied but invalid or if a
 * re-read immediately prior to unlinking shows ownership changed, so a retiring
 * instance never clobbers a newer hub's record.
 */
export function removeHubDiscoveryIfOwned({ pid = process.pid, url, file = DEFAULT_DISCOVERY_FILE } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let expectedUrl = null;
  if (url !== undefined && url !== null) {
    expectedUrl = normalizeLoopbackHubUrl(url);
    if (expectedUrl === null) return false;
  }
  const matchesOwner = (entry) => Boolean(entry && entry.pid === pid && (expectedUrl === null || entry.url === expectedUrl));
  if (!matchesOwner(readHubDiscovery({ file }))) return false;
  if (!matchesOwner(readHubDiscovery({ file }))) return false;
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

function addressToHubUrl(addr, protocol = 'http') {
  if (typeof addr === 'string') return normalizeLoopbackHubUrl(addr);
  if (!addr || typeof addr !== 'object') return null;
  const port = addr.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const rawHost = typeof addr.address === 'string'
    ? addr.address
    : typeof addr.host === 'string'
      ? addr.host
      : typeof addr.hostname === 'string'
        ? addr.hostname
        : '127.0.0.1';
  const cleanHost = rawHost.split('%', 1)[0].trim() || '127.0.0.1';
  const host = cleanHost.includes(':') && !cleanHost.startsWith('[') ? `[${cleanHost}]` : cleanHost;
  return normalizeLoopbackHubUrl(`${protocol}://${host}:${port}`);
}

/**
 * Best-effort extraction of the bound loopback URL from a host `webServer`
 * service without assuming a single private implementation shape.
 */
export function extractWebServerUrl(webServer) {
  if (!webServer || typeof webServer !== 'object') return null;
  const rawProto = typeof webServer.protocol === 'string'
    ? webServer.protocol.trim().toLowerCase().replace(/:$/, '')
    : '';
  const proto = rawProto === 'https' || (webServer.https != null && webServer.https !== false)
    ? 'https'
    : 'http';

  const addressCandidates = [];
  if (typeof webServer.address === 'function') {
    try { addressCandidates.push(webServer.address()); } catch {}
  } else if (webServer.address && typeof webServer.address === 'object') {
    addressCandidates.push(webServer.address);
  }
  for (const holder of [webServer.server, webServer.httpServer]) {
    if (typeof holder?.address === 'function') {
      try { addressCandidates.push(holder.address()); } catch {}
    }
  }
  if (Number.isInteger(webServer.port) && webServer.port > 0) {
    addressCandidates.push({
      address: webServer.host ?? webServer.hostname ?? '127.0.0.1',
      port: webServer.port,
    });
  }

  for (const addr of addressCandidates) {
    const normalized = addressToHubUrl(addr, proto);
    if (normalized !== null) return normalized;
  }

  for (const candidate of [webServer.url, webServer.origin, webServer.baseUrl]) {
    const normalized = normalizeLoopbackHubUrl(candidate);
    if (normalized !== null) return normalized;
  }
  return null;
}

/**
 * Extract the bound loopback URL from an incoming Node HTTP request, only when
 * the request comes from a real bound socket (`localPort > 0` and non-empty
 * `localAddress`). Mock requests in unit tests lack socket metadata and return
 * `null` so they never write discovery files.
 */
export function extractRequestLoopbackUrl(req) {
  const localPort = req?.socket?.localPort;
  if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) return null;
  if (typeof req?.socket?.localAddress !== 'string' || req.socket.localAddress.trim() === '') return null;
  const proto = req.socket?.encrypted ? 'https' : 'http';
  const rawAddr = req.socket.localAddress.split('%', 1)[0].trim();
  const host = rawAddr.includes(':') && !rawAddr.startsWith('[') ? `[${rawAddr}]` : rawAddr;
  return normalizeLoopbackHubUrl(`${proto}://${host}:${localPort}`);
}
