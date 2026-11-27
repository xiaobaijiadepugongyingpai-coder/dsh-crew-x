# Changelog

All notable changes to **`dsh-crew-x`** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.1] - 2026-11-27

### 📦 Marketplace Readiness & Manifest Metadata

- **DSH Plugin Market Metadata**:
  - Declared `engines.dsh` (`>=0.1.0-rc.6 <1.0.0-0`), `dsh.manifestVersion: 1`, `dsh.catalog` (bilingual summary, `workflow` category, capabilities), and `dsh-plugin` npm keyword for compatibility with `@deepseek-ai/dsh-plugin-market-index`, `dsh-plugin-shop`, and `awesome-dsh-plugin`.
  - Added 180×180 PNG storefront icon (`docs/assets/icon-180.png`, < 32 KiB) and `screenshots.json` referencing real DSH Desktop light-theme UI screenshots.
  - Bumped package, `.claude-plugin/plugin.json`, and MCP server version to `0.2.1`.

---

## [0.2.0] - 2026-11-23

Initial Hard Fork release from upstream `ZSeven-W/dsh-crew` (`0.1.0-rc.15` at commit `b00cc6d`).

### 🚀 Major Enhancements & New Features

- **Opt-In Persistent DSH Sessions (`persistent: true`)**:
  - Added 1:1 binding between forwarding subagents and DSH Hub sessions, carrying full conversation history, tool calls, and workspace context across multiple turns.
  - Added new 8th MCP tool: `dsh_session_close({ session_id })` for explicit teardown with persistent tombstone tracking.
  - Implemented background idle session reaper with configurable timeout (`persistent_session_idle_timeout_minutes`, default 30m).
  - Added turn-level watchdog with monotonic `turnEpoch` protection and dynamic budgets calculated from caller `timeout_seconds`.
  - Added active persistent sessions monitor table and per-session job grouping badges (`↻ <shortId> #<turn>`) in the DSH Web UI.

- **Dynamic Hub Port Discovery & Hot Reconnection**:
  - Implemented atomic `~/.config/dsh-crew/hub.json` file-based discovery for randomized loopback ports assigned by DSH Desktop.
  - Added CAS-governed dynamic failover and `ECONNREFUSED` auto-reconnection in `hub-client.mjs`, making DSH Desktop restarts completely seamless.

- **Visual Tier Binding & Route Probe**:
  - Added dynamic Provider/Model selector in DSH settings panel querying `ctx.llm.listProviders()` and `listModels()` (5s timeout isolation, credential redaction).
  - Added inline custom model ID editing (`✎`/`✓`/`×`) and default reset buttons.
  - Added one-click "Test route" probe button for each tier executing a zero-side-effect no-op tool call to verify live routing capability.

- **Per-Task Granular Permissions & Windows Worktree Fallback**:
  - Supported 4 per-task sandbox modes: `read-only`, `workspace-write`, `auto`, and `full-access`.
  - Implemented Windows ACL failure auto-fallback: tasks under `permission: "auto"` encountering `SetNamedSecurityInfoW` or `Win32 5 Access Denied` gracefully migrate to an isolated temporary Git Worktree at `%TEMP%\dsh-crew-worktrees\<id>`, keeping external session identity unchanged.
  - Added `.degradation.json` sidecar metadata ensuring degraded worktrees survive across DSH Hub process restarts.
  - Added `DSH_CREW_MAX_PERMISSION` environment ceiling ensuring non-escalating permission delegation.

- **Structured Summary Contract & Result Offloading**:
  - Automatically appends standardized summary contracts: read-only tasks return `VERDICT` + `FINDINGS`; modification tasks return `CHANGED` + `VERIFIED` + `UNVERIFIED`.
  - Added automatic result offloading: settled outputs exceeding `inline_limit` (default 1500 tokens / 4000 characters) or failed tasks are automatically written to `<cwd>/.dsh-reports/` with `.gitignore` managed idempotently, saving 85%+ host context window.

- **Antigravity Fine-Grained Permissions**:
  - Split MCP tools into Safe (4 low-risk query tools auto-allowed) and Sensitive (4 dispatch/cancel/session tools asking by default).
  - Added CLI flag `--agy-permissions=safe|all|none` and one-click rule copier for Antigravity Desktop App `Global Permissions`.

- **Concurrent Read-Only Execution**:
  - Supported `allow_concurrent_cwd: true` on read-only tasks, unlocking concurrent multi-worker code exploration without workspace write-lock contention.

---

### 🐛 Bug Fixes & Deep Hardening (14 Confirmed Defects Resolved)

1. **Job Cancel 415 Blocking (`0115753`)**: Fixed missing `content-type: application/json` in `dsh_worker_cancel` calls that caused requests to be rejected by P0 JSON guards.
2. **Async Spawn Silent Downgrade (`272bb69`)**: Replaced default Zod parameter stripping with `.passthrough()` and explicit rejection (`PERSISTENT_ASYNC_UNSUPPORTED`) when `persistent` parameters are passed to `dsh_spawn_worker`.
3. **Two-Way ACL False-Positive & Detection Fixes (`cadd24d`, `c8cb5a9`)**: Fixed Win32 ACL error detection to detect stripped stack traces while preventing false positives caused by code comments or string mentions of ACL APIs.
4. **Worktree Degradation Survival (`4d36d24`)**: Guaranteed degraded worktree paths and cwd locks persist and resume properly across Hub restarts.
5. **Caller Watchdog Timeout (`e8e2df6`)**: Replaced hardcoded 30-minute watchdog with dynamic budget derived from caller `timeout_seconds`.
6. **Lenient Preset Inheritance (`7e6aae7`)**: Normalized explicit `preset: "default"` on follow-up turns to prevent false `SESSION_PRESET_MISMATCH` errors.
7. **CWD Advisory Lock Holding on Timeout (`fa097df`)**: Prevented premature release of workspace locks when a timed-out turn is still executing in the Hub runtime.
8. **Session Close Revival Race (`1d8f726`)**: Fixed race condition between `closePersistentSession` and late `agents.resume` events via monotonic `turnEpoch` validation.
9. **Empty Session ID Exploit (`a5eda58`)**: Fixed `session_id: ""` falsy fallback that previously dispatched a silent one-shot job instead of validating existence.
10. **Client Session Close Feedback (`99f1798`)**: Isolated session close failure state so errors are not masked by the 3-second polling cycle.
11. **JSON Content-Type Guards (`1d8f726`)**: Enforced strict `application/json` content-type verification across all 9 Hub mutating routes.
12. **CWD Path Canonicalization (`1d8f726`)**: Normalized casing and directory separators across all session validation paths.
13. **Undici Long-Polling Protection**: Maintained `MAX_POLL_SLICE_SECONDS = 60` to eliminate 300-second Node HTTP header timeout disconnections.
14. **Strict Host Realm Isolation**: Enforced zero `@deepseek-ai/*` imports across all Hub and MCP modules, communicating exclusively via DSH runtime-injected contexts.

---

### ⚠️ Breaking Changes & Migration Notes

- `dsh_spawn_worker` now explicitly rejects `persistent` and `session_id` arguments with error code `PERSISTENT_ASYNC_UNSUPPORTED`.
- When an `auto` task degrades to a Git Worktree on Windows, the returned payload includes `worktree_path` and `isolation: true`.
- Upstream `@zseven-w/dsh-crew` and `dsh-crew-x` should not be enabled simultaneously in the same host configuration to avoid tool name collisions.
