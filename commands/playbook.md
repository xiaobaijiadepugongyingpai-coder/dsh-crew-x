---
description: How to dispatch well — choosing flash vs pro, writing self-contained briefs, parallelism, verifying results, and guardrails
---

When the user asks how to dispatch work to DSH workers — tier choice, writing a brief, parallelism, verifying results, guardrails — answer from the playbook below. Point to the relevant section rather than reciting it whole.

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

## 3. Parallelism

- Default: one worker per repo/workspace. The cwd advisory lock enforces this — a second dispatch into a held workspace is refused with the holder's job id, not queued.
- Parallel workers in one repo are only safe with explicitly disjoint file territories AND a named owner for every seam where the two halves meet. Unowned seams are where integration gaps happen; write the seam owner's name into each brief.
- `allow_concurrent_cwd: true` is only for read-only tasks (`permission: "read-only"`). It is never a license for two writers.

## 4. Verifying results & large-result offloading

- Trust artifacts, not claims. Check which files actually changed (git status / git diff) and run the verify scripts or tests the brief demanded.
- Check `summary_missing`: if `summary_missing: true`, treat the report as incomplete / non-compliant and verify or re-run before accepting.
- Large or non-`done` outputs offload automatically to `report_path` (default `<cwd>/.dsh-reports/<YYYYMMDD-HHmmss>-<jobId>.md`, auto-adding `.dsh-reports/` to `<cwd>/.gitignore`; falls back to `~/.config/dsh-crew/reports/<workspace-slug>/` if unwritable; override via `dsh_worker_config` `report_dir`).
  - Default threshold: `tokens.output > 1500` or `result.length > 4000`. Override with `inline_limit` (sets token limit and scales char limit proportionally as `round(inline_limit * 4000 / 1500)`).
  - When offloaded, `dsh_run_worker` / `dsh_worker_result` return `report_path`, `summary`, `summary_missing`, and stats/status without the verbose `result` text (pass `full_reply: true` to force inline `result`). Non-`done` jobs always write `report_path` and return `error`, `stopReason`, `report_path`, `summary`, `summary_missing`, and a bounded partial preview (or full `result` when short or `full_reply: true`).
- A hub restart can orphan a job that then looks finished: if a result seems missing or stale, verify against the working tree and re-check `dsh_worker_status` before trusting the summary.
- Require workers to report unverified claims honestly (`UNVERIFIED`) rather than simulating success. A "done" summary is not proof.

## 5. Guardrails you may hit

- Origin-chain depth cap (3): worker→worker nesting deeper than 3 hops is refused; a cycle (the same backend + cwd appearing twice in the chain) is refused too. These refuse rather than queue — the fix is to wait, or to re-scope the task so a worker does not spawn another worker, never to bypass.
- Permission ceiling (`DSH_CREW_MAX_PERMISSION`): dispatches requesting a higher permission than the inherited ceiling are refused before spawning.
- cwd lock refusal: the error names the holder (job id, backend, start time). Fix: wait for that job to settle, cancel it with `dsh_worker_cancel`, or re-scope to a different workspace. Refusals are readable errors, not bugs.

## 6. Tool quick reference

| Tool | One line |
|---|---|
| `dsh_run_worker` | Run one task and block until it finishes; supports `permission`, `preset`, `inline_limit`, `full_reply`, returning `summary`/`summary_missing` and `report_path` on offload. |
| `dsh_spawn_worker` | Start a task in the background for fan-out (`permission`, `preset`); returns a job id, not a result. |
| `dsh_worker_status` | Live progress of all jobs plus the cwd advisory locks. |
| `dsh_worker_result` | Fetch a job's final result (`wait_seconds`, `inline_limit`, `full_reply`) with parsed `summary`/`summary_missing` and `report_path` when offloaded. |
| `dsh_worker_cancel` | Terminate a running job and release its cwd lock. |
| `dsh_worker_config` | Read/set session defaults (`default_tier`, `default_effort`, `mode`, `default_timeout_seconds`, `tier_policy`, `escalate_on_failure`, `preset_flash`, `preset_pro`, `report_dir`, `origin_depth_limit`) and list `worker_profiles` / `max_permission`. |
