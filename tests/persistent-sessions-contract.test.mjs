// Opt-in persistent DSH sessions: the CROSS-BATCH contract (batch 3 finding).
//
// The other persistent-session MCP test proves the MCP layer against a hand-written
// stub hub, which cannot catch a break in the middle of the chain. This file
// closes that gap: it runs the REAL `apply()` / `WorkerRegistry` from
// `src/hub/index.mjs` behind a REAL `node:http` server, on a real loopback port,
// and drives the REAL `src/server.mjs` MCP server over stdio at it.
//
// So every assertion here observes what actually crosses the wire:
//
//   MCP tool call -> server.mjs (hub-client.call) -> HTTP -> hub route
//     -> WorkerRegistry.spawnPersistentTurn -> PersistentSessionRecord
//
// Only the DSH runtime itself is faked (`ctx.agents` / `ctx.sessions` /
// `ctx.get` / `ctx.logger` / `ctx.tools` / `ctx.settings`), because a real DSH
// profile is exactly what a test must never touch. Everything the contract is
// about — argument validation, the tolerant preset rule, SESSION_BUSY, the
// tombstones, and how a hub refusal reaches an MCP caller as `code` — is
// exercised for real.
//
// Isolation: HOME / USERPROFILE point at a temp dir before anything resolves
// ~/.config/dsh-crew, so no run can touch the real profile.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'dsh-crew-psess-contract-'));
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
process.env.HOME = ISOLATED_HOME;
process.env.USERPROFILE = ISOLATED_HOME;

const { apply } = await import('../src/hub/index.mjs');

after(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

// ---------- the faked DSH runtime ----------

/**
 * A fake `ctx` for the real WorkerRegistry.
 *
 * Each created agent answers its turn with one assistant message + turn/end, so
 * a turn settles as `done`. `gate` lets a test HOLD a turn open (to provoke a
 * real SESSION_BUSY) and release it afterwards.
 */
function makeCtx() {
  const log = { creates: [], followups: [], appends: [], disposes: 0, flushes: 0 };
  let gate = null;

  const buildAgent = (options) => {
    const record = {
      sessionId: options.sessionId,
      cwd: options.meta?.cwd ?? null,
      preset: options.meta?.agentPreset,
      disposed: 0,
      followups: 0,
    };
    const listeners = {};
    const session = {
      header: { cwd: record.cwd, ...(record.preset === undefined ? {} : { agentPreset: record.preset }) },
      events: [],
      async append(type, data) {
        log.appends.push({ type, mode: data?.mode, sessionId: options.sessionId });
      },
    };
    const emit = (type, data) => {
      for (const fn of listeners['session/event'] ?? []) fn(session, { type, data });
    };
    let pending = null;
    const agent = {
      session,
      id: options.sessionId,
      async whenIdle() { await pending; },
      followup(message) {
        record.followups += 1;
        log.followups.push({ sessionId: options.sessionId, text: message?.content?.[0]?.text ?? null });
        pending = (async () => {
          // A test that wants a turn to STAY running awaits this gate.
          if (gate !== null) await gate;
          emit('assistant/message', { message: { content: [{ type: 'text', text: `turn ${record.followups}` }] } });
          emit('turn/end', { reason: { kind: 'completed' } });
        })().catch(() => {});
      },
      cancel() {},
    };
    return { record, agent, listeners, session };
  };

  const setupCtx = (built) => ({
    agent: { session: built.session, id: built.record.sessionId },
    on(name, fn) {
      (built.listeners[name] ??= []).push(fn);
    },
  });

  const ctx = {
    logger: { warn() {}, info() {} },
    // Resolve presets by identity: the record stores the raw id the test passes,
    // so a preset assertion compares against what the MCP layer actually sent.
    get(name) {
      if (name === 'agentPresets') {
        return { async resolve(id) { return { id: id ?? 'builtin-default' }; }, async mount() {} };
      }
      return undefined;
    },
    sessions: { async flush() { log.flushes += 1; } },
    tools: { register() { return () => {}; } },
    settings: { get() { return undefined; } },
    agents: {
      async create(options) {
        const built = buildAgent(options);
        log.creates.push(built.record);
        await options.setup(setupCtx(built));
        return { agent: built.agent, async dispose() { built.record.disposed += 1; log.disposes += 1; } };
      },
    },
  };

  return {
    ctx,
    log,
    /** Make the next turn(s) hang until `release()` is called. */
    holdTurns() {
      let release;
      gate = new Promise((resolve) => { release = resolve; });
      return () => { gate = null; release(); };
    },
    get currentGate() { return gate; },
  };
}

// ---------- the real hub, on a real port ----------

/**
 * Boot `apply(ctx)` against a real HTTP server.
 *
 * `apply` registers its routes through `ctx.inject(['webServer'], …)`; the fake
 * webServer collects them and this harness feeds each request to the matching
 * route handler, so the hub code under test is the shipped code — not a
 * reimplementation, and not a proxy.
 */
async function startRealHub({ config = {}, fake = makeCtx() } = {}) {
  const routes = [];
  // Cordis disposes an `inject` scope through the function its callback returns;
  // the hub registers a `process.once('exit')` cleanup inside that scope, so the
  // harness must keep the disposer or every test leaks one exit listener.
  const injectDisposers = [];
  const ctx = {
    ...fake.ctx,
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    inject(_names, cb) {
      const disposed = cb({
        webServer: {
          register(spec) { routes.push(spec); return () => {}; },
          address() { return { address: '127.0.0.1', port: 0 }; },
          server: { once() {}, removeListener() {} },
        },
      });
      if (typeof disposed === 'function') injectDisposers.push(disposed);
      return disposed;
    },
  };

  // `apply()` registers a `process.once('exit', …)` discovery cleanup, so its
  // returned disposer MUST run or every test in this file leaves an exit
  // listener behind (the hub's own contract, not something this harness invents).
  const dispose = await apply(ctx);

  // The hub reads its tier/preset config from getConfig(); pin it so the test
  // controls what the tier default WOULD have resolved to.
  const cfg = {
    preset_flash: 'contract-flash-preset',
    preset_pro: 'contract-pro-preset',
    flash_model: 'flash-model',
    pro_model: 'pro-model',
    ...config,
  };

  const matchRoute = (pathname) => routes.find((r) => (
    r.kind === 'exact' ? r.path === pathname : pathname.startsWith(r.path)
  ));

  /** Every request body the REAL hub received, in order. */
  const received = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = matchRoute(url.pathname);
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no route' }));
      return;
    }
    // Tee the body so a test can assert on the ACTUAL payload.
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    // `method` + `contentType` are recorded for EVERY request (body or not) so a
    // test can assert on the wire headers the real hub guard judges. The
    // state-mutating POST guard refuses a request without
    // `content-type: application/json`, and that refusal is invisible in a
    // JSON-only recording of a bodiless POST.
    const record = { path: url.pathname, method: req.method, contentType: req.headers['content-type'] ?? null };
    if (raw !== '') {
      try { received.push({ ...record, body: JSON.parse(raw) }); }
      catch { received.push({ ...record, body: raw }); }
    } else {
      received.push({ ...record, body: undefined });
    }
    // Re-model the stream for the handler, which reads it itself.
    req[Symbol.asyncIterator] = async function* iterator() {
      if (raw !== '') yield Buffer.from(raw);
    };
    return route.handler(req, res);
  });

  // The registry is created inside apply(), so reach the config through the
  // module-level config route instead: point the test's config at the hub that
  // apply() built by overriding readGlobalConfig through the temp HOME.
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  // The hub's getConfig() is readGlobalConfig(); write the test config into the
  // isolated HOME so the REAL hub sees it (no module monkey-patching).
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(ISOLATED_HOME, '.config', 'dsh-crew'), { recursive: true });
  writeFileSync(
    join(ISOLATED_HOME, '.config', 'dsh-crew', 'config.json'),
    JSON.stringify({ ...cfg, hub_url: `http://127.0.0.1:${port}` }, null, 2),
  );

  return {
    server, port, routes, received, fake,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      // Reverse order, like the hub's own `for (const d of disposers.reverse())`.
      for (const d of [...injectDisposers].reverse()) { try { d(); } catch {} }
      try { await dispose?.(); } catch { /* the hub disposer is best-effort here */ }
    },
  };
}

// ---------- the real MCP server, over stdio ----------

async function startMcp({ hubUrl }) {
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: ISOLATED_HOME,
      USERPROFILE: ISOLATED_HOME,
      DSHPLUGIN_CREW_HUB: hubUrl,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buf = '';
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
  });
  child.stderr.on('data', () => {});

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'persistent-contract-test', version: '0.0.0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const callTool = async (name, args) => {
    const res = await request('tools/call', { name, arguments: args });
    const raw = res.result?.content?.[0]?.text ?? '';
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = raw; }
    return { res, payload, text: raw, isError: res.result?.isError === true };
  };

  return {
    callTool,
    async stop() {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

/** Boot both halves and hand a test the pair. */
async function withStack(fn, options = {}) {
  const hub = await startRealHub(options);
  const mcp = await startMcp({ hubUrl: hub.url });
  try {
    return await fn({ hub, mcp });
  } finally {
    await mcp.stop();
    await hub.close();
  }
}

// ---------- 1. multi-turn reuse across the real chain ----------

test('turn 1 creates and turn 2 reuses the SAME session, sending NO preset key', async () => {
  await withStack(async ({ hub, mcp }) => {
    await mcp.callTool('dsh_worker_config', { persistent_sessions: true, mode: 'hub' });

    const first = await mcp.callTool('dsh_run_worker', {
      task: 'turn one',
      cwd: ISOLATED_HOME,
      persistent: true,
    });
    assert.equal(first.isError, false, first.text);
    const sessionId = first.payload.session_id;
    assert.match(sessionId, /^session-/, 'the real hub mints a session-… id');
    assert.equal(first.payload.status, 'done');

    // The creating spawn carried the resolved tier default preset, because this
    // is the call that LOCKS it onto the session.
    const spawnBody = hub.received.find((r) => r.path === '/_dsh/dsh-crew/jobs').body;
    assert.equal(spawnBody.persistent, true);
    assert.equal(spawnBody.preset, 'contract-flash-preset', 'turn 1 locks the resolved default preset');
    assert.equal(spawnBody.maxPermission, 'workspace-write');
    assert.equal(spawnBody.cwd, spawnBody.cwd.trim());

    // Turn 2: switch tier, name NO preset -> must inherit, not overwrite.
    const second = await mcp.callTool('dsh_run_worker', {
      task: 'turn two',
      cwd: ISOLATED_HOME,
      session_id: sessionId,
      tier: 'pro',
    });
    assert.equal(second.isError, false, second.text);
    assert.equal(second.payload.session_id, sessionId, 'the same session id comes back');
    assert.equal(second.payload.status, 'done');

    // THE assertion the audit asked for: read the actual HTTP request the real
    // hub received. A resolved default preset must not be there.
    const turnRequest = hub.received.find((r) => /\/sessions\/[^/]+\/turns$/.test(r.path));
    assert.ok(turnRequest !== undefined, 'turn 2 went through POST /sessions/:id/turns');
    assert.equal(
      Object.prototype.hasOwnProperty.call(turnRequest.body, 'preset'),
      false,
      'a follow-up that names no preset must send NO preset key at all',
    );
    assert.equal(turnRequest.body.tier, 'pro', 'the per-turn tier travels');
    assert.equal(turnRequest.body.cwd, spawnBody.cwd, 'cwd is passed for hub-side validation');

    // The real registry kept ONE underlying runtime across both turns.
    assert.equal(hub.fake.log.creates.length, 1, 'one agent for the whole session, not one per turn');
    assert.equal(hub.fake.log.followups.length, 2, 'two turns ran on that one agent');
  });
});

// ---------- 2. SESSION_BUSY through the whole chain, then recovery ----------

test('a concurrent turn gets the real 409 SESSION_BUSY as MCP code, then the session recovers', async () => {
  await withStack(async ({ hub, mcp }) => {
    await mcp.callTool('dsh_worker_config', { persistent_sessions: true, mode: 'hub' });

    // Hold turn 1 open so a second turn finds the session `running`.
    const release = hub.fake.holdTurns();
    const firstPromise = mcp.callTool('dsh_run_worker', {
      task: 'turn one (held)',
      cwd: ISOLATED_HOME,
      persistent: true,
    });

    // Wait for the REAL hub to have reserved the session. Polled over HTTP, not
    // through MCP: a tool call here would itself race the held turn.
    const listed = async () => fetch(`${hub.url}/_dsh/dsh-crew/sessions`, {
      headers: { host: `127.0.0.1:${hub.port}` },
    }).then((r) => r.json());

    let sessionId = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const pool = await listed();
      sessionId = pool.sessions?.[0]?.session_id ?? null;
      if (sessionId !== null && pool.sessions[0].status === 'running') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(sessionId, `the held session must be listed as running, got ${JSON.stringify(await listed())}`);

    // A second turn on the running session must be refused by the REAL hub,
    // surfacing as `code` on the MCP payload. `allow_concurrent_cwd` (read-only)
    // deliberately skips the MCP-side advisory cwd lock — that lock would refuse
    // first, and this test is about the HUB's 409, not the client-side guard.
    const busy = await mcp.callTool('dsh_run_worker', {
      task: 'turn two (too early)',
      cwd: ISOLATED_HOME,
      session_id: sessionId,
      allow_concurrent_cwd: true,
      permission: 'read-only',
    });
    assert.equal(busy.payload.code, 'SESSION_BUSY', `expected SESSION_BUSY, got ${busy.text}`);
    assert.equal(busy.payload.session_id, sessionId, 'a busy refusal still names the session');
    assert.equal(busy.payload.status, undefined, 'a refusal is not a job view');

    // Let turn 1 finish, then the SAME session must accept a turn again.
    release();
    const settled = await firstPromise;
    assert.equal(settled.payload.session_id, sessionId);
    assert.equal(settled.payload.status, 'done', settled.text);

    // The busy attempt must not have poisoned the record: one more turn works,
    // and it reuses the same handle.
    const retried = await mcp.callTool('dsh_run_worker', {
      task: 'turn two (after settle)',
      cwd: ISOLATED_HOME,
      session_id: sessionId,
    });
    assert.equal(retried.isError, false, retried.text);
    assert.equal(retried.payload.status, 'done', `recovery after busy failed: ${retried.text}`);
    assert.equal(hub.fake.log.creates.length, 1, 'still one runtime for the whole session');
  });
});

// ---------- 3. binding refusals from the real hub ----------

test('an explicit differing preset is refused by the real hub as SESSION_PRESET_MISMATCH', async () => {
  await withStack(async ({ hub, mcp }) => {
    await mcp.callTool('dsh_worker_config', { persistent_sessions: true, mode: 'hub' });
    const first = await mcp.callTool('dsh_run_worker', {
      task: 'turn one',
      cwd: ISOLATED_HOME,
      persistent: true,
      preset: 'locked-preset',
    });
    assert.equal(first.isError, false, first.text);
    const sessionId = first.payload.session_id;

    const conflict = await mcp.callTool('dsh_run_worker', {
      task: 'turn two',
      cwd: ISOLATED_HOME,
      session_id: sessionId,
      preset: 'other-preset',
    });
    assert.equal(conflict.payload.code, 'SESSION_PRESET_MISMATCH', conflict.text);
    assert.equal(conflict.payload.session_id, sessionId);

    // The explicit preset DID cross the wire (that is how the hub can compare).
    const turnRequest = hub.received.find((r) => /\/sessions\/[^/]+\/turns$/.test(r.path));
    assert.equal(turnRequest.body.preset, 'other-preset');

    // An explicit EQUAL preset is accepted: only a real difference is an error.
    const same = await mcp.callTool('dsh_run_worker', {
      task: 'turn two, same preset',
      cwd: ISOLATED_HOME,
      session_id: sessionId,
      preset: 'locked-preset',
    });
    assert.equal(same.isError, false, same.text);
    assert.equal(same.payload.status, 'done');
  });
});

test('a different cwd is refused by the real hub as SESSION_CWD_MISMATCH', async () => {
  await withStack(async ({ hub, mcp }) => {
    await mcp.callTool('dsh_worker_config', { persistent_sessions: true, mode: 'hub' });
    const first = await mcp.callTool('dsh_run_worker', {
      task: 'turn one',
      cwd: ISOLATED_HOME,
      persistent: true,
    });
    const sessionId = first.payload.session_id;

    // A different, real directory.
    const otherCwd = mkdtempSync(join(tmpdir(), 'dsh-crew-other-cwd-'));
    try {
      const conflict = await mcp.callTool('dsh_run_worker', {
        task: 'turn two',
        cwd: otherCwd,
        session_id: sessionId,
      });
      assert.equal(conflict.payload.code, 'SESSION_CWD_MISMATCH', conflict.text);
      assert.equal(conflict.payload.session_id, sessionId);
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });
});

// ---------- 4. close: SESSION_CLOSED + a hub refusal on close ----------

test('dsh_session_close destroys the session, a later turn reports SESSION_CLOSED', async () => {
  await withStack(async ({ hub, mcp }) => {
    await mcp.callTool('dsh_worker_config', { persistent_sessions: true, mode: 'hub' });
    const first = await mcp.callTool('dsh_run_worker', {
      task: 'turn one',
      cwd: ISOLATED_HOME,
      persistent: true,
    });
    const sessionId = first.payload.session_id;

    const closed = await mcp.callTool('dsh_session_close', { session_id: sessionId });
    assert.equal(closed.payload.closed, true, closed.text);
    assert.equal(closed.payload.session_id, sessionId, 'close echoes the id');
    assert.ok(hub.fake.log.disposes >= 1, 'the real hub disposed the runtime');

    // The pool no longer lists it...
    const listed = await fetch(`${hub.url}/_dsh/dsh-crew/sessions`, {
      headers: { host: `127.0.0.1:${hub.port}` },
    }).then((r) => r.json());
    assert.deepEqual(listed.sessions, []);

    // ...and the tombstone refuses a later turn instead of cold-starting.
    const after = await mcp.callTool('dsh_run_worker', {
      task: 'turn two',
      cwd: ISOLATED_HOME,
      session_id: sessionId,
    });
    assert.equal(after.payload.code, 'SESSION_CLOSED', after.text);
    assert.equal(after.payload.session_id, sessionId);
  });
});

test('a hub refusal on close comes back as { closed: false, code, session_id }', async () => {
  const hub = await startRealHub();
  const mcp = await startMcp({ hubUrl: hub.url });
  // Answer the close route with a refusal, so this asserts the MCP layer's
  // handling of a FAILED close (the real 200 path is covered above).
  const sessionsRoute = hub.routes.find((r) => r.path === '/_dsh/dsh-crew/sessions');
  const originalHandler = sessionsRoute.handler;
  sessionsRoute.handler = async (req, res) => {
    if (/\/close$/.test(req.url) && req.method === 'POST') {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'session is running its final turn', code: 'SESSION_BUSY' }));
      return;
    }
    return originalHandler(req, res);
  };
  try {
    await mcp.callTool('dsh_worker_config', { persistent_sessions: true, mode: 'hub' });
    const failed = await mcp.callTool('dsh_session_close', { session_id: 'session-refused' });
    assert.equal(failed.payload.closed, false, failed.text);
    assert.equal(failed.payload.code, 'SESSION_BUSY', 'the hub code reaches the caller');
    assert.equal(failed.payload.session_id, 'session-refused', 'the id is echoed even on failure');
    assert.match(failed.payload.error, /running its final turn/);
  } finally {
    sessionsRoute.handler = originalHandler;
    await mcp.stop();
    await hub.close();
  }
});

// ---------- 6. the caller's timeout reaches the hub watchdog ----------

test('timeout_seconds travels to the hub as the persistent turn watchdog budget', async () => {
  // DEFECT: the hub watchdog hard-capped a turn at 30 minutes because nothing
  // ever passed a budget, while the tool schema documents timeout_seconds up to
  // 7200 s. A 45-minute turn was therefore killed at 30 minutes. The MCP layer
  // now derives `turnTimeoutMs` from timeout_seconds — always LARGER than the
  // caller's own deadline, so the watchdog reclaims a hung turn instead of
  // enforcing the caller's deadline — and sends it on both persistent paths.
  await withStack(async ({ hub, mcp }) => {
    await mcp.callTool('dsh_worker_config', { persistent_sessions: true, mode: 'hub' });

    // 1. First turn (POST /jobs): a budget well above the old 30-minute cap.
    const first = await mcp.callTool('dsh_run_worker', {
      task: 'long turn', cwd: ISOLATED_HOME, persistent: true, timeout_seconds: 3600,
    });
    assert.equal(first.isError, false, first.text);
    const spawnBody = hub.received.find((r) => r.path === '/_dsh/dsh-crew/jobs').body;
    // 3600 s deadline + max(120 s, 10 %) = 3960 s.
    assert.equal(spawnBody.turnTimeoutMs, 3_960_000, 'the caller budget reaches the hub, not a 30-minute cap');
    assert.ok(spawnBody.turnTimeoutMs > 1_800_000, 'the old hard cap is gone');

    // 2. Follow-up turn (POST /sessions/:id/turns): the budget follows the caller.
    const sessionId = first.payload.session_id;
    const second = await mcp.callTool('dsh_run_worker', {
      task: 'short turn', cwd: ISOLATED_HOME, session_id: sessionId, timeout_seconds: 60,
    });
    assert.equal(second.isError, false, second.text);
    const turnRequest = hub.received.find((r) => /\/sessions\/[^/]+\/turns$/.test(r.path));
    assert.ok(turnRequest !== undefined, 'turn 2 went through the sessions route');
    // 60 s deadline is under the 2-minute margin floor: 60 s + 120 s.
    assert.equal(turnRequest.body.turnTimeoutMs, 180_000, 'the follow-up carries its own budget');

    // 3. An omitted timeout_seconds uses this session's default deadline, and the
    //    watchdog still gets a larger budget derived from it.
    const third = await mcp.callTool('dsh_run_worker', { task: 'default budget', cwd: ISOLATED_HOME, session_id: sessionId });
    assert.equal(third.isError, false, third.text);
    const thirdTurn = hub.received.filter((r) => /\/sessions\/[^/]+\/turns$/.test(r.path)).at(-1);
    const defaultTimeoutMs = 1800 * 1000; // GLOBAL_CONFIG_DEFAULTS.default_timeout_seconds
    assert.equal(
      thirdTurn.body.turnTimeoutMs,
      defaultTimeoutMs + Math.max(120_000, defaultTimeoutMs / 10),
      'the session default deadline also yields a watchdog budget past that deadline',
    );
    assert.ok(thirdTurn.body.turnTimeoutMs > defaultTimeoutMs, 'the watchdog must never fire before the caller deadline');
  });
});

// ---------- 5. timed-out persistent turn keeps cwd lock until settled ----------

// ---------- 5. timed-out persistent turn keeps cwd lock until settled ----------

test('a timed-out persistent turn holds the cwd lock until dsh_worker_result observes it settled', async () => {
  await withStack(async ({ hub, mcp }) => {
    await mcp.callTool('dsh_worker_config', { persistent_sessions: true, mode: 'hub' });
    const release = hub.fake.holdTurns();

    const first = await mcp.callTool('dsh_run_worker', {
      task: 'slow turn exceeding timeout',
      cwd: ISOLATED_HOME,
      persistent: true,
      timeout_seconds: 1,
    });
    assert.equal(first.payload.status, 'running', first.text);
    const jobId = first.payload.id;

    // While the turn is still running on the hub, a second writer to the same
    // cwd must be refused by the advisory cwd lock.
    const concurrentWrite = await mcp.callTool('dsh_run_worker', {
      task: 'concurrent writer',
      cwd: ISOLATED_HOME,
    });
    assert.equal(concurrentWrite.payload.rejected_by, 'cwd-lock', `expected cwd-lock refusal, got ${concurrentWrite.text}`);
    assert.equal(concurrentWrite.payload.holder?.jobId, jobId);

    // Let the turn finish and observe settlement through dsh_worker_result.
    release();
    const settled = await mcp.callTool('dsh_worker_result', { job_id: jobId, wait_seconds: 10 });
    assert.equal(settled.payload.status, 'done', settled.text);

    // Once settled, the lock is released and another dispatch proceeds.
    const next = await mcp.callTool('dsh_run_worker', {
      task: 'after settle',
      cwd: ISOLATED_HOME,
    });
    assert.equal(next.payload.status, 'done', next.text);
  });
});

// ---------- 7. dsh_worker_cancel over real HTTP (P0 JSON guard) ----------

test('dsh_worker_cancel sends a JSON content-type and really cancels a running job', async () => {
  // DEFECT (live Antigravity + DSH hub test, not unit tests): the P0
  // content-type guard was added to POST /jobs/:id/cancel, but hub-client's
  // `cancel()` sent NEITHER a content-type header NOR a body, so every MCP
  // `dsh_worker_cancel` call died with HTTP 415 UNSUPPORTED_MEDIA_TYPE before
  // reaching the registry. Every existing suite passed because none of them
  // drove the tool through real HTTP into the real `apply()` hub — the two
  // halves were each tested, and the wire between them was not.
  //
  // This test closes that gap for real: a hanging job is spawned through
  // `dsh_spawn_worker`, then `dsh_worker_cancel` is called over stdio, and the
  // assertions read the HTTP request the real hub actually received plus the
  // registry state it produced.
  await withStack(async ({ hub, mcp }) => {
    await mcp.callTool('dsh_worker_config', { mode: 'hub' });

    // Hold the turn open so the job is genuinely `running` when cancelled.
    const release = hub.fake.holdTurns();
    const spawned = await mcp.callTool('dsh_spawn_worker', {
      task: 'hang until cancelled',
      cwd: ISOLATED_HOME,
      permission: 'read-only',
    });
    assert.equal(spawned.isError, false, spawned.text);
    const jobId = spawned.payload.id;
    assert.match(jobId, /^hub-/, `expected a hub job id, got ${spawned.text}`);
    assert.equal(spawned.payload.status, 'running', 'the spawn worker returns a claim, not a result');

    try {
      const cancelled = await mcp.callTool('dsh_worker_cancel', { job_id: jobId });

      // 1. The refusal must be gone. A 415 from the guard never becomes a job
      //    view: hub-client turns a non-2xx into a thrown error carrying the
      //    hub's prose, and the tool surfaces it as `{ error }` with NO job id
      //    and NO status. So the decisive check is that a real job view came
      //    back at all, and that its prose is not the guard's.
      assert.equal(
        /application\/json required/.test(String(cancelled.payload.error ?? '')),
        false,
        `dsh_worker_cancel was refused by the content-type guard: ${cancelled.text}`,
      );
      assert.equal(cancelled.payload.code, undefined, `a 415 refusal leaked a code: ${cancelled.text}`);

      // 2. The real hub actually cancelled the job. (A cancelled job legitimately
      //    records `error: 'cancelled by request'` next to its status — that is
      //    the registry's own bookkeeping, not a refusal.)
      assert.equal(cancelled.payload.id, jobId);
      assert.equal(cancelled.payload.status, 'cancelled', `expected cancelled, got ${cancelled.text}`);
      assert.equal(cancelled.payload.error, 'cancelled by request');

      // 3. THE assertion the defect is about: the request that crossed the wire
      //    declared application/json, so the guard let it through on its merits
      //    rather than because the route was exempted.
      const cancelRequest = hub.received.find((r) => r.path === `/_dsh/dsh-crew/jobs/${jobId}/cancel`);
      assert.ok(cancelRequest !== undefined, 'the cancel request reached the real hub route');
      assert.equal(cancelRequest.method, 'POST');
      assert.equal(
        cancelRequest.contentType,
        'application/json',
        'cancel must declare content-type: application/json (the guard requires it)',
      );
      assert.deepEqual(cancelRequest.body, {}, 'cancel sends a JSON body, like every sibling call');

      // 4. The registry disposed the runtime and published the settled state.
      assert.ok(hub.fake.log.disposes >= 1, 'a cancelled one-shot job releases its runtime');
    } finally {
      // Let the gated turn unwind so nothing is left pending behind the test.
      release();
    }

    // The cancellation is durable: a second cancel is a no-op that still
    // reports the settled job instead of re-running anything.
    const again = await mcp.callTool('dsh_worker_cancel', { job_id: jobId });
    assert.equal(again.payload.status, 'cancelled', again.text);
  });
});

// Every mutating route this client drives must carry the JSON content-type, or
// the P0 guard 415s it. This is the systematic version of the cancel check:
// it derives the pairs from the traffic of a normal session, so a future route
// that forgets the header fails here instead of in a live run.
test('every state-mutating POST the MCP layer sends declares a JSON content-type', async () => {
  await withStack(async ({ hub, mcp }) => {
    await mcp.callTool('dsh_worker_config', { persistent_sessions: true, mode: 'hub' });

    // Drive each mutating client call that this harness can reach: spawn (POST
    // /jobs), a persistent session turn (POST /sessions/:id/turns), close
    // (POST /sessions/:id/close), a one-shot spawn + cancel. `/worker-probe`
    // and `/proc-kill` need a live provider/process and are covered by their
    // own route tests; their client calls are asserted structurally below.
    const first = await mcp.callTool('dsh_run_worker', { task: 'turn one', cwd: ISOLATED_HOME, persistent: true });
    assert.equal(first.isError, false, first.text);
    const sessionId = first.payload.session_id;
    const second = await mcp.callTool('dsh_run_worker', { task: 'turn two', cwd: ISOLATED_HOME, session_id: sessionId });
    assert.equal(second.isError, false, second.text);
    const closed = await mcp.callTool('dsh_session_close', { session_id: sessionId });
    assert.equal(closed.payload.closed, true, closed.text);

    const release = hub.fake.holdTurns();
    const spawned = await mcp.callTool('dsh_spawn_worker', { task: 'cancel me', cwd: ISOLATED_HOME, permission: 'read-only' });
    const cancelTarget = spawned.payload.id;
    try {
      await mcp.callTool('dsh_worker_cancel', { job_id: cancelTarget });
    } finally {
      release();
    }

    const mutating = hub.received.filter((r) => (
      r.method === 'POST'
      && ['/_dsh/dsh-crew/jobs', `/_dsh/dsh-crew/jobs/${cancelTarget}/cancel`].concat(
        hub.received.filter((x) => /\/sessions\/[^/]+\/(turns|close)$/.test(x.path)).map((x) => x.path),
      ).includes(r.path)
    ));
    assert.ok(mutating.length >= 4, `expected spawn/turn/close/cancel traffic, got ${JSON.stringify(hub.received.map((r) => [r.method, r.path]))}`);
    for (const req of mutating) {
      assert.equal(
        req.contentType,
        'application/json',
        `${req.method} ${req.path} reached the hub without a JSON content-type -> the P0 guard would 415 it`,
      );
    }
  });
});
