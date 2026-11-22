// Pure view helpers for the worker-jobs table (WPC10), with the WPC13
// workspace-group view layered on top: per-cwd grouping, group-header lock
// badges and finished-job counts. No React, no window: everything is a
// function of the job snapshot, so it is side-effect free and unit-testable
// (scripts/verify-wpc10-client.mjs).

export const ORPHAN_MISSES = 2;         // consecutive OK snapshots without the job -> orphaned
export const GHOST_CAP = 40;            // keep at most this many orphaned records
export const SHARD_STALE_HINT_MIN = 5;  // minutes: surface the stale hint in the tooltip
export const SHARD_STALE_WARN_MIN = 10; // minutes: amber dot instead of blue while still running
export const STALL_SECONDS = 120;       // display-only mirror of STALL_SECONDS in cli-workers.mjs

export interface GhostEntry { job: any; lastSeenAt: number; misses: number; }

/** "3m4s ago"-style readable age for a timestamp (ISO string or epoch ms). */
export function timeAgo(ts: any): string {
  if (ts === undefined || ts === null || ts === '') return '';
  const s = Math.max(0, Math.round((Date.now() - +new Date(ts)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/** Ellipsize a path by trimming the HEAD: the tail (repo name) is the part that matters. */
export function shortPath(p: any): string {
  const s = String(p ?? '');
  if (s.length <= 34) return s;
  return '…' + s.slice(-33);
}

/** Multi-line rendering of an origin chain for tooltips (mirrors origin-guard formatChain). */
export function chainText(chain: any): string {
  if (!Array.isArray(chain)) return '';
  return chain
    .map((h: any, i: number) => `  ${i + 1}. ${h?.source ?? '?'} → ${h?.backend ?? '?'} @ ${h?.cwd ?? '?'}`)
    .join('\n');
}

/** Ordering rank: running → orphaned → everything else (finished). */
function rankOf(j: any): number {
  return j?.status === 'running' || j?.status === 'needs_input' ? 0 : j?.status === 'orphaned' ? 1 : 2;
}

/**
 * Fold a fresh OK /jobs snapshot into the ghost registry. Running jobs are
 * (re-)registered with a fresh snapshot; a previously-running job missing
 * from ORPHAN_MISSES consecutive OK snapshots becomes an orphaned ghost —
 * rendered on the board instead of silently disappearing (WPC10 incident:
 * a hub restart killed a running job and erased every trace of it).
 * A non-OK fetch must never reach this function.
 */
export function reconcileGhosts(live: any[], ghosts: Record<string, GhostEntry>, now: number): Record<string, GhostEntry> {
  const next: Record<string, GhostEntry> = {};
  const terminal = new Set<string>();
  for (const j of live ?? []) {
    if (!j || !j.id) continue;
    if (j.status === 'running') next[j.id] = { job: j, lastSeenAt: now, misses: 0 };
    else terminal.add(j.id); // settled in the feed: the ghost (if any) is done
  }
  for (const [id, g] of Object.entries(ghosts ?? {})) {
    if (!g || !g.job) continue;
    if (next[id] || terminal.has(id)) continue; // still alive, or finished normally
    const lastSeenAt = Number.isFinite(g.lastSeenAt) ? g.lastSeenAt : now;
    const misses = (Number.isFinite(g.misses) ? g.misses : 0) + 1;
    const job = misses >= ORPHAN_MISSES
      ? {
          ...g.job,
          status: 'orphaned',
          orphan: {
            kind: g.job.originWriterAlive === false ? 'writer-gone' : 'vanished',
            origin: g.job.origin ?? null,
            lastSeenAt,
          },
        }
      : g.job; // first miss: keep showing it as running (torn shard-read protection)
    next[id] = { job, lastSeenAt, misses };
  }
  const ids = Object.keys(next).sort((a, b) => next[b].lastSeenAt - next[a].lastSeenAt);
  for (const id of ids.slice(GHOST_CAP)) delete next[id];
  return next;
}

/**
 * The rows the board renders: the live snapshot plus any ghost rows (jobs the
 * feed no longer lists), with running jobs whose writer process is gone
 * re-labeled as orphaned — sorted running-first (running → orphaned →
 * finished, newest startedAt first within each group).
 */
export function displayJobs(live: any[], ghosts: Record<string, GhostEntry>): any[] {
  const rows: any[] = [...(live ?? [])];
  const seen = new Set(rows.map((j) => j?.id));
  for (const [id, g] of Object.entries(ghosts ?? {})) {
    if (seen.has(id) || !g?.job) continue;
    rows.push(g.job);
  }
  return rows
    .map((j) => {
      if (j?.status === 'running' && j.originWriterAlive === false) {
        return { ...j, status: 'orphaned', orphan: { kind: 'writer-gone', origin: j.origin ?? null } };
      }
      return j;
    })
    .sort((a, b) => {
      const d = rankOf(a) - rankOf(b);
      if (d !== 0) return d;
      return +new Date(b?.startedAt ?? 0) - +new Date(a?.startedAt ?? 0);
    });
}

/**
 * Workspaces held by live running jobs, grouped by cwd. This is the panel's
 * view of the cwd-lock table: locks live inside each dispatching MCP session
 * (unreachable from the hub routes), but a running job occupying a cwd is
 * exactly what the lock refuses a second dispatch for.
 */
export function heldWorkspaces(rows: any[]): Array<{ cwd: string; jobs: any[] }> {
  const byCwd = new Map<string, any[]>();
  for (const j of rows ?? []) {
    if (j?.status !== 'running' || !j.cwd) continue;
    const list = byCwd.get(j.cwd) ?? [];
    list.push(j);
    byCwd.set(j.cwd, list);
  }
  return [...byCwd.entries()]
    .map(([cwd, jobs]) => ({
      cwd,
      jobs: jobs.sort((a, b) => +new Date(b.startedAt ?? 0) - +new Date(a.startedAt ?? 0)),
    }))
    .sort((a, b) => a.cwd.localeCompare(b.cwd));
}

/** Dot color + label + tooltip for a job's status cell. */
export function statusInfoOf(job: any, copy: any): { color: string; label: string; title: string } {
  const st = job?.status;
  if (st === 'orphaned') {
    if (job.orphan?.kind === 'writer-gone') {
      return {
        color: '#f0883e',
        label: copy.statusOrphaned,
        title: copy.orphanWriterGone(job.orphan?.origin ?? job.origin ?? '?'),
      };
    }
    return {
      color: '#f0883e',
      label: copy.statusOrphaned,
      title: copy.orphanVanished(timeAgo(job.orphan?.lastSeenAt) || '…'),
    };
  }
  if (st === 'running') {
    if (job.liveness === 'stalled') {
      const last = job.activityLastEventAt ? timeAgo(job.activityLastEventAt) : '';
      return { color: '#d29922', label: copy.statusStalled, title: copy.stalledTip(last) };
    }
    if (job.originShardUpdatedAt) {
      const mins = Math.floor((Date.now() - +new Date(job.originShardUpdatedAt)) / 60_000);
      if (mins >= SHARD_STALE_HINT_MIN) {
        return {
          color: mins >= SHARD_STALE_WARN_MIN ? '#d29922' : '#4a9eff',
          label: copy.statusRunning,
          title: copy.shardStale(mins),
        };
      }
    }
    return { color: '#4a9eff', label: copy.statusRunning, title: copy.statusTitle(st) };
  }
  if (st === 'done') return { color: '#3fb950', label: copy.statusDone, title: copy.statusTitle(st) };
  if (st === 'needs_input') return { color: '#d29922', label: copy.statusNeedsInput, title: copy.statusNeedsInput };
  if (st === 'cancelled') return { color: '#f85149', label: copy.statusCancelled, title: copy.statusTitle(st) };
  return { color: '#f85149', label: copy.statusFailed, title: copy.statusTitle(st ?? '?') };
}

// ---------------------------------------------------------------------------
// WPC13: workspace grouping, group-header lock badges, finished counts.

/**
 * Stable localStorage key for a workspace path (FNV-1a 32-bit → hex): the
 * panel keys per-workspace collapse state by this, so paths never leak into
 * storage keys and survive path reordering.
 */
export function workspaceKey(cwd: string | null | undefined): string {
  let h = 0x811c9dc5;
  const s = cwd == null || cwd === '' ? '\u0000' : String(cwd);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'w' + h.toString(16).padStart(8, '0');
}

/** Directory basename for the group header ("/a/b/c/" → "c", "/" → "/", null → ''). */
export function basenameOf(cwd: string | null | undefined): string {
  if (cwd == null || cwd === '') return '';
  const s = String(cwd);
  if (/^\/+$/.test(s)) return '/';
  const trimmed = s.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

/**
 * Abbreviated full path for the group header: $HOME collapses to ~, and a
 * still-too-long result is middle-ellipsized with both head and tail kept.
 * `home` is optional — browsers cannot read $HOME, so the panel calls this
 * without it and gets the middle-ellipsis behavior alone.
 */
export function abbrevPath(p: any, home?: string | null): string {
  let s = String(p ?? '');
  if (home) {
    if (s === home) return '~';
    if (s.startsWith(home + '/')) s = '~' + s.slice(home.length);
  }
  if (s.length <= 44) return s;
  return s.slice(0, 16) + '…' + s.slice(-26);
}

/**
 * WPC13 workspace grouping: every job row under its cwd; rows without a cwd
 * collect in the trailing null-cwd group. Groups are sorted by path, and
 * within a group running rows come first (running → orphaned → finished,
 * newest startedAt first) — the finished ones feed the "已结束 (n)" fold.
 * Non-job feed entries (kind: "cwd-lock" status rows) are skipped.
 */
export function groupJobs(rows: any[]): Array<{ cwd: string | null; jobs: any[] }> {
  const byCwd = new Map<string, any[]>();
  const none: any[] = [];
  for (const j of rows ?? []) {
    if (!j || j.kind === 'cwd-lock') continue;
    const cwd = j.cwd ? String(j.cwd) : null;
    const list = cwd === null ? none : (byCwd.get(cwd) ?? []);
    if (cwd !== null) byCwd.set(cwd, list);
    list.push(j);
  }
  const sortJobs = (jobs: any[]) => jobs.sort((a, b) => {
    const d = rankOf(a) - rankOf(b);
    if (d !== 0) return d;
    return +new Date(b.startedAt ?? 0) - +new Date(a.startedAt ?? 0);
  });
  const groups = [...byCwd.entries()]
    .map(([cwd, jobs]) => ({ cwd, jobs: sortJobs(jobs) }))
    .sort((a, b) => a.cwd.localeCompare(b.cwd));
  if (none.length > 0) groups.push({ cwd: null, jobs: sortJobs(none) });
  return groups;
}

/** Settled rows (done / failed / cancelled / …) in a group — the per-group "已结束 (n)" fold. */
export function finishedCountOf(jobs: any[]): number {
  return (jobs ?? []).filter((j) => j && rankOf(j) === 2).length;
}

/**
 * WPC13 lock view: which cwd is held by whom, feeding the group-header badge.
 * Primary source: kind:"cwd-lock" status entries (holder = jobId / backend /
 * mode / startedAt, as dsh_worker_status lists them). The panel's /jobs feed
 * does not carry those rows yet, so a running job row is the fallback
 * derivation — a running job occupying a cwd is exactly what the advisory
 * lock refuses a second dispatch for (the same view the deleted
 * held-workspaces card used).
 */
export function workspaceLocks(rows: any[]): Array<{ cwd: string; holder: any }> {
  const locks: Array<{ cwd: string; holder: any }> = [];
  const seen = new Set<string>();
  for (const j of rows ?? []) {
    if (!j || !j.cwd) continue;
    if (j.kind === 'cwd-lock') {
      if (!j.holder) continue;
      const key = `lock:${j.cwd}:${j.holder.jobId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locks.push({ cwd: String(j.cwd), holder: j.holder });
      continue;
    }
    if (j.status === 'running') {
      const key = `job:${j.cwd}:${j.id ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locks.push({
        cwd: String(j.cwd),
        holder: { jobId: j.id, backend: j.backend ?? j.mode, mode: j.mode, startedAt: j.startedAt, cwd: String(j.cwd) },
      });
    }
  }
  return locks;
}

/** "7m42s"-style running age since startedAt (epoch ms or ISO), computed against `now`. */
export function lockAge(startedAt: any, now?: number): string {
  if (startedAt === undefined || startedAt === null || startedAt === '') return '';
  const s = Math.max(0, Math.round(((now ?? Date.now()) - +new Date(startedAt)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

/**
 * Compact lock badge for a workspace group header: "🔒 backend · 7m42s" with
 * the old held-workspaces explanation moved into the title. Returns null when
 * the workspace is free (or has no path). The age is derived from the
 * holder's startedAt, so it ticks on every panel refresh.
 */
export function lockBadgeOf(
  locks: Array<{ cwd: string; holder: any }>,
  cwd: string | null,
  copy: any,
  now?: number,
): { text: string; title: string } | null {
  if (cwd === null) return null;
  const lock = (locks ?? []).find((l) => l.cwd === cwd);
  if (!lock) return null;
  const { holder } = lock;
  return {
    text: `🔒 ${holder?.backend ?? '?'} · ${lockAge(holder?.startedAt, now)}`,
    title: copy?.lockBadgeTip?.(holder) ?? '',
  };
}
// ---------------------------------------------------------------------------
// WPC14: ghost-process liveness probing and the verified-kill badge/button.

/** Min gap between two proc-alive probe attempts for the same ghost. */
export const PROC_PROBE_INTERVAL_MS = 10_000;

/**
 * The pid/pgid pair recorded on a job snapshot, or null when absent or
 * invalid. pid must be a positive integer; a present pgid must be one too.
 * Hub jobs never carry a pid, so their tombstones derive nothing here.
 */
export function ghostPidOf(job: any): { pid: number; pgid: number | null } | null {
  if (!job || typeof job !== 'object') return null;
  const pid = job.pid;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const pgid = job.pgid;
  if (pgid === undefined || pgid === null) return { pid, pgid: null };
  if (!Number.isInteger(pgid) || pgid <= 0) return null;
  return { pid, pgid };
}

/**
 * Badge/button derivation for an orphaned ghost row: only an affirmative
 * proc-alive probe shows the "process still alive" badge and the kill
 * button. No pid, no probe yet, a failed probe (alive: null = probe error /
 * hub unreachable / stale hub) or a dead-process probe all hide it, so the
 * row stays a plain tombstone. A probe failure must never look like a dead
 * process, and a dead process never gets a kill button.
 */
export function procBadgeOf(
  job: any,
  probe: { alive: boolean | null } | null | undefined,
): { pid: number; pgid: number | null } | null {
  if (!job || job.status !== 'orphaned') return null;
  const p = ghostPidOf(job);
  if (!p) return null;
  if (!probe || typeof probe.alive !== 'boolean' || !probe.alive) return null;
  return p;
}

/**
 * Which orphaned ghosts are due for a fresh proc-alive probe: pid-carrying
 * tombstones whose last probe attempt (probedAt, keyed by job id) is older
 * than PROC_PROBE_INTERVAL_MS. Keeps the per-refresh probe storm down to at
 * most one request per ghost per interval, batched by the caller.
 */
export function dueProcProbes(
  ghosts: Record<string, GhostEntry>,
  probedAt: Record<string, number>,
  now: number,
): Array<{ id: string; pid: number; pgid: number | null }> {
  const out: Array<{ id: string; pid: number; pgid: number | null }> = [];
  for (const [id, g] of Object.entries(ghosts ?? {})) {
    if (!g?.job || g.job.status !== 'orphaned') continue;
    const p = ghostPidOf(g.job);
    if (!p) continue;
    const at = probedAt?.[id];
    if (Number.isFinite(at) && now - at < PROC_PROBE_INTERVAL_MS) continue;
    out.push({ id, ...p });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Opt-in persistent sessions: display helpers for the session id, the per-turn
// badge and the session grouping of the jobs board. Pure functions of the job
// snapshot, like the rest of this module.

/** Prefix the hub puts in front of the session UUID ("session-<uuid>"). */
const SESSION_ID_PREFIX = 'session-';
/** How many characters of the session body survive into the compact display id. */
const SESSION_SHORT_LEN = 8;

/**
 * Compact display id for a persistent session: the `session-` prefix is
 * dropped and the first 8 characters of what remains are kept
 * ("session-9f3c1a7e-…" → "9f3c1a7e"). Anything else (another id shape, an
 * empty value, null/undefined) degrades to the first 8 characters of the raw
 * string, and an empty input is just ''. Callers must keep the FULL id in a
 * tooltip/title: this value is for display only and is not an address.
 */
export function shortSessionId(id: any): string {
  const raw = id === null || id === undefined ? '' : String(id);
  if (raw === '') return '';
  const body = raw.startsWith(SESSION_ID_PREFIX) ? raw.slice(SESSION_ID_PREFIX.length) : raw;
  return body.slice(0, SESSION_SHORT_LEN);
}

/**
 * Per-turn badge for a persistent session row: "↻ <shortSessionId> #<turn>".
 * Empty string for everything else, so one-shot rows render exactly as before:
 * a non-persistent job, a persistent job whose turn index is null/undefined
 * (the record exists but no turn ran yet) or a job without a session id.
 * `turnIndex` is tested with `!= null`, never for truthiness — turn 0 is a
 * legitimate value in the persisted record even though turns start at 1.
 */
export function sessionTagOf(job: any): string {
  if (!job || job.persistent !== true) return '';
  const turn = job.turnIndex;
  if (turn === null || turn === undefined) return '';
  const short = shortSessionId(job.sessionId);
  if (short === '') return '';
  return `↻ ${short} #${turn}`;
}

/** One persistent session's turns, as the board renders them (one block). */
export interface SessionJobGroup {
  /** Full session id — the stable React key for the block. */
  sessionId: string;
  /** Compact display id (shortSessionId) for the block header. */
  short: string;
  /** This session's turns, lowest turn index first (input order as the tiebreak). */
  turns: any[];
  /** Highest numeric turn index seen in the block, or null when none carried one. */
  lastTurnIndex: number | null;
  /** True when any turn of the block is still running / waiting for input. */
  active: boolean;
}

/**
 * One step of the grouped walk over a job list: a plain row that stays where it
 * was, or the FIRST turn of a session block — whose remaining turns travel with
 * it (they are not emitted again).
 */
export type SessionGroupedEntry =
  | { kind: 'loose'; job: any }
  | { kind: 'session'; session: SessionJobGroup };

/**
 * Session-grouped view of the jobs board (opt-in persistent sessions). The
 * board keeps its WPC13 workspace grouping: this runs per workspace group, over
 * the same rank-ordered slice the panel already splits into running / finished
 * rows, and it does NOT re-sort that input — the panel's existing ordering
 * semantics are the input contract.
 *
 * Returned shape (deterministic, no timestamps of its own):
 *   {
 *     sessions: SessionJobGroup[],            // first-appearance order
 *     loose:    any[],                        // one-shot rows + persistent rows
 *                                             //   without a sessionId, input order
 *     order:    SessionGroupedEntry[],        // one pass over `jobs`: every
 *                                             //   loose row in place, and each
 *                                             //   session block once, at the
 *                                             //   position of its first turn
 *   }
 * Insertion order is stable across polls for the same live set: a session block
 * is anchored to its first-appearing turn and a session's own turns are ordered
 * by turn index, so a re-poll that merely refreshes fields cannot churn either
 * the block order or the row order inside a block. React keys must be the
 * `sessionId` (and the job id inside a block), never the array index.
 *
 * Non-job feed entries (kind: "cwd-lock" status rows) are skipped, exactly as
 * groupJobs skips them.
 */
export function groupJobsBySession(jobs: any[]): {
  sessions: SessionJobGroup[];
  loose: any[];
  order: SessionGroupedEntry[];
} {
  const bySession = new Map<string, any[]>();
  const loose: any[] = [];
  const anchor: Array<{ sessionId: string } | { job: any }> = [];
  const seenAnchor = new Set<string>();
  for (const j of jobs ?? []) {
    if (!j || j.kind === 'cwd-lock') continue;
    const sid = j.persistent === true && j.sessionId != null && j.sessionId !== ''
      ? String(j.sessionId)
      : '';
    if (sid === '') { loose.push(j); anchor.push({ job: j }); continue; }
    const list = bySession.get(sid) ?? [];
    list.push(j);
    bySession.set(sid, list);
    if (!seenAnchor.has(sid)) { seenAnchor.add(sid); anchor.push({ sessionId: sid }); }
  }
  const turnOf = (j: any): number | null => (typeof j?.turnIndex === 'number' && Number.isFinite(j.turnIndex) ? j.turnIndex : null);
  const sessions: SessionJobGroup[] = [];
  const byId = new Map<string, SessionJobGroup>();
  const order: SessionGroupedEntry[] = [];
  for (const a of anchor) {
    if ('job' in a) { order.push({ kind: 'loose', job: a.job }); continue; }
    const turns = [...(bySession.get(a.sessionId) ?? [])];
    // Lowest turn index first; rows without a numeric index keep their input
    // position after the numbered ones (Array.prototype.sort is stable).
    turns.sort((x, y) => {
      const tx = turnOf(x); const ty = turnOf(y);
      if (tx === null && ty === null) return 0;
      if (tx === null) return 1;
      if (ty === null) return -1;
      return tx - ty;
    });
    const numeric = turns.map(turnOf).filter((n): n is number => n !== null);
    const group: SessionJobGroup = {
      sessionId: a.sessionId,
      short: shortSessionId(a.sessionId),
      turns,
      lastTurnIndex: numeric.length > 0 ? numeric[numeric.length - 1] : null,
      active: turns.some((t) => t?.status === 'running' || t?.status === 'needs_input'),
    };
    sessions.push(group);
    byId.set(a.sessionId, group);
    order.push({ kind: 'session', session: group });
  }
  return { sessions, loose, order };
}
