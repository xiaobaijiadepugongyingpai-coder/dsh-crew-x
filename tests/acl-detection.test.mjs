// Windows ACL failure detection from a STRIPPED tool result.
//
// `@deepseek-ai/dsh-tools` copies only `error.message` into the `tool/result`
// event (`message: result.error.message`), and `src/hub/index.mjs`'s `onEvent`
// judges ACL failure from exactly that event. A real host `Win32Error` has
// `name: "Win32Error"` and `message: "GetNamedSecurityInfoW failed (Win32 5): …"`,
// while the marker that used to be matched (`AclWriteGrant`) lives only in
// `.stack` — which the event does not carry. So `permission: "auto"` never
// degraded to a worktree on those real paths.
//
// The detector now also matches the Win32 ACL API names in their ACL-SPECIFIC
// shape (API name next to a Win32 code), deliberately NOT as a bare substring:
// ordinary prose that merely mentions `CreateRestrictedToken` must stay
// non-ACL. This file is separate from tests/worker-permission.test.mjs so that
// its reverse assertions stay untouched and green.
//
// Isolated HOME like every other suite: nothing here may reach a real profile.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'dsh-crew-acl-home-'));
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
process.env.HOME = ISOLATED_HOME;
process.env.USERPROFILE = ISOLATED_HOME;

const { detectWindowsAclFailure } = await import('../src/permission-policy.mjs');
const { WorkerRegistry } = await import('../src/hub/index.mjs');

after(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

// ---------- 1. the five verified cases ----------

test('a stripped Win32 message alone is detected (no stack, no AclWriteGrant marker)', () => {
  // Each of these is what `tool/result` carries for a real host failure: the
  // message string by itself. The two marked BEFORE were silently missed.
  assert.equal(
    detectWindowsAclFailure('GetNamedSecurityInfoW failed (Win32 2/5): C:\\repo'),
    true,
    'GetNamedSecurityInfoW was not detected — auto degradation silently did not trigger',
  );
  assert.equal(detectWindowsAclFailure('SetNamedSecurityInfoW failed (Win32 5): C:\\repo'), true);
  assert.equal(
    detectWindowsAclFailure('CreateRestrictedToken failed (Win32 5): restricting SIDs: 3'),
    true,
    'CreateRestrictedToken was not detected — auto degradation silently did not trigger',
  );
  assert.equal(detectWindowsAclFailure('SetEntriesInAclW failed (Win32 5): write ACE'), true);
  assert.equal(detectWindowsAclFailure('windows-acl-run: CreateRestrictedToken failed (Win32 5)'), true);

  // The same shapes nested where a tool/result event actually carries them.
  assert.equal(detectWindowsAclFailure({
    type: 'tool/result',
    data: { name: 'bash', error: { name: 'Win32Error', message: 'GetNamedSecurityInfoW failed (Win32 5): D:\\repo' } },
  }), true);
  // …and in a real Error whose class name never reaches the message.
  const stripped = new Error('GetNamedSecurityInfoW failed (Win32 5): C:\\repo');
  stripped.name = 'Win32Error';
  stripped.stack = 'Win32Error: GetNamedSecurityInfoW failed (Win32 5): C:\\repo\n    at <anonymous>';
  assert.equal(detectWindowsAclFailure(stripped), true);
});

// ---------- 2. the deliberate negative boundary ----------

test('merely naming an ACL API is NOT an ACL failure', () => {
  // These are the cases the boundary exists for. A false positive is expensive:
  // it silently moves a worker into a throwaway git worktree, so its uncommitted
  // work lands somewhere the caller never asked for. Matching requires the
  // ACL-specific shape (API name AND a Win32 code), never a bare substring.
  for (const prose of [
    'the code calls CreateRestrictedToken',
    'CreateRestrictedToken exists in advapi32.dll',
    'see GetNamedSecurityInfoW for the ACL layout',
    'SetEntriesInAclW writes the DACL once the entries are built',
    'we should not use GetNamedSecurityInfoW here',
  ]) {
    assert.equal(detectWindowsAclFailure(prose), false, `ordinary prose must not be read as an ACL failure: ${prose}`);
  }
  // NOTE: the bare `SetNamedSecurityInfoW` / `AclWriteGrant` patterns were REMOVED
  // in round 2 — they fired on source code and prose. The cases below pin that.
  assert.equal(
    detectWindowsAclFailure('```c\nSetNamedSecurityInfoW(p, SE_FILE_OBJECT, DACL, null, null, pDacl, null);\n```'),
    false,
    'a code block showing the API must not read as an ACL failure',
  );
  assert.equal(
    detectWindowsAclFailure('AclWriteGrant is a helper class that grants write ACEs to the workspace SID.'),
    false,
    'a sentence naming the class must not read as an ACL failure',
  );
  assert.equal(detectWindowsAclFailure('materializeAclGrant is imported by the ACL module'), false);
  assert.equal(detectWindowsAclFailure('SetNamedSecurityInfoW'), false);
  assert.equal(detectWindowsAclFailure('AclWriteGrant'), false);

  // A bare Win32 code, or a bare API name, is not enough either.
  assert.equal(detectWindowsAclFailure('Win32 5'), false);
  assert.equal(detectWindowsAclFailure('GetNamedSecurityInfoW'), false);
  assert.equal(detectWindowsAclFailure('CreateRestrictedToken'), false);

  // An ordinary error keeps being ordinary (the pre-existing reverse assertions
  // in tests/worker-permission.test.mjs stay valid).
  assert.equal(detectWindowsAclFailure('command failed with exit code 127: missing foo'), false);
  assert.equal(detectWindowsAclFailure('ENOENT: no such file or directory'), false);
  assert.equal(detectWindowsAclFailure(new Error('GetNamedSecurityInfoW is documented in winbase.h')), false);

  const cyclic = { msg: 'the code calls CreateRestrictedToken' };
  cyclic.self = cyclic;
  assert.equal(detectWindowsAclFailure(cyclic), false, 'cycle-safe AND not trigger-happy');
});

// ---------- 2b. the marker names are matched only in an ERROR/STACK shape ----------

test('AclWriteGrant / materializeAclGrant count only in an error or stack shape', () => {
  // The host ACL package's symbols still identify a REAL failure when they appear
  // where a failure appears: a stack frame, or beside a failure word.
  assert.equal(detectWindowsAclFailure('AclWriteGrant.create failed: Win32 5'), true);
  assert.equal(detectWindowsAclFailure('materializeAclGrant failed for C:\\repo'), true);
  assert.equal(
    detectWindowsAclFailure('    at AclWriteGrant.create (file:///D:/x/packages/windows-acl/lib/index.js:42:11)'),
    true,
    'a stack frame naming the class IS the real failure',
  );
  assert.equal(
    detectWindowsAclFailure(new Error('grant denied', { cause: { detail: 'at materializeAclGrant (x.js:1:1)' } })),
    true,
    'still reachable through a nested cause',
  );
});

// ---------- 2c. the real no-Win32-code sandbox failure ----------

test('CreateRestrictedToken prerequisite failure is detected without any Win32 code', () => {
  // From `@deepseek-ai/dsh-sandbox-windows-acl`: restricted-token creation can
  // fail before any ACL API is reached and carries no Win32 <code> at all.
  // Deliberate decision: this IS an ACL failure (it is the only way a restricted
  // token cannot be built, the turn dies otherwise, and `auto` exists precisely to
  // keep the task alive on a worktree). The match still needs the API name AND the
  // prerequisite-failure pair, so a mention of the API alone stays non-ACL.
  assert.equal(
    detectWindowsAclFailure('CreateRestrictedToken prerequisite failed: no logon SID found'),
    true,
  );
  assert.equal(detectWindowsAclFailure('CreateRestrictedToken prerequisite failed'), true);
  // Strangers to that exact shape stay out.
  assert.equal(detectWindowsAclFailure('the code calls CreateRestrictedToken'), false);
  assert.equal(detectWindowsAclFailure('CreateRestrictedToken is imported from advapi32'), false);
  assert.equal(detectWindowsAclFailure('prerequisite failed: missing api key'), false, 'the phrase alone is not ACL');
});

test('an auto turn degrades to a worktree when the ACL failure arrives ONLY via tool/result', async () => {
  // End-to-end for the defect: the turn never throws. The sandbox failure shows
  // up as a `tool/result` event carrying the stripped message, exactly as the
  // real host delivers it. Before the fix, `detectWindowsAclFailure(event)`
  // returned false, so the turn simply failed and NO worktree was created.
  const worktreePath = join(ISOLATED_HOME, 'wt-stripped');
  const creates = [];
  const disposes = [];

  const buildAgent = (options) => {
    const listeners = {};
    const session = { header: { cwd: options.meta?.cwd }, events: [], async append() {} };
    const emit = (type, data) => {
      for (const fn of listeners['session/event'] ?? []) fn(session, { type, data });
    };
    let pending = null;
    const agent = {
      session,
      id: options.sessionId,
      async whenIdle() { await pending; },
      followup() {
        pending = Promise.resolve().then(() => {
          if (options.sessionId.endsWith('-wt')) {
            emit('assistant/message', { message: { content: [{ type: 'text', text: 'patched in worktree' }] } });
            emit('turn/end', { reason: { kind: 'completed' } });
            return;
          }
          // The ONLY signal: the stripped message inside tool/result.
          emit('tool/result', {
            name: 'bash',
            error: { name: 'Win32Error', message: 'CreateRestrictedToken failed (Win32 5): restricting SIDs: 3' },
          });
          emit('turn/end', { reason: { kind: 'error' } });
        });
      },
      cancel() {},
    };
    return { record: { sessionId: options.sessionId, cwd: options.meta?.cwd }, agent, listeners };
  };

  const ctx = {
    logger: { warn() {}, info() {} },
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id: id ?? 'builtin-default' }; }, async mount() {} };
      return undefined;
    },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        creates.push({ sessionId: options.sessionId, cwd: options.meta?.cwd, preset: options.meta?.agentPreset });
        const built = buildAgent(options);
        await options.setup({
          agent: { session: built.session, id: options.sessionId },
          on(fn, handler) { (built.listeners[fn] ??= []).push(handler); },
        });
        return {
          agent: built.agent,
          async dispose() { disposes.push(options.sessionId); },
        };
      },
    },
  };

  const registry = new WorkerRegistry(ctx, { publish() {} }, { reaperIntervalMs: 0 });
  registry.getConfig = () => ({ preset_flash: 'fp', preset_pro: 'pp', flash_model: 'fm', pro_model: 'pm' });
  const worktreeCalls = [];
  const createWorktree = async ({ jobId, cwd }) => {
    worktreeCalls.push({ jobId, cwd });
    return { worktreePath, repoRoot: ISOLATED_HOME, cwd: worktreePath };
  };

  const turn = await registry.spawn({
    task: 'edit files', cwd: ISOLATED_HOME, permission: 'auto', persistent: true, createWorktree, turnTimeoutMs: 0,
  });
  await turn.promise;

  assert.equal(worktreeCalls.length, 1, 'the stripped ACL failure was recognized and a worktree was created');
  assert.equal(worktreeCalls[0].jobId, turn.sessionId, 'the worktree is keyed by the external session id');
  assert.equal(creates.length, 2, 'the degraded turn re-ran on a new runtime');
  assert.equal(creates[1].cwd, worktreePath);
  assert.equal(creates[1].sessionId, `${turn.sessionId}-wt`);
  assert.equal(turn.status, 'done', 'the turn succeeded in the worktree instead of failing in place');
  assert.equal(turn.result, 'patched in worktree');
  assert.equal(turn.worktree_path, worktreePath);
  assert.equal(turn.isolation, 'git-worktree');
  assert.equal(turn.degraded_from, 'workspace-write', 'never escalated to full-access');
  assert.deepEqual(disposes, [turn.sessionId], 'the pre-worktree runtime was torn down');
  registry.clearTurnWatchdog(turn);
});

test('auto prose-only "ACL" mention does NOT degrade a turn into a worktree', async () => {
  // The other half of the boundary, at the level where it matters: the model
  // merely TALKING about CreateRestrictedToken must not move the worker into a
  // throwaway worktree.
  const worktreeCalls = [];
  const buildAgent = (options) => {
    const listeners = {};
    const session = { header: { cwd: options.meta?.cwd }, events: [], async append() {} };
    const emit = (type, data) => {
      for (const fn of listeners['session/event'] ?? []) fn(session, { type, data });
    };
    let pending = null;
    const agent = {
      session,
      id: options.sessionId,
      async whenIdle() { await pending; },
      followup() {
        pending = Promise.resolve().then(() => {
          emit('assistant/message', {
            message: { content: [{ type: 'text', text: 'The code calls CreateRestrictedToken to build the sandbox token.' }] },
          });
          emit('turn/end', { reason: { kind: 'completed' } });
        });
      },
      cancel() {},
    };
    return { built: { listeners }, agent, session };
  };
  const ctx = {
    logger: { warn() {}, info() {} },
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id: id ?? 'builtin-default' }; }, async mount() {} };
      return undefined;
    },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        const built = buildAgent(options);
        await options.setup({
          agent: { session: built.session, id: options.sessionId },
          on(fn, handler) { (built.built.listeners[fn] ??= []).push(handler); },
        });
        return { agent: built.agent, async dispose() {} };
      },
    },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} }, { reaperIntervalMs: 0 });
  registry.getConfig = () => ({ preset_flash: 'fp', preset_pro: 'pp', flash_model: 'fm', pro_model: 'pm' });

  const turn = await registry.spawn({
    task: 'explain the sandbox',
    cwd: ISOLATED_HOME,
    permission: 'auto',
    persistent: true,
    turnTimeoutMs: 0,
    createWorktree: async () => { worktreeCalls.push(1); throw new Error('must not be called'); },
  });
  await turn.promise;

  assert.equal(worktreeCalls.length, 0, 'prose mentioning an ACL API must not trigger a worktree');
  assert.equal(turn.status, 'done');
  assert.equal(turn.isolation, null);
  assert.equal(turn.worktree_path, null);
});

// ---------- 4. a SUCCESSFUL turn is never degraded ----------

test('a completed turn that READ a file containing ACL source text is never degraded', async () => {
  // THE ROUND-2 BLOCKER, end to end. Two defects combined here:
  //   1. `applyJobEvent` called detectWindowsAclFailure on the WHOLE tool/result
  //      event, so a successful `read_file` whose OUTPUT contains
  //      `SetNamedSecurityInfoW(...)` looked like a sandbox failure;
  //   2. `runPersistentAttempt` degraded whenever the status was merely not
  //      cancelled/needs_input, so a turn that then COMPLETED successfully was
  //      still relocated into a throwaway worktree, discarding the work it had
  //      just done in the caller's workspace.
  // Both are now impossible: only a tool/result carrying an ERROR is inspected,
  // and only a FAILED turn may be degraded.
  const worktreeCalls = [];
  const creates = [];

  const buildAgent = (options) => {
    const listeners = {};
    const session = { header: { cwd: options.meta?.cwd }, events: [], async append() {} };
    const emit = (type, data) => {
      for (const fn of listeners['session/event'] ?? []) fn(session, { type, data });
    };
    let pending = null;
    const agent = {
      session,
      id: options.sessionId,
      async whenIdle() { await pending; },
      followup() {
        pending = Promise.resolve().then(() => {
          // A SUCCESSFUL read whose output happens to contain ACL source code.
          emit('tool/result', {
            name: 'read_file',
            ok: true,
            output: '```c\nSetNamedSecurityInfoW(p, SE_FILE_OBJECT, DACL, null, null, pDacl, null);\n```',
            content: 'AclWriteGrant is a helper class that grants write ACEs to the workspace SID.',
          });
          emit('assistant/message', { message: { content: [{ type: 'text', text: 'read 2 files' }] } });
          emit('turn/end', { reason: { kind: 'completed' } });
        });
      },
      cancel() {},
    };
    return { record: { sessionId: options.sessionId, cwd: options.meta?.cwd }, agent, listeners };
  };

  const ctx = {
    logger: { warn() {}, info() {} },
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id: id ?? 'builtin-default' }; }, async mount() {} };
      return undefined;
    },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        creates.push({ sessionId: options.sessionId, cwd: options.meta?.cwd });
        const built = buildAgent(options);
        await options.setup({
          agent: { session: built.session, id: options.sessionId },
          on(fn, handler) { (built.listeners[fn] ??= []).push(handler); },
        });
        return { agent: built.agent, async dispose() {} };
      },
    },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} }, { reaperIntervalMs: 0 });
  registry.getConfig = () => ({ preset_flash: 'fp', preset_pro: 'pp', flash_model: 'fm', pro_model: 'pm' });

  const turn = await registry.spawn({
    task: 'read the acl module',
    cwd: ISOLATED_HOME,
    permission: 'auto',
    persistent: true,
    turnTimeoutMs: 0,
    createWorktree: async (args) => { worktreeCalls.push(args); throw new Error('must not be called'); },
  });
  await turn.promise;

  assert.equal(worktreeCalls.length, 0, 'a COMPLETED turn must never be relocated into a worktree');
  assert.equal(creates.length, 1, 'no second runtime was built');
  assert.equal(turn.status, 'done', 'the turn completed where it ran');
  assert.equal(turn.result, 'read 2 files');
  assert.equal(turn.isolation, null);
  assert.equal(turn.worktree_path, null);
  assert.equal(turn.degraded_from, null);

  // The one-shot path (same shared applyJobEvent) behaves identically.
  const oneShotRegistry = new WorkerRegistry(ctx, { publish() {} }, { reaperIntervalMs: 0 });
  oneShotRegistry.getConfig = () => ({ preset_flash: 'fp', preset_pro: 'pp', flash_model: 'fm', pro_model: 'pm' });
  const oneShot = await oneShotRegistry.spawn({
    task: 'read the acl module',
    cwd: ISOLATED_HOME,
    permission: 'auto',
    createWorktree: async (args) => { worktreeCalls.push(args); throw new Error('must not be called'); },
  });
  await oneShot.promise;
  assert.equal(worktreeCalls.length, 0);
  assert.equal(oneShot.status, 'done');
  assert.equal(oneShot.worktree_path, null);
});

test('a FAILED tool result that reports an ACL error still degrades, as before', async () => {
  // The complement: the fix must not have disabled real degradation through the
  // tool/result path. A FAILED turn carrying an ACL error in a failed tool result
  // still moves to the worktree.
  const worktreePath = join(ISOLATED_HOME, 'wt-failed-tool');
  const worktreeCalls = [];
  const disposes = [];

  const buildAgent = (options) => {
    const listeners = {};
    const session = { header: { cwd: options.meta?.cwd }, events: [], async append() {} };
    const emit = (type, data) => {
      for (const fn of listeners['session/event'] ?? []) fn(session, { type, data });
    };
    let pending = null;
    const agent = {
      session,
      id: options.sessionId,
      async whenIdle() { await pending; },
      followup() {
        pending = Promise.resolve().then(() => {
          if (options.sessionId.endsWith('-wt')) {
            emit('assistant/message', { message: { content: [{ type: 'text', text: 'done in worktree' }] } });
            emit('turn/end', { reason: { kind: 'completed' } });
            return;
          }
          emit('tool/result', {
            name: 'bash',
            ok: false,
            error: { name: 'Win32Error', message: 'CreateRestrictedToken prerequisite failed: no logon SID found' },
          });
          emit('turn/end', { reason: { kind: 'error' } });
        });
      },
      cancel() {},
    };
    return { record: { sessionId: options.sessionId }, agent, listeners };
  };
  const ctx = {
    logger: { warn() {}, info() {} },
    get(name) {
      if (name === 'agentPresets') return { async resolve(id) { return { id: id ?? 'builtin-default' }; }, async mount() {} };
      return undefined;
    },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        const built = buildAgent(options);
        await options.setup({
          agent: { session: built.session, id: options.sessionId },
          on(fn, handler) { (built.listeners[fn] ??= []).push(handler); },
        });
        return { agent: built.agent, async dispose() { disposes.push(options.sessionId); } };
      },
    },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} }, { reaperIntervalMs: 0 });
  registry.getConfig = () => ({ preset_flash: 'fp', preset_pro: 'pp', flash_model: 'fm', pro_model: 'pm' });

  const turn = await registry.spawn({
    task: 'edit files',
    cwd: ISOLATED_HOME,
    permission: 'auto',
    persistent: true,
    turnTimeoutMs: 0,
    createWorktree: async ({ jobId }) => {
      worktreeCalls.push(jobId);
      return { worktreePath, repoRoot: ISOLATED_HOME, cwd: worktreePath };
    },
  });
  await turn.promise;

  assert.equal(worktreeCalls.length, 1, 'a genuinely failed ACL turn still degrades');
  assert.equal(turn.status, 'done');
  assert.equal(turn.result, 'done in worktree');
  assert.equal(turn.isolation, 'git-worktree');
  registry.clearTurnWatchdog(turn);
});
