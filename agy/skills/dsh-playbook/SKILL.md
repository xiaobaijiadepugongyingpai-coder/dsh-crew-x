---
name: dsh-playbook
description: How to dispatch well — choosing flash vs pro, writing self-contained briefs, parallelism, verifying results, and guardrails
---

When the user asks how to dispatch work to DSH workers — tier choice, writing a brief, one-shot vs persistent sessions, parallelism, verifying results, guardrails — answer from the playbook below. Point to the relevant section rather than reciting it whole.

# DSH Crew — Dispatch Playbook

How to delegate work to DSH workers well. The tool descriptions carry the mechanics; this playbook is the decision layer.

## 1. Choosing a worker

**flash** — mechanical, well-scoped work:
- Rename a symbol in one or two files and update the obvious call sites.
- Read a config file and report the values of a few keys.
- Add a unit test for an existing function, following the file's existing style.

**pro** — multi-file work, debugging, design judgment:
- Refactor a module that is used across the repo and update every caller.
- Diagnose a flaky test or a race condition by reading logs and tracing the code.
- Design a new API or file layout with tradeoffs to weigh, then implement it.

When in doubt, start with flash: escalate_on_failure retries a failed blocking flash run once on pro, so evidence, not guesswork, decides.

**worker="agy" / worker="grok"** is explicit opt-in. Set it only when the user explicitly asks for that CLI, never as a default. Two caveats to tell the user: grok refuses to start repo-local MCP servers in untrusted folders (global installs are unaffected; change directory or pass --trust), and agy runs with full approval because it has no workspace-scoped permission mode.

## 2. Writing the brief

The worker has zero conversation context. Every task string must be self-contained:

- Absolute paths for every file and directory involved.
- Exact acceptance criteria: what must be true when done, and how to verify it.
- What NOT to touch (generated files, unrelated modules, lockfiles).
- Never commit, push, or publish unless the user explicitly authorized it — write that into the brief.
- Set `permission` (`"read-only"`, `"workspace-write"`, `"auto"`, `"full-access"`) and optional `preset` explicitly when needed. `allow_concurrent_cwd: true` defaults `permission` to `"read-only"` and rejects non-read-only permissions; exclusive dispatches default to `"workspace-write"`. Use `"auto"` on Windows when `workspace-write` ACL grants may fail (degrades to a clean temp git worktree, never `"full-access"`).
- The server automatically appends the summary-block contract based on `permission` (unless the brief already includes its keywords), and parses `{ summary, summary_missing }` on completion.

### Brief & summary block templates

**Read-only task (`permission: "read-only"`):**
```
Review <abs/path/to/file_or_dir> for <scope/criteria>. Do not modify any files or commit.
Begin your final response with:
VERDICT: PASS | FAIL | NEEDS_INFO
FINDINGS:
- [severity] file:line | <trigger condition> | <minimal fix>
(Write `- none` under FINDINGS if there are no findings.)
```

**Implementation task (`permission: "workspace-write" | "auto" | "full-access"`):**
```
In <abs/path/to/file>, <exact change and constraints>. Verify by running `<exact command>`. Do not touch unrelated files or commit.
Begin your final response with:
CHANGED:
- <changed file path, or `- none`>
VERIFIED:
- <command/check and observed result, or `- none`>
UNVERIFIED:
- <unverified items/risks honestly listed, or `- none`>
```

## 3. One-shot vs persistent sessions

`dsh_run_worker` is **one-shot by default** and stays that way unless the caller passes `persistent` or `session_id`. Persistent mode is an **opt-in** extra (DSH Hub mode + Antigravity only), off until `persistent_sessions` says otherwise.

**Use one-shot when** the task is self-contained and its value is the result, not the conversation: a rename, a lookup, a single audit, a verification run. Also — and this is a hard rule, not a preference — **every read-only review and every heterogeneous code audit is one-shot**. A reviewer or a cross-model auditor must start from a clean context and be discarded afterwards; a persistent session would carry a previous audit's verdict into the next one.

**Use persistent when** the work genuinely has continuity: an implementation spread over several rounds where turn 2 needs what turn 1 learned, or an orchestrator that must re-brief the same worker as new evidence arrives (re-sending the whole context into a fresh session each round is the cost you are avoiding).

### The 1:1 binding

One reusable forwarding subagent (`ds-flash` / `ds-pro`, kept alive and re-messaged) binds 1:1 to one DSH Hub session, and the two lifecycles are identical:

1. Turn 1: `dsh_run_worker({ persistent: true, ... })` creates the hub session and returns `session_id`.
2. The subagent remembers `session_id` **in its own context** and echoes it back to the orchestrator verbatim, so the orchestrator can reuse the same subagent across `send_message` rounds.
3. Turn 2..N: `dsh_run_worker({ session_id, ... })` appends a turn to that same session, inheriting its full DSH history.
4. When the orchestrator declares the work done, the subagent calls `dsh_session_close({ session_id })` before ending its lifecycle.

Never pass `persistent: true` and `session_id` together — that is `INVALID_PERSISTENT_ARGS`. Each turn still blocks like a one-shot call, so nothing polls. `dsh_spawn_worker` (async fan-out) deliberately has no persistent arguments: fan-out stays stateless.

### Locked vs per-turn

- **Locked for the session's whole life:** `cwd`, and the agent preset it resolved on turn 1. A different workspace needs a new session (reusing the id returns `SESSION_CWD_MISMATCH`).
- **Preset is tolerant, not locked-by-argument:** omit `preset` on later turns and the session keeps the one it locked at creation — switching `flash` <-> `pro`, or editing `preset_flash` / `preset_pro` in the panel, does not invalidate a live session. Only an explicitly supplied, *different* preset fails, with `SESSION_PRESET_MISMATCH`. So the rule is: do not send `preset` unless you mean to pin it.
- **Per-turn movable:** `tier`, `effort`, `permission`. A session may run turn 1 on `flash` and turn 2 on `pro` without losing its context.
- **Serialized:** one turn at a time. A concurrent turn on the same session returns `SESSION_BUSY` (retry once the running turn settles — do not spin). After `dsh_session_close` the id is tombstoned and later turns return `SESSION_CLOSED`.
- **No escalation:** a failed persistent turn is final — there is no `flash` -> `pro` auto-retry, because that would continue the same session on `pro` with the failed turn's context in it. Decide: retry on the same session, or start a new one.
- **Idle, not locked:** the workspace `cwd` lock is held only while a turn runs and released between turns, so an unrelated one-shot dispatch may use the same workspace while a session sits idle.

### `permission: "auto"` and the worktree degradation

`auto` is allowed in persistent mode and normally resolves to `workspace-write`. If a turn hits a Windows ACL failure, the hub transparently rebuilds the underlying session on a temporary git worktree (`%TEMP%\dsh-crew-worktrees\<sessionId>`) and retries that turn there. The response then carries `worktree_path`, `isolation: "git-worktree"` and `degraded_from`, and the **caller keeps using the same `session_id` and the same original `cwd`** — the outward identity and the cwd comparison base do not change, and later turns continue on the worktree by themselves. Tell the user the workspace is now a temporary copy: edits land in the worktree, not in their checkout.

### Rotation and lifecycle

- **Rotate after roughly 10 turns, or when the topic changes.** Context is the whole point of a session and also its liability; stale steps cost tokens and can mislead. Close the old session and open a new one.
- **`dsh_session_close({ session_id })`** destroys the session, its agent, its context and any in-flight turn. Requires `persistent_sessions` on (else `PERSISTENT_SESSIONS_DISABLED`).
- **`dsh_worker_config({ persistent_sessions: true })`** turns the feature on for that MCP session; it reads `~/.config/dsh-crew/config.json` at startup, so without an explicit call the global value wins. Turning it on changes nothing about existing dispatches — only calls that pass `persistent` or `session_id` become persistent.
- **Idle reaping is a hub-side, global setting**, and the knobs live in the config file / settings panel, not in `dsh_worker_config`: `persistent_session_idle_timeout_enabled` (default `true`) and `persistent_session_idle_timeout_minutes` (default `30`, clamped to `1..1440`). A running turn is never reaped. With `persistent_session_idle_timeout_enabled: false` the reaper stops entirely, leaving explicit `dsh_session_close` as the only cleanup.

## 4. Parallelism

- Default: one worker per repo/workspace. The cwd advisory lock enforces this — a second dispatch into a held workspace is refused with the holder's job id, not queued.
- Parallel workers in one repo are only safe with explicitly disjoint file territories AND a named owner for every seam where the two halves meet. Unowned seams are where integration gaps happen; write the seam owner's name into each brief.
- `allow_concurrent_cwd: true` is only for read-only tasks (`permission: "read-only"`). It is never a license for two writers.

## 5. Verifying results & large-result offloading

- Trust artifacts, not claims. Check which files actually changed (git status / git diff) and run the verify scripts or tests the brief demanded.
- Check `summary_missing`: if `summary_missing: true`, treat the report as incomplete / non-compliant and verify or re-run before accepting.
- Large or non-`done` outputs offload automatically to `report_path` (default `<cwd>/.dsh-reports/<YYYYMMDD-HHmmss>-<jobId>.md`, auto-adding `.dsh-reports/` to `<cwd>/.gitignore`; falls back to `~/.config/dsh-crew/reports/<workspace-slug>/` if unwritable; override via `dsh_worker_config` `report_dir`).
  - Default threshold: `tokens.output > 1500` or `result.length > 4000`. Override with `inline_limit` (sets token limit and scales char limit proportionally as `round(inline_limit * 4000 / 1500)`).
  - When offloaded, `dsh_run_worker` / `dsh_worker_result` return `report_path`, `summary`, `summary_missing`, and stats/status without the verbose `result` text (pass `full_reply: true` to force inline `result`). Non-`done` jobs always write `report_path` and return `error`, `stopReason`, `report_path`, `summary`, `summary_missing`, and a bounded partial preview (or full `result` when short or `full_reply: true`).
- A hub restart can orphan a job that then looks finished: if a result seems missing or stale, verify against the working tree and re-check `dsh_worker_status` before trusting the summary.
- Require workers to report unverified claims honestly (`UNVERIFIED`) rather than simulating success. A "done" summary is not proof.

## 6. Guardrails you may hit

- Origin-chain depth cap (3): worker→worker nesting deeper than 3 hops is refused; a cycle (the same backend + cwd appearing twice in the chain) is refused too. These refuse rather than queue — the fix is to wait, or to re-scope the task so a worker does not spawn another worker, never to bypass.
- Permission ceiling (`DSH_CREW_MAX_PERMISSION`): dispatches requesting a higher permission than the inherited ceiling are refused before spawning.
- cwd lock refusal: the error names the holder (job id, backend, start time). Fix: wait for that job to settle, cancel it with `dsh_worker_cancel`, or re-scope to a different workspace. Refusals are readable errors, not bugs.

## 7. Tool quick reference

| Tool | One line |
|---|---|
| `dsh_run_worker` | Run one task and block until it finishes; supports `permission`, `preset`, `inline_limit`, `full_reply`, returning `summary`/`summary_missing` and `report_path` on offload. Also the only persistent entry point: `persistent: true` creates a session, `session_id` appends a turn. |
| `dsh_spawn_worker` | Start a task in the background for fan-out (`permission`, `preset`); returns a job id, not a result. One-shot only — no persistent arguments. |
| `dsh_worker_status` | Live progress of all jobs plus the cwd advisory locks. |
| `dsh_worker_result` | Fetch a job's final result (`wait_seconds`, `inline_limit`, `full_reply`) with parsed `summary`/`summary_missing` and `report_path` when offloaded. |
| `dsh_worker_cancel` | Terminate a running job and release its cwd lock. On a persistent session it cancels only the in-flight turn; the session stays usable. |
| `dsh_session_close` | Destroy one opt-in persistent session (`session_id`): its agent, its context and any in-flight turn. The id is tombstoned afterwards (`SESSION_CLOSED`). |
| `dsh_worker_config` | Read/set session defaults (`default_tier`, `default_effort`, `mode`, `default_timeout_seconds`, `tier_policy`, `escalate_on_failure`, `preset_flash`, `preset_pro`, `report_dir`, `origin_depth_limit`, `persistent_sessions`) and list `worker_profiles` / `max_permission`. |
