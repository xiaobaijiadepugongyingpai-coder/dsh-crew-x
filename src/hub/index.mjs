// DSH host plugin: workers-hub.
// Runs DeepSeek workers as first-class in-host agent sessions (visible in the
// Web UI session list), exposes a loopback jobs API for the CC/Codex MCP shim,
// and serves the one-click installer endpoints for the settings page.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isAbsoluteCwd, canonicalCwd } from '../paths.mjs';
import { createShardWriter, readMergedStatus } from '../status-shard.mjs';
import { procAlive, killWorkerProcess, parsePid, ProcKillRefused } from '../proc-kill.mjs';
import { installWorkerQuestionHandoff } from '../worker-question.mjs';
import { probeProvider } from '../provider-probe.mjs';
import { listProviderCatalog } from '../provider-catalog.mjs';
import {
  normalizeLoopbackHubUrl,
  writeHubDiscovery,
  removeHubDiscoveryIfOwned,
  extractWebServerUrl,
  extractRequestLoopbackUrl,
} from '../hub-discovery.mjs';
import {
  resolveWorkerPermission,
  resolveEffectivePreset,
  detectWindowsAclFailure,
  createTempWorktree,
  detectPersistedWorktree,
  writeWorktreeMarker,
} from '../permission-policy.mjs';
import {
  HubRequestError,
  createPersistentSessionRecord,
  resolvePersistedSessionPreset,
  summarizePersistentSession,
  validateSessionTurnBinding,
} from './persistent-sessions.mjs';

// Persistent-session pool limits. The tombstone table is bounded so a
// long-lived hub cannot grow without limit, while still remembering every
// recently closed id (a closed session must never be revived, not even by the
// Hub-restart resume path).
const CLOSED_SESSIONS_LIMIT = 1000;
const DEFAULT_REAPER_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
const MAX_IDLE_TIMEOUT_MINUTES = 1440;

// How long ONE persistent turn may stay `running` before the hub gives the
// session back. Without this, an agent/tool/worktree that never settles leaves
// `rec.status === 'running'` forever: the idle reaper skips running sessions by
// design, so every later turn on that session would be 409 SESSION_BUSY until
// someone cancelled the job, closed the session, or restarted the hub.
//
// This value is the FALLBACK for a caller that names no budget at all (a direct
// API caller, or an MCP layer too old to send one). The watchdog must never cut
// a legitimate long turn short: the MCP layer's `timeout_seconds` accepts up to
// 7200 s, so `src/server.mjs` derives a `turnTimeoutMs` from it (its own deadline
// plus a margin, i.e. the watchdog always fires AFTER the caller would have given
// up) and sends it on every persistent dispatch. The watchdog exists to reclaim
// a hung turn, not to enforce the caller's deadline.
//
// The fallback therefore covers the LARGEST caller budget the documented API
// allows, plus the same margin rule src/server.mjs uses (max(120 s, 10 %)), so a
// silent caller can never be killed earlier than an explicit 2 h one would be.
// A wedged session still recovers on its own — just not at the cost of a healthy
// long turn. `0` or negative disables the watchdog entirely.
const MAX_CALLER_TURN_BUDGET_MS = 7_200_000;
const DEFAULT_PERSISTENT_TURN_TIMEOUT_MS = MAX_CALLER_TURN_BUDGET_MS + Math.max(120_000, MAX_CALLER_TURN_BUDGET_MS / 10);

// Ceiling for a caller-supplied watchdog budget. `setTimeout` stores its delay
// in a 32-bit signed int: anything above 2^31-1 ms OVERFLOWS and fires
// IMMEDIATELY, which would fail a healthy turn instead of waiting for it. 24 h
// is far beyond any real turn and safely inside that range, so a garbage value
// is clamped here rather than detonating the watchdog.
const MAX_PERSISTENT_TURN_TIMEOUT_MS = 86_400_000;

/**
 * Resolve the watchdog budget from named candidates, in priority order.
 *
 * Only an explicit, numeric 0/negative value DISABLES the watchdog. A value that
 * is present but unusable (a typo in config, a blank string, a NaN from a bad
 * conversion) falls THROUGH to the next candidate instead of silently switching
 * the watchdog off: a hub with a broken setting must still be able to reclaim a
 * wedged session. A finite positive value is clamped to
 * MAX_PERSISTENT_TURN_TIMEOUT_MS.
 *
 * Returns `{ ms, source }`; `ms <= 0` means "disabled".
 */
function resolveTurnTimeoutMs(candidates) {
  for (const { value, source } of candidates) {
    if (value === undefined || value === null) continue;
    // A blank string means "not configured", not "0 ms".
    if (typeof value === 'string' && value.trim() === '') continue;
    const ms = Number(value);
    if (!Number.isFinite(ms)) continue;
    if (ms <= 0) return { ms, source };
    return { ms: Math.min(ms, MAX_PERSISTENT_TURN_TIMEOUT_MS), source };
  }
  return { ms: DEFAULT_PERSISTENT_TURN_TIMEOUT_MS, source: 'default' };
}

/** True when `value` is a non-blank string. */
function nonBlank(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The number of settled turns a persisted session log recorded. */
function countSettledTurns(session) {
  const events = Array.isArray(session?.events) ? session.events : [];
  let turns = 0;
  for (const event of events) if (event?.type === 'turn/end') turns += 1;
  return turns;
}

/**
 * Fold one session event into a turn job's counters.
 *
 * Shared by the one-shot and persistent runners so the two views report the
 * same turn/step/tool/token numbers; `markAcl` records a Windows ACL failure
 * for the auto-worktree degradation decision.
 */
function applyJobEvent(job, event, markAcl) {
  switch (event?.type) {
    case 'step/start':
      job.turn = event.data?.turn ?? job.turn;
      job.step = event.data?.step ?? job.step;
      break;
    case 'tool/call': job.currentTool = event.data?.name ?? null; job.toolCalls += 1; break;
    case 'tool/result':
      if (detectWindowsAclFailure(event)) markAcl();
      job.currentTool = null;
      break;
    case 'assistant/message': {
      const u = event.data?.usage;
      if (u) {
        job.tokens.input += u.inputTokens ?? 0;
        job.tokens.output += u.outputTokens ?? 0;
        job.tokens.reasoning += u.reasoningTokens ?? 0;
      }
      const text = (event.data?.message?.content ?? [])
        .filter((c) => c?.type === 'text').map((c) => c.text).join('');
      if (text) job.texts.push(text);
      break;
    }
    case 'turn/end':
      if (detectWindowsAclFailure(event.data?.reason)) markAcl();
      job.stopReason = event.data?.reason?.kind ?? null;
      job.reasonDetail = event.data?.reason;
      break;
  }
}

// No @deepseek-ai imports here on purpose: this plugin is loaded into the
// profile realm, and importing our own package copies would create duplicate
// module realms (symbol identity mismatches in the tool runtime). Everything
// below is either plain data or inlined logic that only touches ctx APIs.

/** Inlined from @deepseek-ai/dsh-agent model-selection.ts (same semantics). */
function installModelSelection(agentCtx, selection) {
  agentCtx.on('system-prompt/assemble', async (_assembly, _cause, next) => {
    const selected = selection.current;
    const assembled = await next();
    selection.assembled = selected;
    if (selected === undefined) return assembled;
    return { ...assembled, variables: { ...assembled.variables, provider: selected.provider, model: selected.model } };
  });
  agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next();
    const selected = selection.assembled;
    if (selected === undefined) return resolved;
    const { reasoningEffort: _inherited, ...rest } = resolved;
    return {
      ...rest, provider: selected.provider, model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    };
  });
}

/** Inlined shape of createUserMessage (role + fresh id, frozen). */
function userMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
}

/**
 * The rejection a worker's ask_user_question receives. Shaped like the host's
 * UserQuestionError (name + code) so the seam restores it as one and the
 * model sees the message, the same way the host answers a question from a
 * child agent that has no human either (DELEGATED_CALLER).
 */
export function unattendedQuestion() {
  const error = new Error(
    'no one is attending this dsh-crew worker session, so a question cannot be answered and must not be waited on. '
    + 'Stop and put the unresolved question in your final message so the orchestrator can obtain the required answer or approval. '
    + 'An unanswered question grants no permission; never select an option automatically.',
  );
  error.name = 'UserQuestionError';
  error.code = 'UNATTENDED_WORKER';
  return error;
}

export const name = 'dsh-crew';
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'tools', 'llm', 'attachments'];

// Optional: the host's durable locale preference seeds server-side strings
// before the panel is ever opened. Absent preference means "browser decides".
function seedLangFromHost(ctx) {
  try {
    const pref = ctx.settings?.get?.('locale')?.preference;
    if (pref) setLang(pref);
  } catch { /* settings service absent or shaped differently — keep the default */ }
}

import { setLang } from '../i18n.mjs';

const ROUTE_BASE = '/_dsh/dsh-crew';
// Tier -> {provider, model}. The defaults live in tier-binding.mjs; the
// caller may override per dispatch, and the hub's own config is the fallback
// when it does not (the same shape the preset lookup below uses).
import { describeBindings, resolveTierBinding, TIERS } from '../tier-binding.mjs';
const CONFIG_DIR = join(homedir(), '.config', 'dsh-crew');

// ---------- job registry ----------

/** Bounded task preview with a visible truncation marker (PATTERN-AUDIT D3:
// a silently truncated task reads like the whole brief in status views). */
function clipTask(task, cap = 300) {
  return task.length > cap ? task.slice(0, cap) + '…' : task;
}

export class WorkerRegistry {
  constructor(ctx, shard = createShardWriter('hub'), options = {}) {
    this.ctx = ctx;
    this.jobs = new Map();
    this.nextId = 1;
    this.shard = shard;
    // Persistent session pool (opt-in). `closedSessions` is a tombstone table:
    // a closed id must stay closed, so a later turn cannot silently revive it
    // through the Hub-restart resume path.
    this.persistentSessions = new Map();
    this.closedSessions = new Map();
    // Single-flight registry for Hub-restart recovery: two turns arriving for
    // the same unknown id must share ONE resume, not race two.
    this.resumeInFlight = new Map();
    // The interval is a live knob: setting `registry.reaperIntervalMs = 0`
    // disables reaping even when the timer was armed (tests drive
    // reapIdleSessions(now) themselves). It can also be pre-set on the
    // prototype/subclass, or injected as a constructor option.
    const configuredReaper = options.reaperIntervalMs ?? this.reaperIntervalMs;
    this.reaperIntervalMs = configuredReaper === undefined ? DEFAULT_REAPER_INTERVAL_MS : Number(configuredReaper);
    this.reaperTimer = null;
    if (Number.isFinite(this.reaperIntervalMs) && this.reaperIntervalMs > 0) {
      this.reaperTimer = setInterval(() => {
        if (!(this.reaperIntervalMs > 0)) return;
        try { this.reapIdleSessions(); } catch (err) {
          this.ctx?.logger?.warn?.(`dsh-crew: idle session reaper failed: ${err?.message ?? err}`);
        }
      }, this.reaperIntervalMs);
      // Never hold the process open for a reaper.
      this.reaperTimer.unref?.();
    }
  }

  view(job, withResult = false) {
    const v = {
      id: job.id, sessionId: job.sessionId, tier: job.tier, model: job.model, provider: job.provider,
      effort: job.effort, status: job.status, source: job.source, task: clipTask(job.task),
      cwd: job.cwd, turn: job.turn, step: job.step, currentTool: job.currentTool,
      toolCalls: job.toolCalls, tokens: job.tokens, mode: 'hub',
      permission: job.permission ?? null,
      effective_sandbox_mode: job.effective_sandbox_mode ?? null,
      preset: job.preset ?? null,
      ...(job.permission_warning ? { permission_warning: job.permission_warning } : {}),
      ...(job.worktree_path ? { worktree_path: job.worktree_path } : {}),
      ...(job.isolation ? { isolation: job.isolation } : {}),
      ...(job.degraded_from ? { degraded_from: job.degraded_from } : {}),
      startedAt: job.startedAt, endedAt: job.endedAt,
      ...(job.questions === undefined ? {} : { questions: job.questions }),
      persistent: Boolean(job.persistent),
      turnIndex: job.turnIndex ?? null,
    };
    if (withResult) {
      v.result = job.result; v.error = job.error; v.stopReason = job.stopReason;
      v.reasonDetail = job.reasonDetail;
    }
    return v;
  }

  publish() {
    this.shard.publish([...this.jobs.values()].map((j) => this.view(j)));
  }

  /**
   * Dispatch one unit of work.
   *
   * `sessionId` resumes a persistent session (a later turn); `persistent: true`
   * opens a new persistent session and runs its first turn; anything else is
   * the original one-shot job, unchanged.
   */
  async spawn(spec = {}) {
    const sessionId = nonBlank(spec?.sessionId);
    if (sessionId !== null) return this.spawnPersistentTurn({ ...spec, sessionId });
    if (spec?.persistent === true) return this.spawnPersistentSession(spec);
    return this.spawnOneShot(spec);
  }

  async spawnOneShot({
    task,
    tier = 'flash',
    effort = 'max',
    cwd,
    source = 'api',
    provider,
    model,
    preset,
    permission,
    allowConcurrentCwd,
    allow_concurrent_cwd,
    maxPermission,
    max_permission,
    createWorktree,
  }) {
    if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}"`);
    // An explicit {provider, model} from the caller wins (the MCP process owns
    // session-level overrides, exactly as it does for presets); otherwise the
    // hub's own stored config decides, and failing that the tier default.
    const cfg = this.getConfig?.() ?? {};
    const bound = resolveTierBinding(tier, cfg);
    const resolvedProvider = typeof provider === 'string' && provider.trim() !== '' ? provider.trim() : bound.provider;
    const resolvedModel = typeof model === 'string' && model.trim() !== '' ? model.trim() : bound.model;
    if (!['off', 'high', 'max'].includes(effort)) throw new Error(`unknown effort "${effort}"`);
    // Validate permission & ceiling before touching cwd, loader, or sessions.
    const perm = resolveWorkerPermission({
      permission,
      allowConcurrentCwd: Boolean(allowConcurrentCwd ?? allow_concurrent_cwd),
      maxPermission: maxPermission ?? max_permission,
    });
    // Accept POSIX, Windows drive (D:\x, C:/x) and UNC (\\srv\share) roots.
    if (!isAbsoluteCwd(cwd)) throw new Error('cwd must be an absolute path');
    // One canonical form for the job, the advisory lock and the workspace
    // lookup: D:/x and D:\x must map to the same workspace on Windows.
    const cwdPath = canonicalCwd(cwd);
    await this.ctx.get('loader')?.await();

    const id = `hub-${this.nextId++}-${Date.now().toString(36)}`;
    const sessionId = `session-${randomUUID()}`;
    const selection = { provider: resolvedProvider, model: resolvedModel, reasoningEffort: effort };
    const presets = this.ctx.get('agentPresets');
    const wanted = resolveEffectivePreset({ preset, tier, config: cfg });
    const presetId = presets === undefined
      ? undefined
      : (await presets.resolve(!wanted || wanted === 'default' ? undefined : wanted)).id;
    const effectivePreset = presetId ?? wanted;

    const job = {
      id, sessionId, tier, model: resolvedModel, provider: resolvedProvider, effort, task, source, cwd: cwdPath,
      permission: perm.permission,
      effective_sandbox_mode: perm.effective_sandbox_mode,
      preset: effectivePreset,
      ...(perm.permission_warning ? { permission_warning: perm.permission_warning } : {}),
      worktree_path: null, isolation: null, degraded_from: null,
      status: 'running', turn: 0, step: 0, currentTool: null, toolCalls: 0,
      tokens: { input: 0, output: 0, reasoning: 0 },
      startedAt: new Date().toISOString(), endedAt: null,
      result: null, error: null, stopReason: null, handle: null, waiters: [],
      texts: [],
    };
    this.jobs.set(id, job);

    const runAttempt = async (attemptCwd, attemptSessionId, allowAutoDegrade) => {
      let attemptActive = true;
      let aclDetected = false;
      let handle = null;

      const onEvent = (session, event) => {
        if (!attemptActive) return;
        applyJobEvent(job, event, () => { aclDetected = true; });
        this.publish();
      };

      try {
        handle = await this.ctx.agents.create({
          sessionId: attemptSessionId,
          meta: { cwd: attemptCwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
          agentOptions: {
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          },
          setup: async (agentCtx) => {
            installModelSelection(agentCtx, { current: selection, assembled: undefined });
            if (presets !== undefined) await presets.mount(agentCtx, presetId);
            // Nobody attends a worker session, so a question would wait forever
            // (#13). Claim this agent's requests ahead of the Web answerer.
            installWorkerQuestionHandoff(agentCtx, job, () => this.publish());
            agentCtx.on('session/event', onEvent);
            agentCtx.on('agent/error', (payload) => {
              if (!attemptActive) return;
              const err = payload?.error;
              if (detectWindowsAclFailure(err)) aclDetected = true;
              if (job.status !== 'needs_input') job.error = err?.message ?? String(err);
            });
          },
        });
        job.handle = handle;
        if (job.status === 'needs_input' || job.status === 'cancelled') {
          await handle.dispose();
          return { aclFailed: false };
        }
        try {
          // Group the worker session under the workspace of its cwd; create the
          // workspace when none exists yet (resolveByPath is exact-match, so a
          // job cwd never inherits a parent directory's workspace).
          const registry = this.ctx.get('workspaceRegistry');
          if (registry !== undefined) {
            const ws = (await registry.resolveByPath(attemptCwd)) ?? (await registry.create(attemptCwd));
            await ws.attachSession(attemptSessionId);
          }
        } catch (err) {
          this.ctx.logger?.warn?.(`dsh-crew: workspace attach failed for ${attemptCwd}: ${err?.message ?? err}`);
        }
        await handle.agent.whenIdle();
        if (typeof handle?.agent?.session?.append !== 'function') {
          throw new Error('agent session does not support sandbox/mode append');
        }
        await handle.agent.session.append('sandbox/mode', { mode: perm.effective_sandbox_mode });
        handle.agent.followup(userMessage(task));
        await handle.agent.whenIdle();
        if (job.status !== 'needs_input' && job.status !== 'cancelled') {
          job.result = job.texts.at(-1) ?? '';
          job.status = job.stopReason === 'completed' ? 'done' : 'failed';
        }
        if (job.status === 'failed' && !job.error) job.error = `turn ended: ${job.stopReason ?? 'unknown'}`;
        await this.ctx.sessions.flush(handle.agent.session);
      } catch (err) {
        attemptActive = false;
        if (detectWindowsAclFailure(err)) aclDetected = true;
        const isAcl = aclDetected || detectWindowsAclFailure([job.error, job.reasonDetail]);
        try { await handle?.dispose(); } catch {}
        job.handle = null;
        if (job.status === 'cancelled') return { aclFailed: false };
        if (allowAutoDegrade && perm.permission === 'auto' && isAcl) {
          return { aclFailed: true };
        }
        throw err;
      }

      attemptActive = false;
      const isAcl = aclDetected || detectWindowsAclFailure([job.error, job.reasonDetail]);
      if (job.status !== 'cancelled' && job.status !== 'needs_input' && allowAutoDegrade && perm.permission === 'auto' && isAcl) {
        try { await handle?.dispose(); } catch {}
        job.handle = null;
        return { aclFailed: true };
      }
      return { aclFailed: false };
    };

    const run = async () => {
      const first = await runAttempt(cwdPath, sessionId, true);
      if (first.aclFailed && job.status !== 'cancelled') {
        const firstAclError = job.error;
        const worktreeFn = createWorktree ?? this.createWorktree ?? createTempWorktree;
        let wt;
        try {
          wt = await worktreeFn({ cwd: cwdPath, jobId: id });
        } catch (wtErr) {
          job.status = 'failed';
          job.error = firstAclError ? `${firstAclError}; ${wtErr?.message ?? wtErr}` : (wtErr?.message ?? String(wtErr));
          return;
        }
        if (job.status === 'cancelled') return;
        const attemptCwd = wt?.cwd ?? wt?.worktreePath;
        if (!attemptCwd) {
          job.status = 'failed';
          job.error = 'auto worktree fallback failed: missing worktree cwd';
          return;
        }
        const retrySessionId = `session-${randomUUID()}`;
        job.sessionId = retrySessionId;
        job.worktree_path = wt.worktreePath;
        job.isolation = 'git-worktree';
        job.degraded_from = perm.effective_sandbox_mode;
        job.status = 'running';
        job.turn = 0;
        job.step = 0;
        job.toolCalls = 0;
        job.tokens = { input: 0, output: 0, reasoning: 0 };
        job.error = null;
        job.result = null;
        job.stopReason = null;
        job.reasonDetail = undefined;
        job.currentTool = null;
        job.texts = [];
        this.publish();
        await runAttempt(attemptCwd, retrySessionId, false);
      }
    };

    job.promise = run()
      .catch((err) => {
        if (job.status === 'running') job.status = 'failed';
        job.error = job.error ?? (err?.message ?? String(err));
      })
      .finally(async () => {
        job.endedAt = new Date().toISOString();
        job.currentTool = null;
        this.publish();
        for (const w of job.waiters.splice(0)) w();
        // One-shot jobs own their runtime for exactly one turn: the session has
        // been flushed above, so the handle must not outlive the job (it used to
        // leak one live agent per dispatch). Persistent turns keep theirs.
        if (job.persistent !== true) {
          try { await job.handle?.dispose(); } catch {}
          job.handle = null;
        }
      });

    this.publish();
    return job;
  }

  async wait(id, timeoutMs) {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status !== 'running') return job;
    await Promise.race([
      new Promise((res) => job.waiters.push(res)),
      timeoutMs > 0 ? new Promise((res) => setTimeout(res, timeoutMs)) : Promise.resolve(),
    ]);
    return job;
  }

  // ---------- persistent sessions (opt-in) ----------
  //
  // A persistent session is ONE reusable DSH agent/session that several turns
  // run on, so a forwarded subagent keeps its conversation and tool context
  // instead of paying for a cold context every dispatch. The record keeps the
  // caller-facing identity (sessionId + the cwd it was created in) apart from
  // the runtime it currently runs on (dshSessionId + effectiveCwd), which is
  // what lets an `auto` Windows ACL failure move the runtime onto a temporary
  // git worktree while later turns keep passing the original session_id/cwd.

  /** The {provider, model, reasoningEffort} agent options for one record. */
  agentOptionsFor(rec) {
    const current = rec?.selectionRef?.current ?? {};
    return {
      ...(current.provider === undefined ? {} : { provider: current.provider }),
      ...(current.model === undefined ? {} : { model: current.model }),
      ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }),
    };
  }

  /**
   * Turn-event listeners live on the agent for the WHOLE session (it outlives
   * one turn), so they forward into whatever turn is active right now and
   * ignore events once that turn settled. ACL detection is recorded on the turn
   * job, because the degradation decision is per turn.
   */
  installRecordEventListeners(rec, agentCtx) {
    agentCtx.on('session/event', (_session, event) => {
      const job = rec.activeJob;
      if (job === null || job === undefined || job.status !== 'running') return;
      applyJobEvent(job, event, () => { job.aclDetected = true; });
      this.publish();
    });
    agentCtx.on('agent/error', (payload) => {
      const job = rec.activeJob;
      if (job === null || job === undefined || job.status !== 'running') return;
      const err = payload?.error;
      if (detectWindowsAclFailure(err)) job.aclDetected = true;
      if (job.status !== 'needs_input') job.error = err?.message ?? String(err);
    });
  }

  /** Open a fresh runtime for a record (first turn, recovery, or re-created after degradation). */
  async openAgentHandle(rec, { attemptCwd, attemptSessionId, presetId, turnJob }) {
    const handle = await this.ctx.agents.create({
      sessionId: attemptSessionId,
      meta: { cwd: attemptCwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
      agentOptions: this.agentOptionsFor(rec),
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, rec.selectionRef);
        const presets = this.ctx.get('agentPresets');
        if (presets !== undefined) await presets.mount(agentCtx, presetId);
        // Nobody attends a worker session, so a question would wait forever
        // (#13). A persistent session outlives one turn, so the handoff follows
        // the record's currently active job instead of this turn's job object.
        const job = () => rec.activeJob;
        installWorkerQuestionHandoff(agentCtx, job, () => this.publish());
        this.installRecordEventListeners(rec, agentCtx);
      },
    });
    rec.handle = handle;
    turnJob.handle = handle;
    return handle;
  }

  /**
   * Run exactly ONE turn on the record's runtime.
   *
   * `reuseHandle` is false only when this turn must build a runtime (first
   * turn, post-restart recovery, or the retry after an ACL degradation).
   * Returns `{ aclFailed }` instead of throwing when the turn hit a Windows ACL
   * failure in `auto` mode and may still be retried elsewhere.
   */
  async runPersistentAttempt(rec, job, {
    attemptCwd, attemptSessionId, presetId, perm, allowDegrade, reuseHandle, task,
  }) {
    let handle = reuseHandle ? rec.handle : null;
    try {
      if (handle === null) {
        handle = await this.openAgentHandle(rec, { attemptCwd, attemptSessionId, presetId, turnJob: job });
      } else {
        job.handle = handle;
      }
      if (job.status === 'needs_input' || job.status === 'cancelled') return { aclFailed: false };
      try {
        // Group the worker session under the workspace of its cwd, exactly as
        // the one-shot path does, so a persistent worker stays visible there.
        const registry = this.ctx.get('workspaceRegistry');
        if (registry !== undefined) {
          const ws = (await registry.resolveByPath(attemptCwd)) ?? (await registry.create(attemptCwd));
          await ws.attachSession(attemptSessionId);
        }
      } catch (err) {
        this.ctx.logger?.warn?.(`dsh-crew: workspace attach failed for ${attemptCwd}: ${err?.message ?? err}`);
      }
      await handle.agent.whenIdle();
      if (typeof handle?.agent?.session?.append !== 'function') {
        throw new Error('agent session does not support sandbox/mode append');
      }
      // Sandbox level is a per-turn choice on a persistent session: append the
      // new mode before the followup so this turn runs under it.
      await handle.agent.session.append('sandbox/mode', { mode: perm.effective_sandbox_mode });
      job.permission = perm.permission;
      job.effective_sandbox_mode = perm.effective_sandbox_mode;
      handle.agent.followup(userMessage(task));
      await handle.agent.whenIdle();
      if (job.status !== 'needs_input' && job.status !== 'cancelled') {
        job.result = job.texts.at(-1) ?? '';
        job.status = job.stopReason === 'completed' ? 'done' : 'failed';
      }
      if (job.status === 'failed' && !job.error) job.error = `turn ended: ${job.stopReason ?? 'unknown'}`;
      await this.ctx.sessions.flush(handle.agent.session);
    } catch (err) {
      if (detectWindowsAclFailure(err)) job.aclDetected = true;
      const isAcl = job.aclDetected === true || detectWindowsAclFailure([job.error, job.reasonDetail, err]);
      if (job.status === 'cancelled') return { aclFailed: false };
      if (allowDegrade && perm.permission === 'auto' && isAcl) {
        // The caller rebuilds this turn on a worktree, so this runtime is done.
        try { await handle?.dispose(); } catch {}
        if (rec.handle === handle) rec.handle = null;
        job.handle = null;
        return { aclFailed: true };
      }
      if (!reuseHandle) {
        try { await handle?.dispose(); } catch {}
        if (rec.handle === handle) rec.handle = null;
        job.handle = null;
      }
      throw err;
    }

    const isAcl = job.aclDetected === true || detectWindowsAclFailure([job.error, job.reasonDetail]);
    if (job.status !== 'cancelled' && job.status !== 'needs_input' && allowDegrade && perm.permission === 'auto' && isAcl) {
      try { await handle?.dispose(); } catch {}
      if (rec.handle === handle) rec.handle = null;
      job.handle = null;
      return { aclFailed: true };
    }
    return { aclFailed: false };
  }

  /**
   * Create a turn job on a record and start running it.
   *
   * Dynamic switching happens here, before the turn runs: tier/effort move the
   * record's `selectionRef.current` (the model-selection hooks read it per
   * request) and the sandbox mode is re-appended by the attempt itself.
   */
  startPersistentTurn(rec, spec) {
    const cfg = this.getConfig?.() ?? {};
    const tier = nonBlank(spec.tier) ?? rec.tier ?? 'flash';
    if (!TIERS.includes(tier)) {
      throw new HubRequestError(`unknown tier ${JSON.stringify(tier)}`, { status: 400, code: 'INVALID_TIER' });
    }
    const bound = resolveTierBinding(tier, cfg);
    const provider = nonBlank(spec.provider) ?? bound.provider;
    const model = nonBlank(spec.model) ?? bound.model;
    const effort = nonBlank(spec.effort) ?? rec.selectionRef?.current?.reasoningEffort ?? 'max';
    if (!['off', 'high', 'max'].includes(effort)) {
      throw new HubRequestError(`unknown effort ${JSON.stringify(effort)}`, { status: 400, code: 'INVALID_EFFORT' });
    }
    const perm = resolveWorkerPermission({
      permission: nonBlank(spec.permission) ?? rec.permission,
      allowConcurrentCwd: Boolean(spec.allowConcurrentCwd ?? spec.allow_concurrent_cwd),
      maxPermission: spec.maxPermission ?? spec.max_permission,
    });
    const task = typeof spec.task === 'string' ? spec.task : '';
    if (task.trim() === '') throw new HubRequestError('task is required', { status: 400, code: 'INVALID_PERSISTENT_ARGS' });
    const source = nonBlank(spec.source) ?? 'api';

    rec.selectionRef.current = {
      provider,
      model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };
    rec.selectionRef.assembled = undefined;
    rec.tier = tier;
    rec.model = model;
    rec.provider = provider;
    rec.permission = perm.permission;
    rec.turns += 1;
    rec.lastActiveAt = Date.now();
    // Claim this record for the new turn. The epoch is monotonic, so a zombie
    // callback from an earlier turn can always tell it no longer owns the
    // record — object identity alone cannot, because a settled job's late
    // `finally` still holds a reference to the job it ran.
    rec.turnEpoch += 1;
    const turnEpoch = rec.turnEpoch;

    const job = {
      id: `hub-${this.nextId++}-${Date.now().toString(36)}`,
      sessionId: rec.sessionId, persistent: true, turnIndex: rec.turns,
      turnEpoch,
      tier, model, provider, effort, task, source, cwd: rec.cwd,
      permission: perm.permission,
      effective_sandbox_mode: perm.effective_sandbox_mode,
      preset: rec.preset ?? null,
      ...(perm.permission_warning ? { permission_warning: perm.permission_warning } : {}),
      worktree_path: rec.worktreePath ?? null,
      isolation: rec.isolation ?? null,
      degraded_from: rec.degradedFrom ?? null,
      status: 'running', turn: 0, step: 0, currentTool: null, toolCalls: 0, aclDetected: false,
      tokens: { input: 0, output: 0, reasoning: 0 },
      startedAt: new Date().toISOString(), endedAt: null,
      result: null, error: null, stopReason: null, handle: rec.handle, waiters: [], texts: [],
      watchdogTimer: null,
    };
    this.jobs.set(job.id, job);
    rec.activeJob = job;
    this.armTurnWatchdog(rec, job, spec);

    const worktreeFn = spec.createWorktree ?? this.createWorktree ?? createTempWorktree;

    const run = async () => {
      const first = await this.runPersistentAttempt(rec, job, {
        attemptCwd: rec.effectiveCwd,
        attemptSessionId: rec.dshSessionId,
        presetId: rec.preset ?? undefined,
        perm,
        allowDegrade: perm.permission === 'auto',
        reuseHandle: rec.handle !== null,
        task,
      });
      if (!first.aclFailed || job.status === 'cancelled' || rec.isolation === 'git-worktree') return;

      // Windows ACL failure under `permission: "auto"`: keep serving the same
      // visible session_id from a temporary git worktree. rec.sessionId and
      // rec.cwd stay put — they are the caller's identity and comparison base.
      const firstAclError = job.error;
      if (!rec.worktreePath) {
        let wt;
        try {
          wt = await worktreeFn({ cwd: rec.cwd, jobId: rec.sessionId });
        } catch (wtErr) {
          job.status = 'failed';
          job.error = firstAclError ? `${firstAclError}; ${wtErr?.message ?? wtErr}` : (wtErr?.message ?? String(wtErr));
          return;
        }
        const worktreeCwd = wt?.cwd ?? wt?.worktreePath;
        if (!worktreeCwd) {
          job.status = 'failed';
          job.error = 'auto worktree fallback failed: missing worktree cwd';
          return;
        }
        rec.worktreePath = wt.worktreePath;
        rec.effectiveCwd = worktreeCwd;
      }
      rec.isolation = 'git-worktree';
      rec.degradedFrom = perm.effective_sandbox_mode;
      rec.dshSessionId = `${rec.sessionId}-wt`;
      // Record the degradation BESIDE the worktree, so a hub restart can
      // re-attach to it instead of silently resuming the original cwd and
      // hiding every uncommitted file the worker produced here. Best effort:
      // a marker that cannot be written must never fail a live turn.
      writeWorktreeMarker({
        worktreePath: rec.worktreePath,
        facts: {
          sessionId: rec.sessionId,
          dshSessionId: rec.dshSessionId,
          worktreePath: rec.worktreePath,
          effectiveCwd: rec.effectiveCwd,
          isolation: rec.isolation,
          degradedFrom: rec.degradedFrom,
        },
      });
      if (rec.handle !== null) {
        try { await rec.handle.dispose(); } catch {}
        rec.handle = null;
      }
      if (job.status === 'cancelled') return;
      job.worktree_path = rec.worktreePath;
      job.isolation = rec.isolation;
      job.degraded_from = rec.degradedFrom;
      job.status = 'running';
      job.turn = 0;
      job.step = 0;
      job.toolCalls = 0;
      job.tokens = { input: 0, output: 0, reasoning: 0 };
      job.error = null;
      job.result = null;
      job.stopReason = null;
      job.reasonDetail = undefined;
      job.currentTool = null;
      job.texts = [];
      this.publish();
      await this.runPersistentAttempt(rec, job, {
        attemptCwd: rec.effectiveCwd,
        attemptSessionId: rec.dshSessionId,
        presetId: rec.preset ?? undefined,
        perm,
        allowDegrade: false,
        reuseHandle: false,
        task,
      });
    };

    job.promise = run()
      .catch((err) => {
        if (this.stillOwnsTurn(rec, job) && job.status === 'running') job.status = 'failed';
        job.error = job.error ?? (err?.message ?? String(err));
      })
      .finally(() => {
        // A0/A1: a zombie turn (one that timed out and settled later) must not
        // touch the record at all — a successor may own it by now. The job's own
        // bookkeeping still finishes, so a caller waiting on it is released.
        this.clearTurnWatchdog(job);
        job.endedAt = new Date().toISOString();
        job.currentTool = null;
        if (this.stillOwnsTurn(rec, job)) {
          rec.lastActiveAt = Date.now();
          if (rec.status === 'running') rec.status = 'idle';
        }
        this.publish();
        for (const w of job.waiters.splice(0)) w();
      });
    return job;
  }

  /** Cancel one turn's watchdog timer (idempotent, safe on a fired timer). */
  clearTurnWatchdog(job) {
    if (job?.watchdogTimer != null) {
      try { clearTimeout(job.watchdogTimer); } catch {}
      job.watchdogTimer = null;
    }
  }

  /**
   * Does this turn still own its session record?
   *
   * TWO guards, and both must pass. `turnEpoch` is the primary authority: it is
   * monotonic, so a turn that already timed out (or was superseded) can never
   * be mistaken for the current owner — object identity alone would let a
   * settled job's late callback clobber a successor's `running` state and
   * silently release the busy lock. `activeJob` stays as belt-and-braces for the
   * close/cancel paths, which null it out directly.
   */
  stillOwnsTurn(rec, job) {
    if (rec === null || rec === undefined || job === null || job === undefined) return false;
    if (rec.turnEpoch !== job.turnEpoch) return false;
    return rec.activeJob === job;
  }

  /**
   * Arm the per-turn watchdog.
   *
   * Without it a turn whose agent never settles leaves the record `running`
   * forever, and the idle reaper deliberately skips running sessions — so every
   * later turn would be SESSION_BUSY with no way back short of a cancel, a close
   * or a hub restart.
   *
   * WAIT IS RESOLVED IN THIS ORDER and recorded on the job as `watchdogMs`/
   * `watchdogSource`, so an operator (and a test) can see WHICH budget actually
   * armed it instead of inferring it from a wall clock:
   *
   *   1. `spec.turnTimeoutMs` — the per-turn budget the caller computed from its
   *      own `timeout_seconds` (see src/server.mjs). This is the fix for the
   *      hard 30-minute cap: a caller allowed 2 h must not be killed at 30 min.
   *   2. `this.persistentTurnTimeoutMs` — the hub's own configured default.
   *   3. `DEFAULT_PERSISTENT_TURN_TIMEOUT_MS` — the fallback for a caller that
   *      names no budget at all.
   *
   * `0`/negative disables it; an unusable value at one level falls through to
   * the next (see resolveTurnTimeoutMs) rather than disabling the watchdog by
   * accident.
   */
  armTurnWatchdog(rec, job, spec = {}) {
    const { ms, source } = resolveTurnTimeoutMs([
      { value: spec.turnTimeoutMs, source: 'turn' },
      { value: this.persistentTurnTimeoutMs, source: 'config' },
    ]);
    // Always record the resolved budget, including a disabled one, so the value
    // a caller asked for is observable without waiting for the timer.
    job.watchdogMs = ms;
    job.watchdogSource = source;
    if (!Number.isFinite(ms) || ms <= 0) return;
    job.watchdogTimer = setTimeout(() => this.fireTurnWatchdog(rec, job, ms), ms);
    // Never hold the process (or `node --test`) open for a watchdog.
    job.watchdogTimer.unref?.();
  }

  /**
   * The watchdog fired: give the session back.
   *
   * The timed-out `run()` promise may never settle, so the release CANNOT be
   * left to its `finally` — this handler performs it. The agent handle is
   * deliberately NOT disposed: the whole point is to keep the session usable,
   * exactly as the `needs_input` path does.
   */
  fireTurnWatchdog(rec, job, ms) {
    // A newer turn may already own the record (the hung turn was superseded).
    // Then this timer is a stale no-op — it must not touch anything.
    if (!this.stillOwnsTurn(rec, job)) {
      this.clearTurnWatchdog(job);
      return;
    }
    this.clearTurnWatchdog(job);
    const minutes = Math.round((ms / 60_000) * 10) / 10;
    try { job.handle?.agent?.cancel?.({ kind: 'timeout', reason: 'persistent-turn-timeout' }); } catch {}
    job.status = 'failed';
    job.stopReason = 'timeout';
    job.error = `persistent turn timed out after ${ms} ms (${minutes} min): the worker never settled, so the hub reclaimed the session. The session itself is intact and returned to idle — the next turn on this session_id is accepted; retry the task, or close the session with dsh_session_close if it should be abandoned.`;
    job.currentTool = null;
    job.endedAt = new Date().toISOString();
    // Reclaim the record so later turns are admitted again. Guarded by BOTH
    // ownership checks inside stillOwnsTurn, re-verified here because the guards
    // are what make the state transition safe.
    if (this.stillOwnsTurn(rec, job)) {
      rec.lastActiveAt = Date.now();
      if (rec.status === 'running') rec.status = 'idle';
    }
    this.publish();
    // A caller blocked in hub.get(id, wait) must not stay blocked on a turn that
    // is now failed.
    for (const w of job.waiters.splice(0)) w();
  }

  /** Open a NEW persistent session and run its first turn. */
  async spawnPersistentSession(spec = {}) {
    const tier = nonBlank(spec.tier) ?? 'flash';
    if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}"`);
    const effort = nonBlank(spec.effort) ?? 'max';
    if (!['off', 'high', 'max'].includes(effort)) throw new Error(`unknown effort "${effort}"`);
    // Validate the permission, ceiling and cwd before touching any runtime.
    const perm = resolveWorkerPermission({
      permission: spec.permission,
      allowConcurrentCwd: Boolean(spec.allowConcurrentCwd ?? spec.allow_concurrent_cwd),
      maxPermission: spec.maxPermission ?? spec.max_permission,
    });
    if (!isAbsoluteCwd(spec.cwd)) throw new Error('cwd must be an absolute path');
    const cwdPath = canonicalCwd(spec.cwd);
    const cfg = this.getConfig?.() ?? {};
    const bound = resolveTierBinding(tier, cfg);
    const provider = nonBlank(spec.provider) ?? bound.provider;
    const model = nonBlank(spec.model) ?? bound.model;
    await this.ctx.get('loader')?.await();
    const presets = this.ctx.get('agentPresets');
    const wanted = resolveEffectivePreset({ preset: spec.preset, tier, config: cfg });
    const presetId = presets === undefined
      ? undefined
      : (await presets.resolve(!wanted || wanted === 'default' ? undefined : wanted)).id;
    const effectivePreset = presetId ?? wanted;
    // The external identity IS the first underlying session id, so a Hub
    // restart can map session_id -> persisted log without extra bookkeeping.
    const sessionId = `session-${randomUUID()}`;
    const rec = createPersistentSessionRecord({
      sessionId,
      cwd: cwdPath,
      preset: effectivePreset,
      tier,
      model,
      provider,
      selection: { provider, model, reasoningEffort: effort },
    });
    rec.permission = perm.permission;
    this.persistentSessions.set(sessionId, rec);
    rec.status = 'running';
    try {
      return await this.startPersistentTurn(rec, { ...spec, tier, effort, provider, model, permission: perm.permission });
    } catch (err) {
      if (rec.activeJob === null) this.persistentSessions.delete(sessionId);
      rec.status = 'idle';
      throw err;
    }
  }

  /**
   * The canonical preset id a caller's `preset` names.
   *
   * `"default"` is the documented way to name the host's DEFAULT preset, but the
   * host resolves it to a real id (`standard`, `fast-coder`, …). A session whose
   * first turn named `"default"` is therefore locked to THAT id, and a later turn
   * that names `"default"` again is naming the very same composition — comparing
   * the two as literal strings reported SESSION_PRESET_MISMATCH for a perfectly
   * valid continuation.
   *
   * Both sides are canonicalised here, at the hub layer, because
   * `persistent-sessions.mjs` deliberately has no service access (it is a pure,
   * dependency-free module). The LOCKED side is already canonical: creation
   * stores the id the service resolved, and `'default'` maps to "whatever the
   * service says the default is" — that is the same id. So canonicalising the
   * caller's name is enough, and `validateSessionTurnBinding` keeps comparing
   * literal strings so it cannot be weakened by accident: a genuinely DIFFERENT
   * real preset still resolves to a different id and still throws.
   *
   * Returns the trimmed literal when the hub has no preset service (then nothing
   * could have been resolved at creation either, so the literal IS the locked
   * value), and `null` for a blank/absent name (tolerant inheritance).
   */
  async canonicalPresetId(value) {
    const wanted = nonBlank(value);
    if (wanted === null) return null;
    const presets = this.ctx.get('agentPresets');
    if (presets === undefined || typeof presets.resolve !== 'function') return wanted;
    try {
      // `'default'` is resolved the same way creation resolves it: "the default",
      // i.e. no explicit id at all.
      const resolved = await presets.resolve(wanted === 'default' ? undefined : wanted);
      return nonBlank(resolved?.id) ?? wanted;
    } catch (err) {
      // Resolution failing must not turn a valid continuation into a mismatch
      // silently: fall back to the literal, which then fails closed (and loud)
      // exactly as it did before this canonicalisation existed.
      this.ctx.logger?.warn?.(`dsh-crew: preset ${JSON.stringify(wanted)} could not be resolved: ${err?.message ?? err}`);
      return wanted;
    }
  }

  /** Append one turn to an existing persistent session. */
  async spawnPersistentTurn(spec = {}) {
    const sessionId = nonBlank(spec.sessionId);
    if (sessionId === null) {
      throw new HubRequestError('session_id is required', { status: 400, code: 'INVALID_PERSISTENT_ARGS' });
    }
    const rec = this.persistentSessions.get(sessionId) ?? await this.recoverPersistentSession(sessionId, spec);
    if (rec.status === 'running') {
      throw new HubRequestError('session is busy', { status: 409, code: 'SESSION_BUSY' });
    }
    // A follow-up turn takes its cwd from the caller, so it needs the same
    // absolute-path guard the creating turn and the resume path already have:
    // a relative cwd would resolve against whatever process the hub happens to
    // be, i.e. a different workspace than the caller meant, and the locked-cwd
    // comparison below would then be made against a path that never named one.
    if (spec.cwd !== undefined && !isAbsoluteCwd(spec.cwd)) {
      throw new HubRequestError('cwd must be an absolute path', { status: 400, code: 'INVALID_CWD' });
    }
    // cwd is locked; preset is inherited unless the caller names one explicitly.
    // The explicit name is canonicalised through the preset service first, so
    // `"default"` compares equal to the real id it resolved to at creation while
    // a genuinely different preset still compares unequal.
    validateSessionTurnBinding({
      expectedCwd: rec.cwd,
      actualCwd: spec.cwd,
      expectedPreset: rec.preset,
      explicitPreset: await this.canonicalPresetId(spec.preset),
    });
    // Reservation is synchronous: a concurrent turn cannot slip in between the
    // busy check above and this write.
    rec.status = 'running';
    try {
      return await this.startPersistentTurn(rec, spec);
    } catch (err) {
      rec.status = 'idle';
      throw err;
    }
  }

  /** Resume one persisted session after a Hub restart, or fail with SESSION_RESUME_FAILED. */
  async recoverPersistentSession(sessionId, spec = {}) {
    if (this.closedSessions.has(sessionId)) {
      throw new HubRequestError('session is closed', { status: 409, code: 'SESSION_CLOSED' });
    }
    const inFlight = this.resumeInFlight.get(sessionId);
    if (inFlight !== undefined) return inFlight;
    const resume = this.recoverPersistentSessionOnce(sessionId, spec)
      .finally(() => {
        if (this.resumeInFlight.get(sessionId) === resume) this.resumeInFlight.delete(sessionId);
      });
    this.resumeInFlight.set(sessionId, resume);
    return resume;
  }

  async recoverPersistentSessionOnce(sessionId, spec = {}) {
    const fail = (detail) => new HubRequestError(
      `cannot resume persistent session ${sessionId}: ${detail}`,
      { status: 409, code: 'SESSION_RESUME_FAILED' },
    );
    if (typeof this.ctx?.agents?.resume !== 'function') throw fail('this hub has no agent resume support');
    if (!isAbsoluteCwd(spec.cwd)) throw fail('cwd must be an absolute path to resume a session');
    const cwdPath = canonicalCwd(spec.cwd);
    const cfg = this.getConfig?.() ?? {};
    const tier = nonBlank(spec.tier) ?? nonBlank(cfg.default_tier) ?? 'flash';
    const effort = nonBlank(spec.effort) ?? nonBlank(cfg.default_effort) ?? 'max';
    const bound = resolveTierBinding(tier, cfg);
    const provider = nonBlank(spec.provider) ?? bound.provider;
    const model = nonBlank(spec.model) ?? bound.model;
    const rec = createPersistentSessionRecord({
      sessionId,
      cwd: cwdPath,
      preset: nonBlank(spec.preset),
      tier,
      model,
      provider,
      selection: { provider, model, reasoningEffort: effort },
    });
    rec.permission = resolveWorkerPermission({
      permission: spec.permission,
      allowConcurrentCwd: Boolean(spec.allowConcurrentCwd ?? spec.allow_concurrent_cwd),
      maxPermission: spec.maxPermission ?? spec.max_permission,
    }).permission;

    // An `auto` degradation is DURABLE. The worktree path is deterministic
    // (`%TEMP%\dsh-crew-worktrees\<session_id>`), so a worktree that still exists
    // after the restart is proof that this session was degraded — and resuming
    // the ORIGINAL id on the ORIGINAL cwd would silently hide every uncommitted
    // file the worker produced in it. Re-attach to `<id>-wt` on the recorded
    // worktree cwd instead. See permission-policy.mjs for the marker contract.
    const persistedWorktree = detectPersistedWorktree({
      sessionId,
      baseDir: spec.worktreeBaseDir ?? this.worktreeBaseDir,
    });
    if (persistedWorktree !== null) {
      rec.worktreePath = persistedWorktree.worktreePath;
      rec.effectiveCwd = persistedWorktree.cwd;
      rec.isolation = nonBlank(persistedWorktree.facts?.isolation) ?? 'git-worktree';
      // `degradedFrom` is the sandbox mode the degradation moved AWAY from. The
      // marker records it; a marker that predates the field cannot invent it, and
      // `auto` always maps to `workspace-write`, so that is the honest fallback.
      rec.degradedFrom = nonBlank(persistedWorktree.facts?.degradedFrom) ?? 'workspace-write';
      // The degraded runtime has its OWN underlying session id, so the log that
      // must be resumed is the worktree one, not the caller-facing id.
      rec.dshSessionId = `${sessionId}-wt`;
      this.ctx.logger?.info?.(
        `dsh-crew: resuming degraded persistent session ${sessionId} on its worktree ${persistedWorktree.worktreePath}`,
      );
    }
    // The cwd the persisted log must agree with: the worktree's when degraded,
    // the caller's original baseline otherwise.
    const resumeCwd = persistedWorktree === null ? cwdPath : canonicalCwd(persistedWorktree.cwd) ?? cwdPath;

    let handle;
    try {
      handle = await this.ctx.agents.resume({
        resumeSessionId: rec.dshSessionId,
        agentOptions: this.agentOptionsFor(rec),
        setup: async (agentCtx) => {
          // The persisted log is the authority on where and under what preset
          // this session ran; a mismatch means resuming would silently run the
          // caller's task in the wrong workspace or composition. The caller's
          // name is canonicalised first, for the same reason as on a live turn:
          // `"default"` names the preset the log's real id resolved from.
          try {
            const session = agentCtx?.agent?.session;
            validateSessionTurnBinding({
              expectedCwd: session?.header?.cwd,
              actualCwd: resumeCwd,
              expectedPreset: resolvePersistedSessionPreset(session),
              explicitPreset: await this.canonicalPresetId(spec.preset),
            });
          } catch (err) {
            throw fail(err?.message ?? String(err));
          }
          installModelSelection(agentCtx, rec.selectionRef);
          const presets = this.ctx.get('agentPresets');
          const persistedPreset = resolvePersistedSessionPreset(agentCtx?.agent?.session) ?? rec.preset ?? undefined;
          if (persistedPreset !== undefined && persistedPreset !== null) rec.preset = persistedPreset;
          if (presets !== undefined && persistedPreset !== undefined && persistedPreset !== null) {
            await presets.mount(agentCtx, persistedPreset);
          }
          const jobOrGetter = () => rec.activeJob;
          installWorkerQuestionHandoff(agentCtx, jobOrGetter, () => this.publish());
          this.installRecordEventListeners(rec, agentCtx);
        },
      });
    } catch (err) {
      if (err instanceof HubRequestError && err.code === 'SESSION_RESUME_FAILED') throw err;
      throw fail(err?.message ?? String(err));
    }
    // A close can land while `agents.resume()` is in flight, and inserting the
    // record unconditionally here would REVIVE a session the caller just
    // destroyed — resurrecting a closed id is the one thing the tombstone exists
    // to prevent. Re-check after the await: dispose the runtime we just built and
    // refuse, instead of leaking a hidden live agent for a closed session.
    if (this.closedSessions.has(sessionId)) {
      try { await handle?.dispose(); } catch {}
      this.publish();
      throw new HubRequestError('session is closed', { status: 409, code: 'SESSION_CLOSED' });
    }
    rec.handle = handle;
    // Continue the turn counter from the persisted log instead of restarting at 1.
    rec.turns = countSettledTurns(handle?.agent?.session);
    rec.preset = resolvePersistedSessionPreset(handle?.agent?.session) ?? rec.preset ?? null;
    rec.lastActiveAt = Date.now();
    // Report the recovered degradation instead of reverting silently: a caller
    // that resumes a degraded session must be able to SEE that it is running on
    // a worktree (the same facts the live degradation reports on the job view).
    if (persistedWorktree !== null) rec.recoveredDegradation = true;
    this.persistentSessions.set(sessionId, rec);
    return rec;
  }

  /** Remember a closed id so no later turn (or restart recovery) revives it. */
  rememberClosedSession(sessionId, reason) {
    this.closedSessions.set(sessionId, { closedAt: Date.now(), reason: reason ?? null });
    while (this.closedSessions.size > CLOSED_SESSIONS_LIMIT) {
      const oldest = this.closedSessions.keys().next();
      if (oldest.done) break;
      this.closedSessions.delete(oldest.value);
    }
  }

  /**
   * Destroy one persistent session. The map mutation and the tombstone happen
   * synchronously (so `reapIdleSessions` can be driven from a test); only the
   * runtime teardown is awaited.
   */
  async closePersistentSession(sessionId, { reason } = {}) {
    const rec = this.persistentSessions.get(sessionId);
    let handle = null;
    if (rec !== undefined) {
      rec.status = 'closed';
      rec.lastActiveAt = Date.now();
      handle = rec.handle;
      rec.handle = null;
      const active = rec.activeJob;
      rec.activeJob = null;
      if (active !== null && active !== undefined) {
        // Nothing may fire for a closed session.
        this.clearTurnWatchdog(active);
        if (active.status === 'running') {
          try { active.handle?.agent?.cancel?.({ kind: 'user' }); } catch {}
          active.status = 'cancelled';
          active.error = 'session closed';
        }
      }
      this.persistentSessions.delete(sessionId);
    }
    this.rememberClosedSession(sessionId, reason);
    if (handle !== null) { try { await handle.dispose(); } catch {} }
    this.publish();
    return { session_id: sessionId, closed: true };
  }

  listPersistentSessions() {
    return [...this.persistentSessions.values()].map((rec) => summarizePersistentSession(rec));
  }

  /**
   * Close sessions idle past the configured timeout. Never touches a running
   * session, and an explicit `false` in the panel disables reaping entirely.
   */
  reapIdleSessions(now = Date.now()) {
    const cfg = this.getConfig?.() ?? {};
    if (cfg?.persistent_session_idle_timeout_enabled === false) return [];
    const minutes = clampIdleMinutes(cfg?.persistent_session_idle_timeout_minutes);
    const timeoutMs = minutes * 60_000;
    const closed = [];
    for (const rec of [...this.persistentSessions.values()]) {
      if (rec.status === 'running') continue;
      const idleSince = typeof rec.lastActiveAt === 'number' ? rec.lastActiveAt : now;
      if (now - idleSince < timeoutMs) continue;
      closed.push(rec.sessionId);
      this.closePersistentSession(rec.sessionId, { reason: 'idle-timeout' }).catch((err) => {
        this.ctx?.logger?.warn?.(`dsh-crew: idle session close failed: ${err?.message ?? err}`);
      });
    }
    return closed;
  }

  async cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === 'running') {
      // The turn is over either way, so its watchdog must not outlive it.
      this.clearTurnWatchdog(job);
      job.status = 'cancelled';
      job.error = 'cancelled by request';
      const rec = job.persistent === true ? this.persistentSessions.get(job.sessionId) : undefined;
      if (rec !== undefined) {
        // A persistent session keeps its handle: cancel only the in-flight turn.
        try { job.handle?.agent?.cancel?.({ kind: 'user' }); } catch {}
        if (this.stillOwnsTurn(rec, job)) { rec.status = 'idle'; rec.lastActiveAt = Date.now(); }
      } else {
        try { await job.handle?.dispose(); } catch {}
      }
      this.publish();
    }
    return job;
  }

  async dispose() {
    if (this.reaperTimer !== null) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    for (const rec of [...this.persistentSessions.values()]) {
      try { await this.closePersistentSession(rec.sessionId, { reason: 'hub-dispose' }); } catch {}
    }
    for (const job of this.jobs.values()) {
      if (job.status === 'running') { try { await job.handle?.dispose(); } catch {} }
    }
  }
}

/** Minutes for the idle reaper, clamped to the documented 1..1440 range. */
function clampIdleMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_IDLE_TIMEOUT_MINUTES;
  return Math.min(MAX_IDLE_TIMEOUT_MINUTES, Math.max(1, Math.round(n)));
}

// ---------- loopback route helpers (pattern from dsh-noema) ----------

function isIpv4Loopback(a) { return /^127(\.\d{1,3}){3}$/.test(a); }
function isLoopbackAddress(address) {
  if (!address) return false;
  const n = address.toLowerCase().split('%', 1)[0];
  if (n === '::1' || isIpv4Loopback(n)) return true;
  if (!n.startsWith('::ffff:')) return false;
  return isIpv4Loopback(n.slice(7));
}
/**
 * True when the request declares a JSON body.
 *
 * A `; charset=utf-8` suffix is accepted (that is still application/json); a
 * `text/plain` body is not. This is the ONE check every state-mutating POST
 * route uses, so a body cannot arrive through a browser "simple request" that
 * skips a CORS preflight: a cross-origin `text/plain` POST is delivered without
 * any preflight, and without this guard a hostile page could drive this hub.
 * `application/x-www-form-urlencoded` and `multipart/form-data` are simple
 * requests too, so they are refused the same way.
 */
function hasJsonContentType(req) {
  const raw = req?.headers?.['content-type'];
  if (typeof raw !== 'string') return false;
  const mediaType = raw.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

/** The uniform 415 refusal for a mutating POST without a JSON body. */
function requireJsonContentType(res, req) {
  if (hasJsonContentType(req)) return false;
  sendJson(res, 415, {
    ok: false,
    error: 'application/json required: state-mutating requests must declare content-type: application/json',
    code: 'UNSUPPORTED_MEDIA_TYPE',
  });
  return true;
}

function isLoopbackRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || isIpv4Loopback(host);
}
function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    ...headers,
  });
  res.end(body);
}
/**
 * The panel is the authority on the active locale (DSH's setting may be unset,
 * leaving it to the browser), so it tags requests with ?lang= / body.lang and
 * the hub adopts it. Conversation-side paths with no request behind them —
 * pasted-image transcription — then follow the same language.
 */
function adoptLang(value) {
  if (value === 'zh' || value === 'en') setLang(value);
}

/**
 * `?wait` as a non-negative integer second count. Absent/empty means 0;
 * anything non-numeric, fractional or negative is null (HTTP 400) — a
 * garbage wait must be an error, never a silent no-wait (PATTERN-AUDIT D2:
 * `?wait=abc` used to return immediately with 200 OK because
 * Math.min(NaN, 600) is NaN and the wait promise resolved instantly).
 */
export function parseWaitSeconds(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (!/^\d+$/.test(String(value))) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

async function readBody(req, limit = 64 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('payload too large');
  }
  return body.trim() === '' ? {} : JSON.parse(body);
}

/**
 * `readBody` for a route whose failures carry a status: a malformed or
 * oversized body is the caller's mistake (400), not a server fault (500).
 */
async function readJsonBody(req, { limit } = {}) {
  try {
    return await readBody(req, limit);
  } catch (err) {
    throw new HubRequestError(err?.message ?? 'invalid request body', { status: 400, code: 'INVALID_JSON' });
  }
}

// ---------- plugin entry ----------

export async function apply(ctx) {
  seedLangFromHost(ctx);
  const hub = new WorkerRegistry(ctx);
  try {
    const { readGlobalConfig } = await import('../install/install.mjs');
    hub.getConfig = () => readGlobalConfig();
  } catch {}
  const disposers = [];

  // Multimodal bridge: register describe_image / generate_image for the DS
  // model. Config is read per call so settings-page edits apply live.
  try {
    const { createMultimodalTools } = await import('../multimodal.mjs');
    const { readGlobalConfig } = await import('../install/install.mjs');
    for (const tool of createMultimodalTools(() => readGlobalConfig())) {
      disposers.push(ctx.effect(() => ctx.tools.register(tool), `dsh-crew: ${tool.name} tool`));
    }
  } catch (err) {
    ctx.logger?.warn?.(`dsh-crew: multimodal tools unavailable: ${err?.message ?? err}`);
  }

  // Vision route: image paste on the text-only DS models (admission adapter +
  // pre-step transcription).
  try {
    const { installVisionRoute } = await import('../vision-route.mjs');
    const { readGlobalConfig } = await import('../install/install.mjs');
    disposers.push(installVisionRoute(ctx, () => readGlobalConfig()));
  } catch (err) {
    ctx.logger?.warn?.(`dsh-crew: vision route unavailable: ${err?.message ?? err}`);
  }

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer;
    const disposers = [];
    let publishedHubUrl = null;
    const hubStartedAt = new Date().toISOString();

    const publishHubUrl = (candidate) => {
      const normalized = normalizeLoopbackHubUrl(candidate);
      if (!normalized || normalized === publishedHubUrl) return;
      try {
        writeHubDiscovery({ url: normalized, pid: process.pid, startedAt: hubStartedAt });
        publishedHubUrl = normalized;
      } catch (err) {
        ctx.logger?.warn?.(`dsh-crew: failed to write hub discovery file: ${err?.message ?? err}`);
      }
    };

    const captureRequestUrl = (req) => {
      if (publishedHubUrl) return;
      if (!isLoopbackRequest(req)) return;
      publishHubUrl(extractRequestLoopbackUrl(req));
    };

    const register = (spec) => webServer.register({
      ...spec,
      handler: async (...args) => {
        captureRequestUrl(args[0]);
        return spec.handler(...args);
      },
    });

    publishHubUrl(extractWebServerUrl(webServer));
    const listeningTarget = webServer?.server ?? webServer?.httpServer;
    const onListening = () => publishHubUrl(extractWebServerUrl(webServer));
    if (listeningTarget && typeof listeningTarget.once === 'function') {
      listeningTarget.once('listening', onListening);
    }
    const probeTimer = setTimeout(() => publishHubUrl(extractWebServerUrl(webServer)), 500);
    probeTimer.unref?.();

    const cleanupDiscovery = () => {
      if (!publishedHubUrl) return;
      removeHubDiscoveryIfOwned({ pid: process.pid, url: publishedHubUrl });
    };
    process.once('exit', cleanupDiscovery);
    disposers.push(() => {
      clearTimeout(probeTimer);
      if (listeningTarget && typeof listeningTarget.removeListener === 'function') {
        try { listeningTarget.removeListener('listening', onListening); } catch {}
      }
      process.removeListener('exit', cleanupDiscovery);
      cleanupDiscovery();
    });

    disposers.push(register({
      kind: 'exact', path: `${ROUTE_BASE}/worker-probe`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' });
        if (requireJsonContentType(res, req)) return;
        try {
          const body = await readBody(req);
          if (typeof body.provider !== 'string' || body.provider.trim() === '' || typeof body.model !== 'string' || body.model.trim() === '') return sendJson(res, 400, { ok: false, error: 'provider and model required' });
          const result = await probeProvider(ctx.llm, { provider: body.provider.trim(), model: body.model.trim() });
          return sendJson(res, 200, { ok: true, result });
        } catch { return sendJson(res, 400, { ok: false, error: 'invalid probe request' }); }
      },
    }));

    disposers.push(register({
      kind: 'exact', path: `${ROUTE_BASE}/ping`,
      handler: (req, res) => sendJson(res, 200, { ok: true, service: 'dsh-crew-hub' }),
    }));

    // WPC14: liveness probe for a ghost job's recorded pid. The panel probes
    // orphaned tombstones that carry a pid so it can offer the "process still
    // alive" badge and a kill button; same process.kill(pid, 0) probe the
    // status shard uses for writer liveness (status-shard.mjs writerProcessAlive).
    disposers.push(register({
      kind: 'exact', path: `${ROUTE_BASE}/proc-alive`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' }, { allow: 'GET' });
        try {
          const url = new URL(req.url, 'http://localhost');
          const pid = parsePid(url.searchParams.get('pid'));
          if (pid === null) return sendJson(res, 400, { ok: false, error: 'pid must be a positive integer' });
          return sendJson(res, 200, { ok: true, alive: procAlive(pid) });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    // WPC14: verified kill of a ghost job's recorded pid. The pid may have
    // been recycled since the job died, so the command line is read (ps) and
    // must match a process shape this plugin spawns (DSH runtime / agy /
    // grok) before anything is signalled; then SIGTERM (whole group when a
    // pgid is given) and SIGKILL after a ~3s grace. Refusals are readable,
    // in the origin-guard style.
    disposers.push(register({
      kind: 'exact', path: `${ROUTE_BASE}/proc-kill`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' });
        if (requireJsonContentType(res, req)) return;
        try {
          const body = await readBody(req);
          adoptLang(body?.lang);
          const pid = parsePid(body?.pid);
          if (pid === null) return sendJson(res, 400, { ok: false, error: 'pid must be a positive integer' });
          let pgid = null;
          if (body.pgid !== undefined && body.pgid !== null) {
            pgid = parsePid(body.pgid);
            if (pgid === null) return sendJson(res, 400, { ok: false, error: 'pgid must be a positive integer' });
          }
          const result = await killWorkerProcess({ pid, pgid });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          if (err instanceof ProcKillRefused) {
            return sendJson(res, 403, { ok: false, error: err.message, code: err.code, pid: err.pid ?? null, command: err.command ?? null });
          }
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(register({
      kind: 'prefix', path: `${ROUTE_BASE}/jobs`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const url = new URL(req.url, 'http://localhost');
          const parts = url.pathname.slice(`${ROUTE_BASE}/jobs`.length).split('/').filter(Boolean);
          if (req.method === 'GET' && parts.length === 0) {
            // Machine-wide view: this hub's live jobs plus fresh shards from
            // other writers (standalone MCP sessions, other hub instances).
            const own = [...hub.jobs.values()].map((j) => ({ ...hub.view(j), origin: hub.shard.writer }));
            const foreign = readMergedStatus({ excludeWriter: hub.shard.writer });
            return sendJson(res, 200, { ok: true, jobs: [...own, ...foreign] });
          }
          if (req.method === 'GET' && parts.length === 1) {
            const wait = parseWaitSeconds(url.searchParams.get('wait'));
            if (wait === null) return sendJson(res, 400, { ok: false, error: 'wait must be a non-negative integer number of seconds' });
            const job = await hub.wait(parts[0], Math.min(wait, 600) * 1000);
            if (!job) return sendJson(res, 404, { ok: false, error: 'no such job' });
            return sendJson(res, 200, { ok: true, job: hub.view(job, true) });
          }
          if (req.method === 'POST' && parts.length === 0) {
            if (requireJsonContentType(res, req)) return undefined;
            const payload = await readBody(req);
            const job = await hub.spawn(payload);
            return sendJson(res, 200, { ok: true, job: hub.view(job) });
          }
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'cancel') {
            if (requireJsonContentType(res, req)) return undefined;
            const job = await hub.cancel(parts[0]);
            if (!job) return sendJson(res, 404, { ok: false, error: 'no such job' });
            return sendJson(res, 200, { ok: true, job: hub.view(job, true) });
          }
          return sendJson(res, 404, { ok: false, error: 'unknown jobs endpoint' });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(register({
      kind: 'prefix', path: `${ROUTE_BASE}/sessions`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        const url = new URL(req.url, 'http://localhost');
        const parts = url.pathname.slice(`${ROUTE_BASE}/sessions`.length).split('/').filter(Boolean);
        try {
          if (req.method === 'GET' && parts.length === 0) {
            return sendJson(res, 200, { ok: true, sessions: hub.listPersistentSessions() });
          }
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'turns') {
            if (requireJsonContentType(res, req)) return undefined;
            const sessionId = decodeURIComponent(parts[0]);
            const body = await readJsonBody(req);
            adoptLang(body?.lang);
            const job = await hub.spawnPersistentTurn({ ...body, sessionId });
            return sendJson(res, 200, { ok: true, session_id: job.sessionId, turn_index: job.turnIndex, job: hub.view(job, true) });
          }
          if (req.method === 'POST' && parts.length === 2 && parts[1] === 'close') {
            if (requireJsonContentType(res, req)) return undefined;
            const sessionId = decodeURIComponent(parts[0]);
            const body = await readJsonBody(req).catch((err) => {
              // A close request may legitimately have no body at all; still
              // refuse genuinely malformed JSON rather than closing silently.
              if (err instanceof HubRequestError && err.code === 'INVALID_JSON') throw err;
              return {};
            });
            adoptLang(body?.lang);
            const result = await hub.closePersistentSession(sessionId, { reason: body?.reason });
            return sendJson(res, 200, { ok: true, ...result });
          }
          return sendJson(res, 404, { ok: false, error: 'unknown sessions endpoint' });
        } catch (err) {
          // A session-level refusal carries its own status and stable code
          // (SESSION_BUSY / SESSION_CLOSED / SESSION_CWD_MISMATCH / ...), so the
          // MCP layer can surface it verbatim instead of a generic 500.
          if (err instanceof HubRequestError) {
            return sendJson(res, err.status, { ok: false, error: err.message, code: err.code });
          }
          // A bad permission/ceiling is the request's fault, not the hub's.
          if (err?.name === 'PermissionError') {
            return sendJson(res, 400, { ok: false, error: err.message, code: err.code ?? 'INVALID_PERMISSION' });
          }
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(register({
      kind: 'exact', path: `${ROUTE_BASE}/config`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const { readGlobalConfig, writeGlobalConfig } = await import(`../install/install.mjs?t=${Date.now()}`);
          if (req.method === 'GET') {
            adoptLang(new URL(req.url, 'http://localhost').searchParams.get('lang'));
            return sendJson(res, 200, { ok: true, config: readGlobalConfig() });
          }
          if (req.method === 'POST') {
            if (requireJsonContentType(res, req)) return undefined;
            return sendJson(res, 200, { ok: true, config: writeGlobalConfig(await readBody(req)) });
          }
          return sendJson(res, 405, { ok: false, error: 'GET or POST' }, { allow: 'GET, POST' });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(register({
      kind: 'exact', path: `${ROUTE_BASE}/presets`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const presets = ctx.get('agentPresets');
          if (presets === undefined) return sendJson(res, 200, { ok: true, presets: [] });
          const list = await presets.list();
          return sendJson(res, 200, {
            ok: true,
            defaultId: presets.defaultId,
            presets: list.map((p) => ({ id: p.id, name: p.name ?? p.id, trust: p.trust })),
          });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    // The MCP server runs as its own process and cannot reach ctx.llm, so the
    // routes the HOST has configured are published here. This is the whole
    // point of issue #10: a local model is configured once in DSH, and the
    // worker config names it instead of redefining it.
    disposers.push(register({
      kind: 'exact', path: `${ROUTE_BASE}/providers`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' }, { allow: 'GET' });
        try {
          const { readGlobalConfig } = await import('../install/install.mjs');
          const providers = await listProviderCatalog(ctx.llm);
          return sendJson(res, 200, {
            ok: true,
            providers,
            bindings: describeBindings(readGlobalConfig()),
          });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(register({
      kind: 'exact', path: `${ROUTE_BASE}/vision-models`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const url = new URL(req.url, 'http://localhost');
          const provider = url.searchParams.get('provider');
          const force = url.searchParams.get('refresh') === '1';
          const lang = url.searchParams.get('lang');
          adoptLang(lang);
          const { listVisionModels } = await import('../multimodal.mjs');
          const { readGlobalConfig } = await import('../install/install.mjs');
          return sendJson(res, 200, { ok: true, models: await listVisionModels(provider, force, () => readGlobalConfig(), lang) });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(register({
      kind: 'exact', path: `${ROUTE_BASE}/provider-test`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (requireJsonContentType(res, req)) return;
        try {
          // The entry comes from the panel form so unsaved edits can be probed.
          const entry = await readBody(req);
          adoptLang(entry?.lang);
          const { testProvider } = await import('../multimodal.mjs');
          const result = await testProvider(entry, entry?.lang);
          return sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(register({
      kind: 'exact', path: `${ROUTE_BASE}/install/status`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        try {
          const { installStatus } = await import(`../install/install.mjs?t=${Date.now()}`);
          return sendJson(res, 200, { ok: true, status: installStatus() });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    disposers.push(register({
      kind: 'exact', path: `${ROUTE_BASE}/install`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' });
        if (requireJsonContentType(res, req)) return;
        try {
          const {
            target,
            statusline,
            agyPermissions,
            permissions,
            allowSafePermissions,
            allowDispatchPermissions,
          } = await readBody(req);
          // Cache-busted import: the installer must always run the code
          // currently on disk, not whatever this process first loaded —
          // a stale cached copy once re-broke user settings after a fix.
          const {
            installClaudeCode, installCodex, installHudSegment, uninstallClaudeCode, uninstallCodex,
            installAgy, installGrok, uninstallAgy, uninstallGrok,
          } = await import(`../install/install.mjs?t=${Date.now()}`);
          if (target === 'claude') {
            const base = await installClaudeCode({ statusline: !!statusline });
            const hud = installHudSegment({});
            return sendJson(res, 200, {
              ok: base.ok,
              actions: [...base.actions, ...hud.actions.map((a) => `hud: ${a}`)],
            });
          }
          if (target === 'codex') return sendJson(res, 200, installCodex({}));
          if (target === 'agy') {
            return sendJson(res, 200, installAgy({
              ...(agyPermissions !== undefined ? { agyPermissions } : {}),
              ...(permissions !== undefined ? { permissions } : {}),
              ...(allowSafePermissions !== undefined ? { allowSafePermissions } : {}),
              ...(allowDispatchPermissions !== undefined ? { allowDispatchPermissions } : {}),
            }));
          }
          if (target === 'grok') return sendJson(res, 200, installGrok({}));
          if (target === 'claude-uninstall') return sendJson(res, 200, await uninstallClaudeCode({}));
          if (target === 'codex-uninstall') return sendJson(res, 200, uninstallCodex({}));
          if (target === 'agy-uninstall') return sendJson(res, 200, uninstallAgy({}));
          if (target === 'grok-uninstall') return sendJson(res, 200, uninstallGrok({}));
          return sendJson(res, 400, { ok: false, error: 'target must be claude | codex | agy | grok | claude-uninstall | codex-uninstall | agy-uninstall | grok-uninstall' });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message ?? String(err) });
        }
      },
    }));

    return () => { for (const d of disposers.reverse()) d(); };
  });

  ctx.logger?.info?.('dsh-crew hub mounted (jobs API + installer endpoints + multimodal tools)');
  return async () => {
    for (const d of disposers.reverse()) { try { d(); } catch {} }
    await hub.dispose();
  };
}
