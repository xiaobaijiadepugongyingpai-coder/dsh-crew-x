// Opt-in persistent DSH sessions, MCP layer (batch 3).
//
// These tests drive the real `src/server.mjs` over stdio — the same harness
// style as tests/worker-permission.test.mjs — against a STUB HUB on loopback, so
// a wrong argument can never reach a real DSH profile, a real session, or the
// user's config. What is asserted is the contract a forwarded subagent depends
// on: which refusals happen before any runtime is touched, that a follow-up
// turn does NOT overwrite the session's locked preset, and that a persistent
// turn never silently escalates flash -> pro.
//
// Isolation: HOME / USERPROFILE point at a temp dir before anything resolves
// ~/.config/dsh-crew, so `npm test` never writes the real profile.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'dsh-crew-psess-mcp-'));
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
process.env.HOME = ISOLATED_HOME;
process.env.USERPROFILE = ISOLATED_HOME;

after(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

// ---------- stub hub ----------

/**
 * A minimal hub the MCP server can talk to.
 *
 * `turns` records every POST the server makes, so an assertion can read the
 * exact payload that WOULD have reached DSH — in particular whether a follow-up
 * turn carried a `preset` the caller never named.
 */
function makeStubHub({ spawnResponse, turnResponse, closeResponse } = {}) {
  const state = { spawns: [], turns: [], closes: [], lists: 0 };

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const readBody = async () => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      return raw === '' ? {} : JSON.parse(raw);
    };
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/^\/_dsh\/dsh-crew/, '');

    if (path === '/ping') return json(res, 200, { ok: true, service: 'dsh-crew-hub' });
    if (path === '/providers') return json(res, 200, { ok: true, providers: [], bindings: null });

    if (path === '/jobs' && req.method === 'POST') {
      const body = await readBody();
      state.spawns.push(body);
      const job = spawnResponse
        ? spawnResponse(body)
        : { id: 'hub-p1', status: 'done', sessionId: 'session-stub-1', turnIndex: 1, result: 'ok', tokens: {}, permission: body.permission, preset: body.preset };
      // The server waits through GET /jobs/:id, so the spawn answer IS the
      // settled view the wait must observe.
      state.lastJob = job;
      return json(res, 200, { ok: true, job });
    }

    // GET /jobs/:id — the wait after a spawn/turn.
    const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
    if (jobMatch) {
      const settle = state.lastJob ?? { id: decodeURIComponent(jobMatch[1]), status: 'done', result: 'turn done', tokens: {} };
      return json(res, 200, { ok: true, job: settle });
    }

    if (path === '/sessions' && req.method === 'GET') {
      state.lists += 1;
      return json(res, 200, { ok: true, sessions: [{ session_id: 'session-stub-1', turns: 1 }] });
    }

    const turnMatch = path.match(/^\/sessions\/([^/]+)\/turns$/);
    if (turnMatch && req.method === 'POST') {
      const sessionId = decodeURIComponent(turnMatch[1]);
      const body = await readBody();
      state.turns.push({ sessionId, body });
      const job = turnResponse
        ? turnResponse(sessionId, body)
        : { id: 'hub-t2', status: 'done', sessionId, turnIndex: 2, result: 'second turn', tokens: {}, permission: body.permission, preset: body.preset };
      state.lastJob = job;
      return json(res, 200, { ok: true, session_id: sessionId, turn_index: 2, job });
    }

    const closeMatch = path.match(/^\/sessions\/([^/]+)\/close$/);
    if (closeMatch && req.method === 'POST') {
      const sessionId = decodeURIComponent(closeMatch[1]);
      state.closes.push(sessionId);
      const out = closeResponse
        ? closeResponse(sessionId)
        : { ok: true, session_id: sessionId, closed: true };
      const { ok, ...rest } = out;
      return json(res, 200, { ok: true, ...rest });
    }

    return json(res, 404, { ok: false, error: `stub hub: no route for ${req.method} ${path}` });
  });

  return { server, state };
}

// ---------- MCP stdio client ----------

/**
 * Spawn `src/server.mjs` over stdio and return a request() bound to it.
 *
 * `env` is layered over the isolated-home default so a test can point the
 * server at a stub hub, or at nothing at all.
 */
async function startServer({ env = {}, stubPort } = {}) {
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: ISOLATED_HOME,
      USERPROFILE: ISOLATED_HOME,
      ...(stubPort ? { DSHPLUGIN_CREW_HUB: `http://127.0.0.1:${stubPort}` } : {}),
      ...env,
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
  // Drain stderr so a chatty child can never block on a full pipe.
  child.stderr.on('data', () => {});

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'persistent-mcp-test', version: '0.0.0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const callTool = async (name, args) => {
    const res = await request('tools/call', { name, arguments: args });
    const payload = parsePayload(res);
    return {
      res,
      payload,
      isError: res.result?.isError === true,
      text: res.result?.content?.[0]?.text ?? '',
    };
  };

  const stop = async () => {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  };

  return { child, request, callTool, stop };
}

/** Tool output is JSON in a text block; fall back to raw text on a non-JSON body. */
function parsePayload(res) {
  const raw = res?.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(raw); } catch { return raw; }
}

/** Read the error code a refusal carries (prose-only refusals report null). */
function codeOf(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  const code = payload.code ?? payload.error_code;
  if (typeof code === 'string') return code;
  // Older/simpler refusals put the code in the message only.
  const text = String(payload.error ?? '');
  const match = text.match(/\b(PERSISTENT_[A-Z_]+|INVALID_PERSISTENT_ARGS|SESSION_[A-Z_]+)\b/);
  return match ? match[1] : null;
}

// ---------- 1. tool surface ----------

test('tools/list advertises dsh_session_close and the persistent args only on dsh_run_worker', async () => {
  const { request, stop } = await startServer();
  try {
    const listed = await request('tools/list', {});
    const tools = new Map((listed.result?.tools ?? []).map((t) => [t.name, t]));

    assert.ok(tools.has('dsh_session_close'), 'dsh_session_close must be registered');
    assert.equal(tools.size, 8, `expected 8 tools, got ${[...tools.keys()].join(', ')}`);

    const closeProps = tools.get('dsh_session_close').inputSchema.properties ?? {};
    assert.deepEqual(Object.keys(closeProps), ['session_id']);
    assert.deepEqual(
      tools.get('dsh_session_close').inputSchema.required,
      ['session_id'],
      'session_id must be required on dsh_session_close',
    );

    const runProps = tools.get('dsh_run_worker').inputSchema.properties ?? {};
    assert.equal(runProps.persistent?.type, 'boolean', 'dsh_run_worker must expose persistent');
    assert.equal(runProps.session_id?.type, 'string', 'dsh_run_worker must expose session_id');

    // The async fan-out tool stays a pure one-shot surface: no persistent args.
    const spawnProps = tools.get('dsh_spawn_worker').inputSchema.properties ?? {};
    assert.equal(spawnProps.persistent, undefined, 'dsh_spawn_worker must NOT expose persistent');
    assert.equal(spawnProps.session_id, undefined, 'dsh_spawn_worker must NOT expose session_id');

    // dsh_worker_config gained the feature flag.
    const cfgProps = tools.get('dsh_worker_config').inputSchema.properties ?? {};
    assert.equal(cfgProps.persistent_sessions?.type, 'boolean');
  } finally {
    await stop();
  }
});

test('dsh_worker_config reports persistent_sessions and can flip it for the session', async () => {
  const { callTool, stop } = await startServer();
  try {
    const initial = await callTool('dsh_worker_config', {});
    assert.equal(initial.payload.persistent_sessions, false, 'the feature is off by default');

    const enabled = await callTool('dsh_worker_config', { persistent_sessions: true });
    assert.equal(enabled.payload.persistent_sessions, true);
    const reread = await callTool('dsh_worker_config', {});
    assert.equal(reread.payload.persistent_sessions, true, 'the override must stick for the session');
  } finally {
    await stop();
  }
});

// ---------- 2. refusals, in the documented order ----------

test('PERSISTENT_SESSIONS_DISABLED while the feature flag is off', async () => {
  const { callTool, stop } = await startServer();
  try {
    // The flag is off by default, so the refusal must land before the hub is
    // even probed (there is no hub in this test at all).
    const first = await callTool('dsh_run_worker', { task: 'x', persistent: true });
    assert.equal(codeOf(first.payload), 'PERSISTENT_SESSIONS_DISABLED');
    assert.match(first.text, /persistent sessions are disabled/);

    const followup = await callTool('dsh_run_worker', { task: 'x', session_id: 'session-abc' });
    assert.equal(codeOf(followup.payload), 'PERSISTENT_SESSIONS_DISABLED');

    const close = await callTool('dsh_session_close', { session_id: 'session-abc' });
    assert.equal(codeOf(close.payload), 'PERSISTENT_SESSIONS_DISABLED');
  } finally {
    await stop();
  }
});

test('INVALID_PERSISTENT_ARGS when both persistent:true and session_id are passed', async () => {
  const { callTool, stop } = await startServer();
  try {
    await callTool('dsh_worker_config', { persistent_sessions: true });
    const res = await callTool('dsh_run_worker', {
      task: 'x',
      persistent: true,
      session_id: 'session-abc',
    });
    assert.equal(codeOf(res.payload), 'INVALID_PERSISTENT_ARGS');
    assert.match(res.text, /cannot be combined/);
  } finally {
    await stop();
  }
});

test('PERSISTENT_CLI_UNSUPPORTED for an external CLI worker', async () => {
  const { callTool, stop } = await startServer();
  try {
    await callTool('dsh_worker_config', { persistent_sessions: true });
    const res = await callTool('dsh_run_worker', {
      task: 'x',
      worker: 'agy',
      persistent: true,
    });
    assert.equal(codeOf(res.payload), 'PERSISTENT_CLI_UNSUPPORTED');

    // A follow-up turn on the CLI path is refused the same way.
    const followup = await callTool('dsh_run_worker', { task: 'x', worker: 'agy', session_id: 'session-abc' });
    assert.equal(codeOf(followup.payload), 'PERSISTENT_CLI_UNSUPPORTED');
  } finally {
    await stop();
  }
});

test('PERSISTENT_STANDALONE_UNSUPPORTED when the hub is unreachable', async () => {
  // A port nothing listens on: the probe fails, so mode resolves to standalone.
  const deadPort = 1;
  const { callTool, stop } = await startServer({ stubPort: deadPort });
  try {
    await callTool('dsh_worker_config', { persistent_sessions: true, mode: 'auto' });
    const res = await callTool('dsh_run_worker', { task: 'x', persistent: true });
    assert.equal(codeOf(res.payload), 'PERSISTENT_STANDALONE_UNSUPPORTED');
    assert.match(res.text, /DSH hub/);
  } finally {
    await stop();
  }
});

test('PERSISTENT_STANDALONE_UNSUPPORTED when mode is explicitly standalone', async () => {
  const { callTool, stop } = await startServer();
  try {
    await callTool('dsh_worker_config', { persistent_sessions: true, mode: 'standalone' });
    const res = await callTool('dsh_run_worker', { task: 'x', persistent: true });
    assert.equal(codeOf(res.payload), 'PERSISTENT_STANDALONE_UNSUPPORTED');
  } finally {
    await stop();
  }
});

test('persistent:false alone is a one-shot dispatch, not a feature-flag error', async () => {
  // With the flag off, `persistent: false` names no persistent mode at all, so
  // it must fall through to the ordinary path and fail for a one-shot reason
  // (here: no hub and no local runtime), never PERSISTENT_SESSIONS_DISABLED.
  const { callTool, stop } = await startServer();
  try {
    const res = await callTool('dsh_run_worker', { task: 'x', persistent: false });
    assert.notEqual(codeOf(res.payload), 'PERSISTENT_SESSIONS_DISABLED');
  } finally {
    await stop();
  }
});

// ---------- 3. persistent dispatch behaviour ----------

test('first turn creates the session, returns session_id, and dsh_session_close echoes it', async () => {
  const { server, state } = makeStubHub();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const { callTool, stop } = await startServer({ stubPort: port });
  try {
    await callTool('dsh_worker_config', { persistent_sessions: true, mode: 'hub' });

    const first = await callTool('dsh_run_worker', {
      task: 'first turn',
      cwd: ISOLATED_HOME,
      persistent: true,
    });
    assert.equal(first.isError, false, first.text);
    assert.equal(first.payload.session_id, 'session-stub-1', 'the first turn must return session_id');
    assert.equal(first.payload.status, 'done');
    assert.equal(state.spawns.length, 1);
    assert.equal(state.spawns[0].persistent, true, 'the first turn must ask the hub to CREATE a session');
    assert.equal(state.spawns[0].maxPermission, 'workspace-write');
    assert.ok(state.spawns[0].provider !== undefined, 'the tier binding must travel');

    const closed = await callTool('dsh_session_close', { session_id: first.payload.session_id });
    assert.equal(closed.payload.session_id, 'session-stub-1', 'close must echo the session_id');
    assert.equal(closed.payload.closed, true);
    assert.deepEqual(state.closes, ['session-stub-1']);
  } finally {
    await stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a follow-up turn with NO preset does not send a resolved default preset', async () => {
  const { server, state } = makeStubHub();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const { callTool, stop } = await startServer({ stubPort: port });
  try {
    await callTool('dsh_worker_config', {
      persistent_sessions: true,
      mode: 'hub',
      // A default preset the follow-up must NOT inject: sending it would
      // overwrite whatever the session locked at creation.
      preset_flash: 'auditor-flash',
      preset_pro: 'auditor-pro',
    });

    const first = await callTool('dsh_run_worker', { task: 'turn one', cwd: ISOLATED_HOME, persistent: true });
    // The creating turn DOES lock a preset, so the default is expected there.
    assert.equal(state.spawns[0].preset, 'auditor-flash', 'the first turn locks the resolved default preset');

    const second = await callTool('dsh_run_worker', {
      task: 'turn two',
      cwd: ISOLATED_HOME,
      session_id: first.payload.session_id,
      // tier switched, preset NOT named -> tolerant inheritance
      tier: 'pro',
    });
    assert.equal(second.isError, false, second.text);
    assert.equal(state.turns.length, 1, 'the follow-up must go through POST /sessions/:id/turns');
    assert.equal(state.turns[0].sessionId, 'session-stub-1');
    assert.equal(
      Object.prototype.hasOwnProperty.call(state.turns[0].body, 'preset'),
      false,
      'a follow-up that names no preset must not send one (tolerant inheritance)',
    );
    assert.equal(state.turns[0].body.tier, 'pro', 'the per-turn tier must still travel');
    assert.equal(state.turns[0].body.cwd, state.spawns[0].cwd, 'cwd is always passed for hub-side validation');
  } finally {
    await stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an explicit differing preset on a follow-up surfaces SESSION_PRESET_MISMATCH', async () => {
  const { server, state } = makeStubHub({
    turnResponse: (sessionId) => ({ id: 'hub-t2', status: 'failed', sessionId, error: 'session is busy' }),
  });
  // Make the turn route answer the real refusal the hub sends.
  const originalHandler = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    if (/\/sessions\/[^/]+\/turns$/.test(req.url) && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      state.turns.push({ sessionId: 'session-stub-1', body: JSON.parse(raw || '{}') });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: 'preset "other-preset" does not match this session\'s locked preset "auditor-flash"; omit preset to inherit it',
        code: 'SESSION_PRESET_MISMATCH',
      }));
      return;
    }
    return originalHandler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const { callTool, stop } = await startServer({ stubPort: port });
  try {
    await callTool('dsh_worker_config', { persistent_sessions: true, mode: 'hub', preset_flash: 'auditor-flash' });
    const first = await callTool('dsh_run_worker', { task: 'turn one', cwd: ISOLATED_HOME, persistent: true });

    const conflict = await callTool('dsh_run_worker', {
      task: 'turn two',
      cwd: ISOLATED_HOME,
      session_id: first.payload.session_id,
      preset: 'other-preset',
    });
    assert.equal(codeOf(conflict.payload), 'SESSION_PRESET_MISMATCH', conflict.text);
    assert.equal(
      state.turns[0].body.preset,
      'other-preset',
      'an explicitly named preset MUST travel so the hub can compare it',
    );
    assert.equal(conflict.payload.session_id, 'session-stub-1', 'the refusal still names the session');
  } finally {
    await stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a failed persistent flash turn is NOT retried on pro', async () => {
  // Escalation is on, the tier policy allows it, and the turn fails: the
  // one-shot path would retry on pro here. A persistent session must not,
  // because the failed turn's context would stay in the session.
  const { server, state } = makeStubHub({
    spawnResponse: (body) => ({
      id: 'hub-f1',
      status: 'failed',
      sessionId: 'session-stub-fail',
      turnIndex: 1,
      error: 'boom',
      tokens: {},
      permission: body.permission,
      preset: body.preset,
    }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const { callTool, stop } = await startServer({ stubPort: port });
  try {
    await callTool('dsh_worker_config', {
      persistent_sessions: true,
      mode: 'hub',
      escalate_on_failure: true,
      tier_policy: 'auto',
    });
    const res = await callTool('dsh_run_worker', {
      task: 'will fail',
      cwd: ISOLATED_HOME,
      persistent: true,
      tier: 'flash',
    });
    assert.equal(res.payload.status, 'failed');
    assert.equal(state.spawns.length, 1, 'no second spawn: a persistent turn is never retried on pro');
    assert.equal(res.payload.escalated, undefined, 'no escalation marker in persistent mode');
    assert.equal(res.payload.session_id, 'session-stub-fail');
    // The claim was made, so the session is the caller's to retry or close.
    assert.ok(res.payload.report_path || res.payload.error, 'the failure must be visible to the caller');
  } finally {
    await stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('dsh_session_close maps a disabled feature and reports hub refusals as answers', async () => {
  const { server, state } = makeStubHub({
    closeResponse: (sessionId) => ({ ok: true, session_id: sessionId, closed: true }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const { callTool, stop } = await startServer({ stubPort: port });
  try {
    // Flag off -> the hub is never contacted.
    const disabled = await callTool('dsh_session_close', { session_id: 'session-x' });
    assert.equal(codeOf(disabled.payload), 'PERSISTENT_SESSIONS_DISABLED');
    assert.deepEqual(state.closes, []);

    await callTool('dsh_worker_config', { persistent_sessions: true });
    const closed = await callTool('dsh_session_close', { session_id: 'session-x' });
    assert.equal(closed.payload.closed, true);
    assert.equal(closed.payload.session_id, 'session-x');
    assert.deepEqual(state.closes, ['session-x']);
  } finally {
    await stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('src stays free of @deepseek-ai imports for the persistent-session modules', async () => {
  const { readFileSync } = await import('node:fs');
  for (const rel of ['src/hub/persistent-sessions.mjs', 'src/hub-client.mjs']) {
    const source = readFileSync(join(ROOT, rel), 'utf8');
    assert.equal(
      /from\s+['"]@deepseek-ai\//.test(source),
      false,
      `${rel} must not import @deepseek-ai/* (profile realm rule)`,
    );
  }
  // The poll-slice constant is load-bearing for the hub client's long waits.
  const client = readFileSync(join(ROOT, 'src/hub-client.mjs'), 'utf8');
  assert.ok(client.includes('MAX_POLL_SLICE_SECONDS = 60'));
});
