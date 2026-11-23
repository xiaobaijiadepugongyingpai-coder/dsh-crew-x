// MCP stdio server exposing the DSH worker pool to Claude Code / Codex.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { startJob, waitJob, cancelJob, listJobs, getJob, jobView } from './jobs.mjs';
import { hubAvailable, hub, getActiveHubUrl, redactHubUrl } from './hub-client.mjs';
import { startCliJob } from './cli-workers.mjs';
import { listProfiles, resolveProfile } from './worker-profiles.mjs';
import { readInheritedOrigin, extendOrigin, DEFAULT_ORIGIN_DEPTH_LIMIT } from './origin-guard.mjs';
import { acquireCwdLock, releaseCwdLockByJobId, updateCwdLockHolder, getCwdLocks, CwdLockError } from './cwd-lock.mjs';
import { resolveWorkerCwd } from './paths.mjs';
import { detectOrchestrator } from './process-info.mjs';
import { PERMISSIONS, resolveWorkerPermission, resolveEffectivePreset, readMaxPermission } from './permission-policy.mjs';
import { appendSummaryContract } from './summary-parser.mjs';
import { offloadWorkerResult } from './result-offload.mjs';

const server = new McpServer({ name: 'dsh-crew-x', version: '0.2.0' });

const tierSchema = z.enum(['flash', 'pro']).optional().describe('Worker model tier. flash = mechanical, well-scoped work (single-file edits, lookups, formatting); pro = multi-file changes, debugging, design judgment. Omit to use the session default. Ignored when worker= is set.');
const effortSchema = z.enum(['off', 'high', 'max']).optional().describe('Reasoning effort for the worker. Omit to use the session default. With worker= it only applies when passed explicitly and the profile supports it (agy maps to low/medium/high).');
const workerSchema = z.string().optional().describe('Named CLI worker profile (e.g. "agy" or "grok"). Explicit opt-in only: set it when the user explicitly asks for that external coding CLI, never as a default. When set, dispatch bypasses tier/mode and runs the task through that CLI; the profile pins backend×model×effort. See dsh_worker_config output, worker_profiles field, for the available profiles.');
const allowConcurrentCwdSchema = z.boolean().optional().describe('Allow this dispatch even though another running worker already holds the same cwd (workspace) lock. Default false: concurrent writers corrupt a shared repo, so the second dispatch is refused with the holder info instead of queueing. Set true only for read-only tasks (defaults permission to "read-only" and rejects non-read-only permissions).');
const permissionSchema = z.enum(PERMISSIONS).optional().describe('Per-task DSH sandbox permission: "read-only" (no writes, skips Windows ACL grants; default when allow_concurrent_cwd=true), "workspace-write" (default when allow_concurrent_cwd=false; read/write inside cwd), "auto" (workspace-write with temporary git worktree fallback on Windows ACL failure), "full-access" (explicit opt-in only -> danger-full-access).');
const presetSchema = z.string().optional().describe('Optional hub-mode agent preset id for this task (overrides session preset_flash / preset_pro).');
const inlineLimitSchema = z.number().int().positive().optional().describe('Override the inline output-token threshold (default 1500 tokens; char threshold scales proportionally as round(inline_limit * 4000 / 1500), default 4000 chars). Outputs exceeding the threshold are offloaded to report_path with only summary + stats returned unless full_reply=true.');
const fullReplySchema = z.boolean().optional().describe('When true, keep the full result text inline even when offloaded to report_path or when the job failed.');

// Session-level configuration. This MCP server process lives exactly as long
// as one Claude Code / Codex session, so plain memory IS session scope.
// Initial values come from the global config (~/.config/dsh-crew/config.json,
// edited on the DSH settings page); dsh_worker_config overrides per session.
import { readGlobalConfig } from './install/install.mjs';
import { describeBindings, resolveTierBinding } from './tier-binding.mjs';
const globalDefaults = readGlobalConfig();
const sessionConfig = {
  enabled: true,
  default_tier: globalDefaults.default_tier,
  default_effort: globalDefaults.default_effort,
  mode: globalDefaults.mode, // auto | hub | standalone
  default_timeout_seconds: globalDefaults.default_timeout_seconds,
  tier_policy: globalDefaults.tier_policy, // auto | flash-only | pro-only
  escalate_on_failure: globalDefaults.escalate_on_failure,
  preset_flash: globalDefaults.preset_flash ?? 'default',
  preset_pro: globalDefaults.preset_pro ?? 'default',
  report_dir: globalDefaults.report_dir ?? '',
  // Tier -> LLM route. A provider id names a route the HOST already has
  // configured; blank means the tier's built-in DeepSeek default (#10).
  flash_provider: globalDefaults.flash_provider ?? '',
  flash_model: globalDefaults.flash_model ?? '',
  pro_provider: globalDefaults.pro_provider ?? '',
  pro_model: globalDefaults.pro_model ?? '',
  // WPC9: max worker→worker nesting depth before a dispatch is refused.
  origin_depth_limit: DEFAULT_ORIGIN_DEPTH_LIMIT,
  // Opt-in persistent DSH sessions (hub mode only). Off unless the global
  // config turns it on, so an existing install keeps its one-shot behaviour.
  persistent_sessions: globalDefaults.persistent_sessions ?? false,
};

/** The {provider, model} this session dispatches `tier` to. */
function bindingForTier(tier) {
  return resolveTierBinding(tier, sessionConfig);
}

function presetForTier(tier, explicitPreset) {
  return resolveEffectivePreset({ preset: explicitPreset, tier, config: sessionConfig });
}

/** Tool-layer tier enforcement: the policy overrides whatever was requested. */
function applyTierPolicy(tier) {
  if (sessionConfig.tier_policy === 'flash-only') return 'flash';
  if (sessionConfig.tier_policy === 'pro-only') return 'pro';
  return tier ?? sessionConfig.default_tier;
}

function text(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

function prepareCliDispatch({ worker, task, permission, allowConcurrentCwd }) {
  if (permission !== undefined) {
    throw new Error(`worker=${JSON.stringify(worker)} CLI profile cannot enforce DSH sandbox permission=${JSON.stringify(permission)}; omit permission or omit worker=`);
  }
  return appendSummaryContract(task, { permission: allowConcurrentCwd ? 'read-only' : 'workspace-write' });
}

const settledReportTimestamps = new Map();

function finalizeWorkerResult(view, { inline_limit, full_reply } = {}) {
  if (!view || typeof view !== 'object' || view.status === 'running' || !view.id) return view;
  const dirKey = `${view.id}\0${sessionConfig.report_dir}`;
  let now = settledReportTimestamps.get(dirKey);
  if (!now) {
    if (settledReportTimestamps.size >= 500) {
      settledReportTimestamps.delete(settledReportTimestamps.keys().next().value);
    }
    now = new Date();
    settledReportTimestamps.set(dirKey, now);
  }
  return offloadWorkerResult(view, {
    inlineLimit: inline_limit,
    fullReply: full_reply,
    reportDir: sessionConfig.report_dir,
    now,
  });
}

// Which orchestrator spawned this MCP server — stamped on every job so the
// panel can show where a dispatch came from.
const ORCHESTRATOR = detectOrchestrator();

// ---------- WPC9 guardrails ----------

// Origin chain this crew instance inherited from whoever spawned it (read at
// startup from the env written by the dispatching crew — origin-guard.mjs).
// Every dispatch appends its own hop and refuses loops / over-deep chains
// BEFORE anything is spawned, so recursion can never start burning quota.
const INHERITED_ORIGIN = readInheritedOrigin(process.env);
const depthLimitNow = () => sessionConfig.origin_depth_limit ?? DEFAULT_ORIGIN_DEPTH_LIMIT;

// Hub jobs run inside the DSH host and have no settle callback on this side,
// so the origin recorded at spawn time is kept here and re-attached to every
// hub view this session returns (the hub itself ignores the extra spawn
// fields until the hub side adopts them).
const hubOrigins = new Map();
const hubDispatchMeta = new Map();

function attachOrigin(view, jobId) {
  if (!view || typeof view !== 'object') return view;
  const o = hubOrigins.get(jobId);
  if (o && view.origin_depth === undefined) {
    view.origin_depth = o.depth;
    view.origin_chain = o.chain;
  }
  const m = hubDispatchMeta.get(jobId);
  if (m) {
    if (view.permission === undefined) view.permission = m.permission;
    if (view.effective_sandbox_mode === undefined) view.effective_sandbox_mode = m.effective_sandbox_mode;
    if (view.preset === undefined) view.preset = m.preset;
    if (m.permission_warning && view.permission_warning === undefined) view.permission_warning = m.permission_warning;
  }
  return view;
}

/** Readable refusal payload for the two origin guard checks. */
function originRefusal(res) {
  return text({ error: `dispatch refused by origin guard: ${res.error.reason}`, ...res.error });
}

// ---------- persistent turn watchdog budget ----------

/**
 * The hub-side watchdog budget for ONE persistent turn, derived from the
 * caller's own `timeout_seconds`.
 *
 * The defect this exists for: the hub had a hard 30-minute default and the MCP
 * layer never sent a budget, so `timeout_seconds: 2700` (a legitimate 45-minute
 * turn the tool schema explicitly allows up to 7200) was killed at 30 minutes.
 *
 * The rule: the watchdog must fire AFTER the caller's own deadline, never
 * before. The caller's deadline bounds how long THIS call blocks; the watchdog
 * bounds how long the hub keeps the session claimed before reclaiming it from a
 * hung turn. Those are different questions, so the hub gets a margin:
 *
 *   margin = max(120 s, 10 % of the deadline)
 *
 * - the floor (2 min) covers the last hub poll slice (MAX_POLL_SLICE_SECONDS =
 *   60 s) plus flush/teardown, so a turn that settles at the caller's deadline
 *   is never reported as failed by the watchdog;
 * - the proportional part keeps the margin from swallowing the watchdog on a
 *   long turn (a 2 h turn gets a 12 min margin, not 2 min).
 *
 * Returns `undefined` when no budget can be derived (`timeout_seconds` <= 0, or
 * not a finite number): then the hub's own default applies, which is the
 * documented fallback — this never disables the watchdog by accident.
 */
function persistentTurnWatchdogMs(timeoutSeconds) {
  const seconds = Number(timeoutSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const marginMs = Math.max(120_000, Math.round(seconds * 0.1) * 1000);
  return Math.round(seconds * 1000) + marginMs;
}

/**
 * Acquire the cwd advisory lock for a hub dispatch (job id is unknown until
 * the hub answers, so it is backfilled by updateCwdLockHolder). A conflict
 * against a hub-held lock is re-checked once against the hub: a hub job can
 * settle without this side ever hearing about it, and a stale lock must not
 * permanently block the cwd.
 */
async function acquireDispatchLock({ cwd, backend, mode, allowConcurrent }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return acquireCwdLock({ cwd, jobId: null, backend, mode, startedAt: new Date().toISOString(), allowConcurrent });
    } catch (err) {
      if (!(err instanceof CwdLockError) || attempt > 0 || err.holder.mode !== 'hub') throw err;
      let settled = false;
      try { settled = (await hub.get(err.holder.jobId, 0)).status !== 'running'; }
      catch (e) { if (String(e?.message ?? e).includes('no such job')) settled = true; }
      if (!settled) throw err;
      releaseCwdLockByJobId(err.holder.jobId);
    }
  }
}

function dispatchDisabled() {
  return text({
    error: 'worker dispatch is disabled for this session (set via dsh_worker_config). Report this to the user instead of doing the task yourself.',
  });
}

// ---------- opt-in persistent sessions (hub mode only) ----------

// Stable refusal codes, mirrored from the Hub's own vocabulary so a caller can
// branch on `code` instead of matching English prose.
const PERSISTENT_SESSIONS_DISABLED = 'persistent sessions are disabled: turn them on with dsh_worker_config({ persistent_sessions: true }) (or the DSH settings panel) and retry. Persistent sessions require the DSH hub.';
const INVALID_PERSISTENT_ARGS = 'invalid persistent arguments: pass EITHER persistent: true for the first turn (which creates the session) OR a non-empty session_id for later turns, never both, and never an empty session_id — an empty id is a resumption request with nothing to resume, so it is refused instead of quietly running a cold one-shot task.';
const PERSISTENT_CLI_UNSUPPORTED = 'persistent sessions are not supported for external CLI workers (worker=...): those run a one-shot CLI process with no DSH session to reuse. Omit worker= or leave persistent/session_id unset.';
const PERSISTENT_STANDALONE_UNSUPPORTED = 'persistent sessions need the DSH hub, which is not reachable (this dispatch would fall back to standalone). Start DSH, set mode: "hub" via dsh_worker_config, or use a one-shot dispatch.';
// dsh_spawn_worker is async fan-out and can never host a reusable session, so
// these two arguments are REFUSED rather than stripped. Silently dropping them
// (zod's default for undeclared keys) ran a one-shot job while the caller
// believed it had opened a reusable session — a live Antigravity + DSH hub run
// found exactly that. Use dsh_run_worker (blocking) when you need persistence.
const PERSISTENT_ASYNC_UNSUPPORTED = 'persistent sessions are not supported on dsh_spawn_worker: that tool is async fan-out and always runs a one-shot task, so a requested session would be unusable. Pass neither persistent nor session_id here, or use dsh_run_worker (blocking) with persistent: true for a reusable session.';

/** A refusal that carries its machine-readable code next to the prose. */
function codedRefusal(message, code) {
  return text({ error: message, code });
}

/**
 * Was a `session_id` argument supplied at all?
 *
 * Presence, not content: `session_id: ""` is still a caller ASKING to resume a
 * session, and silently downgrading that to a cold one-shot dispatch would run
 * an unrelated task while the caller believes it continued its session. The
 * empty/blank value is therefore an argument error (INVALID_PERSISTENT_ARGS),
 * never a quiet fallback.
 */
function hasSessionIdArg(value) {
  return value !== undefined && value !== null;
}

/** `session_id` argument -> trimmed id, or null when it carries no usable id. */
function sessionIdArgOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Is the caller asking for persistent mode at all?
 *
 * `persistent: true` and ANY supplied `session_id` (= arguments) are requests.
 * An explicit `persistent: false` names no persistent mode — it is the
 * documented way to say "one-shot, please" — so it must never fail the feature
 * flag.
 */
function persistentRequested({ persistent, sessionIdArg }) {
  return persistent === true || hasSessionIdArg(sessionIdArg);
}

/**
 * The first two persistent-mode refusals, in their fixed order.
 *
 * `sessionIdArg` is the RAW argument (presence matters) and `sessionId` its
 * normalized form (null when blank), so "supplied but unusable" and "supplied
 * alongside persistent: true" are both argument errors rather than silent
 * fallbacks.
 */
function checkPersistentArgs({ persistent, sessionIdArg, sessionId }) {
  if (!sessionConfig.persistent_sessions) return codedRefusal(PERSISTENT_SESSIONS_DISABLED, 'PERSISTENT_SESSIONS_DISABLED');
  if ((typeof persistent === 'boolean' && hasSessionIdArg(sessionIdArg)) || (hasSessionIdArg(sessionIdArg) && sessionId === null)) {
    return codedRefusal(INVALID_PERSISTENT_ARGS, 'INVALID_PERSISTENT_ARGS');
  }
  return null;
}

async function resolveMode() {
  if (sessionConfig.mode === 'standalone') return 'standalone';
  const up = await hubAvailable();
  if (sessionConfig.mode === 'hub' && !up) throw new Error('session mode is "hub" but the DSH workers hub is not reachable');
  return up ? 'hub' : 'standalone';
}

server.registerTool('dsh_run_worker', {
  title: 'Run DSH worker (blocking)',
  description: 'Run one DSH (DeepSeek Harness) coding agent task and block until it finishes. Tier guidance: flash for mechanical, well-scoped work (single-file edits, lookups, formatting); pro for multi-file changes, debugging, and design judgment. The task string must be self-contained: the worker has zero conversation context, so include absolute paths, exact acceptance criteria, and constraints. Set permission ("read-only" | "workspace-write" | "auto" | "full-access") and optional preset per task; the server automatically appends a fixed summary-block contract (read-only: VERDICT + FINDINGS; implementation: CHANGED + VERIFIED + UNVERIFIED) and parses { summary, summary_missing } from the final output. Outputs exceeding inline_limit (default 1500 output tokens / 4000 chars) or non-done jobs are offloaded to report_path (default <cwd>/.dsh-reports/ with .gitignore updated, or ~/.config/dsh-crew/reports fallback when unwritable) and omit the full result unless full_reply=true. Set worker="agy" or "grok" only when the user explicitly asks for that CLI, never as a default. Guardrails refuse (never queue) worker→worker recursion beyond the origin-chain depth cap and a second writer on the same cwd; allow_concurrent_cwd: true only for read-only tasks. OPT-IN PERSISTENT SESSIONS (hub mode, requires persistent_sessions enabled): pass persistent: true to start a reusable DSH session and get its session_id back, then pass that session_id on later calls to append turns to the SAME session with its conversation history intact. Persistent turns keep their locked cwd and agent preset (omit preset after the first turn to inherit it), may switch tier/effort/permission per turn, and never auto-escalate flash -> pro. Close a session with dsh_session_close when done.',
  inputSchema: {
    task: z.string().describe('Full task description for the worker, self-contained'),
    tier: tierSchema,
    effort: effortSchema,
    worker: workerSchema,
    cwd: z.string().optional().describe('Workspace directory for the worker. Relative paths resolve against the caller\'s current workspace; "." or "current" mean the current workspace. Omit for the current workspace.'),
    timeout_seconds: z.number().int().positive().max(7200).optional(),
    allow_concurrent_cwd: allowConcurrentCwdSchema,
    permission: permissionSchema,
    preset: presetSchema,
    inline_limit: inlineLimitSchema,
    full_reply: fullReplySchema,
    persistent: z.boolean().optional().describe('Opt-in persistent sessions (hub mode only, requires persistent_sessions enabled). true starts a NEW reusable DSH session with this task as its first turn and returns session_id in the result. Later turns pass that session_id instead, so the worker keeps its full conversation context. Never combine with session_id. Ignored argument for external CLI workers (worker=...), which are refused.'),
    session_id: z.string().optional().describe('Append this task as the NEXT turn on an existing persistent session (the session_id a previous persistent: true call returned). The session keeps its locked cwd and agent preset: pass the same cwd, and omit preset unless it is the identical one you created the session with. A busy session fails with SESSION_BUSY; a closed one with SESSION_CLOSED. Never combine with persistent: true.'),
  },
}, async ({ task, tier, effort, worker, cwd, timeout_seconds, allow_concurrent_cwd, permission, preset, inline_limit, full_reply, persistent, session_id }) => {
  if (!sessionConfig.enabled) return dispatchDisabled();
  const workDir = resolveWorkerCwd(cwd);
  const e = effort ?? sessionConfig.default_effort;
  const timeout = timeout_seconds ?? sessionConfig.default_timeout_seconds;
  const depthLimit = depthLimitNow();
  // `sessionIdArg` keeps the RAW value so "the caller supplied session_id" (
  // including "") stays distinguishable from "the caller did not"; `sessionId`
  // is the usable id or null.
  const sessionIdArg = session_id;
  const sessionId = sessionIdArgOf(session_id);

  // Persistent-mode gatekeeping happens BEFORE any runtime, lock, or CLI
  // process: an impossible request must cost nothing. Order matters and is
  // fixed: feature flag -> contradictory/unusable args -> unsupported backend.
  let persistentMode = false;
  if (persistentRequested({ persistent, sessionIdArg })) {
    const refused = checkPersistentArgs({ persistent, sessionIdArg, sessionId });
    if (refused) return refused;
    if (worker) return codedRefusal(PERSISTENT_CLI_UNSUPPORTED, 'PERSISTENT_CLI_UNSUPPORTED');
    // Standalone cannot host a session that outlives one turn. `mode: "standalone"`
    // is a decision; an unreachable hub is discovered here, before the spawn.
    if (sessionConfig.mode === 'standalone' || !(await hubAvailable())) {
      return codedRefusal(PERSISTENT_STANDALONE_UNSUPPORTED, 'PERSISTENT_STANDALONE_UNSUPPORTED');
    }
    persistentMode = true;
  }

  // CLI profile dispatch: worker= names a profile and bypasses the
  // hub/standalone tier logic entirely (no tier policy, no escalation — the
  // profile pins backend×model×effort). Calls without worker= are untouched.
  if (worker) {
    const profile = resolveProfile(worker); // throws listing the available profile names
    const cliTask = prepareCliDispatch({ worker, task, permission, allowConcurrentCwd: !!allow_concurrent_cwd });
    const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: profile.backend, cwd: workDir, source: ORCHESTRATOR, depthLimit });
    if (!origin.ok) return originRefusal(origin);
    let job;
    try {
      job = await startCliJob({ worker, task: cliTask, cwd: workDir, timeoutMs: timeout * 1000, source: ORCHESTRATOR, effort, origin: origin.origin, allowConcurrentCwd: !!allow_concurrent_cwd });
    } catch (err) {
      if (err instanceof CwdLockError) return text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder });
      throw err;
    }
    await waitJob(job.id, timeout * 1000);
    const view = jobView(job, { withResult: true });
    if (view.status === 'running') return text({ ...view, note: `still running after ${timeout}s; poll with dsh_worker_result` });
    return text(finalizeWorkerResult(view, { inline_limit, full_reply }));
  }

  const perm = resolveWorkerPermission({ permission, allowConcurrentCwd: !!allow_concurrent_cwd });
  const taskWithContract = appendSummaryContract(task, { permission: perm.permission });

  // ---------- persistent dispatch (opt-in) ----------
  // ONE reusable hub session spread over several blocking calls. The first turn
  // CREATES it (`persistent: true` -> hub.spawn), every later turn appends to it
  // (`session_id` -> hub.sessionTurn).
  //
  // Preset is the tolerant-inheritance rule and the subtle part: only a
  // CALLER-SUPPLIED preset travels on a follow-up. Omitting it is exactly how a
  // session keeps the preset it locked at creation (switching flash <-> pro on
  // turn 2, or editing the panel's preset_flash, must not invalidate it), so
  // resolving this tier's default here and sending THAT would turn a silent
  // inheritance into a SESSION_PRESET_MISMATCH. An explicit preset still travels
  // so the hub can compare it and refuse a real conflict.
  const presetExplicit = typeof preset === 'string' && preset.trim() !== '' ? preset.trim() : null;

  const runPersistent = async (t) => {
    const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: 'hub', cwd: workDir, source: ORCHESTRATOR, depthLimit });
    if (!origin.ok) return { refusal: originRefusal(origin) };
    let lock;
    try {
      lock = await acquireDispatchLock({ cwd: workDir, backend: 'hub', mode: 'hub', allowConcurrent: !!allow_concurrent_cwd });
    } catch (err) {
      if (err instanceof CwdLockError) return { refusal: text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder }) };
      throw err;
    }
    // The lock covers this turn only and is released as soon as the turn
    // settles — never held across idle turns, and never dropped early while a
    // timed-out turn is still running on the hub.
    let spawned;
    let turnSessionId = sessionId;
    let keepLockUntilSettled = false;
    // The hub reclaims a wedged turn on this budget; it must be LARGER than this
    // call's own deadline so a slow-but-healthy turn is never killed first.
    const turnTimeoutMs = persistentTurnWatchdogMs(timeout);
    try {
      const dispatch = {
        task: taskWithContract,
        tier: t,
        effort: e,
        cwd: workDir,
        source: ORCHESTRATOR,
        permission: perm.permission,
        allow_concurrent_cwd: !!allow_concurrent_cwd,
        maxPermission: perm.childMaxPermission,
        ...bindingForTier(t),
        ...(presetExplicit !== null ? { preset: presetExplicit } : {}),
        ...(turnTimeoutMs === undefined ? {} : { turnTimeoutMs }),
        origin_chain: origin.origin.chain,
        origin_depth: origin.origin.depth,
      };
      spawned = sessionId !== null
        ? await hub.sessionTurn(sessionId, dispatch)
        // First turn: the resolved default preset is correct here, because this
        // call is the one that LOCKS it for the session's whole life.
        : await hub.spawn({ task: taskWithContract, tier: t, effort: e, cwd: workDir, source: ORCHESTRATOR, preset: presetForTier(t, preset), permission: perm.permission, allow_concurrent_cwd: !!allow_concurrent_cwd, maxPermission: perm.childMaxPermission, ...bindingForTier(t), persistent: true, ...(turnTimeoutMs === undefined ? {} : { turnTimeoutMs }), origin_chain: origin.origin.chain, origin_depth: origin.origin.depth });
      turnSessionId = spawned?.sessionId ?? spawned?.session_id ?? turnSessionId;
      if (!spawned?.id) {
        return { refusal: text({ error: 'the hub accepted the persistent dispatch but returned no job id', code: 'SESSION_RESUME_FAILED', session_id: turnSessionId }) };
      }
      updateCwdLockHolder({ cwd: workDir, jobId: spawned.id });
      hubOrigins.set(spawned.id, origin.origin);
      hubDispatchMeta.set(spawned.id, { permission: perm.permission, effective_sandbox_mode: perm.effective_sandbox_mode, preset: presetExplicit ?? undefined, ...(perm.permission_warning ? { permission_warning: perm.permission_warning } : {}) });
      const got = await hub.get(spawned.id, timeout);
      attachOrigin(got, spawned.id);
      if (got.status === 'running') {
        keepLockUntilSettled = true;
      }
      // The hub client slices this wait internally; a single request that waits
      // minutes would be cut by undici's 300 s header timeout and reported as a
      // bare "fetch failed" while the job kept running.
      return { view: got, sessionId: turnSessionId };
    } catch (err) {
      // Session-level refusals are answers, not crashes: surface the hub's own
      // stable code (SESSION_BUSY -> retry, SESSION_CLOSED -> start over) next to
      // the prose so the MCP caller never has to match English.
      const code = typeof err?.code === 'string' && /^(SESSION_|INVALID_PERSISTENT)/.test(err.code) ? err.code : null;
      if (code !== null) return { refusal: text({ error: err.message, code, session_id: turnSessionId }) };
      throw err;
    } finally {
      if (!keepLockUntilSettled) lock.release();
    }
  };

  const runOnce = async (t) => {
    const effectivePreset = presetForTier(t, preset);
    if ((await resolveMode()) === 'hub') {
      const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: 'hub', cwd: workDir, source: ORCHESTRATOR, depthLimit });
      if (!origin.ok) return { refusal: originRefusal(origin) };
      let lock;
      try {
        lock = await acquireDispatchLock({ cwd: workDir, backend: 'hub', mode: 'hub', allowConcurrent: !!allow_concurrent_cwd });
      } catch (err) {
        if (err instanceof CwdLockError) return { refusal: text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder }) };
        throw err;
      }
      let spawned;
      try {
        spawned = await hub.spawn({ task: taskWithContract, tier: t, effort: e, cwd: workDir, source: ORCHESTRATOR, preset: effectivePreset, permission: perm.permission, allow_concurrent_cwd: !!allow_concurrent_cwd, maxPermission: perm.childMaxPermission, ...bindingForTier(t), origin_chain: origin.origin.chain, origin_depth: origin.origin.depth });
        updateCwdLockHolder({ cwd: workDir, jobId: spawned.id });
        hubOrigins.set(spawned.id, origin.origin);
        hubDispatchMeta.set(spawned.id, { permission: perm.permission, effective_sandbox_mode: perm.effective_sandbox_mode, preset: effectivePreset, ...(perm.permission_warning ? { permission_warning: perm.permission_warning } : {}) });
      } catch (err) {
        lock.release();
        throw err;
      }
      // The hub client slices this wait internally; a single request that
      // waits minutes would be cut by undici's 300 s header timeout and
      // reported as a bare "fetch failed" while the job kept running.
      const got = await hub.get(spawned.id, timeout);
      attachOrigin(got, spawned.id);
      if (got.status !== 'running') releaseCwdLockByJobId(spawned.id);
      return { view: got };
    }
    const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: 'standalone', cwd: workDir, source: ORCHESTRATOR, depthLimit });
    if (!origin.ok) return { refusal: originRefusal(origin) };
    let job;
    try {
      job = await startJob({ task: taskWithContract, tier: t, effort: e, cwd: workDir, timeoutMs: timeout * 1000, source: ORCHESTRATOR, origin: origin.origin, allowConcurrentCwd: !!allow_concurrent_cwd, permission: perm.permission, maxPermission: perm.childMaxPermission, preset: effectivePreset, ...bindingForTier(t) });
    } catch (err) {
      if (err instanceof CwdLockError) return { refusal: text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder }) };
      throw err;
    }
    await waitJob(job.id, timeout * 1000);
    return { view: jobView(job, { withResult: true }) };
  };

  const firstTier = applyTierPolicy(tier);

  if (persistentMode) {
    // A persistent turn is final: no flash -> pro retry. Escalating on failure
    // would abandon the failed turn's context in place and continue the SAME
    // session on pro, poisoning every later turn with a broken step. The caller
    // decides — retry on the same session, or start a new one.
    const res = await runPersistent(firstTier);
    if (res.refusal) return res.refusal;
    const { view, sessionId: turnSessionId } = res;
    const withSession = { ...view, session_id: turnSessionId ?? null };
    if (withSession.status === 'running') {
      return text({ ...withSession, note: `still running after ${timeout}s; poll with dsh_worker_result, then continue this session with session_id` });
    }
    return text(finalizeWorkerResult(withSession, { inline_limit, full_reply }));
  }

  let res = await runOnce(firstTier);
  if (res.refusal) return res.refusal;
  let job = res.view;
  if (job.status === 'running') return text({ ...job, note: `still running after ${timeout}s; poll with dsh_worker_result` });

  // Escalate on evidence, not prediction: a failed flash run retries once on
  // pro — unless the policy pins the tier to flash.
  if (job.status === 'failed' && sessionConfig.escalate_on_failure
      && firstTier === 'flash' && sessionConfig.tier_policy !== 'flash-only') {
    const firstError = job.error ?? job.stopReason ?? 'unknown failure';
    res = await runOnce('pro');
    if (res.refusal) return res.refusal;
    job = res.view;
    if (job.status === 'running') return text({ ...job, escalated: true, note: `escalated to pro, still running after ${timeout}s; poll with dsh_worker_result` });
    return text(finalizeWorkerResult({ ...job, escalated: true, flash_failure: String(firstError).slice(0, 200) }, { inline_limit, full_reply }));
  }
  return text(finalizeWorkerResult(job, { inline_limit, full_reply }));
});

server.registerTool('dsh_worker_probe', {
  title: 'Probe a configured worker model route',
  description: 'Explicitly test one DSH-configured provider/model with a small no-op tool-call request. Requires the hub. Does not start a worker, touch files, or change bindings; it may consume one model request. A listed provider is not proof of agent/tool support. Results are observations at checked_at, not a permanent capability guarantee.',
  inputSchema: { tier: z.enum(['flash', 'pro']).optional(), provider: z.string().optional(), model: z.string().optional() },
}, async ({ tier, provider, model }) => {
  if (!(await hubAvailable())) return text({ status: 'hub_unavailable', tool_call_verified: false });
  const bound = bindingForTier(tier ?? sessionConfig.default_tier);
  return text(await hub.probe({ provider: provider?.trim() || bound.provider, model: model?.trim() || bound.model }));
});

server.registerTool('dsh_worker_config', {
  title: 'Session worker configuration',
  description: 'Read or update session-level worker settings: enable/disable dispatch, default tier/effort/timeout, execution mode (auto = prefer hub, hub = require the DSH hub, standalone = never use it), tier policy, failure escalation, preset_flash/preset_pro, report_dir (directory for offloaded worker reports; empty string restores <cwd>/.dsh-reports), and which LLM route each tier dispatches to. Call with no arguments to read. To run workers on a local model (Ollama and the like), configure that provider ONCE in DSH and then name it here with flash_provider/flash_model or pro_provider/pro_model — this plugin never defines providers of its own. available_providers lists what the host has configured (hub mode only); bindings shows what each tier currently resolves to. The output includes worker_profiles — the external-CLI backends (agy, grok) usable via the worker= parameter of dsh_run_worker / dsh_spawn_worker — max_permission ceiling, and origin, the inherited worker→worker dispatch chain with its depth limit. Session-only.',
  inputSchema: {
    enabled: z.boolean().optional().describe('false = refuse all worker dispatch this session'),
    default_tier: z.enum(['flash', 'pro']).optional(),
    default_effort: z.enum(['off', 'high', 'max']).optional(),
    mode: z.enum(['auto', 'hub', 'standalone']).optional(),
    default_timeout_seconds: z.number().int().positive().max(7200).optional(),
    tier_policy: z.enum(['auto', 'flash-only', 'pro-only']).optional().describe('flash-only / pro-only clamp every dispatch to one tier'),
    escalate_on_failure: z.boolean().optional().describe('retry a failed blocking flash run once on pro'),
    preset_flash: z.string().optional().describe('hub-mode agent preset for flash workers (preset id, or "default")'),
    preset_pro: z.string().optional().describe('hub-mode agent preset for pro workers (preset id, or "default")'),
    report_dir: z.string().optional().describe('Directory for offloaded worker reports (relative paths resolve against worker cwd; empty string "" restores default <cwd>/.dsh-reports).'),
    flash_provider: z.string().optional().describe('LLM provider route the flash tier dispatches to. Must be a provider DSH already has configured — see available_providers in this tool\'s output. Empty string restores the built-in DeepSeek default. Configure the provider itself in DSH, not here.'),
    flash_model: z.string().optional().describe('Model id for the flash tier, as that provider names it (e.g. a local Ollama model). Empty string restores the default.'),
    pro_provider: z.string().optional().describe('LLM provider route the pro tier dispatches to. Same rules as flash_provider.'),
    pro_model: z.string().optional().describe('Model id for the pro tier. Empty string restores the default.'),
    origin_depth_limit: z.number().int().min(1).max(32).optional().describe('Max worker→worker origin-chain depth (default 3). Deeper dispatches are refused to stop recursive self-amplification; raise only for deliberate deep delegation.'),
    persistent_sessions: z.boolean().optional().describe('Enable opt-in persistent DSH sessions (default false; global config value otherwise). While off, passing persistent/session_id to dsh_run_worker or calling dsh_session_close fails with PERSISTENT_SESSIONS_DISABLED. Turning it on does NOT change existing dispatches: only calls that pass persistent or session_id use a persistent session.'),
    reset: z.boolean().optional().describe('true = restore all defaults first'),
  },
}, async ({ reset, ...patch }) => {
  if (reset) {
    Object.assign(sessionConfig, { enabled: true, ...globalDefaults });
    sessionConfig.origin_depth_limit = DEFAULT_ORIGIN_DEPTH_LIMIT;
  }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) sessionConfig[k] = v;
  const reachable = await hubAvailable();
  const activeHubUrl = reachable ? redactHubUrl(getActiveHubUrl()) : null;
  // Only the hub can enumerate the host's LLM routes (this process has no
  // ctx.llm), so in standalone mode the list is honestly absent rather than
  // empty — "we cannot see them" is not "there are none".
  const available = reachable ? (await hub.providers()).providers : null;
  const bindings = describeBindings(sessionConfig);
  const custom = Object.entries(bindings).filter(([, b]) => b.custom).map(([tier]) => tier);
  const unknown = available === null
    ? []
    : custom.filter((tier) => !available.some((p) => p.id === bindings[tier].provider));
  return text({
    ...sessionConfig,
    hub_reachable: reachable,
    hub_url: activeHubUrl,
    bindings,
    available_providers: available,
    ...(available === null && custom.length > 0
      ? { providers_note: 'The hub is not reachable, so the configured provider ids could not be checked against what DSH actually has. A route DSH does not know will fail at dispatch, not here.' }
      : {}),
    ...(unknown.length > 0
      ? { providers_warning: `DSH has no provider route named ${unknown.map((t) => JSON.stringify(bindings[t].provider)).join(', ')} (bound to: ${unknown.join(', ')}). Configure it in DSH first, or these dispatches will fail.` }
      : {}),
    ...(custom.length > 0
      ? { route_caveat: 'Appearing in available_providers only means an adapter is registered, NOT that it can run a worker. Measured: a route registered purely to re-route another provider fails a dispatch with "registration.adapter.prepareCall is not a function". Nor does DSH report tool-calling support anywhere, and a worker that cannot call tools returns prose and touches no files. A tier bound to a custom route is therefore UNVERIFIED until you call dsh_worker_probe for the configured route; the probe observes one request and is not a permanent capability guarantee.' }
      : {}),
    worker_profiles: listProfiles(),
    max_permission: readMaxPermission() ?? null,
    origin: { chain: INHERITED_ORIGIN.chain, depth: INHERITED_ORIGIN.depth, depth_limit: depthLimitNow() },
  });
});

// `dsh_spawn_worker` is the ASYNC fan-out tool and is deliberately a pure
// one-shot surface: persistent sessions need one long-lived hub agent that
// several BLOCKING turns append to, which is exactly what an async spawn does
// not provide.
//
// The original design assumed "zod will reject an unknown `persistent`", and
// that assumption was wrong: zod's default object behaviour STRIPS undeclared
// keys. A live Antigravity + DSH hub run proved it —
// `dsh_spawn_worker({ task, persistent: true })` silently ran a one-shot task
// with `persistent: false`, and the caller only discovered it turns later.
//
// Two shapes would fix it, and the choice matters:
//   * `.strict()` rejects anything undeclared, but zod's rejection surfaces as a
//     generic McpError "Invalid arguments ..." — no stable code to branch on,
//     and it would also reject every OTHER undeclared key, a much wider
//     behaviour change than this defect.
//   * DECLARING them in `inputSchema` would make `tools/list` advertise
//     `persistent` / `session_id` as usable arguments, contradicting the tool's
//     contract (and the tool-surface test that pins it).
// So: keep the advertised schema as the one-shot surface, register the tool with
// `.passthrough()` (below) so undeclared keys survive parsing instead of being
// dropped, and refuse the two known ones here with a dedicated code.
const spawnWorkerShape = {
  task: z.string().describe('Full task description for the worker, self-contained — the worker has no conversation context, so include absolute paths, acceptance criteria and constraints'),
  tier: tierSchema,
  effort: effortSchema,
  worker: workerSchema,
  cwd: z.string().optional().describe('Workspace directory for the worker. Relative paths resolve against the caller\'s current workspace; "." or "current" mean the current workspace. Omit for the current workspace.'),
  allow_concurrent_cwd: allowConcurrentCwdSchema,
  permission: permissionSchema,
  preset: presetSchema,
};

// The registered tool's `inputSchema` is a ZodObject built from this shape by
// the SDK. Its default behaviour strips undeclared keys BEFORE the callback
// runs, which is what made the refusal below unreachable; `spawnWorkerTool`
// swaps in the passthrough variant after registration (see below), so extra
// keys survive parsing and the handler can refuse them by PRESENCE.
const spawnWorkerTool = server.registerTool('dsh_spawn_worker', {
  title: 'Spawn DSH worker (async)',
  description: 'Start a DSH (DeepSeek Harness) coding agent in the background and return immediately with a job id — use it to fan out several workers in parallel. The spawn response carries claims, not results: always fetch each job\'s final result later with dsh_worker_result (which parses { summary, summary_missing } and offloads large or failed outputs to report_path unless full_reply=true). Same tier guidance as dsh_run_worker: flash for mechanical, well-scoped work, pro for multi-file changes and debugging. Set permission ("read-only" | "workspace-write" | "auto" | "full-access") and optional preset per task; the server automatically appends the summary-block contract (read-only: VERDICT + FINDINGS; implementation: CHANGED + VERIFIED + UNVERIFIED). The task string must be self-contained (absolute paths, acceptance criteria, constraints) — the worker sees nothing of your conversation. worker="agy" or "grok" only when the user explicitly asks for that CLI, never a default. Guardrails refuse (never queue) origin-chain recursion and a second writer on the same cwd; allow_concurrent_cwd: true only for read-only fan-out. This tool is ALWAYS one-shot: persistent sessions are only available on dsh_run_worker, and passing persistent or session_id here is refused with PERSISTENT_ASYNC_UNSUPPORTED, never silently ignored.',
  inputSchema: spawnWorkerShape,
}, async ({ task, tier, effort, worker, cwd, allow_concurrent_cwd, permission, preset, ...undeclared }) => {
  // Presence, not value: `persistent: false` and `session_id: ""` are still a
  // caller asking for async persistence, and silently degrading that to a cold
  // one-shot job is the defect. An omitted key is absent from `undeclared`
  // entirely, which is what keeps an ordinary fan-out dispatch unaffected.
  if ('persistent' in undeclared || 'session_id' in undeclared) {
    return codedRefusal(PERSISTENT_ASYNC_UNSUPPORTED, 'PERSISTENT_ASYNC_UNSUPPORTED');
  }
  if (!sessionConfig.enabled) return dispatchDisabled();
  const workDir = resolveWorkerCwd(cwd);
  const depthLimit = depthLimitNow();
  if (worker) {
    // CLI profile dispatch; no hub/standalone involvement, no tier policy.
    const profile = resolveProfile(worker);
    const cliTask = prepareCliDispatch({ worker, task, permission, allowConcurrentCwd: !!allow_concurrent_cwd });
    const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: profile.backend, cwd: workDir, source: ORCHESTRATOR, depthLimit });
    if (!origin.ok) return originRefusal(origin);
    try {
      const job = await startCliJob({ worker, task: cliTask, cwd: workDir, source: ORCHESTRATOR, effort, origin: origin.origin, allowConcurrentCwd: !!allow_concurrent_cwd });
      return text(jobView(job));
    } catch (err) {
      if (err instanceof CwdLockError) return text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder });
      throw err;
    }
  }
  const perm = resolveWorkerPermission({ permission, allowConcurrentCwd: !!allow_concurrent_cwd });
  const taskWithContract = appendSummaryContract(task, { permission: perm.permission });
  const t = applyTierPolicy(tier);
  const e = effort ?? sessionConfig.default_effort;
  const effectivePreset = presetForTier(t, preset);
  if ((await resolveMode()) === 'hub') {
    const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: 'hub', cwd: workDir, source: ORCHESTRATOR, depthLimit });
    if (!origin.ok) return originRefusal(origin);
    let lock;
    try {
      lock = await acquireDispatchLock({ cwd: workDir, backend: 'hub', mode: 'hub', allowConcurrent: !!allow_concurrent_cwd });
    } catch (err) {
      if (err instanceof CwdLockError) return text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder });
      throw err;
    }
    let spawned;
    try {
      spawned = await hub.spawn({ task: taskWithContract, tier: t, effort: e, cwd: workDir, source: ORCHESTRATOR, preset: effectivePreset, permission: perm.permission, allow_concurrent_cwd: !!allow_concurrent_cwd, maxPermission: perm.childMaxPermission, ...bindingForTier(t), origin_chain: origin.origin.chain, origin_depth: origin.origin.depth });
      updateCwdLockHolder({ cwd: workDir, jobId: spawned.id });
      hubOrigins.set(spawned.id, origin.origin);
      hubDispatchMeta.set(spawned.id, { permission: perm.permission, effective_sandbox_mode: perm.effective_sandbox_mode, preset: effectivePreset, ...(perm.permission_warning ? { permission_warning: perm.permission_warning } : {}) });
    } catch (err) {
      lock.release();
      throw err;
    }
    attachOrigin(spawned, spawned.id);
    return text(spawned);
  }
  const origin = extendOrigin({ inherited: INHERITED_ORIGIN, backend: 'standalone', cwd: workDir, source: ORCHESTRATOR, depthLimit });
  if (!origin.ok) return originRefusal(origin);
  try {
    const job = await startJob({ task: taskWithContract, tier: t, effort: e, cwd: workDir, source: ORCHESTRATOR, origin: origin.origin, allowConcurrentCwd: !!allow_concurrent_cwd, permission: perm.permission, maxPermission: perm.childMaxPermission, preset: effectivePreset, ...bindingForTier(t) });
    return text(jobView(job));
  } catch (err) {
    if (err instanceof CwdLockError) return text({ error: err.message, rejected_by: 'cwd-lock', holder: err.holder });
    throw err;
  }
});

// Post-registration swap, deliberately narrow: only the PARSE behaviour changes,
// so undeclared keys reach the callback instead of being stripped. `tools/list`
// is unaffected because `zodToJsonSchema` reads `properties`, and the advertised
// contract stays exactly `spawnWorkerShape` — the tool still does not offer
// persistent/session_id as usable arguments (tests/persistent-sessions-mcp
// pins that, and it must stay true).
spawnWorkerTool.inputSchema = z.object(spawnWorkerShape).passthrough();

server.registerTool('dsh_worker_status', {
  title: 'DSH worker status',
  description: 'List all DSH worker jobs in this session with live progress (turn/step, current tool, token usage) plus the cwd advisory locks (kind: "cwd-lock" entries show which workspace is held by which running job). Use it before dispatching into a busy workspace and to see whether spawned jobs are still running.',
  inputSchema: {},
}, async () => {
  const hubUp = await hubAvailable();
  const remote = hubUp ? await hub.list().catch(() => null) : [];
  const remoteJobs = remote ?? [];
  if (remote !== null) {
    // The list actually arrived: hub-held locks whose job is settled or gone
    // release now. A failed fetch (remote === null) must NOT release locks —
    // a down hub says nothing about whether its jobs still run.
    const byId = new Map(remoteJobs.map((j) => [j.id, j]));
    for (const l of getCwdLocks()) {
      if (l.holder.mode !== 'hub') continue;
      const j = byId.get(l.holder.jobId);
      if (j === undefined || j.status !== 'running') releaseCwdLockByJobId(l.holder.jobId);
    }
  }
  for (const j of remoteJobs) attachOrigin(j, j.id);
  const local = listJobs().map((j) => jobView(j));
  const locks = getCwdLocks().map((l, i) => ({
    kind: 'cwd-lock',
    id: `cwd-lock-${i + 1}`,
    cwd: l.cwd,
    holder: l.holder,
    note: 'advisory workspace lock: a running worker holds this cwd, so a new dispatch to it is refused (unless allow_concurrent_cwd is set)',
  }));
  return text([...remoteJobs, ...local, ...locks]);
});

server.registerTool('dsh_worker_result', {
  title: 'DSH worker result',
  description: 'Fetch the final result of a worker job, optionally waiting up to wait_seconds. Always call this for spawned jobs: the dsh_spawn_worker response returns only the job id and status claims, never the result. Settled jobs return parsed { summary, summary_missing } from the leading summary block; outputs exceeding inline_limit (default 1500 output tokens / 4000 chars) or non-done jobs are written to report_path (default <cwd>/.dsh-reports/ with .gitignore updated, or ~/.config/dsh-crew/reports fallback when unwritable) and omit full result unless full_reply=true. If a result seems missing or stale (for example after a hub restart orphaned the job), verify against the working tree and dsh_worker_status instead of trusting the summary.',
  inputSchema: {
    job_id: z.string(),
    wait_seconds: z.number().int().min(0).max(7200).default(0).describe('0 = return current state immediately'),
    inline_limit: inlineLimitSchema,
    full_reply: fullReplySchema,
  },
}, async ({ job_id, wait_seconds, inline_limit, full_reply }) => {
  if (job_id.startsWith('hub-')) {
    if (!(await hubAvailable())) return text({ error: 'hub not reachable' });
    const view = await hub.get(job_id, wait_seconds).catch((e) => ({ error: e.message }));
    if (view && view.id) {
      attachOrigin(view, view.id);
      if (view.status !== 'running') {
        releaseCwdLockByJobId(job_id);
        return text(finalizeWorkerResult(view, { inline_limit, full_reply }));
      }
    }
    return text(view);
  }
  if (!getJob(job_id)) return text({ error: `no such job: ${job_id}` });
  const job = await waitJob(job_id, wait_seconds > 0 ? wait_seconds * 1000 : 1);
  const view = jobView(job, { withResult: true });
  if (view.status === 'running') return text(view);
  return text(finalizeWorkerResult(view, { inline_limit, full_reply }));
});

server.registerTool('dsh_worker_cancel', {
  title: 'Cancel DSH worker',
  description: 'Cancel a running worker job: terminates its runtime process and releases its cwd lock. Use it when a workspace lock is held by a job that is stuck or no longer needed, so a new dispatch to that cwd can proceed.',
  inputSchema: { job_id: z.string() },
}, async ({ job_id }) => {
  if (job_id.startsWith('hub-')) {
    if (!(await hubAvailable())) return text({ error: 'hub not reachable' });
    const view = await hub.cancel(job_id).catch((e) => ({ error: e.message }));
    if (view && view.id) {
      attachOrigin(view, view.id);
      releaseCwdLockByJobId(job_id); // cancelled = holder being disposed
    }
    return text(view);
  }
  if (!getJob(job_id)) return text({ error: `no such job: ${job_id}` });
  return text(jobView(await cancelJob(job_id), { withResult: true }));
});

server.registerTool('dsh_session_close', {
  title: 'Close DSH persistent session',
  description: 'Destroy one opt-in persistent DSH session on the hub: its agent, its conversation context and any in-flight turn. Call it when a persistent worker is done for good (before the forwarded subagent ends its life). Only sessions created with persistent: true can be closed; a closed session_id is tombstoned, so a later turn with it fails with SESSION_CLOSED instead of silently starting fresh. Requires persistent_sessions enabled (else PERSISTENT_SESSIONS_DISABLED).',
  inputSchema: {
    session_id: z.string().describe('The session_id a persistent: true dispatch returned'),
  },
}, async ({ session_id }) => {
  // Feature flag first: while persistent sessions are off, that is the reason
  // nothing can be closed, whatever the argument looks like.
  if (!sessionConfig.persistent_sessions) return codedRefusal(PERSISTENT_SESSIONS_DISABLED, 'PERSISTENT_SESSIONS_DISABLED');
  const sessionId = sessionIdArgOf(session_id);
  if (sessionId === null) return codedRefusal('session_id is required', 'INVALID_PERSISTENT_ARGS');
  if (!(await hubAvailable())) return codedRefusal(PERSISTENT_STANDALONE_UNSUPPORTED, 'PERSISTENT_STANDALONE_UNSUPPORTED');
  try {
    const result = await hub.closeSession(sessionId);
    return text({ ...result, session_id: result?.session_id ?? sessionId });
  } catch (err) {
    // Closing is idempotent from the caller's point of view: an already-closed
    // (or never-seen) session leaves nothing behind, and the hub kept the
    // reason in its prose. Report it as an answer, not a crash.
    return text({ error: err?.message ?? String(err), ...(err?.code ? { code: err.code } : {}), session_id: sessionId, closed: false });
  }
});

await server.connect(new StdioServerTransport());
