// An `auto` ACL degradation must survive a Hub restart.
//
// DEFECT: after degrading onto a temporary git worktree the record held
// `worktreePath`, `dshSessionId = "<id>-wt"`, `isolation` and `degradedFrom` in
// MEMORY only. A hub restart dropped all four, so the next turn resumed the
// ORIGINAL sessionId on the ORIGINAL cwd — and every uncommitted file the worker
// had produced in the worktree silently disappeared from the session's view. The
// session looked healthy while its work was gone.
//
// The worktree path is deterministic (`%TEMP%\dsh-crew-worktrees\<session_id>`),
// so recovery can DETECT a surviving worktree and re-attach to it. A marker file
// beside the worktree carries what is not re-derivable (the worker cwd inside the
// worktree, and the sandbox mode degraded from).
//
// The "restart" is modelled the way the real one is: a NEW WorkerRegistry (new
// in-memory pool) over the same filesystem, resuming by session id.
//
// Every temp path here is created under an isolated HOME/tmp base, and cleaned
// up in `after`, so no run can leave a real worktree behind.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'dsh-crew-wt-restart-home-'));
const WT_BASE = join(ISOLATED_HOME, 'worktrees');
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
process.env.HOME = ISOLATED_HOME;
process.env.USERPROFILE = ISOLATED_HOME;

const { WorkerRegistry } = await import('../src/hub/index.mjs');
const {
  buildWorktreePath,
  detectPersistedWorktree,
  readWorktreeMarker,
  worktreeMarkerPath,
  writeWorktreeMarker,
} = await import('../src/permission-policy.mjs');

const created = [];
after(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
  for (const p of created) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

// ---------- fake ctx ----------

/**
 * A hub `ctx` whose agents answer normally.
 *
 * `failFirstTurn` makes the FIRST runtime report an ACL failure, which is what
 * drives `permission: "auto"` onto a worktree.
 */
function makeCtx({ failFirstTurn = false } = {}) {
  const log = { creates: [], resumes: [], disposes: [], flush: 0 };

  const buildAgent = (options, header = null) => {
    const listeners = {};
    const session = {
      header: header ?? { cwd: options.meta?.cwd, ...(options.meta?.agentPreset ? { agentPreset: options.meta.agentPreset } : {}) },
      events: [],
      async append() {},
    };
    const emit = (type, data) => {
      for (const fn of listeners['session/event'] ?? []) fn(session, { type, data });
    };
    const fail = (error) => {
      for (const fn of listeners['agent/error'] ?? []) fn({ error });
    };
    let pending = null;
    const agent = {
      session,
      id: options.sessionId,
      async whenIdle() { await pending; },
      followup() {
        pending = Promise.resolve().then(() => {
          if (failFirstTurn && !options.sessionId.endsWith('-wt')) {
            fail(new Error('GetNamedSecurityInfoW failed (Win32 5): C:\\repo'));
            emit('turn/end', { reason: { kind: 'error' } });
            return;
          }
          emit('assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } });
          emit('turn/end', { reason: { kind: 'completed' } });
        });
      },
      cancel() {},
    };
    return { record: { sessionId: options.sessionId, cwd: options.meta?.cwd }, agent, listeners, session };
  };

  const setupCtx = (built) => ({
    agent: { session: built.session, id: built.record.sessionId },
    on(name, fn) { (built.listeners[name] ??= []).push(fn); },
  });

  const ctx = {
    logger: { warn() {}, info() {} },
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id: id ?? 'builtin-default' }; }, async mount() {} };
      return undefined;
    },
    sessions: { async flush() { log.flush += 1; } },
    agents: {
      async create(options) {
        const built = buildAgent(options);
        log.creates.push(built.record);
        await options.setup(setupCtx(built));
        return {
          agent: built.agent,
          async dispose() { log.disposes.push(options.sessionId); },
        };
      },
      // Recovery after a restart goes through resume(), exactly as the real hub
      // does it: the persisted log is reloaded from disk (here: from the header
      // the restart harness recorded) and its cwd is what the binding checks.
      async resume(options) {
        log.resumes.push(options.resumeSessionId);
        const restored = restoredSessions.get(options.resumeSessionId);
        assert.ok(restored !== undefined, `no persisted log for ${options.resumeSessionId}`);
        const built = buildAgent({ sessionId: options.resumeSessionId, meta: restored.header }, restored.header);
        await options.setup(setupCtx(built));
        return { agent: built.agent, async dispose() { log.disposes.push(options.resumeSessionId); } };
      },
    },
  };
  return { ctx, log };
}

/** Persisted session logs a restart would find on disk. */
const restoredSessions = new Map();

function makeRegistry(fake, { config = {} } = {}) {
  const registry = new WorkerRegistry(fake.ctx, { publish() {} }, { reaperIntervalMs: 0 });
  registry.worktreeBaseDir = WT_BASE;
  registry.getConfig = () => ({
    preset_flash: 'fp', preset_pro: 'pp', flash_model: 'fm', pro_model: 'pm', ...config,
  });
  return registry;
}

// ---------- 1. the pure detection helper ----------

test('detectPersistedWorktree finds a surviving worktree and reports its cwd', () => {
  const sessionId = 'session-wt-detect';
  const worktreePath = buildWorktreePath(sessionId, WT_BASE);
  created.push(worktreePath);

  // No worktree yet: nothing to recover (the ordinary case).
  assert.equal(detectPersistedWorktree({ sessionId, baseDir: WT_BASE }), null);

  mkdirSync(worktreePath, { recursive: true });
  // A worktree WITHOUT a marker still re-attaches (falling back to its root): a
  // worktree holding uncommitted work is strictly better than silently reverting.
  const bare = detectPersistedWorktree({ sessionId, baseDir: WT_BASE });
  assert.equal(bare.worktreePath, worktreePath);
  assert.equal(bare.cwd, worktreePath, 'no marker: fall back to the worktree root');
  assert.equal(bare.facts, null);

  // With a marker, the recorded worker cwd wins.
  const markerPath = writeWorktreeMarker({
    worktreePath,
    facts: {
      sessionId,
      dshSessionId: `${sessionId}-wt`,
      worktreePath,
      effectiveCwd: join(worktreePath, 'packages', 'sub'),
      isolation: 'git-worktree',
      degradedFrom: 'workspace-write',
    },
  });
  assert.equal(markerPath, worktreeMarkerPath(worktreePath));
  assert.ok(existsSync(markerPath), 'the marker is written beside the worktree');
  const detected = detectPersistedWorktree({ sessionId, baseDir: WT_BASE });
  assert.equal(detected.cwd, join(worktreePath, 'packages', 'sub'));
  assert.equal(detected.facts.degradedFrom, 'workspace-write');
  assert.equal(readWorktreeMarker({ worktreePath }).isolation, 'git-worktree');

  // A corrupt marker must not throw or fabricate facts.
  writeFileSync(markerPath, '{not json');
  const corrupt = detectPersistedWorktree({ sessionId, baseDir: WT_BASE });
  assert.equal(corrupt.cwd, worktreePath, 'a corrupt marker degrades to the worktree root');
  assert.equal(corrupt.facts, null);

  // A different session id has its own path and finds nothing.
  assert.equal(detectPersistedWorktree({ sessionId: 'session-other', baseDir: WT_BASE }), null);
  assert.equal(detectPersistedWorktree({ sessionId: '', baseDir: WT_BASE }), null);
});

// ---------- 2. the restart ----------

test('a degraded session resumes on its WORKTREE after a hub restart, not the original cwd', async () => {
  const fake = makeCtx({ failFirstTurn: true });
  const registry = makeRegistry(fake);

  const worktreePath = buildWorktreePath('placeholder', WT_BASE);
  created.push(worktreePath);

  // Turn 1 degrades: the worktree is created at the deterministic path for the
  // session id, exactly as createTempWorktree would, and the marker is written by
  // the hub when it records the degradation.
  const createWorktree = async ({ jobId }) => {
    const path = buildWorktreePath(jobId, WT_BASE);
    created.push(path);
    mkdirSync(path, { recursive: true });
    mkdirSync(join(path, 'packages', 'sub'), { recursive: true });
    writeFileSync(join(path, 'packages', 'sub', 'uncommitted.txt'), 'work the caller must not lose\n');
    return { worktreePath: path, repoRoot: ISOLATED_HOME, cwd: join(path, 'packages', 'sub') };
  };

  const turn1 = await registry.spawn({
    task: 'edit files', cwd: ISOLATED_HOME, permission: 'auto', persistent: true, createWorktree, turnTimeoutMs: 0,
  });
  await turn1.promise;
  const sessionId = turn1.sessionId;
  assert.equal(turn1.status, 'done', turn1.error ?? '');
  assert.equal(turn1.isolation, 'git-worktree', 'turn 1 degraded onto a worktree');
  assert.equal(turn1.worktree_path, buildWorktreePath(sessionId, WT_BASE));

  const recBefore = registry.persistentSessions.get(sessionId);
  assert.equal(recBefore.dshSessionId, `${sessionId}-wt`);
  assert.equal(recBefore.effectiveCwd, join(recBefore.worktreePath, 'packages', 'sub'));
  // The marker exists on disk BESIDE the worktree (not inside the repo, not in
  // ~/.config): that is the durable artifact a restart reads.
  const markerPath = worktreeMarkerPath(recBefore.worktreePath);
  assert.ok(existsSync(markerPath), 'the degradation facts were persisted');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  assert.equal(marker.sessionId, sessionId);
  assert.equal(marker.effectiveCwd, recBefore.effectiveCwd);
  assert.equal(marker.degradedFrom, 'workspace-write');

  // ---------- the restart ----------
  // A NEW registry over the same filesystem has NO in-memory pool. Its persisted
  // log for the session is the WORKTREE one (`<id>-wt`), whose header records the
  // worktree cwd — a resume that reverted to the original cwd would trip the
  // locked-cwd check immediately, which is exactly the bug.
  restoredSessions.set(`${sessionId}-wt`, { header: { cwd: recBefore.effectiveCwd } });
  const restarted = makeRegistry(fake);
  assert.equal(restarted.persistentSessions.size, 0, 'the restart really started empty');

  // The caller passes the SAME original cwd/session_id it has always used.
  const turn2 = await restarted.spawn({
    task: 'continue', sessionId, cwd: ISOLATED_HOME, permission: 'auto', turnTimeoutMs: 0,
  });
  await turn2.promise;

  assert.deepEqual(fake.log.resumes, [`${sessionId}-wt`], 'recovery resumed the WORKTREE runtime, not the original');
  assert.equal(fake.log.creates.at(-1).cwd, recBefore.effectiveCwd, 'the resumed agent runs on the worktree cwd');
  assert.equal(turn2.status, 'done', turn2.error ?? '');

  const recAfter = restarted.persistentSessions.get(sessionId);
  assert.equal(recAfter.cwd, ISOLATED_HOME, 'the caller-facing cwd baseline never moves');
  assert.equal(recAfter.effectiveCwd, recBefore.effectiveCwd, 'the runtime keeps running in the worktree');
  assert.equal(recAfter.worktreePath, recBefore.worktreePath);
  assert.equal(recAfter.isolation, 'git-worktree');
  assert.equal(recAfter.degradedFrom, 'workspace-write');
  assert.equal(recAfter.dshSessionId, `${sessionId}-wt`);
  assert.equal(recAfter.recoveredDegradation, true, 'the recovery reports that it re-attached a degraded session');

  // The recovered facts reach the caller-visible job view too.
  assert.equal(turn2.worktree_path, recBefore.worktreePath);
  assert.equal(turn2.isolation, 'git-worktree');
  assert.equal(turn2.degraded_from, 'workspace-write');
  const summary = restarted.listPersistentSessions().find((s) => s.session_id === sessionId);
  assert.equal(summary.worktree_path, recBefore.worktreePath);
  assert.equal(summary.isolation, 'git-worktree');

  // ...and the uncommitted work is still where the session is looking.
  assert.ok(existsSync(join(recAfter.effectiveCwd, 'uncommitted.txt')), 'the worktree work survived the restart');
});

test('a hub restart does NOT unlock the degraded session workspace', async () => {
  // FINDING 2 (round 2 blocker). The marker originally omitted the caller's
  // original cwd, and recovery validated the persisted header against the
  // WORKTREE cwd instead of checking the cwd the CALLER passed. So after a
  // restart, resuming the same session_id with a DIFFERENT cwd succeeded and
  // overwrote the locked baseline — while before the restart the same call
  // correctly threw SESSION_CWD_MISMATCH. A restart must not relax a lock.
  const fake = makeCtx({ failFirstTurn: true });
  const registry = makeRegistry(fake);

  const createWorktree = async ({ jobId }) => {
    const path = buildWorktreePath(jobId, WT_BASE);
    created.push(path);
    mkdirSync(path, { recursive: true });
    return { worktreePath: path, repoRoot: ISOLATED_HOME, cwd: path };
  };
  const turn1 = await registry.spawn({
    task: 'edit files', cwd: ISOLATED_HOME, permission: 'auto', persistent: true, createWorktree, turnTimeoutMs: 0,
  });
  await turn1.promise;
  const sessionId = turn1.sessionId;
  assert.equal(turn1.isolation, 'git-worktree');

  // The marker records the LOCKED caller cwd, which is what recovery validates.
  const marker = JSON.parse(readFileSync(worktreeMarkerPath(turn1.worktree_path), 'utf8'));
  assert.equal(marker.cwd, ISOLATED_HOME, 'the locked workspace is persisted with the degradation facts');

  // A live (same-process) hub refuses a different cwd — the baseline behaviour.
  await assert.rejects(
    () => registry.spawn({ task: 'elsewhere', sessionId, cwd: join(ISOLATED_HOME, 'other-repo') }),
    (err) => err?.code === 'SESSION_CWD_MISMATCH',
    'precondition: a live hub refuses a different cwd',
  );

  // ---------- the restart ----------
  restoredSessions.set(`${sessionId}-wt`, { header: { cwd: turn1.worktree_path } });
  const restarted = makeRegistry(fake);
  const otherDir = join(ISOLATED_HOME, 'other-repo');
  mkdirSync(otherDir, { recursive: true });

  // Same as before the restart: a different workspace must be refused.
  await assert.rejects(
    () => restarted.spawn({ task: 'hijack', sessionId, cwd: otherDir, turnTimeoutMs: 0 }),
    (err) => {
      assert.equal(err?.code, 'SESSION_RESUME_FAILED', `expected SESSION_RESUME_FAILED, got ${err?.code}: ${err?.message}`);
      assert.match(err.message, /does not match|cwd/i, 'the refusal explains the workspace mismatch');
      return true;
    },
    'a restart must NOT unlock the session workspace',
  );
  assert.equal(restarted.persistentSessions.has(sessionId), false, 'the refused resume registered no record');
  assert.equal(fake.log.resumes.length, 0, 'nothing was resumed for a refused workspace');

  // The CORRECT cwd still resumes normally, and the baseline stays the original.
  const wrongAttempts = restarted.persistentSessions.size;
  assert.equal(wrongAttempts, 0);
  const turn2 = await restarted.spawn({ task: 'continue', sessionId, cwd: ISOLATED_HOME, turnTimeoutMs: 0 });
  await turn2.promise;
  assert.equal(turn2.status, 'done', turn2.error ?? '');
  const rec = restarted.persistentSessions.get(sessionId);
  assert.equal(rec.cwd, ISOLATED_HOME, 'the locked baseline is the original workspace, not the worktree');
  assert.equal(rec.effectiveCwd, turn1.worktree_path, 'the runtime still runs in the worktree');
  assert.equal(rec.recoveredDegradation, true);
});

test('a session that never degraded still resumes on its original cwd', async () => {
  // The negative case: detection must not invent a worktree for an ordinary
  // session, or every restart would resume in the wrong place.
  const fake = makeCtx();
  const registry = makeRegistry(fake);
  const turn1 = await registry.spawn({ task: 'no acl', cwd: ISOLATED_HOME, persistent: true, turnTimeoutMs: 0 });
  await turn1.promise;
  const sessionId = turn1.sessionId;
  assert.equal(turn1.isolation, null);

  restoredSessions.set(sessionId, { header: { cwd: ISOLATED_HOME } });
  const restarted = makeRegistry(fake);
  const turn2 = await restarted.spawn({ task: 'continue', sessionId, cwd: ISOLATED_HOME, turnTimeoutMs: 0 });
  await turn2.promise;

  assert.deepEqual(fake.log.resumes, [sessionId], 'an undegraded session resumes its own id');
  const rec = restarted.persistentSessions.get(sessionId);
  assert.equal(rec.effectiveCwd, ISOLATED_HOME);
  assert.equal(rec.worktreePath, null);
  assert.equal(rec.isolation, null);
  assert.equal(rec.recoveredDegradation, undefined, 'nothing is reported as recovered');
  assert.equal(turn2.worktree_path, null);
});
