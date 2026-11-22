// Pure helpers for opt-in persistent DSH sessions (Hub realm).
//
// A persistent session is one DSH agent/session reused across several turns.
// The hub keeps the authoritative record; this module holds the shapes and the
// pure checks around it so they can be unit-tested without a DSH runtime.
//
// Deliberately imports ONLY Node built-ins and sibling relative modules: this
// file is loaded into the profile realm, and importing our own package copies
// would create duplicate module realms (symbol identity mismatches in the tool
// runtime). Access to the host goes through the injected ctx services only.

import { posix, win32 } from 'node:path';

const DEFAULT_ERROR_STATUS = 400;
const DEFAULT_ERROR_CODE = 'BAD_REQUEST';

/**
 * A request failure the HTTP layer can map to a status and a stable code.
 *
 * The routes answer `{ ok: false, error, code }` with `status`, so a caller can
 * tell a busy session (409, retry later) from a closed one (409, do not retry)
 * without parsing prose.
 */
export class HubRequestError extends Error {
  constructor(message, { status = DEFAULT_ERROR_STATUS, code = DEFAULT_ERROR_CODE } = {}) {
    super(message);
    this.name = 'HubRequestError';
    this.status = status;
    this.code = code;
  }
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The preset id carried by a logged selection.
 *
 * The host's own record is `{ agentPreset }`; a projection or a newer shape may
 * name it `id` or `presetId`, so accept every spelling rather than dropping a
 * selection that is really there.
 */
function presetIdOfSelection(data) {
  if (data === null || typeof data !== 'object') return null;
  return nonBlankString(data.agentPreset)
    ?? nonBlankString(data.id)
    ?? nonBlankString(data.presetId);
}

/**
 * The preset a persisted session actually runs, newest selection winning.
 *
 * Mirrors the host's own session-preset resolution: a session may switch preset
 * while it is still blank, and that switch is a logged
 * `agent-preset/selected` event, so the header alone rebuilds a switched
 * session under the composition it was created with. Defensive on purpose: the
 * log arrives from a persistence backend, so events may be missing, not an
 * array, or carry a half-shaped payload.
 */
export function resolvePersistedSessionPreset(session) {
  const events = Array.isArray(session?.events) ? session.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'agent-preset/selected') continue;
    const id = presetIdOfSelection(event.data);
    // This IS the newest recorded selection, so stop here even when its payload
    // has no usable id — an older selection is not the answer either.
    if (id !== null) return id;
  }
  return nonBlankString(session?.header?.agentPreset);
}

/**
 * One canonical form for cwd comparison.
 *
 * `D:\x`, `d:/x/` and `D:\\x\\.\\` must all compare equal on Windows, while a
 * POSIX path stays case-sensitive (two real directories may differ only by
 * case there). Foreign-platform paths are normalized in their own flavour, the
 * same way `src/paths.mjs` canonicalCwd treats them.
 *
 * Four Windows anomalies this has to get right, because `cwd` is a LOCKED
 * session binding — a wrong answer either refuses a legitimate turn or silently
 * admits a different workspace:
 *
 * 1. **Extended-length prefixes.** `realpathSync.native` legitimately returns
 *    `\\?\D:\x\y` (or `\\?\UNC\srv\share` for a UNC path). Those name the SAME
 *    directory as `D:\x\y` / `\\srv\share`, so the prefix is stripped before
 *    normalising instead of producing a false SESSION_CWD_MISMATCH.
 * 2. **Drive root vs drive-relative.** `D:\` is the root of a drive; `D:` is a
 *    path RELATIVE to that drive's current directory. Stripping the trailing
 *    separator collapsed both to `d:`, silently matching two different
 *    places, so a root keeps its separator.
 * 3. **Drive-relative paths.** `C:foo` is Windows-flavoured even though it has
 *    no separator after the drive; it must not fall through to POSIX
 *    normalisation (which is case-sensitive and would compare `C:foo` to
 *    `c:foo` as different). They canonicalise deterministically, drive letter
 *    lowercased.
 * 4. POSIX behaviour and genuine mismatches are unchanged: a root path keeps a
 *    single `/`, and two DIFFERENT workspaces still compare unequal.
 *
 * macOS/APFS case-insensitivity is deliberately OUT OF SCOPE (owner's ruling):
 * a POSIX path here stays case-sensitive.
 */
export function canonicalSessionCwd(value) {
  const raw = nonBlankString(value);
  if (raw === null) return null;
  let trimmed = raw.trim();

  // 1. Extended-length prefixes name the ordinary path. Handle the UNC form
  //    first, because `\\?\UNC\` also starts with `\\?\`.
  if (/^\\\\\?\\UNC\\/i.test(trimmed)) {
    trimmed = `\\\\${trimmed.slice('\\\\?\\UNC\\'.length)}`;
  } else if (trimmed.startsWith('\\\\?\\')) {
    trimmed = trimmed.slice('\\\\?\\'.length);
  }

  const unified = trimmed.replace(/\\/g, '/');
  // A drive-qualified path (absolute `D:/x` OR drive-relative `C:foo`) is
  // Windows-flavoured; a leading `//` is UNC.
  const windowsFlavoured = /^[a-zA-Z]:/.test(unified) || unified.startsWith('//');

  if (!windowsFlavoured) {
    const normalized = posix.normalize(unified);
    // 4. A POSIX root stays `/`; any other path loses trailing slashes.
    return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
  }

  const normalized = win32.normalize(unified.replace(/\//g, '\\')).replace(/\\/g, '/');
  const lowered = normalized.toLowerCase();
  // 2. A drive root (`d:/`, and a UNC share root) keeps its separator so it can
  //    never collide with the drive-relative `d:` or with `d:foo`.
  if (/^[a-z]:\/$/.test(lowered)) return lowered;
  return lowered.replace(/\/+$/, '');
}

/**
 * Enforce the two session-level bindings a later turn must respect.
 *
 * - `cwd` is locked: a different workspace must start a new session, because
 *   the agent's history belongs to the original workspace.
 * - `preset` is tolerant: a turn that names no preset inherits the one locked
 *   when the session was created (switching flash <-> pro, or editing the
 *   panel's default presets, must not invalidate a live session). Only an
 *   explicit, different preset is an error.
 */
export function validateSessionTurnBinding({ expectedCwd, actualCwd, expectedPreset, explicitPreset } = {}) {
  const actual = canonicalSessionCwd(actualCwd);
  if (actual !== null) {
    const expected = canonicalSessionCwd(expectedCwd);
    if (expected !== null && expected !== actual) {
      throw new HubRequestError(
        `cwd ${JSON.stringify(actualCwd)} does not match this session's locked cwd ${JSON.stringify(expectedCwd)}; start a new session to change the workspace`,
        { status: 400, code: 'SESSION_CWD_MISMATCH' },
      );
    }
  }

  const explicit = nonBlankString(explicitPreset);
  const locked = nonBlankString(expectedPreset);
  if (explicit !== null && locked !== null && explicit.trim() !== locked.trim()) {
    throw new HubRequestError(
      `preset ${JSON.stringify(explicit)} does not match this session's locked preset ${JSON.stringify(locked)}; omit preset to inherit it`,
      { status: 400, code: 'SESSION_PRESET_MISMATCH' },
    );
  }
}

/**
 * Build one persistent session record.
 *
 * `cwd` is the caller-facing workspace the session was created in and stays
 * the comparison baseline for every later turn; `effectiveCwd` is where turns
 * actually run, which differs only after an `auto` ACL degradation rebuilt the
 * underlying session on a temporary git worktree. `selectionRef` is the single
 * mutable {provider, model, reasoningEffort} the agent's model-selection hooks
 * read, so a later turn can switch tier without recreating the agent.
 */
export function createPersistentSessionRecord({
  sessionId,
  cwd,
  preset = null,
  tier = 'flash',
  model = null,
  provider = null,
  selection = null,
  dshSessionId,
  effectiveCwd,
  createdAt,
  lastActiveAt,
} = {}) {
  const now = Date.now();
  return {
    sessionId,
    cwd,
    preset: preset ?? null,
    tier,
    model,
    provider,
    selectionRef: { current: selection, assembled: undefined },
    dshSessionId: dshSessionId ?? sessionId,
    effectiveCwd: effectiveCwd ?? cwd,
    worktreePath: null,
    isolation: null,
    degradedFrom: null,
    turns: 0,
    status: 'idle',
    // Monotonic per-session turn counter. A turn that already timed out can
    // settle LATE (its hung run() finally resolves); without an epoch that late
    // write-back would clobber a SUCCESSOR turn's `running` state and silently
    // release the busy lock, admitting two turns onto one handle. Every write to
    // `status`/`activeJob` from a turn is guarded by "is this still MY epoch?".
    turnEpoch: 0,
    // How long one turn may stay running before the hub reclaims the session
    // (see DEFAULT_PERSISTENT_TURN_TIMEOUT_MS). Per-session override; 0 disables.
    turnTimeoutMs: null,
    lastActiveAt: lastActiveAt ?? now,
    handle: null,
    activeJob: null,
    createdAt: createdAt ?? now,
  };
}

/**
 * The panel/API view of a persistent session, snake_case like the job views.
 * Optional fields appear only once they carry information, so a fresh session
 * is not padded with a dozen nulls.
 */
export function summarizePersistentSession(rec) {
  const summary = {
    session_id: rec?.sessionId ?? null,
    cwd: rec?.cwd ?? null,
    tier: rec?.tier ?? null,
    model: rec?.model ?? null,
    provider: rec?.provider ?? null,
    preset: rec?.preset ?? null,
    turns: rec?.turns ?? 0,
    status: rec?.status ?? null,
    last_active_iso: typeof rec?.lastActiveAt === 'number' ? new Date(rec.lastActiveAt).toISOString() : null,
  };
  if (rec?.dshSessionId) summary.dsh_session_id = rec.dshSessionId;
  if (rec?.worktreePath) {
    summary.worktree_path = rec.worktreePath;
    summary.isolation = rec.isolation ?? null;
    summary.degraded_from = rec.degradedFrom ?? null;
  }
  return summary;
}
