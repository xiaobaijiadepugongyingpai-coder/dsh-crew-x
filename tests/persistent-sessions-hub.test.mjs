// Opt-in persistent DSH sessions on the Hub (batch 2).
//
// A persistent session is ONE reusable DSH agent/session that several turns
// run on, so a forwarded subagent keeps its conversation instead of paying for
// a cold context on every dispatch. These tests drive the pool through a fake
// `ctx` — the same fake-agent harness style as tests/worker-permission.test.mjs
// — so a bad turn cannot reach a real DSH profile or the user's config.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Isolate HOME / USERPROFILE before importing anything that resolves
// ~/.config/dsh-crew, so a run never touches the real profile.
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'dsh-crew-psess-home-'));
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
process.env.HOME = ISOLATED_HOME;
process.env.USERPROFILE = ISOLATED_HOME;

const { WorkerRegistry } = await import('../src/hub/index.mjs');
const {
  HubRequestError,
  resolvePersistedSessionPreset,
  validateSessionTurnBinding,
  createPersistentSessionRecord,
  summarizePersistentSession,
} = await import('../src/hub/persistent-sessions.mjs');

after(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

// ---------- fake hub context ----------

/**
 * Build a fake `ctx` for WorkerRegistry.
 *
 * `script` may override what a followup does:
 *   - onFollowup({ emit, ask, record, agent }) — defaults to one assistant text
 *     plus a completed turn/end.
 *   - onResume(options) — supplies a persisted session for ctx.agents.resume.
 */
function makeCtx({ onFollowup, onResume } = {}) {
  const log = {
    creates: [], resumes: [], appends: [], followups: [], routes: [],
    flushes: 0, disposes: 0, cancels: [], questions: [],
  };
  const askHandlers = new Map();

  const buildAgent = (options, header = null, events = []) => {
    const record = {
      sessionId: options.sessionId,
      cwd: options.meta?.cwd ?? header?.cwd ?? null,
      preset: options.meta?.agentPreset,
      agentOptions: options.agentOptions,
      sandboxModes: [],
      followups: 0,
      cancels: [],
      disposed: 0,
      pending: null,
      route: null,
    };
    const listeners = {};
    const session = {
      header: header ?? { cwd: record.cwd },
      events,
      async append(type, data) {
        record.sandboxModes.push(data?.mode);
        log.appends.push({ type, mode: data?.mode, sessionId: options.sessionId });
      },
    };
    const emit = (type, data) => {
      for (const fn of listeners['session/event'] ?? []) fn(session, { type, data });
    };
    const fail = (error) => {
      for (const fn of listeners['agent/error'] ?? []) fn({ error });
    };
    const ask = (questions) => askHandlers.get(options.sessionId)?.({ questions });
    /**
     * What the model would actually be called with for this turn.
     *
     * The real runtime asks the two model-selection hooks (prompt assembly then
     * agent/request); a switch that only mutated a create-time snapshot would
     * never reach the model, so the fake resolves them the same way.
     */
    const resolveRoute = async () => {
      let assembled = { variables: {} };
      for (const fn of listeners['system-prompt/assemble'] ?? []) {
        assembled = await fn({ variables: {} }, undefined, async () => assembled);
      }
      let request = {};
      for (const fn of listeners['agent/request'] ?? []) {
        request = await fn({}, async () => ({}));
      }
      return {
        assembled,
        provider: request.provider ?? assembled.variables.provider,
        model: request.model ?? assembled.variables.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      };
    };
    const agent = {
      session,
      id: options.sessionId,
      async whenIdle() { await record.pending; },
      followup(message) {
        record.followups += 1;
        log.followups.push({ sessionId: options.sessionId, text: message?.content?.[0]?.text ?? null });
        record.pending = Promise.resolve()
          .then(async () => {
            record.route = await resolveRoute();
            log.routes.push(record.route);
            if (onFollowup) {
              await onFollowup({ emit, fail, ask, record, agent, route: record.route });
              return;
            }
            emit('assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } });
            emit('turn/end', { reason: { kind: 'completed' } });
          })
          .catch(() => {});
      },
      cancel(cause) {
        record.cancels.push(cause);
        log.cancels.push(cause);
      },
    };
    return { record, agent, listeners, session };
  };

  const setupCtx = (built) => ({
    agent: { session: built.session, id: built.record.sessionId },
    on(name, fn) {
      (built.listeners[name] ??= []).push(fn);
      if (name === 'user-questions/request') askHandlers.set(built.record.sessionId, fn);
    },
  });

  const ctx = {
    logger: { warn() {}, info() {} },
    get(name) {
      if (name === 'agentPresets') {
        return { async resolve(id) { return { id: id ?? 'builtin-default' }; }, async mount() {} };
      }
      return undefined;
    },
    sessions: { async flush() { log.flushes += 1; } },
    agents: {
      async create(options) {
        const built = buildAgent(options);
        log.creates.push(built.record);
        await options.setup(setupCtx(built));
        return { agent: built.agent, async dispose() { built.record.disposed += 1; log.disposes += 1; } };
      },
      ...(onResume === undefined ? {} : {
        async resume(options) {
          log.resumes.push({ sessionId: options.resumeSessionId });
          return onResume({ options, log, buildAgent, setupCtx });
        },
      }),
    },
  };
  return { ctx, log };
}

/** A registry whose reaper timer is off, so `reapIdleSessions(now)` drives it. */
function makeRegistry(fake, { config = {} } = {}) {
  const registry = new WorkerRegistry(fake.ctx, { publish() {} }, { reaperIntervalMs: 0 });
  registry.getConfig = () => ({
    preset_flash: 'flash-preset', preset_pro: 'pro-preset',
    flash_model: 'flash-model', pro_model: 'pro-model',
    ...config,
  });
  return registry;
}

/** The {provider, model, reasoningEffort} a resolved route reports. */
function routeOf(route) {
  return {
    ...(route?.provider === undefined ? {} : { provider: route.provider }),
    ...(route?.model === undefined ? {} : { model: route.model }),
    ...(route?.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  };
}

// ---------- 1. pure helpers ----------

test('resolvePersistedSessionPreset reads the newest logged selection, then the header', () => {
  assert.equal(resolvePersistedSessionPreset({
    header: { agentPreset: 'header-one' },
    events: [
      { type: 'agent-preset/selected', data: { agentPreset: 'first' } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      { type: 'agent-preset/selected', data: { agentPreset: 'second' } },
    ],
  }), 'second', 'the last selection wins, not the first');
  assert.equal(resolvePersistedSessionPreset({ header: { agentPreset: 'header-one' }, events: [] }), 'header-one');
  assert.equal(resolvePersistedSessionPreset({ header: {}, events: [] }), null);
  // Defensive: a backend may hand back a half-shaped log.
  assert.equal(resolvePersistedSessionPreset({ events: 'nope', header: { agentPreset: 'h' } }), 'h');
  assert.equal(resolvePersistedSessionPreset({ events: [null, {}, { type: 'agent-preset/selected' }] }), null);
  assert.equal(resolvePersistedSessionPreset(undefined), null);
  // A `presetId` payload is accepted too.
  assert.equal(resolvePersistedSessionPreset({
    header: {}, events: [{ type: 'agent-preset/selected', data: { presetId: 'p-1' } }],
  }), 'p-1');
});

test('cwd is locked (with separator/case equivalence) while preset is only locked when explicit', () => {
  // Same workspace, different spelling: must NOT throw on any platform.
  assert.doesNotThrow(() => validateSessionTurnBinding({
    expectedCwd: 'D:\\work\\proj', actualCwd: 'D:/work/proj/', expectedPreset: 'p', explicitPreset: undefined,
  }));
  assert.doesNotThrow(() => validateSessionTurnBinding({
    expectedCwd: 'd:\\work\\proj', actualCwd: 'D:\\WORK\\proj', expectedPreset: 'p',
  }));
  assert.doesNotThrow(() => validateSessionTurnBinding({
    expectedCwd: '/srv/work', actualCwd: '/srv/work/', expectedPreset: 'p',
  }));
  // A different workspace is a hard error.
  for (const bad of ['D:\\work\\other', '/srv/other']) {
    assert.throws(
      () => validateSessionTurnBinding({ expectedCwd: 'D:\\work\\proj', actualCwd: bad, expectedPreset: 'p' }),
      (err) => err instanceof HubRequestError && err.status === 400 && err.code === 'SESSION_CWD_MISMATCH',
    );
  }
  // Tolerant preset inheritance: no explicit preset never throws, whatever the
  // config now says; an explicit equal preset is fine; a different one is not.
  for (const explicit of [undefined, null, '', '   ']) {
    assert.doesNotThrow(() => validateSessionTurnBinding({
      expectedCwd: '/w', actualCwd: '/w', expectedPreset: 'locked', explicitPreset: explicit,
    }));
  }
  assert.doesNotThrow(() => validateSessionTurnBinding({
    expectedCwd: '/w', actualCwd: '/w', expectedPreset: 'locked', explicitPreset: 'locked',
  }));
  assert.throws(
    () => validateSessionTurnBinding({
      expectedCwd: '/w', actualCwd: '/w', expectedPreset: 'locked', explicitPreset: 'other',
    }),
    (err) => err instanceof HubRequestError && err.status === 400 && err.code === 'SESSION_PRESET_MISMATCH',
  );
});

test('record + summary expose the documented shape and omit unset optional fields', () => {
  const rec = createPersistentSessionRecord({
    sessionId: 's-1', cwd: 'D:\\w', preset: 'p', tier: 'flash', model: 'm', provider: 'prov',
    selection: { provider: 'prov', model: 'm', reasoningEffort: 'max' },
  });
  assert.equal(rec.sessionId, 's-1');
  assert.equal(rec.dshSessionId, 's-1');
  assert.equal(rec.effectiveCwd, 'D:\\w');
  assert.equal(rec.turns, 0);
  assert.equal(rec.status, 'idle');
  assert.equal(rec.selectionRef.current.model, 'm');

  const fresh = summarizePersistentSession(rec);
  assert.equal(fresh.session_id, 's-1');
  assert.equal(fresh.turns, 0);
  assert.equal(fresh.status, 'idle');
  assert.match(fresh.last_active_iso, /^\d{4}-\d\d-\d\dT/);
  assert.equal('worktree_path' in fresh, false, 'no worktree keys before a degradation');
  assert.equal('degraded_from' in fresh, false);

  const degraded = summarizePersistentSession({
    ...rec, worktreePath: 'C:\\tmp\\wt', isolation: 'git-worktree', degradedFrom: 'workspace-write',
    dshSessionId: 's-1-wt',
  });
  assert.equal(degraded.worktree_path, 'C:\\tmp\\wt');
  assert.equal(degraded.isolation, 'git-worktree');
  assert.equal(degraded.degraded_from, 'workspace-write');
  assert.equal(degraded.dsh_session_id, 's-1-wt');
});

// ---------- 2. multi-turn reuse ----------

test('a persistent session reuses one underlying handle across turns', async () => {
  const fake = makeCtx();
  const registry = makeRegistry(fake);

  const turn1 = await registry.spawn({ task: 'first', cwd: ISOLATED_HOME, tier: 'flash', persistent: true });
  assert.equal(turn1.persistent, true);
  assert.equal(turn1.turnIndex, 1);
  await turn1.promise;
  assert.equal(turn1.status, 'done');
  const sessionId = turn1.sessionId;
  assert.match(sessionId, /^session-/);

  const turn2 = await registry.spawn({ task: 'second', sessionId });
  assert.equal(turn2.sessionId, sessionId, 'the external id is stable across turns');
  assert.equal(turn2.turnIndex, 2);
  await turn2.promise;
  assert.equal(turn2.status, 'done');

  assert.equal(fake.log.creates.length, 1, 'turn 2 must not create a second agent');
  assert.equal(fake.log.creates[0].sessionId, sessionId);
  assert.equal(fake.log.creates[0].followups, 2);
  assert.equal(fake.log.disposes, 0, 'a persistent handle must survive turn end');
  assert.equal(fake.log.flushes, 2, 'each turn settles independently (one flush per turn)');

  const rec = registry.persistentSessions.get(sessionId);
  assert.equal(rec.turns, 2);
  assert.equal(rec.status, 'idle');
  const [summary] = registry.listPersistentSessions();
  assert.equal(summary.session_id, sessionId);
  assert.equal(summary.turns, 2);

  // The view keeps every one-shot field and adds the persistent pair.
  const view = registry.view(turn2, true);
  assert.equal(view.persistent, true);
  assert.equal(view.turnIndex, 2);
  assert.equal(view.mode, 'hub');
  assert.equal(view.sessionId, sessionId);
  assert.ok('permission' in view && 'effective_sandbox_mode' in view && 'preset' in view);
});

// ---------- 3. dynamic switching ----------

test('tier and effort switch between turns through the shared selection', async () => {
  const fake = makeCtx();
  const registry = makeRegistry(fake);

  const turn1 = await registry.spawn({ task: 'a', cwd: ISOLATED_HOME, tier: 'flash', effort: 'max', persistent: true });
  await turn1.promise;
  const sessionId = turn1.sessionId;
  const rec = registry.persistentSessions.get(sessionId);
  const selectionRef = rec.selectionRef;
  assert.deepEqual(routeOf(fake.log.routes[0]), {
    provider: 'deepseek-official', model: 'flash-model', reasoningEffort: 'max',
  });
  assert.equal(fake.log.creates[0].agentOptions.model, 'flash-model');

  const turn2 = await registry.spawn({ task: 'b', sessionId, tier: 'pro', effort: 'high' });
  await turn2.promise;

  assert.equal(turn2.tier, 'pro');
  assert.equal(turn2.model, 'pro-model');
  assert.equal(rec.tier, 'pro');
  assert.equal(rec.model, 'pro-model');
  // The SAME ref object the agent's model-selection hooks were installed with
  // must carry the new route, otherwise a switch would never reach the model.
  assert.equal(rec.selectionRef, selectionRef);
  assert.deepEqual(rec.selectionRef.current, { provider: 'deepseek-official', model: 'pro-model', reasoningEffort: 'high' });
  // ...and the hooks really did resolve to the new route on the reused runtime.
  assert.deepEqual(routeOf(fake.log.routes[1]), {
    provider: 'deepseek-official', model: 'pro-model', reasoningEffort: 'high',
  });
  assert.equal(fake.log.creates.length, 1, 'switching tier must not rebuild the agent');

  const turn3 = await registry.spawn({ task: 'c', sessionId, tier: 'flash', effort: 'off' });
  await turn3.promise;
  assert.equal(rec.selectionRef.current.model, 'flash-model');
  assert.equal(rec.selectionRef.current.reasoningEffort, 'off');
  // Switching BACK must reach the model on the same handle too.
  assert.deepEqual(routeOf(fake.log.routes[2]), {
    provider: 'deepseek-official', model: 'flash-model', reasoningEffort: 'off',
  });
  assert.equal(fake.log.creates.length, 1);
});

test('permission switches between turns by appending a new sandbox/mode before the followup', async () => {
  const fake = makeCtx();
  const registry = makeRegistry(fake);

  const turn1 = await registry.spawn({
    task: 'read', cwd: ISOLATED_HOME, permission: 'read-only', persistent: true,
  });
  await turn1.promise;
  const sessionId = turn1.sessionId;

  const turn2 = await registry.spawn({ task: 'write', sessionId, permission: 'workspace-write' });
  await turn2.promise;

  assert.deepEqual(fake.log.appends.map((a) => a.mode), ['read-only', 'workspace-write']);
  // Both appends land on the same session *before* each followup.
  assert.deepEqual(fake.log.appends.map((a) => a.sessionId), [sessionId, sessionId]);
  assert.equal(turn2.permission, 'workspace-write');
  assert.equal(registry.persistentSessions.get(sessionId).permission, 'workspace-write');
  assert.equal(fake.log.creates.length, 1, 'a sandbox switch must not rebuild the agent');
});

// ---------- 4. tolerant preset inheritance ----------

test('an omitted preset inherits the turn-1 preset even after the config default changed', async () => {
  const fake = makeCtx();
  const registry = makeRegistry(fake);

  const turn1 = await registry.spawn({ task: 'a', cwd: ISOLATED_HOME, tier: 'flash', persistent: true });
  await turn1.promise;
  const sessionId = turn1.sessionId;
  assert.equal(turn1.preset, 'flash-preset');

  // The user edits the panel's default preset (or switches flash <-> pro)
  // between turns: the live session keeps its locked composition.
  registry.getConfig = () => ({ preset_flash: 'brand-new-default', preset_pro: 'pro-preset' });

  const turn2 = await registry.spawn({ task: 'b', sessionId, tier: 'pro' });
  await turn2.promise;
  assert.equal(turn2.status, 'done');
  assert.equal(turn2.preset, 'flash-preset', 'inherited, not re-resolved');
  assert.equal(fake.log.creates.length, 1);

  // An explicit preset equal to turn 1 is accepted.
  const turn3 = await registry.spawn({ task: 'c', sessionId, preset: 'flash-preset' });
  await turn3.promise;
  assert.equal(turn3.status, 'done');

  // An explicit, DIFFERENT preset is refused and does not disturb the session.
  await assert.rejects(
    () => registry.spawn({ task: 'd', sessionId, preset: 'brand-new-default' }),
    (err) => err instanceof HubRequestError && err.status === 400 && err.code === 'SESSION_PRESET_MISMATCH',
  );
  assert.equal(registry.persistentSessions.get(sessionId).status, 'idle', 'a refused turn releases the session');

  // ...and the session still works afterwards.
  const turn4 = await registry.spawn({ task: 'e', sessionId });
  await turn4.promise;
  assert.equal(turn4.status, 'done');
});

test('a different cwd is refused but a differently-spelled same cwd is accepted', async () => {
  const fake = makeCtx();
  const registry = makeRegistry(fake);

  const turn1 = await registry.spawn({ task: 'a', cwd: ISOLATED_HOME, persistent: true });
  await turn1.promise;
  const sessionId = turn1.sessionId;

  const other = join(ISOLATED_HOME, 'elsewhere');
  await assert.rejects(
    () => registry.spawn({ task: 'b', sessionId, cwd: other }),
    (err) => err instanceof HubRequestError && err.status === 400 && err.code === 'SESSION_CWD_MISMATCH',
  );

  // Same directory, POSIX-slash form plus a trailing separator: not a change.
  const aliasCwd = ISOLATED_HOME.replace(/\\/g, '/') + '/';
  const turn2 = await registry.spawn({ task: 'c', sessionId, cwd: aliasCwd });
  await turn2.promise;
  assert.equal(turn2.status, 'done');
  assert.equal(registry.persistentSessions.get(sessionId).cwd, ISOLATED_HOME, 'the locked baseline never moves');
});

// ---------- 5. permission auto -> git worktree continuation ----------

test('auto ACL failure moves the runtime onto a worktree while session_id and cwd stay put', async () => {
  const worktreePath = join(ISOLATED_HOME, 'wt-session');
  const fake = makeCtx({
    onFollowup({ emit, fail, record }) {
      if (record.sessionId.endsWith('-wt')) {
        emit('assistant/message', { message: { content: [{ type: 'text', text: 'patched in worktree' }] } });
        emit('turn/end', { reason: { kind: 'completed' } });
        return;
      }
      // First runtime: the sandbox runner cannot be granted write access.
      fail(new Error('SetNamedSecurityInfoW failed: Win32 5'));
      emit('turn/end', { reason: { kind: 'error' } });
    },
  });
  const registry = makeRegistry(fake);
  const worktreeCalls = [];
  const createWorktree = async ({ jobId }) => {
    worktreeCalls.push(jobId);
    return { worktreePath, repoRoot: ISOLATED_HOME, cwd: worktreePath };
  };

  const turn1 = await registry.spawn({
    task: 'edit', cwd: ISOLATED_HOME, permission: 'auto', persistent: true, createWorktree,
  });
  await turn1.promise;
  const sessionId = turn1.sessionId;
  const rec = registry.persistentSessions.get(sessionId);

  assert.equal(worktreeCalls.length, 1);
  assert.equal(worktreeCalls[0], sessionId, 'the worktree is keyed by the external session id');
  assert.equal(fake.log.creates.length, 2, 'the degraded turn re-runs on a new runtime');
  assert.equal(fake.log.creates[0].cwd, ISOLATED_HOME);
  assert.equal(fake.log.creates[1].cwd, worktreePath);
  assert.equal(fake.log.creates[1].sessionId, `${sessionId}-wt`, 'the underlying id is decoupled');
  assert.equal(fake.log.disposes, 1, 'the pre-worktree runtime is torn down');
  assert.deepEqual(fake.log.creates[1].sandboxModes, ['workspace-write'], 'never escalates to full-access');
  assert.equal(turn1.status, 'done');
  assert.equal(turn1.result, 'patched in worktree');
  assert.equal(turn1.worktree_path, worktreePath);
  assert.equal(turn1.isolation, 'git-worktree');
  assert.equal(turn1.degraded_from, 'workspace-write');
  assert.equal(turn1.sessionId, sessionId, 'the reported session id is still the external one');

  // The external identity and the comparison baseline never move.
  assert.equal(rec.sessionId, sessionId);
  assert.equal(rec.cwd, ISOLATED_HOME, 'cwd stays the original comparison baseline');
  assert.equal(rec.effectiveCwd, worktreePath);
  assert.equal(rec.dshSessionId, `${sessionId}-wt`);
  assert.match(rec.dshSessionId, /-wt$/);

  // Later turns keep the ORIGINAL session_id and cwd and continue on the worktree.
  const turn2 = await registry.spawn({ task: 'more', sessionId, cwd: ISOLATED_HOME, permission: 'auto' });
  await turn2.promise;
  assert.equal(turn2.status, 'done');
  assert.equal(fake.log.creates.length, 2, 'turn 2 reuses the worktree runtime');
  assert.equal(fake.log.followups.at(-1).sessionId, `${sessionId}-wt`);
  assert.equal(turn2.worktree_path, worktreePath);
  assert.equal(turn2.isolation, 'git-worktree');
  assert.equal(turn2.degraded_from, 'workspace-write');
  assert.equal(registry.persistentSessions.get(sessionId), rec);
});

// ---------- 6. serialisation ----------

test('a concurrent turn on a running session is refused with SESSION_BUSY', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fake = makeCtx({
    async onFollowup({ emit }) {
      await gate;
      emit('turn/end', { reason: { kind: 'completed' } });
    },
  });
  const registry = makeRegistry(fake);

  const turn1 = await registry.spawn({ task: 'slow', cwd: ISOLATED_HOME, persistent: true });
  const sessionId = turn1.sessionId;

  await assert.rejects(
    () => registry.spawn({ task: 'intruder', sessionId }),
    (err) => err instanceof HubRequestError && err.status === 409 && err.code === 'SESSION_BUSY',
  );

  release();
  await turn1.promise;
  // The refused turn must not have left the session busy.
  assert.equal(registry.persistentSessions.get(sessionId).status, 'idle');
  const turn2 = await registry.spawn({ task: 'next', sessionId });
  await turn2.promise;
  assert.equal(turn2.turnIndex, 2);
});

// ---------- 7. needs_input keeps the handle ----------

test('needs_input cancels only the turn and keeps the reusable handle', async () => {
  const fake = makeCtx({
    async onFollowup({ ask, emit }) {
      await ask([{ id: 'overwrite', question: 'Overwrite the existing file?' }]).catch(() => {});
      emit('turn/end', { reason: { kind: 'cancelled' } });
    },
  });
  const registry = makeRegistry(fake);

  const turn1 = await registry.spawn({ task: 'edit', cwd: ISOLATED_HOME, persistent: true });
  const sessionId = turn1.sessionId;
  await turn1.promise;

  assert.equal(turn1.status, 'needs_input');
  assert.equal(turn1.questions[0].id, 'overwrite');
  assert.equal(fake.log.disposes, 0, 'a persistent session must not be disposed for a question');
  assert.equal(fake.log.cancels.length, 1, 'the in-flight turn is cancelled instead');
  assert.equal(registry.persistentSessions.get(sessionId).status, 'idle');

  // The same runtime serves a later turn.
  const turn2 = await registry.spawn({ task: 'continue', sessionId });
  await turn2.promise;
  assert.equal(fake.log.creates.length, 1);
});

// ---------- 8. Hub restart recovery ----------

test('an unknown session id resumes the persisted log once and validates its header', async () => {
  const resumeCalls = [];
  const fake = makeCtx({
    onResume({ options, log, buildAgent, setupCtx }) {
      resumeCalls.push(options.resumeSessionId);
      const built = buildAgent(
        { sessionId: options.resumeSessionId, meta: { cwd: ISOLATED_HOME } },
        { cwd: ISOLATED_HOME, agentPreset: 'flash-preset' },
        [
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        ],
      );
      // The resumed agent answers the turn through the SAME followup path the
      // real loop uses; only then do the record listeners see it.
      built.agent.followup = (message) => {
        built.record.followups += 1;
        log.followups.push({ sessionId: options.resumeSessionId, text: message?.content?.[0]?.text ?? null });
        built.record.pending = Promise.resolve().then(() => {
          const emit = (type, data) => {
            for (const fn of built.listeners['session/event'] ?? []) fn(built.session, { type, data });
          };
          emit('assistant/message', { message: { content: [{ type: 'text', text: 'resumed ok' }] } });
          emit('turn/end', { reason: { kind: 'completed' } });
        });
      };
      return options.setup(setupCtx(built)).then(() => {
        log.creates.push(built.record);
        return { agent: built.agent, async dispose() { built.record.disposed += 1; log.disposes += 1; } };
      });
    },
  });
  const registry = makeRegistry(fake);

  const turn = await registry.spawn({ task: 'after restart', sessionId: 'session-lost-1', cwd: ISOLATED_HOME });
  await turn.promise;

  assert.deepEqual(resumeCalls, ['session-lost-1']);
  assert.equal(fake.log.resumes.length, 1);
  assert.equal(turn.status, 'done');
  assert.equal(turn.result, 'resumed ok');
  const rec = registry.persistentSessions.get('session-lost-1');
  assert.equal(rec.preset, 'flash-preset', 'the persisted preset is adopted');
  assert.equal(rec.turns, 3, 'the turn counter continues from the persisted log (2 settled + this one)');
  assert.equal(turn.turnIndex, 3);

  // A SECOND turn on the same id must reuse the recovered record, not resume again.
  const turn2 = await registry.spawn({ task: 'next', sessionId: 'session-lost-1', cwd: ISOLATED_HOME });
  await turn2.promise;
  assert.equal(fake.log.resumes.length, 1, 'recovery happens once per session');
  assert.equal(turn2.turnIndex, 4);
});

test('a failed resume or a header mismatch reports SESSION_RESUME_FAILED', async () => {
  // 1. The persistence backend has nothing to load.
  const brokenFake = makeCtx({
    onResume() { throw new Error('no persisted session log'); },
  });
  const brokenRegistry = makeRegistry(brokenFake);
  await assert.rejects(
    () => brokenRegistry.spawn({ task: 'x', sessionId: 'session-gone', cwd: ISOLATED_HOME }),
    (err) => err instanceof HubRequestError && err.status === 409 && err.code === 'SESSION_RESUME_FAILED'
      && /no persisted session log/.test(err.message),
  );

  // 2. The persisted log belongs to a different workspace.
  const mismatchedFake = makeCtx({
    onResume({ options, buildAgent, setupCtx }) {
      const built = buildAgent({ sessionId: options.resumeSessionId, meta: {} }, { cwd: 'D:\\somewhere\\else' }, []);
      return options.setup(setupCtx(built)).then(() => ({
        agent: built.agent, async dispose() {},
      }));
    },
  });
  const mismatchedRegistry = makeRegistry(mismatchedFake);
  await assert.rejects(
    () => mismatchedRegistry.spawn({ task: 'x', sessionId: 'session-elsewhere', cwd: ISOLATED_HOME }),
    (err) => err instanceof HubRequestError && err.code === 'SESSION_RESUME_FAILED'
      && /SESSION_CWD_MISMATCH|does not match/.test(err.message),
  );

  // 3. No resume support at all (old host).
  const plainFake = makeCtx();
  const plainRegistry = makeRegistry(plainFake);
  await assert.rejects(
    () => plainRegistry.spawn({ task: 'x', sessionId: 'session-unknown', cwd: ISOLATED_HOME }),
    (err) => err instanceof HubRequestError && err.code === 'SESSION_RESUME_FAILED',
  );
});

// ---------- 9. close + tombstone ----------

test('closePersistentSession disposes the runtime and tombstones the id against revival', async () => {
  const fake = makeCtx();
  const registry = makeRegistry(fake);

  const turn1 = await registry.spawn({ task: 'a', cwd: ISOLATED_HOME, persistent: true });
  await turn1.promise;
  const sessionId = turn1.sessionId;

  const closed = await registry.closePersistentSession(sessionId, { reason: 'done' });
  assert.deepEqual(closed, { session_id: sessionId, closed: true });
  assert.equal(registry.persistentSessions.has(sessionId), false);
  assert.equal(registry.listPersistentSessions().length, 0);
  assert.ok(registry.closedSessions.has(sessionId));
  assert.equal(fake.log.disposes, 1);

  await assert.rejects(
    () => registry.spawn({ task: 'revive', sessionId, cwd: ISOLATED_HOME }),
    (err) => err instanceof HubRequestError && err.status === 409 && err.code === 'SESSION_CLOSED',
  );
  assert.equal(fake.log.creates.length, 1, 'a closed session must never be recreated');
});

test('the tombstone table is bounded so a long-lived hub cannot grow without limit', async () => {
  const fake = makeCtx();
  const registry = makeRegistry(fake);
  for (let i = 0; i < 1005; i += 1) registry.rememberClosedSession(`s-${i}`);
  assert.equal(registry.closedSessions.size, 1000);
  assert.equal(registry.closedSessions.has('s-0'), false, 'the oldest tombstones are evicted');
  assert.equal(registry.closedSessions.has('s-1004'), true);
});

// ---------- 10. idle reaper ----------

test('the idle reaper closes idle sessions only, honoring the configured timeout', async () => {
  const fake = makeCtx();
  const registry = makeRegistry(fake);

  const turnA = await registry.spawn({ task: 'a', cwd: ISOLATED_HOME, persistent: true });
  await turnA.promise;
  const idleId = turnA.sessionId;

  const turnB = await registry.spawn({ task: 'b', cwd: ISOLATED_HOME, persistent: true });
  await turnB.promise;
  const busyId = turnB.sessionId;

  const now = Date.now();
  registry.persistentSessions.get(idleId).lastActiveAt = now - 31 * 60_000; // past 30 min
  registry.persistentSessions.get(busyId).lastActiveAt = now - 31 * 60_000;
  registry.persistentSessions.get(busyId).status = 'running'; // never reap a live turn

  const closed = registry.reapIdleSessions(now);
  assert.deepEqual(closed, [idleId]);
  assert.equal(registry.persistentSessions.has(idleId), false);
  assert.equal(registry.persistentSessions.has(busyId), true, 'a running session is never reaped');
  assert.ok(registry.closedSessions.has(idleId));

  // A session inside the window survives.
  registry.persistentSessions.get(busyId).status = 'idle';
  registry.persistentSessions.get(busyId).lastActiveAt = now - 5 * 60_000;
  assert.deepEqual(registry.reapIdleSessions(now), []);

  // The panel switch turns reaping off entirely.
  registry.getConfig = () => ({ persistent_session_idle_timeout_enabled: false });
  registry.persistentSessions.get(busyId).lastActiveAt = now - 10 * 60 * 60_000;
  assert.deepEqual(registry.reapIdleSessions(now), []);
  assert.equal(registry.persistentSessions.has(busyId), true);

  // Minutes are clamped to 1..1440.
  registry.getConfig = () => ({ persistent_session_idle_timeout_enabled: true, persistent_session_idle_timeout_minutes: 0 });
  registry.persistentSessions.get(busyId).lastActiveAt = now - 2 * 60_000;
  assert.deepEqual(registry.reapIdleSessions(now), [busyId], '0 minutes clamps up to 1 minute');
});

test('the reaper timer is opt-out for tests and unref-ed for production', async () => {
  const fake = makeCtx();
  const manual = new WorkerRegistry(fake.ctx, { publish() {} }, { reaperIntervalMs: 0 });
  assert.equal(manual.reaperTimer, null, 'a 0 interval disables the timer');

  const timerRegistry = new WorkerRegistry(fake.ctx, { publish() {} }, { reaperIntervalMs: 60_000 });
  assert.notEqual(timerRegistry.reaperTimer, null);
  await timerRegistry.dispose();
  assert.equal(timerRegistry.reaperTimer, null, 'dispose clears the timer');
});

// ---------- 11. one-shot handle leak ----------

test('one-shot jobs dispose their handle at the end; persistent turns do not', async () => {
  const fake = makeCtx();
  const registry = makeRegistry(fake);

  const oneShot = await registry.spawn({ task: 'once', cwd: ISOLATED_HOME });
  await oneShot.promise;
  assert.equal(oneShot.status, 'done');
  assert.notEqual(oneShot.persistent, true);
  assert.equal(registry.view(oneShot).persistent, false);
  assert.equal(registry.view(oneShot).turnIndex, null);
  assert.equal(fake.log.disposes, 1, 'the one-shot runtime is released (leak fix)');
  assert.equal(oneShot.handle, null);

  const persistent = await registry.spawn({ task: 'many', cwd: ISOLATED_HOME, persistent: true });
  await persistent.promise;
  assert.equal(fake.log.disposes, 1, 'a persistent turn keeps its runtime alive');
  assert.equal(registry.view(persistent).persistent, true);
});

// ---------- 12. dispose ----------

test('hub dispose closes every persistent session', async () => {
  const fake = makeCtx();
  const registry = makeRegistry(fake);
  const turn = await registry.spawn({ task: 'a', cwd: ISOLATED_HOME, persistent: true });
  await turn.promise;
  const sessionId = turn.sessionId;

  await registry.dispose();
  assert.equal(registry.persistentSessions.size, 0);
  assert.ok(registry.closedSessions.has(sessionId));
  assert.equal(fake.log.disposes, 1);
});

// ---------- 13. HTTP routes ----------

test('the session routes answer with the pool, map HubRequestError status/code, and reject non-loopback', async () => {
  const fake = makeCtx();
  const routes = [];
  const ctx = {
    ...fake.ctx,
    settings: { get() { return undefined; } },
    tools: { register() { return () => {}; } },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    logger: { warn() {}, info() {} },
    get(name) { return fake.ctx.get(name); },
    inject(_names, cb) {
      cb({
        webServer: {
          register(spec) { routes.push(spec); return () => {}; },
          address() { return { address: '127.0.0.1', port: 45678 }; },
          server: { once() {}, removeListener() {} },
        },
      });
    },
  };

  const { apply } = await import('../src/hub/index.mjs');
  await apply(ctx);

  const sessionsRoute = routes.find((r) => r.path.endsWith('/sessions'));
  assert.ok(sessionsRoute !== undefined, 'the sessions route is registered');
  assert.equal(sessionsRoute.kind, 'prefix');
  // The pre-existing routes are still registered alongside it.
  for (const suffix of ['/ping', '/jobs', '/config', '/providers', '/worker-probe']) {
    assert.ok(routes.some((r) => r.path.endsWith(suffix)), `${suffix} route still registered`);
  }
  assert.equal(new Set(routes.map((r) => r.path)).size, routes.length, 'no route path is duplicated');

  const call = async ({ method, path, body, remoteAddress = '127.0.0.1' }) => {
    const chunks = [Buffer.from(JSON.stringify(body ?? {}))];
    const req = {
      method,
      url: `/_dsh/dsh-crew/sessions${path}`,
      headers: { host: '127.0.0.1:45678', 'content-type': 'application/json' },
      socket: { remoteAddress },
      async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
    };
    const answer = { status: 0, body: null, headers: {} };
    const res = {
      writeHead(status, headers) { answer.status = status; answer.headers = headers; },
      end(payload) { answer.body = payload === undefined ? null : JSON.parse(payload); },
    };
    await sessionsRoute.handler(req, res);
    return answer;
  };

  const empty = await call({ method: 'GET', path: '' });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { ok: true, sessions: [] });
  assert.equal(empty.headers['cache-control'], 'no-store', 'the sessions view is never cached');

  // Non-loopback callers are refused outright, and no session state is touched.
  const foreign = await call({ method: 'GET', path: '', remoteAddress: '10.1.2.3' });
  assert.equal(foreign.status, 403);
  assert.deepEqual(foreign.body, { ok: false, error: 'loopback only' });
  const foreignClose = await call({ method: 'POST', path: '/session-x/close', remoteAddress: '10.1.2.3' });
  assert.equal(foreignClose.status, 403);

  // A turn route needs a real session; an unknown id surfaces 409 + code.
  const missing = await call({ method: 'POST', path: '/session-unknown/turns', body: { task: 'x', cwd: ISOLATED_HOME } });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.code, 'SESSION_RESUME_FAILED');

  // A bad request (no task) keeps its 400 + code.
  const badBody = await call({ method: 'POST', path: '/session-unknown/turns', body: { cwd: ISOLATED_HOME } });
  assert.equal(badBody.status, 409);
  assert.equal(badBody.body.code, 'SESSION_RESUME_FAILED', 'resume runs before the body contract');

  // Close is idempotent and tombstones the id.
  const closed = await call({ method: 'POST', path: '/session-unknown/close', body: {} });
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.body, { ok: true, session_id: 'session-unknown', closed: true });

  // ...so a later turn on it reports the tombstone rather than resuming.
  const tombstoned = await call({ method: 'POST', path: '/session-unknown/turns', body: { task: 'x', cwd: ISOLATED_HOME } });
  assert.equal(tombstoned.status, 409);
  assert.equal(tombstoned.body.code, 'SESSION_CLOSED');

  const unknown = await call({ method: 'GET', path: '/a/b' });
  assert.equal(unknown.status, 404);
});

// ---------- 14. realm isolation ----------

test('the persistent-session modules import no host-realm packages', () => {
  for (const file of ['src/hub/persistent-sessions.mjs', 'src/hub/index.mjs']) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const line of source.split('\n')) {
      if (!/^\s*(?:import|export)\b/.test(line)) continue;
      const specifier = /from\s+['"]([^'"]+)['"]/.exec(line)?.[1] ?? null;
      if (specifier === null) continue;
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `${file} imports a non-relative, non-builtin module: ${specifier}`,
      );
    }
    // A dynamic `import()` must obey the same rule as a static one.
    for (const match of source.matchAll(/import\(\s*[`'"]([^`'"]+)[`'"]/g)) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'),
        `${file} dynamically imports a non-relative, non-builtin module: ${specifier}`,
      );
    }
  }
});
