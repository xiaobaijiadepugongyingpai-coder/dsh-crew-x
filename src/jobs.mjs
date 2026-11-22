// Job manager: each job runs one dsh-jsonrpc-agent runtime via the DSH SDK.
// Progress derived from session.event notifications; status mirrored to a
// JSON file so the Claude Code statusline (and anything else) can render it.

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { createShardWriter } from './status-shard.mjs';
import { acquireCwdLock } from './cwd-lock.mjs';
import { ORIGIN_CHAIN_ENV, ORIGIN_DEPTH_ENV } from './origin-guard.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  resolveWorkerPermission,
  resolveEffectivePreset,
  detectWindowsAclFailure,
  createTempWorktree,
} from './permission-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = join(homedir(), '.config', 'dsh-crew');
const STATUS_FILE = join(CONFIG_DIR, 'status.json');
const RUNTIME_BIN = join(ROOT, 'node_modules', '.bin', 'dsh-jsonrpc-agent');
const CORDIS = join(ROOT, 'worker.cordis.yml');

export const TIERS = {
  flash: { model: 'deepseek-v4-flash', label: 'V4 Flash' },
  pro: { model: 'deepseek-v4-pro', label: 'V4 Pro' },
};

function loadDotEnv() {
  const out = {};
  try {
    for (const line of readFileSync(join(CONFIG_DIR, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[2]) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}

const jobs = new Map();
let nextId = 1;
const shard = createShardWriter('mcp');

// Job shapes now carry an execution backend: 'standalone' (DSH runtime here),
// 'cli' (external coding CLI via cli-workers.mjs — backend/profile name it),
// and hub jobs (hub/index.mjs view) keep their own mode: 'hub'. Additive only.
function backendOf(j) { return j.backend ?? 'standalone'; }
function profileOf(j) { return j.profile ?? null; }
function modeOf(j) { return j.mode ?? (j.backend ? 'cli' : 'standalone'); }

/** Bounded task preview with a visible truncation marker (PATTERN-AUDIT D3). */
function clipTask(task, cap = 300) {
  return task.length > cap ? task.slice(0, cap) + '…' : task;
}

export function publishStatus() {
  shard.publish([...jobs.values()].map((j) => ({
    id: j.id, tier: j.tier, model: j.model, provider: j.provider, effort: j.effort, status: j.status, source: j.source,
    task: clipTask(j.task), cwd: j.cwd, turn: j.turn, step: j.step, toolCalls: j.toolCalls,
    currentTool: j.currentTool, tokens: j.tokens,
    backend: backendOf(j), profile: profileOf(j), mode: modeOf(j),
    permission: j.permission ?? null,
    effective_sandbox_mode: j.effective_sandbox_mode ?? null,
    preset: j.preset ?? null,
    ...(j.permission_warning ? { permission_warning: j.permission_warning } : {}),
    ...(j.worktree_path ? { worktree_path: j.worktree_path } : {}),
    ...(j.isolation ? { isolation: j.isolation } : {}),
    ...(j.degraded_from ? { degraded_from: j.degraded_from } : {}),
    liveness: j.liveness ?? null,
    // WPC10: last CLI stream event, so the panel can say how long a stalled
    // job has been quiet (mirrors v.activity.lastEventAt used by the MCP tools).
    activityLastEventAt: j.activity?.lastEventAt ?? null,
    // WPC14: the OS process behind the job (CLI workers: detached process
    // group; standalone runtimes: the lazily-spawned dsh runtime). Hub jobs
    // publish through hub/index.mjs and carry no pid. Ghost tombstones
    // snapshot this mirror, so the pid rides into the board's ghost registry.
    pid: j.pid ?? null, pgid: j.pgid ?? null,
    origin_depth: j.origin_depth ?? null, origin_chain: j.origin_chain ?? null,
    startedAt: j.startedAt, endedAt: j.endedAt,
  })));
}

export function jobView(j, { withResult = false } = {}) {
  const v = {
    id: j.id, tier: j.tier, model: j.model, provider: j.provider, effort: j.effort, status: j.status, source: j.source,
    task: clipTask(j.task), turn: j.turn, step: j.step, currentTool: j.currentTool,
    tokens: j.tokens, toolCalls: j.toolCalls,
    backend: backendOf(j), profile: profileOf(j), mode: modeOf(j),
    cwd: j.cwd,
    permission: j.permission ?? null,
    effective_sandbox_mode: j.effective_sandbox_mode ?? null,
    preset: j.preset ?? null,
    ...(j.permission_warning ? { permission_warning: j.permission_warning } : {}),
    ...(j.worktree_path ? { worktree_path: j.worktree_path } : {}),
    ...(j.isolation ? { isolation: j.isolation } : {}),
    ...(j.degraded_from ? { degraded_from: j.degraded_from } : {}),
    // WPC14: pid (+ pgid when the worker leads its own process group) so the
    // panel can probe and kill the OS process of an orphaned ghost job.
    pid: j.pid ?? null, pgid: j.pgid ?? null,
    origin_depth: j.origin_depth ?? null, origin_chain: j.origin_chain ?? null,
    startedAt: j.startedAt, endedAt: j.endedAt,
  };
  // CLI jobs: live activity + liveness ("在动" vs "卡死") for dsh_worker_status.
  if (j.activity) {
    v.activity = {
      events: j.activity.events,
      lastEventAt: j.activity.lastEventAt,
      staleSeconds: j.activity.lastEventAt
        ? Math.round((Date.now() - Date.parse(j.activity.lastEventAt)) / 1000)
        : null,
    };
    v.liveness = j.liveness ?? null;
  }
  if (withResult) { v.result = j.result; v.error = j.error; v.stopReason = j.stopReason; }
  return v;
}

export function listJobs() { return [...jobs.values()]; }
export function getJob(id) { return jobs.get(id); }

/** Register a job created elsewhere (cli-workers.mjs) in the shared registry. */
export function registerJob(job) {
  jobs.set(job.id, job);
  publishStatus();
  return job;
}

export async function startJob({
  task,
  tier = 'flash',
  effort = 'max',
  cwd,
  maxTokens = 49_152,
  timeoutMs = 1_800_000,
  source = 'api',
  origin = null,
  allowConcurrentCwd,
  allow_concurrent_cwd,
  provider,
  model,
  permission,
  maxPermission,
  preset,
  _deps,
}) {
  const tierInfo = TIERS[tier];
  if (!tierInfo) throw new Error(`unknown tier "${tier}" (expected: ${Object.keys(TIERS).join(', ')})`);
  // The caller (the MCP server, which owns session-level config) may bind this
  // tier to a route the HOST has configured — a local model, typically. Blank
  // is not a binding: it falls back to the tier's built-in DeepSeek route
  // rather than dispatching to "". See tier-binding.mjs and issue #10.
  const dispatchProvider = typeof provider === 'string' && provider.trim() !== '' ? provider.trim() : 'deepseek-official';
  const dispatchModel = typeof model === 'string' && model.trim() !== '' ? model.trim() : tierInfo.model;
  if (!['off', 'high', 'max'].includes(effort)) throw new Error(`unknown effort "${effort}" (expected: off, high, max)`);

  const effectiveAllowConcurrent = Boolean(allowConcurrentCwd ?? allow_concurrent_cwd);
  const baseEnv = _deps?.env ?? process.env;
  const perm = resolveWorkerPermission({
    permission,
    allowConcurrentCwd: effectiveAllowConcurrent,
    maxPermission,
    env: baseEnv,
  });
  const effectivePreset = resolveEffectivePreset({ preset, tier });

  const workspace = resolve(cwd ?? process.cwd());
  const id = `job-${nextId++}-${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();

  // Cwd advisory lock FIRST: a conflicting dispatch is refused before any
  // SDK import, key check or runtime spawn can happen (and every later
  // failure path releases it — see the catch below and the run finally).
  let releaseLock = null;
  if (!effectiveAllowConcurrent) {
    releaseLock = acquireCwdLock({ cwd: workspace, jobId: id, backend: 'standalone', mode: 'standalone', startedAt }).release;
  }

  const job = {
    id, tier, model: dispatchModel, provider: dispatchProvider, effort, task, source, cwd: workspace,
    permission: perm.permission,
    effective_sandbox_mode: perm.effective_sandbox_mode,
    preset: effectivePreset,
    ...(perm.permission_warning ? { permission_warning: perm.permission_warning } : {}),
    worktree_path: null, isolation: null, degraded_from: null,
    status: 'running', turn: 0, step: 0, currentTool: null, toolCalls: 0,
    tokens: { input: 0, output: 0, reasoning: 0 },
    startedAt, endedAt: null,
    origin_depth: origin?.depth ?? null, origin_chain: origin?.chain ?? null,
    result: null, error: null, stopReason: null, harness: null,
    waiters: [], _releaseCwdLock: releaseLock,
  };

  try {
    // The DSH SDK is only needed by the standalone dispatch path, so it is
    // loaded lazily here instead of being a top-level import. The bundled MCP
    // server keeps every @deepseek-ai/* package external (see scripts/build-mcp.mjs):
    // hub mode never touches the SDK, and an installed copy without the package
    // fails on this line - with a hint - instead of dying at module load.
    let DeepSeekHarness = _deps?.DeepSeekHarness;
    if (!DeepSeekHarness) {
      try {
        ({ DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client'));
      } catch (err) {
        if (err?.code === 'ERR_MODULE_NOT_FOUND') {
          const hint = new Error(`@deepseek-ai/dsh-sdk-client not installed; standalone dispatch requires it - run pnpm install in ${ROOT}, or use hub mode (dsh_worker_config mode=hub) so jobs run inside a DSH instance`);
          hint.code = 'ERR_MODULE_NOT_FOUND';
          throw hint;
        }
        throw err;
      }

      if (!existsSync(RUNTIME_BIN)) throw new Error(`dsh-jsonrpc-agent not installed at ${RUNTIME_BIN}; run pnpm install in ${ROOT}`);
    }

    const dotEnv = _deps?.dotEnv ?? loadDotEnv();
    if (!_deps?.DeepSeekHarness && !baseEnv.DEEPSEEK_API_KEY && !dotEnv.DEEPSEEK_API_KEY) {
      throw new Error(`DEEPSEEK_API_KEY not found in env or ${join(CONFIG_DIR, '.env')}`);
    }

    const createHarnessForCwd = (targetCwd) => new DeepSeekHarness({
      launch: {
        command: RUNTIME_BIN,
        args: [CORDIS],
        cwd: targetCwd,
        env: {
          ...baseEnv,
          ...dotEnv,
          DSH_CWD: targetCwd,
          DSH_SESSION_ROOT: join(CONFIG_DIR, 'sessions'),
          DSH_REASONING_EFFORT: effort,
          DSH_SANDBOX_MODE: perm.effective_sandbox_mode,
          DSH_CREW_MAX_PERMISSION: perm.childMaxPermission,
          // Origin guard: the worker runtime inherits the dispatch chain, so a
          // crew instance it starts itself continues the chain (WPC9).
          ...(origin ? { [ORIGIN_CHAIN_ENV]: JSON.stringify(origin.chain), [ORIGIN_DEPTH_ENV]: String(origin.depth) } : {}),
        },
        requestTimeoutMs: timeoutMs,
      },
      cwd: targetCwd,
      provider: dispatchProvider,
      model: dispatchModel,
      maxTokens,
    });

    const runAttempt = async (targetCwd, sessionId, allowAutoDegrade) => {
      const attemptHarness = createHarnessForCwd(targetCwd);
      job.harness = attemptHarness;
      let attemptActive = true;
      let aclDetected = false;

      const onNotification = (n) => {
        if (!attemptActive) return;
        // WPC14: the standalone runtime process exists once the run has started
        // (the SDK client spawns it lazily). Capture its pid on the first
        // notification so views, shard mirrors and ghost tombstones carry it —
        // and track it while running, since a failed handshake makes the SDK
        // swap in a fresh client (new subprocess).
        if (job.status === 'running') {
          const child = attemptHarness.client?.child;
          if (child?.pid && job.pid !== child.pid) { job.pid = child.pid; publishStatus(); }
        }
        if (n.method === 'session.status') return;
        if (n.method !== 'session.event') return;
        if (n.params?.sessionId && n.params.sessionId !== sessionId) return;
        const e = n.params.event;
        if (!e?.type) return;
        switch (e.type) {
          case 'step/start': job.turn = e.data?.turn ?? job.turn; job.step = e.data?.step ?? job.step; break;
          case 'tool/call': job.currentTool = e.data?.name ?? null; job.toolCalls += 1; break;
          case 'tool/result':
            if (detectWindowsAclFailure(e)) aclDetected = true;
            job.currentTool = null;
            break;
          case 'assistant/message': {
            const u = e.data?.usage;
            if (u) {
              job.tokens.input += u.inputTokens ?? 0;
              job.tokens.output += u.outputTokens ?? 0;
              job.tokens.reasoning += u.reasoningTokens ?? 0;
            }
            break;
          }
          case 'turn/end':
            if (detectWindowsAclFailure(e.data?.reason)) aclDetected = true;
            job.stopReason = e.data?.reason?.kind ?? null;
            break;
        }
        publishStatus();
      };

      try {
        const result = await attemptHarness.run(task, { sessionId, onNotification });
        attemptActive = false;
        const aclEvents = (result?.events ?? [])
          .filter((ev) => ev?.type === 'tool/result' || ev?.type === 'turn/end')
          .map((ev) => (ev.type === 'turn/end' ? ev.data?.reason : ev));
        if (detectWindowsAclFailure(aclEvents)) aclDetected = true;
        if (job.status !== 'cancelled' && allowAutoDegrade && perm.permission === 'auto' && aclDetected) {
          return { aclFailed: true, detail: null };
        }
        if (job.status === 'cancelled') return { aclFailed: false };
        job.result = result.finalResponse ?? '';
        const lastEnd = [...(result.events ?? [])].reverse().find((ev) => ev?.type === 'turn/end');
        job.stopReason = lastEnd?.data?.reason?.kind ?? job.stopReason;
        job.status = job.stopReason === 'completed' ? 'done' : 'failed';
        if (job.status === 'failed' && !job.error) job.error = `turn ended with reason: ${job.stopReason ?? 'unknown'}`;
        return { aclFailed: false };
      } catch (err) {
        attemptActive = false;
        if (detectWindowsAclFailure(err)) aclDetected = true;
        if (job.status !== 'cancelled' && allowAutoDegrade && perm.permission === 'auto' && aclDetected) {
          return { aclFailed: true, detail: err?.message ?? String(err) };
        }
        throw err;
      } finally {
        try { await attemptHarness.close(); } catch {}
      }
    };

    jobs.set(id, job);
    job.promise = (async () => {
      const first = await runAttempt(workspace, id, true);
      if (first.aclFailed && job.status !== 'cancelled') {
        const worktreeFn = _deps?.createWorktree ?? createTempWorktree;
        let wt;
        try {
          wt = await worktreeFn({ cwd: workspace, jobId: id });
        } catch (wtErr) {
          const prefix = first.detail ? `${first.detail}; ` : '';
          throw new Error(`${prefix}${wtErr?.message ?? wtErr}`, { cause: wtErr });
        }
        if (job.status === 'cancelled') return;
        const attemptCwd = wt?.cwd ?? wt?.worktreePath;
        if (!attemptCwd) throw new Error('auto worktree fallback failed: missing worktree cwd');
        job.worktree_path = wt.worktreePath;
        job.isolation = 'git-worktree';
        job.degraded_from = perm.effective_sandbox_mode;
        job.status = 'running';
        job.pid = null;
        job.turn = 0;
        job.step = 0;
        job.toolCalls = 0;
        job.tokens = { input: 0, output: 0, reasoning: 0 };
        job.error = null;
        job.result = null;
        job.stopReason = null;
        job.currentTool = null;
        publishStatus();
        await runAttempt(attemptCwd, `${id}-wt`, false);
      }
    })()
      .catch((err) => {
        job.status = job.status === 'cancelled' ? 'cancelled' : 'failed';
        job.error = err?.message ?? String(err);
      })
      .finally(() => {
        job.endedAt = new Date().toISOString();
        job.currentTool = null;
        // Release the cwd lock on EVERY terminal path: done, failed,
        // cancelled, request-timeout (harness rejects) all land here.
        job._releaseCwdLock?.();
        job._releaseCwdLock = null;
        publishStatus();
        for (const w of job.waiters.splice(0)) w();
      });
  } catch (err) {
    // Failed start (SDK missing, no API key, spawn error, ...): settle the
    // record and free the lock so the cwd never stays locked.
    job.status = 'failed';
    job.error = err?.message ?? String(err);
    job.endedAt = new Date().toISOString();
    job._releaseCwdLock?.();
    job._releaseCwdLock = null;
    publishStatus();
    throw err;
  }

  publishStatus();
  return job;
}

export async function waitJob(id, timeoutMs) {
  const job = jobs.get(id);
  if (!job) throw new Error(`no such job: ${id}`);
  if (job.status !== 'running') return job;
  let timer;
  await Promise.race([
    new Promise((res) => job.waiters.push(res)),
    timeoutMs ? new Promise((res) => { timer = setTimeout(res, timeoutMs); }) : new Promise(() => {}),
  ]);
  // The losing branch's timer would otherwise pin the event loop for its full
  // remaining duration and delay server exit after a job settles.
  if (timer) clearTimeout(timer);
  return job;
}

export async function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) throw new Error(`no such job: ${id}`);
  if (job.status !== 'running') return job;
  job.status = 'cancelled';
  job.error = 'cancelled by request';
  try { await job.harness?.close(); } catch {}
  publishStatus();
  return job;
}
