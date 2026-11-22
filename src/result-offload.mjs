// Large-result & failed-job report offloading for DSH workers.
//
// Deliberately imports ONLY Node built-ins and ./summary-parser.mjs (zero
// @deepseek-ai/* imports) so the MCP server remains completely decoupled from
// host-realm SDK modules.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseWorkerSummary } from './summary-parser.mjs';

export const DEFAULT_OUTPUT_TOKEN_LIMIT = 1500;
export const DEFAULT_CHAR_LIMIT = 4000;
export const PARTIAL_RESULT_PREVIEW_LIMIT = 1200;

const DEFAULT_FS_OPS = {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
};

const FALLBACK_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EBADF', 'EIO']);

/**
 * Resolve effective offload thresholds.
 * When `inlineLimit` (positive integer) is specified, it sets the output-token
 * threshold directly and scales the character threshold proportionally
 * (`round(inlineLimit * 4000 / 1500)`), so `inlineLimit = 1500` reproduces the
 * exact default `(1500 tokens, 4000 chars)`.
 */
export function resolveOffloadLimits(inlineLimit) {
  if (inlineLimit === undefined || inlineLimit === null) {
    return { tokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT, charLimit: DEFAULT_CHAR_LIMIT };
  }
  if (!Number.isInteger(inlineLimit) || inlineLimit <= 0) {
    throw new RangeError(`inline_limit must be a positive integer (got ${JSON.stringify(inlineLimit)})`);
  }
  const charLimit = Math.max(1, Math.round((inlineLimit * DEFAULT_CHAR_LIMIT) / DEFAULT_OUTPUT_TOKEN_LIMIT));
  return { tokenLimit: inlineLimit, charLimit };
}

/** True when output tokens or result length exceed the effective inline limits. */
export function shouldOffloadResult({ result, tokens, inlineLimit } = {}) {
  const { tokenLimit, charLimit } = resolveOffloadLimits(inlineLimit);
  const text = typeof result === 'string' ? result : (result == null ? '' : String(result));
  const outputTokens = typeof tokens?.output === 'number' && Number.isFinite(tokens.output) ? tokens.output : null;
  return (outputTokens !== null && outputTokens > tokenLimit) || text.length > charLimit;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function formatReportTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
    + `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

function sanitizeSegment(value, fallback = 'item') {
  const cleaned = String(value ?? '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^\.+/, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || fallback;
}

export function workspaceSlug(cwd) {
  const resolved = resolve(String(cwd || process.cwd()));
  const base = sanitizeSegment(basename(resolved) || 'workspace', 'workspace').slice(0, 40);
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

export function resolveReportTarget({ cwd, reportDir } = {}) {
  const workDir = resolve(String(cwd || process.cwd()));
  const defaultDir = resolve(workDir, '.dsh-reports');
  const configured = typeof reportDir === 'string' ? reportDir.trim() : '';
  const targetDir = configured ? resolve(workDir, configured) : defaultDir;
  return {
    workDir,
    targetDir,
    isDefaultDotReports: targetDir === defaultDir,
  };
}

export function resolveFallbackReportsRoot({ fallbackRoot, env, homeDir } = {}) {
  if (typeof fallbackRoot === 'string' && fallbackRoot.trim() !== '') {
    return resolve(fallbackRoot.trim());
  }
  const home = homeDir ?? env?.HOME ?? env?.USERPROFILE ?? homedir();
  return join(resolve(home), '.config', 'dsh-crew', 'reports');
}

/**
 * Idempotently ensure `<workDir>/.gitignore` ignores `.dsh-reports/`.
 * Never throws if `.gitignore` itself cannot be updated.
 */
export function ensureGitignoreHasReports(workDir, fsOps = DEFAULT_FS_OPS) {
  const gitignorePath = join(workDir, '.gitignore');
  try {
    if (fsOps.existsSync(gitignorePath)) {
      const existing = fsOps.readFileSync(gitignorePath, 'utf8');
      const lines = existing.split(/\r?\n/).map((line) => line.trim());
      if (lines.some((line) => /^\/?\.dsh-reports\/?$/.test(line))) {
        return { updated: false, path: gitignorePath };
      }
      const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
      fsOps.writeFileSync(gitignorePath, `${existing}${prefix}.dsh-reports/\n`, 'utf8');
      return { updated: true, path: gitignorePath };
    }
    fsOps.writeFileSync(gitignorePath, '.dsh-reports/\n', 'utf8');
    return { updated: true, path: gitignorePath };
  } catch {
    return { updated: false, path: gitignorePath };
  }
}

function assertDirWritable(dir, fsOps) {
  fsOps.mkdirSync(dir, { recursive: true });
  const probe = join(dir, `.dsh-write-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fsOps.writeFileSync(probe, '', { flag: 'wx' });
  try {
    fsOps.unlinkSync(probe);
  } catch {
    // Best-effort cleanup of probe file.
  }
}

function isWriteFallbackError(err) {
  if (!err) return false;
  if (FALLBACK_ERROR_CODES.has(err.code)) return true;
  return /EACCES|EPERM|EROFS|permission denied|read-only/i.test(String(err.message ?? err));
}

export function formatReportMarkdown(job, { summaryMissing } = {}) {
  const tokens = job?.tokens ?? {};
  const lines = [
    `# DSH Worker Report: ${job?.id ?? 'unknown'}`,
    '',
    `- status: ${job?.status ?? 'unknown'}`,
    `- stopReason: ${job?.stopReason ?? 'none'}`,
    `- tier: ${job?.tier ?? 'n/a'}`,
    `- model: ${job?.model ?? 'n/a'}`,
    `- provider: ${job?.provider ?? 'n/a'}`,
    `- effort: ${job?.effort ?? 'n/a'}`,
    `- mode: ${job?.mode ?? 'n/a'}`,
    `- permission: ${job?.permission ?? 'n/a'}`,
    `- effective_sandbox_mode: ${job?.effective_sandbox_mode ?? 'n/a'}`,
    `- preset: ${job?.preset ?? 'n/a'}`,
    `- cwd: ${job?.cwd ?? 'n/a'}`,
  ];
  // Persistent sessions: name the session and the turn so a stored report can
  // be traced back to the conversation it came from.
  if (job?.sessionId) lines.push(`- sessionId: ${job.sessionId}`);
  if (job?.turnIndex != null) lines.push(`- turnIndex: ${job.turnIndex}`);
  lines.push(
    `- tokens: input=${tokens.input ?? 0}, output=${tokens.output ?? 0}, reasoning=${tokens.reasoning ?? 0}`,
    `- toolCalls: ${job?.toolCalls ?? 0}`,
    `- startedAt: ${job?.startedAt ?? 'n/a'}`,
    `- endedAt: ${job?.endedAt ?? 'n/a'}`,
    `- summary_missing: ${Boolean(summaryMissing)}`,
  );
  if (job?.error) lines.push(`- error: ${job.error}`);
  lines.push('', '## Full Output', '');
  const body = typeof job?.result === 'string' ? job.result : (job?.result == null ? '' : String(job.result));
  lines.push(body || '_No output captured._', '');
  return lines.join('\n');
}

function writeReportWithFallback({
  job,
  markdown,
  reportDir,
  fallbackRoot,
  env,
  homeDir,
  now,
  fsOps = DEFAULT_FS_OPS,
}) {
  const stamp = formatReportTimestamp(now);
  const safeId = sanitizeSegment(job?.id, 'job');
  const fileName = `${stamp}-${safeId}.md`;
  const { workDir, targetDir, isDefaultDotReports } = resolveReportTarget({ cwd: job?.cwd, reportDir });
  const primaryPath = join(targetDir, fileName);

  try {
    assertDirWritable(targetDir, fsOps);
    fsOps.writeFileSync(primaryPath, markdown, 'utf8');
    if (isDefaultDotReports) ensureGitignoreHasReports(workDir, fsOps);
    return { reportPath: primaryPath, usedFallback: false };
  } catch (err) {
    if (!isWriteFallbackError(err)) throw err;
  }

  const fbRoot = resolveFallbackReportsRoot({ fallbackRoot, env, homeDir });
  const fbDir = join(fbRoot, workspaceSlug(workDir));
  const fbPath = join(fbDir, fileName);
  fsOps.mkdirSync(dirname(fbPath), { recursive: true });
  fsOps.writeFileSync(fbPath, markdown, 'utf8');
  return { reportPath: fbPath, usedFallback: true };
}

/**
 * Process a settled worker job view:
 * - Always extracts `{ summary, summary_missing }` via `parseWorkerSummary`.
 * - For `status === 'done'` within inline limits: returns inline `result` +
 *   `summary` + `summary_missing` (no file written).
 * - For `status === 'done'` exceeding inline limits: writes `report_path` and
 *   omits `result` unless `fullReply === true`.
 * - For non-`'done'` settled jobs (`failed`, `cancelled`, `needs_input`, etc.):
 *   writes `report_path` (including status/error/stopReason/partial result) and
 *   returns `error`, `stopReason`, `report_path`, `summary`, `summary_missing`,
 *   plus partial `result` (truncated preview if overlong unless `fullReply`).
 */
export function offloadWorkerResult(view, options = {}) {
  if (!view || typeof view !== 'object' || view.status === 'running' || !view.id) {
    return view;
  }

  const { inlineLimit, fullReply = false } = options;
  const { charLimit } = resolveOffloadLimits(inlineLimit);
  const rawResult = typeof view.result === 'string'
    ? view.result
    : (view.result == null ? '' : String(view.result));

  const { summary, summary_missing } = parseWorkerSummary(rawResult, { permission: view.permission });
  const isSuccess = view.status === 'done';
  const exceedsLimit = shouldOffloadResult({ result: rawResult, tokens: view.tokens, inlineLimit });

  if (isSuccess && !exceedsLimit) {
    return {
      ...view,
      summary,
      summary_missing,
    };
  }

  const markdown = formatReportMarkdown(view, { summaryMissing: summary_missing });
  const { reportPath } = writeReportWithFallback({
    job: view,
    markdown,
    reportDir: options.reportDir,
    fallbackRoot: options.fallbackRoot,
    env: options.env,
    homeDir: options.homeDir,
    now: options.now,
    fsOps: options.fsOps,
  });

  const out = {
    ...view,
    report_path: reportPath,
    summary,
    summary_missing,
  };

  if (fullReply === true) {
    return out;
  }

  if (isSuccess) {
    delete out.result;
    return out;
  }

  // Failed / non-done job: preserve short partial output verbatim, or provide a
  // bounded preview when the partial output is overlong.
  const previewCap = Math.min(charLimit, PARTIAL_RESULT_PREVIEW_LIMIT);
  if (typeof out.result === 'string' && out.result.length > previewCap) {
    out.result = `${out.result.slice(0, previewCap)}… [truncated; see report_path]`;
  }
  return out;
}
