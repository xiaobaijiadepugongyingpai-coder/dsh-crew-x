import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Isolate HOME / USERPROFILE before importing jobs.mjs / status-shard.mjs so
// normal `npm test` runs never touch the real %USERPROFILE%\.config\dsh-crew\.
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'dsh-crew-perm-home-'));
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
process.env.HOME = ISOLATED_HOME;
process.env.USERPROFILE = ISOLATED_HOME;

const {
  PERMISSIONS,
  PERMISSION_LEVEL,
  SANDBOX_MODE_BY_PERMISSION,
  MAX_PERMISSION_ENV,
  FULL_ACCESS_WARNING,
  PermissionError,
  resolveWorkerPermission,
  resolveEffectivePreset,
  readMaxPermission,
  detectWindowsAclFailure,
  buildWorktreePath,
  createTempWorktree,
} = await import('../src/permission-policy.mjs');
const { WorkerRegistry } = await import('../src/hub/index.mjs');
const { createHubClient } = await import('../src/hub-client.mjs');
const { startJob, jobView, publishStatus } = await import('../src/jobs.mjs');

after(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

// ---------- 1. Permission Policy & Ceiling ----------

test('permission defaults follow Method B and reject concurrent_cwd write conflicts', () => {
  assert.deepEqual(PERMISSIONS, ['read-only', 'workspace-write', 'auto', 'full-access']);
  assert.ok(PERMISSION_LEVEL['read-only'] < PERMISSION_LEVEL['workspace-write']);
  assert.equal(PERMISSION_LEVEL['workspace-write'], PERMISSION_LEVEL.auto);
  assert.ok(PERMISSION_LEVEL.auto < PERMISSION_LEVEL['full-access']);

  const exclusiveDefault = resolveWorkerPermission({ env: {} });
  assert.equal(exclusiveDefault.permission, 'workspace-write');
  assert.equal(exclusiveDefault.effective_sandbox_mode, 'workspace-write');
  assert.equal(exclusiveDefault.permission_warning, undefined);

  const concurrentDefault = resolveWorkerPermission({ allowConcurrentCwd: true, env: {} });
  assert.equal(concurrentDefault.permission, 'read-only');
  assert.equal(concurrentDefault.effective_sandbox_mode, 'read-only');
  assert.equal(concurrentDefault.permission_warning, undefined);

  const concurrentExplicitReadOnly = resolveWorkerPermission({
    permission: 'read-only',
    allowConcurrentCwd: true,
    env: {},
  });
  assert.equal(concurrentExplicitReadOnly.permission, 'read-only');
  assert.equal(concurrentExplicitReadOnly.effective_sandbox_mode, 'read-only');

  for (const bad of ['workspace-write', 'auto', 'full-access']) {
    assert.throws(
      () => resolveWorkerPermission({ permission: bad, allowConcurrentCwd: true, env: {} }),
      (err) => err instanceof PermissionError && err.code === 'concurrent-cwd-conflict',
      `allow_concurrent_cwd=true must reject ${bad}`,
    );
  }

  assert.throws(
    () => resolveWorkerPermission({ permission: 'root', env: {} }),
    (err) => err instanceof PermissionError && err.code === 'unknown-permission',
  );
});

test('DSH_CREW_MAX_PERMISSION enforces ceiling and full-access requires explicit opt-in with warning', () => {
  assert.equal(SANDBOX_MODE_BY_PERMISSION['read-only'], 'read-only');
  assert.equal(SANDBOX_MODE_BY_PERMISSION['workspace-write'], 'workspace-write');
  assert.equal(SANDBOX_MODE_BY_PERMISSION.auto, 'workspace-write');
  assert.equal(SANDBOX_MODE_BY_PERMISSION['full-access'], 'danger-full-access');

  // Ceiling = read-only refuses default workspace-write, auto, and full-access.
  for (const p of [undefined, 'workspace-write', 'auto', 'full-access']) {
    assert.throws(
      () => resolveWorkerPermission({ permission: p, env: { [MAX_PERMISSION_ENV]: 'read-only' } }),
      (err) => err instanceof PermissionError && err.code === 'permission-ceiling-exceeded',
    );
  }
  const roUnderCap = resolveWorkerPermission({
    permission: 'read-only',
    env: { [MAX_PERMISSION_ENV]: 'read-only' },
  });
  assert.equal(roUnderCap.permission, 'read-only');
  assert.equal(roUnderCap.childMaxPermission, 'read-only');

  // Ceiling = workspace-write allows workspace-write and auto, refuses full-access.
  const autoUnderWriteCap = resolveWorkerPermission({
    permission: 'auto',
    env: { [MAX_PERMISSION_ENV]: 'workspace-write' },
  });
  assert.equal(autoUnderWriteCap.permission, 'auto');
  assert.equal(autoUnderWriteCap.effective_sandbox_mode, 'workspace-write');
  assert.equal(autoUnderWriteCap.childMaxPermission, 'workspace-write');
  assert.throws(
    () => resolveWorkerPermission({ permission: 'full-access', env: { [MAX_PERMISSION_ENV]: 'workspace-write' } }),
    (err) => err instanceof PermissionError && err.code === 'permission-ceiling-exceeded',
  );

  // Caller maxPermission can tighten, never raise an inherited env ceiling.
  assert.equal(
    readMaxPermission({ maxPermission: 'full-access', env: { [MAX_PERMISSION_ENV]: 'read-only' } }),
    'read-only',
  );
  assert.throws(
    () => resolveWorkerPermission({
      permission: 'workspace-write',
      maxPermission: 'full-access',
      env: { [MAX_PERMISSION_ENV]: 'read-only' },
    }),
    (err) => err instanceof PermissionError && err.code === 'permission-ceiling-exceeded',
  );

  // Invalid ceiling fails closed.
  assert.throws(
    () => readMaxPermission({ env: { [MAX_PERMISSION_ENV]: 'bogus' } }),
    (err) => err instanceof PermissionError && err.code === 'invalid-max-permission',
  );

  // Explicit full-access maps to danger-full-access with warning.
  const full = resolveWorkerPermission({ permission: 'full-access', env: {} });
  assert.equal(full.permission, 'full-access');
  assert.equal(full.effective_sandbox_mode, 'danger-full-access');
  assert.equal(full.permission_warning, FULL_ACCESS_WARNING);
  assert.equal(full.childMaxPermission, 'full-access');
});

test('resolveEffectivePreset prioritizes explicit preset then tier config fallback', () => {
  const cfg = { preset_flash: 'fast-coder', preset_pro: 'deep-reviewer' };
  assert.equal(resolveEffectivePreset({ preset: '  custom-one  ', tier: 'flash', config: cfg }), 'custom-one');
  assert.equal(resolveEffectivePreset({ preset: '   ', tier: 'flash', config: cfg }), 'fast-coder');
  assert.equal(resolveEffectivePreset({ tier: 'pro', config: cfg }), 'deep-reviewer');
  assert.equal(resolveEffectivePreset({ tier: 'flash', config: {} }), 'default');
});

// ---------- 2. Windows ACL Detection & Temp Git Worktree ----------

test('detectWindowsAclFailure recognizes ACL signatures without false positives and survives cycles', () => {
  assert.equal(detectWindowsAclFailure('SetNamedSecurityInfoW failed with Win32 5'), true);
  assert.equal(detectWindowsAclFailure('windows-acl-run: grant failed (exit 127)'), true);
  assert.equal(detectWindowsAclFailure(new Error('sandbox runner exit code: 127 Win32 5')), true);
  assert.equal(detectWindowsAclFailure({ runnerFailed: true, exitCode: 127 }), true);

  assert.equal(detectWindowsAclFailure('command failed with exit code 127: missing foo'), false);
  assert.equal(detectWindowsAclFailure('ENOENT: no such file or directory'), false);

  const cyclic = { msg: 'ordinary error' };
  cyclic.self = cyclic;
  assert.equal(detectWindowsAclFailure(cyclic), false);

  const nested = new Error('outer', { cause: { detail: 'windows-acl-run: exit 127' } });
  assert.equal(detectWindowsAclFailure(nested), true);
});

test('buildWorktreePath blocks dot-segment and traversal jobId escapes out of baseDir', () => {
  const baseDir = join(ISOLATED_HOME, 'wt-base');
  const resolvedBase = resolve(baseDir);
  for (const weirdId of ['.', '..', '...', '.hidden', '..\\..\\outside', '../../outside', '']) {
    const p = buildWorktreePath(weirdId, baseDir);
    const rel = relative(resolvedBase, p);
    assert.ok(rel && rel !== '.' && !rel.startsWith('..') && !isAbsolute(rel), `expected ${p} inside ${resolvedBase} for ${JSON.stringify(weirdId)}`);
  }
});

test('createTempWorktree creates detached git worktree under temp baseDir and preserves subdir cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wt-test-'));
  const repo = join(root, 'repo');
  const sub = join(repo, 'packages', 'sub');
  const wtBase = join(root, 'worktrees');
  mkdirSync(sub, { recursive: true });

  try {
    await execFileAsync('git', ['init'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo, windowsHide: true });
    writeFileSync(join(sub, 'hello.txt'), 'world\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo, windowsHide: true });

    const wt = await createTempWorktree({ cwd: sub, jobId: 'job-wt-1', baseDir: wtBase });
    assert.equal(wt.worktreePath, buildWorktreePath('job-wt-1', wtBase));
    assert.ok(existsSync(join(wt.worktreePath, 'packages', 'sub', 'hello.txt')));
    assert.equal(readFileSync(join(wt.cwd, 'hello.txt'), 'utf8').trim(), 'world');

    await execFileAsync('git', ['-C', repo, 'worktree', 'remove', '--force', wt.worktreePath], { windowsHide: true });

    const nonGit = join(root, 'not-a-repo');
    mkdirSync(nonGit, { recursive: true });
    await assert.rejects(
      () => createTempWorktree({ cwd: nonGit, jobId: 'job-wt-2', baseDir: wtBase }),
      /not a git repository/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 3. Hub Mode (WorkerRegistry) ----------

test('hub spawn appends sandbox/mode after whenIdle and before followup, passes preset, and exposes view fields', async () => {
  const timeline = [];
  const appendedModes = [];
  const resolvedPresets = [];
  const publishedSnapshots = [];

  const ctx = {
    get(name) {
      if (name === 'agentPresets') {
        return {
          async resolve(id) {
            resolvedPresets.push(id);
            return { id: id ?? 'builtin-default' };
          },
          async mount() {},
        };
      }
      return undefined;
    },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        let onEvent;
        const agent = {
          session: {
            async append(type, data) {
              timeline.push(`append:${type}:${data.mode}`);
              appendedModes.push({ type, data, sessionId: options.sessionId });
            },
          },
          async whenIdle() {
            timeline.push('whenIdle');
          },
          followup() {
            timeline.push('followup');
            onEvent(agent.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } });
            onEvent(agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
          },
        };
        await options.setup({
          on(name, fn) {
            if (name === 'session/event') onEvent = fn;
          },
        });
        return { agent, async dispose() {} };
      },
    },
  };

  const registry = new WorkerRegistry(ctx, {
    publish(list) { publishedSnapshots.push(list); },
  });
  registry.getConfig = () => ({ preset_flash: 'flash-preset', preset_pro: 'pro-preset' });

  // read-only with allow_concurrent_cwd=true (default Method B) and explicit preset override
  const roJob = await registry.spawn({
    task: 'inspect',
    cwd: ISOLATED_HOME,
    tier: 'flash',
    allow_concurrent_cwd: true,
    preset: 'audit-preset',
  });
  await roJob.promise;

  assert.equal(roJob.status, 'done');
  assert.deepEqual(timeline.slice(0, 4), ['whenIdle', 'append:sandbox/mode:read-only', 'followup', 'whenIdle']);
  assert.deepEqual(resolvedPresets, ['audit-preset']);
  const roView = registry.view(roJob, true);
  assert.equal(roView.permission, 'read-only');
  assert.equal(roView.effective_sandbox_mode, 'read-only');
  assert.equal(roView.preset, 'audit-preset');
  assert.equal(roView.permission_warning, undefined);

  // full-access emits permission_warning and danger-full-access, falling back to preset_pro
  const faJob = await registry.spawn({
    task: 'fix',
    cwd: ISOLATED_HOME,
    tier: 'pro',
    permission: 'full-access',
  });
  await faJob.promise;
  assert.equal(faJob.status, 'done');
  assert.equal(appendedModes[1].data.mode, 'danger-full-access');
  assert.equal(resolvedPresets[1], 'pro-preset');
  const faView = registry.view(faJob, true);
  assert.equal(faView.permission, 'full-access');
  assert.equal(faView.effective_sandbox_mode, 'danger-full-access');
  assert.equal(faView.permission_warning, FULL_ACCESS_WARNING);
  assert.ok(publishedSnapshots.at(-1).some((entry) => entry.id === faJob.id && entry.permission_warning === FULL_ACCESS_WARNING));
});

test('hub mode auto degrades to temporary git worktree on Windows ACL failure without escalating to full-access', async () => {
  const attempts = [];
  const worktreeCalls = [];

  const ctx = {
    get() { return undefined; },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        const attempt = { cwd: options.meta.cwd, sessionId: options.sessionId, sandboxModes: [] };
        attempts.push(attempt);
        let onEvent;
        let onError;
        const agent = {
          session: {
            async append(type, data) {
              if (type === 'sandbox/mode') attempt.sandboxModes.push(data.mode);
            },
          },
          async whenIdle() {},
          followup() {
            if (attempts.length === 1) {
              onEvent(agent.session, { type: 'step/start', data: { turn: 2, step: 3 } });
              onEvent(agent.session, { type: 'tool/call', data: { name: 'bash' } });
              onEvent(agent.session, { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5 }, message: { content: [] } } });
              onError({ error: new Error('SetNamedSecurityInfoW failed: Win32 5') });
              onEvent(agent.session, { type: 'turn/end', data: { reason: { kind: 'error' } } });
            } else {
              onEvent(agent.session, { type: 'step/start', data: { turn: 1, step: 1 } });
              onEvent(agent.session, { type: 'tool/call', data: { name: 'edit_file' } });
              onEvent(agent.session, { type: 'tool/result', data: { ok: true } });
              onEvent(agent.session, { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 1 }, message: { content: [{ type: 'text', text: 'patched in worktree' }] } } });
              onEvent(agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
            }
          },
        };
        await options.setup({
          on(name, fn) {
            if (name === 'session/event') onEvent = fn;
            if (name === 'agent/error') onError = fn;
          },
        });
        return { agent, async dispose() {} };
      },
    },
  };

  const registry = new WorkerRegistry(ctx, { publish() {} });
  const fakeWtDir = join(ISOLATED_HOME, 'dsh-crew-worktrees', 'hub-wt');
  const job = await registry.spawn({
    task: 'edit file',
    cwd: ISOLATED_HOME,
    permission: 'auto',
    createWorktree: async ({ cwd, jobId }) => {
      worktreeCalls.push({ cwd, jobId });
      return { worktreePath: fakeWtDir, repoRoot: ISOLATED_HOME, cwd: fakeWtDir };
    },
  });
  await job.promise;

  assert.equal(attempts.length, 2);
  assert.equal(worktreeCalls.length, 1);
  assert.deepEqual(attempts[0].sandboxModes, ['workspace-write']);
  assert.deepEqual(attempts[1].sandboxModes, ['workspace-write']); // never danger-full-access
  assert.equal(attempts[1].cwd, fakeWtDir);

  const view = registry.view(job, true);
  assert.equal(view.status, 'done');
  assert.equal(view.result, 'patched in worktree');
  assert.equal(view.turn, 1);
  assert.equal(view.step, 1);
  assert.equal(view.toolCalls, 1);
  assert.deepEqual(view.tokens, { input: 10, output: 4, reasoning: 1 });
  assert.equal(view.permission, 'auto');
  assert.equal(view.effective_sandbox_mode, 'workspace-write');
  assert.equal(view.worktree_path, fakeWtDir);
  assert.equal(view.isolation, 'git-worktree');
  assert.equal(view.degraded_from, 'workspace-write');
  assert.equal(view.permission_warning, undefined);
});

test('hub mode requires session.append and does not degrade when only model text mentions ACL errors', async () => {
  const missingAppendCtx = {
    get() { return undefined; },
    sessions: { async flush() {} },
    agents: {
      async create() {
        return {
          agent: { session: {}, async whenIdle() {}, followup() {} },
          async dispose() {},
        };
      },
    },
  };
  const badRegistry = new WorkerRegistry(missingAppendCtx, { publish() {} });
  const badJob = await badRegistry.spawn({ task: 'x', cwd: ISOLATED_HOME, permission: 'auto' });
  await badJob.promise;
  assert.equal(badJob.status, 'failed');
  assert.match(badJob.error, /does not support sandbox\/mode append/);

  let worktreeCalled = false;
  const textMentionCtx = {
    get() { return undefined; },
    sessions: { async flush() {} },
    agents: {
      async create(options) {
        let onEvent;
        const agent = {
          session: { async append() {} },
          async whenIdle() {},
          followup() {
            onEvent(agent.session, {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: 'Discussed SetNamedSecurityInfoW and windows-acl-run in docs.' }] } },
            });
            onEvent(agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
          },
        };
        await options.setup({
          on(name, fn) {
            if (name === 'session/event') onEvent = fn;
          },
        });
        return { agent, async dispose() {} };
      },
    },
  };
  const okRegistry = new WorkerRegistry(textMentionCtx, { publish() {} });
  const okJob = await okRegistry.spawn({
    task: 'summarize acl',
    cwd: ISOLATED_HOME,
    permission: 'auto',
    createWorktree: async () => {
      worktreeCalled = true;
      return { worktreePath: join(ISOLATED_HOME, 'unused'), repoRoot: ISOLATED_HOME, cwd: ISOLATED_HOME };
    },
  });
  await okJob.promise;
  assert.equal(worktreeCalled, false);
  assert.equal(okJob.status, 'done');
  assert.equal(okJob.worktree_path, null);
});

test('hub mode refuses allow_concurrent_cwd conflicts and maxPermission escalations before spawning', async () => {
  let createCalls = 0;
  const ctx = {
    get() { return undefined; },
    sessions: { async flush() {} },
    agents: { async create() { createCalls += 1; return {}; } },
  };
  const registry = new WorkerRegistry(ctx, { publish() {} });

  await assert.rejects(
    () => registry.spawn({ task: 'x', cwd: ISOLATED_HOME, allow_concurrent_cwd: true, permission: 'workspace-write' }),
    (err) => err instanceof PermissionError && err.code === 'concurrent-cwd-conflict',
  );
  await assert.rejects(
    () => registry.spawn({ task: 'x', cwd: ISOLATED_HOME, permission: 'full-access', maxPermission: 'workspace-write' }),
    (err) => err instanceof PermissionError && err.code === 'permission-ceiling-exceeded',
  );
  assert.equal(createCalls, 0);
});

// ---------- 4. Standalone Mode (jobs.mjs) ----------

test('standalone startJob injects DSH_SANDBOX_MODE and DSH_CREW_MAX_PERMISSION and exposes view/status fields', async () => {
  const launches = [];
  class FakeHarness {
    constructor(opts) {
      this.opts = opts;
      launches.push(opts);
    }
    async run() {
      return {
        finalResponse: 'standalone ok',
        events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }],
      };
    }
    async close() {}
  }

  const job = await startJob({
    task: 'read files',
    tier: 'flash',
    cwd: ISOLATED_HOME,
    allowConcurrentCwd: true,
    preset: 'custom-standalone',
    _deps: { DeepSeekHarness: FakeHarness, env: {}, dotEnv: {} },
  });
  await job.promise;

  assert.equal(launches.length, 1);
  assert.equal(launches[0].launch.env.DSH_SANDBOX_MODE, 'read-only');
  assert.equal(launches[0].launch.env[MAX_PERMISSION_ENV], 'read-only');

  const view = jobView(job, { withResult: true });
  assert.equal(view.status, 'done');
  assert.equal(view.permission, 'read-only');
  assert.equal(view.effective_sandbox_mode, 'read-only');
  assert.equal(view.preset, 'custom-standalone');
  assert.equal(view.permission_warning, undefined);

  // Full access sets danger-full-access and permission_warning in jobView + shard
  const fullJob = await startJob({
    task: 'dangerous op',
    tier: 'pro',
    cwd: ISOLATED_HOME,
    permission: 'full-access',
    _deps: { DeepSeekHarness: FakeHarness, env: {}, dotEnv: {} },
  });
  await fullJob.promise;
  assert.equal(launches[1].launch.env.DSH_SANDBOX_MODE, 'danger-full-access');
  assert.equal(launches[1].launch.env[MAX_PERMISSION_ENV], 'full-access');
  const fullView = jobView(fullJob, { withResult: true });
  assert.equal(fullView.permission_warning, FULL_ACCESS_WARNING);

  publishStatus();
  const shardPath = join(ISOLATED_HOME, '.config', 'dsh-crew', 'status.d', `mcp-${process.pid}.json`);
  const shard = JSON.parse(readFileSync(shardPath, 'utf8'));
  const shardFull = shard.jobs.find((j) => j.id === fullJob.id);
  assert.equal(shardFull.permission, 'full-access');
  assert.equal(shardFull.effective_sandbox_mode, 'danger-full-access');
  assert.equal(shardFull.permission_warning, FULL_ACCESS_WARNING);

  // Snake-case allow_concurrent_cwd alone must allow concurrent read-only dispatches on same cwd.
  let releaseFirst;
  const gate = new Promise((r) => { releaseFirst = r; });
  class BlockingReadOnlyHarness {
    async run() {
      await gate;
      return { finalResponse: 'concurrent ok', events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }] };
    }
    async close() {}
  }
  const c1 = await startJob({
    task: 'read 1',
    cwd: ISOLATED_HOME,
    allow_concurrent_cwd: true,
    _deps: { DeepSeekHarness: BlockingReadOnlyHarness, env: {}, dotEnv: {} },
  });
  const c2 = await startJob({
    task: 'read 2',
    cwd: ISOLATED_HOME,
    allow_concurrent_cwd: true,
    _deps: { DeepSeekHarness: BlockingReadOnlyHarness, env: {}, dotEnv: {} },
  });
  releaseFirst();
  await Promise.all([c1.promise, c2.promise]);
  assert.equal(c1.permission, 'read-only');
  assert.equal(c2.permission, 'read-only');
});

test('standalone auto degrades to worktree on windows-acl-run exit 127 without escalating to full-access', async () => {
  const launches = [];
  const fakeWtDir = join(ISOLATED_HOME, 'wt-standalone');
  class FakeAclHarness {
    constructor(opts) {
      this.opts = opts;
      launches.push(opts);
      this.client = launches.length === 1 ? { child: { pid: 99999 } } : undefined;
    }
    async run(_task, { onNotification }) {
      if (launches.length === 1) {
        onNotification({ method: 'session.event', params: { event: { type: 'step/start', data: { turn: 2, step: 4 } } } });
        onNotification({ method: 'session.event', params: { event: { type: 'tool/call', data: { name: 'bash' } } } });
        onNotification({ method: 'session.event', params: { event: { type: 'assistant/message', data: { usage: { inputTokens: 50, outputTokens: 12, reasoningTokens: 3 } } } } });
        throw new Error('windows-acl-run: SetNamedSecurityInfoW failed (Win32 5), exit code 127');
      }
      onNotification({ method: 'session.event', params: { event: { type: 'step/start', data: { turn: 1, step: 1 } } } });
      onNotification({ method: 'session.event', params: { event: { type: 'tool/call', data: { name: 'write_file' } } } });
      onNotification({ method: 'session.event', params: { event: { type: 'tool/result', data: { ok: true } } } });
      onNotification({ method: 'session.event', params: { event: { type: 'assistant/message', data: { usage: { inputTokens: 8, outputTokens: 2, reasoningTokens: 0 } } } } });
      return {
        finalResponse: 'ok after worktree',
        events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }],
      };
    }
    async close() {}
  }

  const job = await startJob({
    task: 'write file',
    cwd: ISOLATED_HOME,
    permission: 'auto',
    _deps: {
      DeepSeekHarness: FakeAclHarness,
      env: {},
      dotEnv: {},
      createWorktree: async () => ({ worktreePath: fakeWtDir, repoRoot: ISOLATED_HOME, cwd: fakeWtDir }),
    },
  });
  await job.promise;

  assert.equal(launches.length, 2);
  assert.equal(launches[0].launch.env.DSH_SANDBOX_MODE, 'workspace-write');
  assert.equal(launches[1].launch.env.DSH_SANDBOX_MODE, 'workspace-write');
  assert.equal(launches[1].cwd, fakeWtDir);
  assert.equal(launches[1].launch.env.DSH_CWD, fakeWtDir);

  const view = jobView(job, { withResult: true });
  assert.equal(view.status, 'done');
  assert.equal(view.result, 'ok after worktree');
  assert.equal(view.pid, null);
  assert.equal(view.turn, 1);
  assert.equal(view.step, 1);
  assert.equal(view.toolCalls, 1);
  assert.deepEqual(view.tokens, { input: 8, output: 2, reasoning: 0 });
  assert.equal(view.permission, 'auto');
  assert.equal(view.effective_sandbox_mode, 'workspace-write');
  assert.equal(view.worktree_path, fakeWtDir);
  assert.equal(view.isolation, 'git-worktree');
  assert.equal(view.degraded_from, 'workspace-write');
  assert.equal(view.permission_warning, undefined);

  // Verify model prose mentioning ACL strings does NOT trigger worktree degradation.
  let proseWtCalled = false;
  class ProseMentionHarness {
    async run(_task, { onNotification }) {
      onNotification({
        method: 'session.event',
        params: {
          event: {
            type: 'assistant/message',
            data: { message: { content: [{ type: 'text', text: 'SetNamedSecurityInfoW failed (Win32 5) example' }] } },
          },
        },
      });
      return {
        finalResponse: 'SetNamedSecurityInfoW failed (Win32 5) and windows-acl-run exit code 127 are documented.',
        events: [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }],
      };
    }
    async close() {}
  }
  const proseJob = await startJob({
    task: 'explain acl',
    cwd: ISOLATED_HOME,
    permission: 'auto',
    _deps: {
      DeepSeekHarness: ProseMentionHarness,
      env: {},
      dotEnv: {},
      createWorktree: async () => {
        proseWtCalled = true;
        return { worktreePath: fakeWtDir, repoRoot: ISOLATED_HOME, cwd: fakeWtDir };
      },
    },
  });
  await proseJob.promise;
  assert.equal(proseWtCalled, false);
  assert.equal(proseJob.status, 'done');
  assert.equal(proseJob.worktree_path, null);

  // Verify workspace-write (non-auto) does NOT degrade on ACL failure.
  const writeLaunches = [];
  class FailingWriteHarness {
    constructor(opts) { writeLaunches.push(opts); }
    async run() { throw new Error('SetNamedSecurityInfoW failed (Win32 5)'); }
    async close() {}
  }
  const wwJob = await startJob({
    task: 'fail directly',
    cwd: ISOLATED_HOME,
    permission: 'workspace-write',
    _deps: { DeepSeekHarness: FailingWriteHarness, env: {}, dotEnv: {} },
  });
  await wwJob.promise;
  assert.equal(writeLaunches.length, 1);
  assert.equal(wwJob.status, 'failed');
  assert.equal(wwJob.worktree_path, null);
});

// ---------- 5. Hub Client & MCP Server End-to-End Wiring ----------

test('hub-client forwards permission and preset on spawn', async () => {
  let receivedBody = null;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/_dsh/dsh-crew/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'dsh-crew-hub' }));
      return;
    }
    if (req.url === '/_dsh/dsh-crew/jobs' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      receivedBody = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, job: { id: 'hub-1', status: 'running', ...receivedBody } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const client = createHubClient({
      env: { DSHPLUGIN_CREW_HUB: `http://127.0.0.1:${port}` },
      readConfig: () => ({}),
      readDiscovery: () => null,
    });
    const spawned = await client.hub.spawn({
      task: 'check',
      cwd: ISOLATED_HOME,
      permission: 'read-only',
      preset: 'auditor',
    });
    assert.equal(receivedBody.permission, 'read-only');
    assert.equal(receivedBody.preset, 'auditor');
    assert.equal(spawned.permission, 'read-only');
    assert.equal(spawned.preset, 'auditor');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('MCP server exposes permission & preset schemas and enforces ceiling/concurrent conflicts over stdio', async () => {
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: ISOLATED_HOME,
      USERPROFILE: ISOLATED_HOME,
      DSH_CREW_MAX_PERMISSION: 'read-only',
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

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  try {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'perm-test', version: '0.0.0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const listed = await request('tools/list', {});
    const tools = new Map((listed.result?.tools ?? []).map((t) => [t.name, t]));
    for (const toolName of ['dsh_run_worker', 'dsh_spawn_worker']) {
      const props = tools.get(toolName)?.inputSchema?.properties ?? {};
      assert.deepEqual(props.permission?.enum, PERMISSIONS);
      assert.equal(props.preset?.type, 'string');
    }

    // dsh_worker_config reports max_permission from DSH_CREW_MAX_PERMISSION
    await request('tools/call', { name: 'dsh_worker_config', arguments: { mode: 'standalone' } });
    const cfgRes = await request('tools/call', { name: 'dsh_worker_config', arguments: {} });
    const cfgPayload = JSON.parse(cfgRes.result.content[0].text);
    assert.equal(cfgPayload.max_permission, 'read-only');

    // Concurrent cwd + non-read-only permission is refused
    const conflictRes = await request('tools/call', {
      name: 'dsh_spawn_worker',
      arguments: { task: 'x', allow_concurrent_cwd: true, permission: 'workspace-write' },
    });
    assert.equal(conflictRes.result.isError, true);
    assert.match(conflictRes.result.content[0].text, /allow_concurrent_cwd requires permission="read-only"/);

    // Exceeding DSH_CREW_MAX_PERMISSION is refused
    const ceilingRes = await request('tools/call', {
      name: 'dsh_run_worker',
      arguments: { task: 'x', permission: 'full-access' },
    });
    assert.equal(ceilingRes.result.isError, true);
    assert.match(ceilingRes.result.content[0].text, /exceeds maxPermission "read-only"/);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('server dispatches always cap child maxPermission to perm.childMaxPermission', async () => {
  const serverSource = readFileSync(join(ROOT, 'src', 'server.mjs'), 'utf8');
  for (const needle of ['hub.spawn({', 'startJob({']) {
    const lines = serverSource.split('\n').filter((l) => l.includes(needle));
    assert.ok(lines.length >= 2, `expected at least 2 ${needle} sites`);
    assert.ok(lines.every((l) => l.includes('maxPermission: perm.childMaxPermission')), `${needle} must forward perm.childMaxPermission`);
  }

  let receivedPayload = null;
  const hubServer = http.createServer(async (req, res) => {
    if (req.url === '/_dsh/dsh-crew/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'dsh-crew-hub' }));
      return;
    }
    if (req.url === '/_dsh/dsh-crew/jobs' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      receivedPayload = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        job: {
          id: 'hub-perm-1',
          status: 'running',
          permission: receivedPayload.permission,
          effective_sandbox_mode: 'read-only',
          preset: receivedPayload.preset,
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => hubServer.listen(0, '127.0.0.1', resolve));
  const { port } = hubServer.address();
  const cleanEnv = { ...process.env, HOME: ISOLATED_HOME, USERPROFILE: ISOLATED_HOME, DSHPLUGIN_CREW_HUB: `http://127.0.0.1:${port}` };
  delete cleanEnv[MAX_PERMISSION_ENV];

  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
    cwd: ROOT,
    env: cleanEnv,
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

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  try {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'perm-cap-test', version: '0.0.0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    await request('tools/call', { name: 'dsh_worker_config', arguments: { mode: 'hub' } });
    const spawned = await request('tools/call', {
      name: 'dsh_spawn_worker',
      arguments: { task: 'read only task', cwd: ISOLATED_HOME, allow_concurrent_cwd: true },
    });
    assert.equal(spawned.result.isError, undefined);
    assert.equal(receivedPayload.permission, 'read-only');
    assert.equal(receivedPayload.maxPermission, 'read-only');
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => hubServer.close(resolve));
  }
});
