// Client for the in-host workers-hub jobs API. When a DSH web instance with the
// dsh-crew bundle is running, jobs run inside it (sessions visible in the
// Web UI); otherwise the MCP server falls back to standalone runtimes.

import { GLOBAL_CONFIG_DEFAULTS, readGlobalConfig } from './install/install.mjs';
import { pluginEnv } from './plugin-env.mjs';
import { isPidAlive, normalizeLoopbackHubUrl, readHubDiscovery } from './hub-discovery.mjs';

const POSITIVE_PROBE_TTL_MS = 10_000;
const NEGATIVE_PROBE_TTL_MS = 2_000;

function stripTrailingSlash(url) {
  return typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
}

const DEFAULT_HUB_URL = stripTrailingSlash(GLOBAL_CONFIG_DEFAULTS?.hub_url ?? '') || 'http://127.0.0.1:3080';

/**
 * Strip credentials, query string, and hash fragment before surfacing a hub URL.
 */
export function redactHubUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  try {
    const parsed = new URL(url.trim());
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    const formatted = parsed.pathname === '/' ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
    return stripTrailingSlash(formatted) || null;
  } catch {
    return null;
  }
}

function isConnRefused(err) {
  if (!err) return false;
  if (err.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNREFUSED') return true;
  const agg = err.cause?.errors;
  return Array.isArray(agg) && agg.length > 0 && agg.every((e) => e?.code === 'ECONNREFUSED');
}

/**
 * Resolve ordered candidate hub base URLs for the current lookup.
 * - Explicit `DSHPLUGIN_CREW_HUB` (or legacy `DSH_CREW_HUB`) wins exclusively.
 * - Custom `config.hub_url` (anything other than default `:3080`) is tried
 *   before a live discovery file, with the discovery file as fallback.
 * - Default `:3080` prefers a live `~/.config/dsh-crew/hub.json` entry first so
 *   ephemeral Desktop ports connect immediately without waiting for `:3080` to
 *   timeout. Users running multiple instances who need to pin one specific hub
 *   can set a custom `hub_url` or `DSHPLUGIN_CREW_HUB`.
 */
export function resolveHubCandidates({ env, config, discovery } = {}) {
  const envRaw = pluginEnv('CREW_HUB', env ? { env } : undefined);
  if (typeof envRaw === 'string' && envRaw.trim() !== '') {
    const cleaned = stripTrailingSlash(envRaw);
    return cleaned ? [cleaned] : [];
  }

  let cfg = config;
  if (cfg === undefined) {
    try { cfg = readGlobalConfig(); } catch { cfg = null; }
  }
  const configUrl = stripTrailingSlash(cfg?.hub_url ?? '');

  let disc = discovery;
  if (disc === undefined) {
    try { disc = readHubDiscovery(); } catch { disc = null; }
  }
  let pidAlive = false;
  if (disc) {
    try { pidAlive = isPidAlive(disc.pid) !== false; } catch { pidAlive = false; }
  }
  const discUrl = pidAlive ? stripTrailingSlash(normalizeLoopbackHubUrl(disc.url) ?? '') : null;

  const rawList = configUrl !== '' && configUrl !== DEFAULT_HUB_URL
    ? [configUrl, discUrl]
    : [discUrl, configUrl || DEFAULT_HUB_URL];

  const seen = new Set();
  const out = [];
  for (const item of rawList) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Create a dynamic hub client (used as a singleton in production and directly
 * instantiated with injected readers in tests).
 */
export function createHubClient({
  readConfig = readGlobalConfig,
  readDiscovery = readHubDiscovery,
  env,
  fetchImpl = fetch,
} = {}) {
  let activeBase = null;
  let lastProbe = { at: 0, ok: false, base: null, candidatesKey: null };
  let inFlightProbe = null;
  let stateEpoch = 0;
  let probeSeq = 0;

  const safeRead = (fn) => {
    try { return fn(); } catch { return null; }
  };

  const getCandidates = () => resolveHubCandidates({
    env,
    config: safeRead(readConfig),
    discovery: safeRead(readDiscovery),
  });

  async function pingBase(base) {
    try {
      const res = await fetchImpl(`${base}/_dsh/dsh-crew/ping`, { signal: AbortSignal.timeout(800) });
      const body = await res.json();
      return res.ok && body?.service === 'dsh-crew-hub';
    } catch {
      return false;
    }
  }

  async function hubAvailable({ force = false } = {}) {
    const now = Date.now();
    const candidates = getCandidates();
    const candidatesKey = candidates.join('|');

    if (!force) {
      if (
        lastProbe.ok &&
        activeBase &&
        lastProbe.base === activeBase &&
        candidatesKey === lastProbe.candidatesKey &&
        now - lastProbe.at < POSITIVE_PROBE_TTL_MS
      ) {
        return true;
      }
      if (
        !lastProbe.ok &&
        candidatesKey === lastProbe.candidatesKey &&
        now - lastProbe.at < NEGATIVE_PROBE_TTL_MS
      ) {
        return false;
      }
    }

    if (
      inFlightProbe &&
      inFlightProbe.candidatesKey === candidatesKey &&
      inFlightProbe.startedEpoch === stateEpoch
    ) {
      return inFlightProbe.promise;
    }

    const epochAtStart = stateEpoch;
    const seqAtStart = ++probeSeq;
    const entry = { candidatesKey, startedEpoch: epochAtStart, promise: null };

    const runProbe = async () => {
      for (const candidate of candidates) {
        if (await pingBase(candidate)) {
          if (stateEpoch === epochAtStart && probeSeq === seqAtStart) {
            activeBase = candidate;
            lastProbe = { at: Date.now(), ok: true, base: candidate, candidatesKey };
          }
          return true;
        }
      }
      if (stateEpoch === epochAtStart && probeSeq === seqAtStart) {
        activeBase = null;
        lastProbe = { at: Date.now(), ok: false, base: null, candidatesKey };
      }
      return false;
    };

    entry.promise = runProbe().finally(() => {
      if (inFlightProbe === entry) inFlightProbe = null;
    });
    inFlightProbe = entry;
    return entry.promise;
  }

  async function call(path, init) {
    const { timeoutMs = 30_000, ...restInit } = init ?? {};
    const makeFetchInit = () => {
      const timeoutSignal = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? AbortSignal.timeout(timeoutMs)
        : null;
      const signal = restInit.signal && timeoutSignal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([restInit.signal, timeoutSignal])
        : (restInit.signal ?? timeoutSignal ?? undefined);
      return signal ? { ...restInit, signal } : { ...restInit };
    };

    const candidates = getCandidates();
    if (!activeBase || candidates.join('|') !== lastProbe.candidatesKey) {
      await hubAvailable();
    }
    let base = activeBase ?? candidates[0];
    if (!base) throw new Error('DSH hub URL is not configured');

    const attempted = base;
    let res;
    try {
      res = await fetchImpl(`${base}/_dsh/dsh-crew${path}`, makeFetchInit());
    } catch (err) {
      if (activeBase === attempted) {
        stateEpoch += 1;
        activeBase = null;
        lastProbe = { at: 0, ok: false, base: null, candidatesKey: null };
      }
      const callerAborted = Boolean(restInit.signal?.aborted);
      const safeToRetry = !restInit.method || restInit.method.toUpperCase() === 'GET' || isConnRefused(err);
      if (!callerAborted && safeToRetry && (await hubAvailable({ force: true })) && activeBase) {
        base = activeBase;
        res = await fetchImpl(`${base}/_dsh/dsh-crew${path}`, makeFetchInit());
      } else {
        throw err;
      }
    }

    const raw = await res.text();
    let body = null;
    if (raw !== '') {
      try {
        body = JSON.parse(raw);
      } catch (parseErr) {
        const err = new Error(`hub returned non-JSON response (${res.status})`, { cause: parseErr });
        err.status = res.status;
        throw err;
      }
    }
    if (!res.ok || !body || typeof body !== 'object' || body.ok === false) {
      const err = new Error(body?.error ?? `hub request failed (${res.status})`);
      err.status = res.status;
      // A refusal carries a stable machine-readable code next to its prose
      // (SESSION_BUSY / SESSION_CLOSED / SESSION_CWD_MISMATCH /
      // SESSION_PRESET_MISMATCH / SESSION_RESUME_FAILED / INVALID_PERSISTENT_ARGS
      // / PERSISTENT_SESSIONS_DISABLED ...), so callers can branch on the reason
      // instead of matching English. Only attached when the hub actually sent
      // one: `err.code` is otherwise undefined, never a stale/guessed value.
      const code = body && typeof body === 'object' ? body.code : undefined;
      if (code !== undefined) err.code = code;
      throw err;
    }
    return body;
  }

  /**
   * One long-poll may never outlive the runtime's request timeouts. Node's
   * fetch (undici) aborts a request whose response headers have not arrived
   * within 300 s, and the hub sends nothing until the job settles — so a
   * `?wait=2700` poll dies at five minutes with a bare "fetch failed" while the
   * job keeps running server-side. Measured on 2026-08-19: dispatches of 2 s and
   * 4 m 03 s returned normally; 14 m, 22 m, 35 m and 41 m all failed that way.
   * Slicing the wait keeps every individual request short enough that no
   * runtime, proxy or load balancer can cut it.
   */
  const MAX_POLL_SLICE_SECONDS = 60;

  const hub = {
    probe: (binding) => call('/worker-probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(binding) }).then(b => b.result),
    spawn: (spec) => {
      const payload = {
        ...spec,
        ...(spec?.permission !== undefined ? { permission: spec.permission } : {}),
        ...(spec?.preset !== undefined ? { preset: spec.preset } : {}),
      };
      return call('/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then((b) => b.job);
    },
    list: () => call('/jobs').then((b) => b.jobs),
    // The LLM routes the HOST has configured. Only the hub can answer this: the
    // MCP server is a separate process with no ctx.llm. Returns [] rather than
    // throwing when the hub is too old to serve the route, so a stale hub
    // degrades to "cannot enumerate" instead of breaking the config tool.
    providers: () => call('/providers').then((b) => ({
      providers: b.providers ?? [],
      bindings: b.bindings ?? null,
    })).catch(() => ({ providers: [], bindings: null })),
    // `waitSeconds = 0` keeps the plain "read it now" semantics; anything longer
    // is served by repeated short waits until the job settles or the budget ends.
    get: async (id, waitSeconds = 0) => {
      const deadline = Date.now() + waitSeconds * 1000;
      for (;;) {
        const remaining = Math.ceil((deadline - Date.now()) / 1000);
        const slice = waitSeconds <= 0 ? 0 : Math.max(1, Math.min(MAX_POLL_SLICE_SECONDS, remaining));
        const job = await call(`/jobs/${id}?wait=${slice}`, { timeoutMs: (slice + 30) * 1000 }).then((b) => b.job);
        if (job.status !== 'running' || waitSeconds <= 0 || Date.now() >= deadline) return job;
      }
    },
    cancel: (id) => call(`/jobs/${id}/cancel`, { method: 'POST' }).then((b) => b.job),
    // ---------- persistent sessions (opt-in) ----------
    // The hub owns the session pool; these three calls are the whole MCP-side
    // surface. `sessionTurn` starts ONE more turn on an existing session and
    // returns immediately with the job view (the turn itself runs in the hub),
    // so the caller waits through the ordinary `get(id, waitSeconds)` path.
    // The session id is path-encoded: it is opaque hub data, not a slug.
    sessionTurn: (sessionId, spec) => call(`/sessions/${encodeURIComponent(sessionId)}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec ?? {}),
    }).then((b) => b.job),
    listSessions: () => call('/sessions').then((b) => b.sessions ?? []),
    closeSession: (sessionId) => call(`/sessions/${encodeURIComponent(sessionId)}/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).then(({ ok, ...rest }) => rest),
  };

  const getActiveHubUrl = () => activeBase;
  const resetHubClientState = () => {
    stateEpoch += 1;
    probeSeq += 1;
    activeBase = null;
    lastProbe = { at: 0, ok: false, base: null, candidatesKey: null };
    inFlightProbe = null;
  };

  return { hubAvailable, hub, getActiveHubUrl, resetHubClientState };
}

const defaultClient = createHubClient();
export const { hubAvailable, hub, getActiveHubUrl, resetHubClientState } = defaultClient;
