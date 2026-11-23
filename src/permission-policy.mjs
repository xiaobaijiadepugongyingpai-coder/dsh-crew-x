// Per-task permission policy, ceiling enforcement, preset fallback, and
// Windows ACL failure -> temporary git worktree degradation helpers.
//
// Deliberately imports ONLY Node built-ins (no @deepseek-ai/* imports) so both
// the host-profile hub realm and the standalone/MCP realm share one source of
// truth without duplicate module realms.

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PERMISSIONS = Object.freeze(['read-only', 'workspace-write', 'auto', 'full-access']);

export const PERMISSION_LEVEL = Object.freeze({
  'read-only': 0,
  'workspace-write': 1,
  auto: 1,
  'full-access': 2,
});

export const SANDBOX_MODE_BY_PERMISSION = Object.freeze({
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
  auto: 'workspace-write',
  'full-access': 'danger-full-access',
});

export const MAX_PERMISSION_ENV = 'DSH_CREW_MAX_PERMISSION';

export const FULL_ACCESS_WARNING =
  'WARNING: Running with danger-full-access (unrestricted host filesystem/command access).';

/** Structured permission policy violation. */
export class PermissionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PermissionError';
    this.code = code;
  }
}

/** Validate that `value` is one of the 4 supported permission names. */
export function assertValidPermission(value, label = 'permission') {
  if (typeof value !== 'string' || !Object.hasOwn(PERMISSION_LEVEL, value)) {
    throw new PermissionError(
      `unknown ${label} ${JSON.stringify(value)} (expected: ${PERMISSIONS.join(', ')})`,
      label === MAX_PERMISSION_ENV || label === 'maxPermission' ? 'invalid-max-permission' : 'unknown-permission',
    );
  }
  return value;
}

/**
 * Return the stricter of two optional permissions (lower level wins; for level-1
 * tie between 'workspace-write' and 'auto', prefer 'workspace-write').
 */
export function stricterPermission(a, b) {
  if (a === undefined) return b === undefined ? undefined : assertValidPermission(b, 'maxPermission');
  assertValidPermission(a, 'maxPermission');
  if (b === undefined) return a;
  assertValidPermission(b, 'maxPermission');
  const diff = PERMISSION_LEVEL[a] - PERMISSION_LEVEL[b];
  if (diff < 0) return a;
  if (diff > 0) return b;
  if (a === 'workspace-write' || b === 'workspace-write') return 'workspace-write';
  return a;
}

/**
 * Read the effective permission ceiling from `env[DSH_CREW_MAX_PERMISSION]` and
 * an optional explicit `maxPermission` override. When both are set, the
 * stricter ceiling wins so a caller can never raise its own inherited cap.
 */
export function readMaxPermission({ maxPermission, env = process.env } = {}) {
  const envRaw = env?.[MAX_PERMISSION_ENV];
  const hasEnv = envRaw !== undefined && envRaw !== null && String(envRaw).trim() !== '';
  const envCeiling = hasEnv ? assertValidPermission(String(envRaw).trim(), MAX_PERMISSION_ENV) : undefined;
  const optCeiling = maxPermission !== undefined ? assertValidPermission(maxPermission, 'maxPermission') : undefined;
  return stricterPermission(envCeiling, optCeiling);
}

/**
 * Resolve and validate effective task permission, sandbox mode, ceiling, and
 * child cap. Refuses unknown permissions, allow_concurrent_cwd conflicts, and
 * ceiling escalations before any lock or runtime is touched.
 */
export function resolveWorkerPermission({
  permission,
  allowConcurrentCwd = false,
  maxPermission,
  env = process.env,
} = {}) {
  if (permission !== undefined) {
    assertValidPermission(permission, 'permission');
    if (allowConcurrentCwd && permission !== 'read-only') {
      throw new PermissionError(
        `allow_concurrent_cwd requires permission="read-only" (got ${JSON.stringify(permission)})`,
        'concurrent-cwd-conflict',
      );
    }
  }

  // Method B default: concurrent cwd dispatches default to read-only; exclusive
  // dispatches default to workspace-write (never full-access).
  const effectivePermission = permission ?? (allowConcurrentCwd ? 'read-only' : 'workspace-write');
  const ceiling = readMaxPermission({ maxPermission, env });

  if (ceiling !== undefined && PERMISSION_LEVEL[effectivePermission] > PERMISSION_LEVEL[ceiling]) {
    throw new PermissionError(
      `permission "${effectivePermission}" exceeds maxPermission "${ceiling}"`,
      'permission-ceiling-exceeded',
    );
  }

  const effectiveSandboxMode = SANDBOX_MODE_BY_PERMISSION[effectivePermission];
  const childMaxPermission = stricterPermission(ceiling, effectivePermission);

  return {
    permission: effectivePermission,
    effective_sandbox_mode: effectiveSandboxMode,
    maxPermission: ceiling,
    childMaxPermission,
    ...(effectivePermission === 'full-access' ? { permission_warning: FULL_ACCESS_WARNING } : {}),
  };
}

/** Resolve the effective agent preset, preferring an explicit non-blank override. */
export function resolveEffectivePreset({ preset, tier = 'flash', config = {} } = {}) {
  if (typeof preset === 'string' && preset.trim() !== '') return preset.trim();
  const configured = tier === 'flash' ? config?.preset_flash : config?.preset_pro;
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  return 'default';
}

// Names that identify OUR acl runner, plus the class/function markers of the
// host's own ACL package. Deliberately shape-scoped: a bare occurrence of
// `SetNamedSecurityInfoW` or `AclWriteGrant` is NOT an ACL failure, because such
// text legitimately appears in source code, documentation and tool OUTPUT — and
// a false positive silently relocates a worker's uncommitted work into a
// throwaway worktree.
//
// `/SetNamedSecurityInfoW/i` used to sit here bare. It was removed: the real
// failure always carries a `Win32 <code>` (see ACL_WIN32_API_PATTERN), and the
// bare form fired on a code block such as
// `SetNamedSecurityInfoW(p, SE_FILE_OBJECT, DACL, …)` — including when a worker
// merely READ a file containing it.
const ACL_DIRECT_PATTERNS = [
  // The runner's own name is specific enough to stand alone: no ordinary prose
  // or source snippet contains `windows-acl-run` by accident.
  /windows-acl-run/i,
];

// The host ACL package's own symbols. Matched only in an ERROR/STACK shape:
// a failure word next to the marker (either order), or a stack frame. A class
// being NAMED is not a failure — "AclWriteGrant is a helper class that grants
// write ACEs to the workspace SID." must stay false, while
// "at AclWriteGrant.create (…)" and "AclWriteGrant.create failed: …" are real.
const ACL_MARKER_NAMES = 'AclWriteGrant|materializeAclGrant';
const ACL_MARKER_PATTERNS = [
  new RegExp(`\\b(?:${ACL_MARKER_NAMES})\\b[\\s\\S]{0,80}?\\b(?:Win32|failed|failure|error|denied|EACCES|EPERM)\\b`, 'i'),
  new RegExp(`\\b(?:failed|failure|error|denied|EACCES|EPERM)\\b[\\s\\S]{0,80}?\\b(?:${ACL_MARKER_NAMES})\\b`, 'i'),
  new RegExp(`\\bat\\s+(?:async\\s+)?(?:new\\s+)?[\\w.$]*\\b(?:${ACL_MARKER_NAMES})\\b`, 'i'),
];

// Win32 ACL API names that appear in a STRIPPED error message.
//
// `@deepseek-ai/dsh-tools` copies only `error.message` into the `tool/result`
// event, and the hub judges ACL failure from that event — so the class name
// (`AclWriteGrant`) that would match above lives only in the `.stack` the event
// does not carry. A real host `Win32Error` therefore arrives as
// `GetNamedSecurityInfoW failed (Win32 5): <path>` and matched NOTHING, which
// meant `permission: "auto"` never degraded to a worktree on those paths.
//
// These names are matched ONLY in the ACL-specific shape the OS/our runner emits:
// the API name next to a `Win32 <code>` (or a `Win32Error` name) within a short
// window. That boundary is deliberate — a bare substring on
// `CreateRestrictedToken` would fire on ordinary prose ("the code calls
// CreateRestrictedToken"), and a false ACL failure silently moves a worker into a
// throwaway worktree, which is a worse failure than not degrading.
const ACL_WIN32_API_PATTERN = /\b(?:GetNamedSecurityInfoW|SetNamedSecurityInfoW|SetEntriesInAclW|CreateRestrictedToken)\b[\s\S]{0,80}?\bWin32\s*\d+\b/i;
const ACL_WIN32_API_PATTERN_REVERSED = /\bWin32(?:Error)?\b\s*(?:code\s*)?[:=]?\s*\d{1,5}\b[\s\S]{0,80}?\b(?:GetNamedSecurityInfoW|SetNamedSecurityInfoW|SetEntriesInAclW|CreateRestrictedToken)\b/i;

// A real sandbox-creation failure from `@deepseek-ai/dsh-sandbox-windows-acl` that
// carries NO `Win32 <code>` at all:
//
//   CreateRestrictedToken prerequisite failed: no logon SID found …
//
// Decision (deliberate, and tested both ways): this IS an ACL failure. It is the
// only way a restricted token cannot be built, it fails the turn outright, and
// `auto`'s whole purpose is to keep the task running on a worktree instead of
// dying. The match still requires the SPECIFIC pair (the API name AND the
// `prerequisite` failure word within a short window), so a sentence that merely
// mentions `CreateRestrictedToken` stays non-ACL.
const ACL_RESTRICTED_TOKEN_PREREQUISITE_PATTERN = /\bCreateRestrictedToken\b[\s\S]{0,40}?\bprerequisite\b[\s\S]{0,40}?\bfailed\b/i;

const ACL_CONTEXT_PATTERNS = [
  /(?:\bexit(?:\s*code)?\s*[:=]?\s*127\b|\bexitCode\b\s*[:=]\s*127\b)[\s\S]{0,240}(?:acl|windows-acl|sandbox|runner|securityinfo|win32\s*5)/i,
  /(?:acl|windows-acl|sandbox\s*runner|SANDBOX_UNAVAILABLE|Win32\s*5)[\s\S]{0,240}(?:\bexit(?:\s*code)?\s*[:=]?\s*127\b|\bexitCode\b\s*[:=]\s*127\b)/i,
  /(?:acl|dacl|grantWrite|sandbox)[\s\S]{0,120}Win32\s*5\b/i,
  /Win32\s*5\b[\s\S]{0,120}(?:acl|dacl|grantWrite|sandbox)/i,
];

function matchesAclText(text) {
  if (typeof text !== 'string' || text === '') return false;
  return ACL_DIRECT_PATTERNS.some((re) => re.test(text))
    || ACL_MARKER_PATTERNS.some((re) => re.test(text))
    || ACL_WIN32_API_PATTERN.test(text)
    || ACL_WIN32_API_PATTERN_REVERSED.test(text)
    || ACL_RESTRICTED_TOKEN_PREREQUISITE_PATTERN.test(text)
    || ACL_CONTEXT_PATTERNS.some((re) => re.test(text));
}

/**
 * Inspect an error, event, result object, or text tree for Windows ACL sandbox
 * failures (`SetNamedSecurityInfoW`, `windows-acl-run`, or exit 127 ACL runner
 * failure signatures). Cycle-safe.
 */
export function detectWindowsAclFailure(input, visited = new Set()) {
  if (input === null || input === undefined) return false;
  if (typeof input === 'string') return matchesAclText(input);
  if (typeof input !== 'object') return false;
  if (visited.has(input)) return false;
  visited.add(input);

  if (Array.isArray(input)) {
    return input.some((item) => detectWindowsAclFailure(item, visited));
  }

  if (input instanceof Error) {
    if (matchesAclText(input.message) || matchesAclText(input.stack)) return true;
    if (input.cause !== undefined && detectWindowsAclFailure(input.cause, visited)) return true;
    if (Array.isArray(input.errors) && detectWindowsAclFailure(input.errors, visited)) return true;
  }

  // Structured sandbox runner failure metadata (e.g., dsh-tool-bash meta/sandbox).
  if (input.runnerFailed === true && (input.exitCode === 127 || input.mode === 'workspace-write')) {
    return true;
  }
  if (input.sandbox?.runnerFailed === true && (input.exitCode === 127 || input.sandbox?.mode === 'workspace-write')) {
    return true;
  }

  for (const key of Object.keys(input)) {
    if (detectWindowsAclFailure(input[key], visited)) return true;
  }
  return false;
}

function safeRealpath(dir) {
  try {
    return realpathSync.native(dir);
  } catch {
    return resolve(dir);
  }
}

/** Compute the isolated temporary worktree directory for a job id. */
export function buildWorktreePath(jobId, baseDir = join(tmpdir(), 'dsh-crew-worktrees')) {
  const resolvedBase = resolve(baseDir);
  const sanitized = String(jobId ?? 'job')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^\.+$/, 'job')
    .replace(/^\.+/, '');
  const safeId = sanitized || 'job';
  const candidate = resolve(resolvedBase, safeId);
  const rel = relative(resolvedBase, candidate);
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`invalid worktree jobId ${JSON.stringify(jobId)}: escapes baseDir "${resolvedBase}"`);
  }
  return candidate;
}

async function defaultRunGit(args) {
  const { stdout } = await execFileAsync('git', args, { windowsHide: true });
  return stdout;
}

// ---------- persisting an `auto` degradation across a hub restart ----------
//
// DEFECT this exists for: after an `auto` ACL degradation the record held
// `worktreePath`, `dshSessionId = "<id>-wt"`, `isolation` and `degradedFrom` in
// MEMORY only. On a hub restart, recovery resumed the ORIGINAL sessionId on the
// ORIGINAL cwd, so every uncommitted file the worker had produced in the
// worktree silently vanished from the session's view — the caller kept talking to
// a session that looked fine and had lost its work.
//
// The worktree path is deterministic (`%TEMP%\dsh-crew-worktrees\<sessionId>`,
// see buildWorktreePath), so the FACT that a session was degraded is re-derivable
// from the filesystem after the restart. What is NOT re-derivable is the worker's
// cwd inside that worktree (createTempWorktree maps the original cwd's
// repo-relative subdirectory into it) and the sandbox mode it degraded FROM. So a
// small marker file is written NEXT TO the worktree (its own temp base
// directory — never the user's repo and never ~/.config) carrying exactly those
// facts. Recovery: if a worktree for this session id exists, re-attach to
// `<id>-wt` on the cwd recorded there instead of silently reverting.
//
// This adds no new durable store: the worktree itself is the durable artifact,
// and the marker lives beside it, so cleaning up a worktree cleans up its
// marker too.
export const WORKTREE_MARKER_SUFFIX = '.degradation.json';

/** The marker path for one worktree (a sibling, never inside the git worktree). */
export function worktreeMarkerPath(worktreePath) {
  return `${worktreePath}${WORKTREE_MARKER_SUFFIX}`;
}

/**
 * Record the degradation facts beside a worktree. Best effort: a failure to
 * write the marker must never fail the turn that is already running.
 */
export function writeWorktreeMarker({ worktreePath, facts } = {}) {
  if (typeof worktreePath !== 'string' || worktreePath === '') return null;
  const markerPath = worktreeMarkerPath(worktreePath);
  try {
    writeFileSync(markerPath, JSON.stringify({ ...facts, recordedAt: new Date().toISOString() }, null, 2) + '\n');
    return markerPath;
  } catch {
    return null;
  }
}

/** Read a worktree's degradation marker, or null when it is absent/unreadable. */
export function readWorktreeMarker({ worktreePath } = {}) {
  if (typeof worktreePath !== 'string' || worktreePath === '') return null;
  try {
    const parsed = JSON.parse(readFileSync(worktreeMarkerPath(worktreePath), 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Did this session degrade onto a worktree, and where should it resume?
 *
 * Returns `null` when no worktree exists for the session (the ordinary case), or
 * `{ worktreePath, cwd, facts }` when one does. `cwd` prefers the worker cwd the
 * marker recorded (the worktree path plus the original cwd's repo-relative
 * subdirectory) and falls back to the worktree root for a worktree whose marker
 * predates this file — a worktree with uncommitted work is still strictly better
 * than silently resuming on the original cwd.
 */
export function detectPersistedWorktree({ sessionId, baseDir } = {}) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (id === '') return null;
  let worktreePath;
  try {
    worktreePath = buildWorktreePath(id, baseDir);
  } catch {
    return null;
  }
  let stat;
  try {
    stat = statSync(worktreePath);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  const facts = readWorktreeMarker({ worktreePath });
  const recordedCwd = typeof facts?.effectiveCwd === 'string' && facts.effectiveCwd !== '' ? facts.effectiveCwd : null;
  return { worktreePath, cwd: recordedCwd ?? worktreePath, facts };
}

/**
 * Create a clean detached git worktree under `%TEMP%\dsh-crew-worktrees\<jobId>`
 * for `auto` mode Windows ACL fallback. Keeps `effective_sandbox_mode` at
 * `'workspace-write'` rather than escalating permissions.
 */
export async function createTempWorktree({ cwd, jobId, baseDir, runGit = defaultRunGit }) {
  let repoRootRaw;
  try {
    repoRootRaw = (await runGit(['-C', cwd, 'rev-parse', '--show-toplevel'])).trim();
  } catch (err) {
    throw new Error(`auto worktree fallback failed: "${cwd}" is not a git repository (${err?.message ?? err})`, { cause: err });
  }
  if (!repoRootRaw) {
    throw new Error(`auto worktree fallback failed: git rev-parse returned empty root for "${cwd}"`);
  }

  const repoRoot = safeRealpath(repoRootRaw);
  const canonCwd = safeRealpath(cwd);
  const rel = relative(repoRoot, canonCwd);
  const worktreePath = buildWorktreePath(jobId, baseDir);

  mkdirSync(dirname(worktreePath), { recursive: true });
  try {
    await runGit(['-C', repoRoot, 'worktree', 'add', '--detach', worktreePath]);
  } catch (err) {
    throw new Error(`auto worktree fallback failed: git worktree add --detach failed for "${worktreePath}" (${err?.message ?? err})`, { cause: err });
  }

  const workerCwd = rel && rel !== '.' && !isAbsolute(rel) && !rel.startsWith('..')
    ? join(worktreePath, rel)
    : worktreePath;

  return { worktreePath, repoRoot, cwd: workerCwd };
}
