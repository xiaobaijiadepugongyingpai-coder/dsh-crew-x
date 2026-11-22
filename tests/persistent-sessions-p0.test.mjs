// P0 hardening for opt-in persistent DSH sessions (batch 3, commit B).
//
// Three defects proven before this file existed:
//
//   P0-1  No hub-side per-turn timeout. The idle reaper skips `running`, so a
//         worker that never settles left the session permanently 409
//         SESSION_BUSY. There is now a watchdog — and, per the owner's
//         amendment, a monotonic `turnEpoch` so a zombie turn that settles LATE
//         can never clobber a successor's state.
//   P0-1b `closePersistentSession` racing `agents.resume()` revived a closed id.
//   P0-2  `canonicalSessionCwd` mishandled `\\?\` prefixes, drive roots vs
//         drive-relative paths, and POSIX-treating `C:foo`; `spawnPersistentTurn`
//         had no absolute-cwd guard.
//   P0-3  Mutating POSTs accepted any content type (cross-origin simple request).
//
// Same harness style as tests/persistent-sessions-hub.test.mjs: a fake `ctx`, so
// nothing here can reach a real DSH profile. HOME/USERPROFILE are isolated.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'dsh-crew-p0-home-'));
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
process.env.HOME = ISOLATED_HOME;
process.env.USERPROFILE = ISOLATED_HOME;

const { WorkerRegistry, apply } = await import('../src/hub/index.mjs');
const { canonicalSessionCwd, HubRequestError } = await import('../src/hub/persistent-sessions.mjs');

after(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

// ---------- fake ctx ----------

/**
 * A fake hub `ctx`. `settle: false` models an agent that never settles on its
 * own (the P0-1 defect); the returned `releaseHang()` lets a test simulate that
 * hung turn finally settling LATE, which is what a zombie turn looks like.
 */
function makeCtx({ settle = true } = {}) {
  const log = { creates: [], followups: 0, disposes: 0, cancels: [], appends: [] };
  // Hang control for the "agent never settles" defect. `hanging` decides whether
  // a NEW `whenIdle()` blocks; each gate stays blocked until released, so a test
  // can let one already-waiting turn settle while a later turn keeps hanging.
  // (Both turns share ONE agent handle — a persistent session reuses it — so
  // gating per agent would release the successor too.)
  let hanging = !settle;
  const waits = [];

  const buildAgent = (options) => {
    const record = {
      sessionId: options.sessionId, disposed: 0, cancels: [], agentTag: null,
    };
    const listeners = {};
    const session = {
      header: { cwd: options.meta?.cwd, ...(options.meta?.agentPreset ? { agentPreset: options.meta.agentPreset } : {}) },
      events: [],
      async append(type, data) { log.appends.push({ type, mode: data?.mode }); },
    };
    const emit = (type, data) => { for (const fn of listeners['session/event'] ?? []) fn(session, { type, data }); };
    let pending = null;
    const agent = {
      session,
      id: options.sessionId,
      async whenIdle() {
        if (hanging) {
          let release;
          const gate = new Promise((resolve) => { release = resolve; });
          waits.push(release);
          await gate;
        }
        await pending;
      },
      followup() {
        log.followups += 1;
        pending = Promise.resolve().then(() => {
          if (!settle) return;
          emit('assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } });
          emit('turn/end', { reason: { kind: 'completed' } });
        });
      },
      cancel(cause) { record.cancels.push(cause); log.cancels.push(cause); },
    };
    return { record, agent, listeners, session };
  };

  const setupCtx = (built) => ({
    agent: { session: built.session, id: built.record.sessionId },
    on(name, fn) { (built.listeners[name] ??= []).push(fn); },
  });

  const ctx = {
    logger: { warn() {}, info() {} },
    get(name) {
      if (name === 'agentPresets') {
        return { async resolve(id) { return { id: id ?? 'builtin-default' }; }, async mount() {} };
      }
      return undefined;
    },
    sessions: { async flush() {} },
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
    /**
     * Release the blocked `whenIdle()` at queue position `index` (0 = oldest),
     * allowing that turn to advance one step. Positions are deterministic: a
     * released wait resumes its turn, which may append a NEW wait at the tail.
     */
    async releaseAt(index) {
      assert.ok(waits.length > index, `no blocked wait at ${index} (have ${waits.length})`);
      const [release] = waits.splice(index, 1);
      release();
      await new Promise((resolve) => setImmediate(resolve));
    },
    get waitCount() { return waits.length; },
  };
}

/** A registry with the reaper timer OFF and a config the test controls. */
function makeRegistry(fake, { config = {} } = {}) {
  const registry = new WorkerRegistry(fake.ctx, { publish() {} }, { reaperIntervalMs: 0 });
  registry.getConfig = () => ({ preset_flash: 'fp', preset_pro: 'pp', flash_model: 'fm', pro_model: 'pm', ...config });
  return registry;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- P0-1: per-turn watchdog ----------

test('a turn that never settles is timed out, released to idle, and keeps its handle', async () => {
  const fake = makeCtx({ settle: false });
  const registry = makeRegistry(fake, { config: { persistent_session_idle_timeout_enabled: false } });

  const first = await registry.spawnPersistentSession({
    task: 'will never settle',
    cwd: ISOLATED_HOME,
    turnTimeoutMs: 120,
  });
  const rec = registry.persistentSessions.get(first.sessionId);
  assert.equal(rec.status, 'running', 'the session starts out running');

  // The watchdog fires without the turn ever settling.
  await sleep(400);

  assert.equal(rec.status, 'idle', 'the record is released to idle');
  assert.equal(first.status, 'failed', 'the turn job is marked failed');
  assert.equal(first.stopReason, 'timeout');
  assert.match(first.error, /timed out/);
  assert.match(first.error, /returned to idle/, 'the error tells the caller the session survived');
  assert.equal(fake.log.disposes, 0, 'the handle must NOT be disposed: the session stays usable');
  assert.equal(rec.handle !== null, true, 'the runtime handle is still there');

  // A SUBSEQUENT turn on the same session is ADMITTED — no SESSION_BUSY, and it
  // takes ownership of the record. (This agent also never settles, so the turn
  // itself stays running; admission is the point, and its own watchdog covers
  // the rest.)
  const second = await registry.spawnPersistentTurn({
    sessionId: first.sessionId,
    task: 'second attempt',
    cwd: ISOLATED_HOME,
    turnTimeoutMs: 5_000,
  });
  assert.ok(second.id);
  assert.notEqual(second.id, first.id);
  assert.equal(rec.status, 'running', 'the successor turn owns the session');
  assert.equal(rec.activeJob, second);
  registry.clearTurnWatchdog(second);
});

test('the watchdog is disabled by a zero/negative timeout and by default resolution order', async () => {
  const fake = makeCtx({ settle: false });
  const registry = makeRegistry(fake);

  // 0 disables.
  const off = await registry.spawnPersistentSession({ task: 'no watchdog', cwd: ISOLATED_HOME, turnTimeoutMs: 0 });
  assert.equal(off.watchdogTimer, null, 'no timer is armed when the timeout is 0');
  await sleep(60);
  const recOff = registry.persistentSessions.get(off.sessionId);
  assert.equal(recOff.status, 'running', 'nothing reclaimed it, because the watchdog is off');
  registry.clearTurnWatchdog(off);

  // A negative value disables too.
  const neg = await registry.spawnPersistentSession({ task: 'no watchdog', cwd: ISOLATED_HOME, turnTimeoutMs: -5 });
  assert.equal(neg.watchdogTimer, null);

  // spec wins over the registry default, which wins over the module default.
  const withDefault = makeRegistry(makeCtx({ settle: false }));
  withDefault.persistentTurnTimeoutMs = 90;
  const viaDefault = await withDefault.spawnPersistentSession({ task: 'registry default', cwd: ISOLATED_HOME });
  assert.notEqual(viaDefault.watchdogTimer, null, 'the registry-level default arms the timer');
  await sleep(300);
  assert.equal(withDefault.persistentSessions.get(viaDefault.sessionId).status, 'idle');
});

test('A2: a normal turn clears its watchdog timer (no leaked timer keeps the process alive)', async () => {
  const fake = makeCtx();
  const registry = makeRegistry(fake);
  const job = await registry.spawnPersistentSession({
    task: 'settles normally',
    cwd: ISOLATED_HOME,
    turnTimeoutMs: 60_000,
  });
  assert.notEqual(job.watchdogTimer, null, 'the timer was armed for the turn');
  await job.promise;
  assert.equal(job.watchdogTimer, null, 'the settled turn cleared its own timer');

  // And an explicit clear is idempotent.
  registry.clearTurnWatchdog(job);
  assert.equal(job.watchdogTimer, null);
});

test('A2: dispose() with an in-flight persistent turn leaves no armed timer', async () => {
  const fake = makeCtx({ settle: false });
  const registry = makeRegistry(fake);
  const job = await registry.spawnPersistentSession({
    task: 'in flight at dispose',
    cwd: ISOLATED_HOME,
    turnTimeoutMs: 60_000,
  });
  assert.notEqual(job.watchdogTimer, null);
  await registry.dispose();
  assert.equal(job.watchdogTimer, null, 'dispose cleared the in-flight turn timer');
});

test('A2: cancel() clears the turn watchdog', async () => {
  const fake = makeCtx({ settle: false });
  const registry = makeRegistry(fake);
  const job = await registry.spawnPersistentSession({
    task: 'cancel me',
    cwd: ISOLATED_HOME,
    turnTimeoutMs: 60_000,
  });
  assert.notEqual(job.watchdogTimer, null);
  await registry.cancel(job.id);
  assert.equal(job.watchdogTimer, null, 'a cancelled turn has no timer left behind');
  assert.equal(job.status, 'cancelled');
});

test('A1: a timeout firing after a NEWER turn started is a no-op', async () => {
  const fake = makeCtx({ settle: false });
  const registry = makeRegistry(fake);

  const first = await registry.spawnPersistentSession({
    task: 'turn one',
    cwd: ISOLATED_HOME,
    turnTimeoutMs: 10_000, // long: we fire it by hand
  });
  const rec = registry.persistentSessions.get(first.sessionId);

  // Simulate: turn 1's timer is still armed, but the record has moved on to a
  // newer turn (as would happen if turn 1 was released another way).
  rec.status = 'idle';
  rec.activeJob = null;
  const second = await registry.spawnPersistentTurn({
    sessionId: first.sessionId,
    task: 'turn two',
    cwd: ISOLATED_HOME,
    turnTimeoutMs: 10_000,
  });
  assert.equal(rec.status, 'running', 'turn 2 owns the record');

  // Now turn 1's stale watchdog fires. It must not touch turn 2's state.
  registry.fireTurnWatchdog(rec, first, 10_000);
  assert.equal(rec.status, 'running', 'the stale timer did NOT flip the record to idle');
  assert.equal(first.status, 'running', 'and it did not mark the stale job failed');
  registry.clearTurnWatchdog(second);
});

test('A1: a zombie turn settling LATE cannot clobber a successor turn', async () => {
  const fake = makeCtx({ settle: false });
  const registry = makeRegistry(fake);

  const first = await registry.spawnPersistentSession({
    task: 'turn one',
    cwd: ISOLATED_HOME,
    turnTimeoutMs: 100,
  });
  const rec = registry.persistentSessions.get(first.sessionId);

  // Let the watchdog reclaim the session while turn 1 still hangs.
  await sleep(300);
  assert.equal(rec.status, 'idle');

  // Turn 2 starts and owns the record. It hangs too (new whenIdle() blocks), so
  // it cannot settle on its own and muddy the assertion.
  const second = await registry.spawnPersistentTurn({
    sessionId: first.sessionId,
    task: 'turn two',
    cwd: ISOLATED_HOME,
    turnTimeoutMs: 10_000,
  });
  assert.equal(rec.status, 'running');
  assert.ok(second.turnEpoch > first.turnEpoch, 'the epoch is monotonic across turns');

  // Now turn 1's hung wait finally settles: its `finally` runs LATE, after the
  // watchdog reclaimed the session and turn 2 took it. This is exactly the
  // zombie settle the epoch guard exists to neutralise.
  //
  // Both turns share ONE agent handle (a persistent session reuses it), so both
  // are blocked on `whenIdle()` and their waits are distinguishable only by
  // position: [turn1-first, turn2-first]. Releasing turn 1 lets it advance and
  // append its SECOND wait at the tail, so the queue becomes
  // [turn2-first, turn1-second] — release that one to let the zombie finish.
  // Turn 2's wait stays blocked throughout, so nothing but turn 1 can write back.
  assert.equal(fake.waitCount, 2, 'turn 1 and turn 2 each hold one blocked wait');
  await fake.releaseAt(0); // turn 1: before-followup wait
  assert.equal(fake.waitCount, 2, 'turn 1 advanced and queued its second wait');
  await fake.releaseAt(1); // turn 1: after-followup wait
  await first.promise.catch(() => {});

  assert.equal(rec.status, 'running', 'turn 1 did NOT flip the record to idle');
  assert.equal(rec.activeJob, second, 'the record still points at turn 2');
  assert.equal(rec.turnEpoch, second.turnEpoch, 'turn 2 still owns the epoch');
  assert.equal(fake.waitCount, 1, "turn 2's own wait is still blocked");
  registry.clearTurnWatchdog(second);
});

test('A1: stillOwnsTurn rejects a stale epoch even when the pointer still matches', async () => {
  const fake = makeCtx({ settle: false });
  const registry = makeRegistry(fake);
  const job = await registry.spawnPersistentSession({ task: 'epoch probe', cwd: ISOLATED_HOME, turnTimeoutMs: 0 });
  const rec = registry.persistentSessions.get(job.sessionId);

  assert.equal(registry.stillOwnsTurn(rec, job), true);
  // Epoch matches but the object is a COPY, not the record's activeJob -> the
  // identity guard refuses it. Both guards must pass, so this is false.
  assert.equal(registry.stillOwnsTurn(rec, { ...job }), false, 'identity is the secondary guard');
  // Pointer matches, epoch does not -> NOT the owner (the epoch is primary).
  const stale = { ...job, turnEpoch: job.turnEpoch - 1 };
  assert.equal(registry.stillOwnsTurn(rec, stale), false, 'a stale epoch outranks a matching pointer');
  assert.equal(registry.stillOwnsTurn(rec, null), false);
  // After a close nulls activeJob, even the true job stops owning.
  await registry.closePersistentSession(job.sessionId, { reason: 'test' });
  assert.equal(registry.stillOwnsTurn(rec, job), false);
});

// ---------- P0-1b: close during resume ----------

test('a close landing during an in-flight resume does not revive the session', async () => {
  const fake = makeCtx();
  let resumeResolve;
  let resumedHandleDisposed = 0;
  const resumeStarted = new Promise((resolveStarted) => {
    fake.ctx.agents.resume = async (options) => {
      const built = {
        record: { sessionId: options.resumeSessionId, disposed: 0 },
        session: { header: { cwd: ISOLATED_HOME }, events: [] },
      };
      const agent = {
        session: built.session,
        id: options.resumeSessionId,
        async whenIdle() {},
        followup() {},
        cancel() {},
      };
      await options.setup({ agent: { session: built.session }, on() {} });
      resolveStarted();
      // Hold the resume open so the test can close the session underneath it.
      await new Promise((r) => { resumeResolve = r; });
      return { agent, async dispose() { resumedHandleDisposed += 1; built.record.disposed += 1; } };
    };
  });

  const registry = makeRegistry(fake);
  const resumePromise = registry.spawnPersistentTurn({
    sessionId: 'session-race',
    task: 'turn while resuming',
    cwd: ISOLATED_HOME,
  }).catch((err) => err);

  await resumeStarted;
  // Close the session WHILE the resume is still awaiting.
  await registry.closePersistentSession('session-race', { reason: 'closed mid-resume' });

  // Let the resume finish: it must notice the tombstone, dispose, and refuse.
  resumeResolve();
  const outcome = await resumePromise;

  assert.ok(outcome instanceof HubRequestError, `expected a HubRequestError, got ${outcome}`);
  assert.equal(outcome.code, 'SESSION_CLOSED', 'the resume refuses instead of reviving');
  assert.equal(registry.persistentSessions.has('session-race'), false, 'the closed id was NOT reinserted');
  assert.equal(resumedHandleDisposed, 1, 'the freshly resumed handle was disposed, not leaked');
});

// ---------- P0-2: cwd canonicalisation ----------

test('P0-2: canonicalSessionCwd handles Windows spellings deterministically', () => {
  // --- equalities that MUST hold ---
  const equal = [
    ['forward vs back slashes', 'D:\\x\\y', 'd:/x/y'],
    ['trailing separator', 'D:/x/y/', 'D:/x/y'],
    ['dot segments', 'D:\\x\\.\\y', 'D:/x/y'],
    ['dotdot segments', 'D:\\x\\z\\..\\y', 'D:/x/y'],
    ['drive-letter case', 'C:\\Work', 'c:\\work'],
    ['extended-length prefix', '\\\\?\\D:\\x\\y', 'D:\\x\\y'],
    ['UNC both forms', '\\\\srv\\share\\p', '//srv/share/p'],
    ['UNC case', '\\\\SRV\\Share\\P', '\\\\srv\\share\\p'],
    ['extended-length UNC', '\\\\?\\UNC\\srv\\share\\p', '\\\\srv\\share\\p'],
    ['extended-length UNC, mixed case', '\\\\?\\UNC\\SRV\\Share\\P', '//srv/share/p'],
    ['drive-relative case', 'C:foo', 'c:foo'],
    ['drive-relative separators', 'C:a\\b', 'c:a/b'],
    ['POSIX root', '/', '/'],
    ['POSIX trailing slash', '/srv/work/', '/srv/work'],
  ];
  for (const [label, a, b] of equal) {
    assert.equal(canonicalSessionCwd(a), canonicalSessionCwd(b), label);
  }

  // --- separations that MUST survive (a mismatch is what a lock relies on) ---
  const differ = [
    ['drive root vs drive-relative', 'D:/', 'D:'],
    ['drive root vs child', 'D:/', 'D:/x'],
    ['drive-relative vs drive-absolute', 'd:foo', 'd:/foo'],
    ['two different workspaces', 'D:\\x', 'D:\\y'],
    ['POSIX case sensitivity (macOS out of scope)', '/srv/work', '/srv/Work'],
    ['POSIX root vs child', '/', '/srv'],
  ];
  for (const [label, a, b] of differ) {
    assert.notEqual(canonicalSessionCwd(a), canonicalSessionCwd(b), label);
  }

  // --- both sides of the drive-root rule are self-consistent ---
  assert.equal(canonicalSessionCwd('D:/'), 'd:/', 'a drive root keeps its separator');
  assert.equal(canonicalSessionCwd('D:'), canonicalSessionCwd('D:.'), 'drive-relative is stable');
  assert.equal(canonicalSessionCwd('D:') === 'd:/', false, 'drive-relative is not a root');

  // Blank / non-string inputs stay null.
  for (const blank of [undefined, null, '', '   ', 5]) assert.equal(canonicalSessionCwd(blank), null);
});

test('P0-2: a follow-up turn refuses a non-absolute cwd with INVALID_CWD', async () => {
  const fake = makeCtx();
  const registry = makeRegistry(fake);
  const job = await registry.spawnPersistentSession({
    task: 'turn one',
    cwd: ISOLATED_HOME,
    turnTimeoutMs: 0,
  });
  await job.promise;

  for (const bad of ['relative/dir', '.', 'foo']) {
    await assert.rejects(
      () => registry.spawnPersistentTurn({ sessionId: job.sessionId, task: 'x', cwd: bad }),
      (err) => err instanceof HubRequestError && err.status === 400 && err.code === 'INVALID_CWD',
      `cwd ${JSON.stringify(bad)} must be refused`,
    );
  }
  // An omitted cwd is still allowed (the record's locked cwd is the baseline).
  const ok = await registry.spawnPersistentTurn({ sessionId: job.sessionId, task: 'x', turnTimeoutMs: 0 });
  assert.ok(ok.id);
  await ok.promise;
});

// ---------- P0-3: JSON content-type on mutating POSTs ----------

test('P0-3: every mutating POST route refuses a non-JSON body with 415', async () => {
  const fake = makeCtx();
  const routes = [];
  const ctx = {
    ...fake.ctx,
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    inject(_names, cb) {
      return cb({
        webServer: {
          register(spec) { routes.push(spec); return () => {}; },
          address() { return { address: '127.0.0.1', port: 0 }; },
          server: { once() {}, removeListener() {} },
        },
      });
    },
  };
  const dispose = await apply(ctx);

  const routeFor = (pathname) => routes.find((r) => (
    r.kind === 'exact' ? r.path === pathname : pathname.startsWith(r.path)
  ));

  const call = async ({ method = 'POST', path, body = {}, contentType }) => {
    const raw = JSON.stringify(body);
    const req = {
      method,
      url: path,
      headers: { host: '127.0.0.1:45678', ...(contentType === undefined ? {} : { 'content-type': contentType }) },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(raw); },
    };
    const answer = { status: 0, body: null };
    const res = {
      writeHead(status) { answer.status = status; },
      end(payload) { answer.body = payload === undefined ? null : JSON.parse(payload); },
    };
    await routeFor(path).handler(req, res);
    return answer;
  };

  const BASE = '/_dsh/dsh-crew';
  // Every state-mutating POST route this plugin exposes.
  const guarded = [
    [`${BASE}/jobs`, { task: 'x', cwd: ISOLATED_HOME, permission: 'read-only' }],
    [`${BASE}/sessions/session-x/turns`, { task: 'x', cwd: ISOLATED_HOME }],
    [`${BASE}/sessions/session-x/close`, {}],
    [`${BASE}/config`, { default_tier: 'flash' }],
    [`${BASE}/proc-kill`, { pid: 1 }],
    [`${BASE}/provider-test`, { id: 'x' }],
    [`${BASE}/install`, { target: 'status' }],
    [`${BASE}/worker-probe`, { provider: 'p', model: 'm' }],
  ];

  for (const [path, body] of guarded) {
    // 1. No content-type at all -> 415.
    const missing = await call({ path, body, contentType: undefined });
    assert.equal(missing.status, 415, `${path}: a POST with no content-type must be refused`);
    assert.equal(missing.body.code, 'UNSUPPORTED_MEDIA_TYPE', `${path}: stable code`);

    // 2. The cross-origin "simple request" media types -> 415 too.
    for (const simple of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const refused = await call({ path, body, contentType: simple });
      assert.equal(refused.status, 415, `${path}: ${simple} must be refused`);
    }

    // 3. A JSON body (with a charset suffix) is NOT refused by the guard. The
    //    route may still fail for another reason; 415 is what must not happen.
    const accepted = await call({ path, body, contentType: 'application/json; charset=utf-8' });
    assert.notEqual(accepted.status, 415, `${path}: application/json must pass the guard`);
  }

  // The guard only applies to mutating POSTs: a GET needs no body type.
  const get = await call({ method: 'GET', path: `${BASE}/sessions`, contentType: undefined });
  assert.equal(get.status, 200);

  await dispose?.();
});
