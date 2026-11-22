---
name: dsh-config
description: Show or set this session's DSH worker defaults (tier / effort / mode / timeout / on-off)
---

Parse the arguments given after this command into key=value pairs: `enabled=true|false`, `tier=flash|pro`, `effort=off|high|max`, `mode=auto|hub|standalone`, `timeout=<seconds>`, `policy=auto|flash-only|pro-only`, `escalate=true|false`, `origin_depth_limit=<1-32>`, `preset_flash=<preset id|default>`, `preset_pro=<preset id|default>`, `report_dir=<path|"">`, `persistent_sessions=true|false`, `reset`. Map them onto the `dsh_worker_config` tool arguments (tier→default_tier, effort→default_effort, timeout→default_timeout_seconds, policy→tier_policy, escalate→escalate_on_failure, origin_depth_limit, preset_flash/preset_pro, persistent_sessions, and report_dir pass through unchanged) and call it; with no arguments, call the tool with no arguments to read the current configuration. Then show the returned configuration (including `hub_reachable`) as one compact table and name the fields that changed. Reply in the language the user is writing in. Do nothing else.

## Opt-in persistent sessions — the config keys

Three keys govern persistent sessions. `persistent_sessions` is the one this command can change; the two reaper keys are **global** settings that the hub reads from `~/.config/dsh-crew/config.json` (they are not `dsh_worker_config` arguments — edit them in the DSH settings panel, or write the config file).

| Key | Default | Meaning |
|---|---|---|
| `persistent_sessions` | `false` | Allows `dsh_run_worker` to take `persistent` / `session_id` and enables `dsh_session_close`. While `false`, a persistent argument fails with `PERSISTENT_SESSIONS_DISABLED`. |
| `persistent_session_idle_timeout_enabled` | `true` | Lets the hub's background reaper close sessions that have been idle past the timeout. A turn that is still running is never reaped. Set `false` to disable reaping entirely. |
| `persistent_session_idle_timeout_minutes` | `30` | Idle minutes before the reaper closes a session. Clamped to `1..1440`; a non-numeric value falls back to `30`. |

- `dsh_worker_config({ persistent_sessions: true })` sets it for **this MCP session only** (the MCP server reads the global config at startup and this call overrides it). The DSH settings panel's matching checkbox writes the same key to `~/.config/dsh-crew/config.json` for future sessions. Turning it on does not change existing dispatches: only calls that actually pass `persistent` or `session_id` use a persistent session, so one-shot dispatches behave exactly as before.
- Turning it **off** does not destroy live sessions; it stops new persistent work and makes `dsh_session_close` itself fail with `PERSISTENT_SESSIONS_DISABLED`. Close sessions before flipping the flag.
- Persistent sessions need the DSH Hub. In `mode: "standalone"` (or with the hub unreachable) a persistent dispatch fails with `PERSISTENT_STANDALONE_UNSUPPORTED`; external CLI profiles (`worker="agy"` / `"grok"`) fail with `PERSISTENT_CLI_UNSUPPORTED`.
- The DSH settings panel exposes the same three knobs — an "enable persistent sessions" checkbox, an "enable idle-timeout reaping" checkbox, and an idle-minutes number field (validated to `1..1440`) — plus an **active persistent sessions** card listing each live session's id (abbreviated), cwd, tier / model, turn count, status, and last-active time, with a **Close** button per row. That card reads the hub directly; it is the quickest way to see what is still alive and to reap a session the reaper has not reached yet.
