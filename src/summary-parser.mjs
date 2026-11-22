// Server-side summary block contract & parser for DSH worker reports.
//
// Deliberately uses pure JavaScript only (no @deepseek-ai/* imports) so the
// MCP server and any shared modules never pull in host-realm dependencies.

export const SUMMARY_TYPES = Object.freeze({
  READ_ONLY: 'read-only',
  IMPLEMENTATION: 'implementation',
});

export const READ_ONLY_CONTRACT = [
  'Report format requirement (begin your final response with this exact summary block):',
  'VERDICT: <PASS | FAIL | NEEDS_INFO>',
  'FINDINGS:',
  '- [severity] file:line | <trigger condition> | <minimal fix>',
  '(Write `- none` under FINDINGS if there are no findings.)',
].join('\n');

export const IMPLEMENTATION_CONTRACT = [
  'Report format requirement (begin your final response with this exact summary block):',
  'CHANGED:',
  '- <changed file path, or `- none`>',
  'VERIFIED:',
  '- <verification run and observed result, or `- none`>',
  'UNVERIFIED:',
  '- <unverified items or risks honestly listed, or `- none`>',
].join('\n');

const READ_ONLY_KEYS = new Set(['VERDICT', 'FINDINGS']);
const IMPLEMENTATION_KEYS = new Set(['CHANGED', 'VERIFIED', 'UNVERIFIED']);
const HEADER_RE = /^(?:#{1,6}\s+)?(?:\*\*)?(VERDICT|FINDINGS|CHANGED|VERIFIED|UNVERIFIED)(?:\*\*)?(?:\s*:\s*(.*)|\s*$)/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s+(.+?)\s*$/;
const NONE_RE = /^(?:[-*+]\s*)?\(?none\)?\.?$/i;

/** Map task permission to expected summary contract type (`null` if unspecified). */
export function resolveSummaryType(permission) {
  if (permission === 'read-only') return SUMMARY_TYPES.READ_ONLY;
  if (permission === 'workspace-write' || permission === 'auto' || permission === 'full-access') {
    return SUMMARY_TYPES.IMPLEMENTATION;
  }
  return null;
}

/**
 * Append the fixed summary block contract to `task` based on effective
 * `permission`. Idempotent: if `task` already contains the required contract
 * keywords for its type, returns `task` unchanged.
 */
export function appendSummaryContract(task, { permission } = {}) {
  const base = typeof task === 'string' ? task : String(task ?? '');
  const type = resolveSummaryType(permission) ?? SUMMARY_TYPES.IMPLEMENTATION;

  if (type === SUMMARY_TYPES.READ_ONLY) {
    if (/\bVERDICT\b/.test(base) && /\bFINDINGS\b/.test(base)) return base;
    return base.trim() === '' ? READ_ONLY_CONTRACT : `${base.replace(/\s+$/, '')}\n\n${READ_ONLY_CONTRACT}`;
  }

  if (/\bCHANGED\b/.test(base) && /\bVERIFIED\b/.test(base) && /\bUNVERIFIED\b/.test(base)) return base;
  return base.trim() === '' ? IMPLEMENTATION_CONTRACT : `${base.replace(/\s+$/, '')}\n\n${IMPLEMENTATION_CONTRACT}`;
}

/** Unwrap a single leading fenced code block if the response opens with one. */
function unwrapLeadingFence(text) {
  const trimmed = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimStart();
  const openMatch = trimmed.match(/^(`{3,}|~{3,})[^\n]*\n/);
  if (!openMatch) return trimmed;
  const fence = openMatch[1];
  const fenceChar = fence[0];
  const rest = trimmed.slice(openMatch[0].length);
  const closeRe = new RegExp(`^${fenceChar}{${fence.length},}[ \\t]*$`, 'm');
  const closeMatch = closeRe.exec(rest);
  if (!closeMatch) return trimmed;
  return rest.slice(0, closeMatch.index).trimStart();
}

function normalizeSectionItems(rawItems) {
  if (rawItems.length === 0) return { items: [], hasEntry: false };
  const cleaned = [];
  let sawNone = false;
  for (const entry of rawItems) {
    const value = entry.trim();
    if (!value) continue;
    if (NONE_RE.test(value)) {
      sawNone = true;
    } else {
      cleaned.push(value);
    }
  }
  if (cleaned.length === 0 && !sawNone) return { items: [], hasEntry: false };
  return { items: cleaned, hasEntry: true };
}

/**
 * Parse a worker response's leading summary block.
 * Tolerates leading/trailing whitespace and a leading Markdown code fence.
 * Returns `{ summary, summary_missing }`.
 */
export function parseWorkerSummary(text, { permission } = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { summary: null, summary_missing: true };
  }

  const candidate = unwrapLeadingFence(text);
  const lines = candidate.split('\n');

  let firstIdx = 0;
  while (firstIdx < lines.length && lines[firstIdx].trim() === '') firstIdx++;
  if (firstIdx >= lines.length) return { summary: null, summary_missing: true };

  const firstHeader = lines[firstIdx].trim().match(HEADER_RE);
  if (!firstHeader) return { summary: null, summary_missing: true };

  let expectedType = resolveSummaryType(permission);
  if (expectedType === null) {
    if (READ_ONLY_KEYS.has(firstHeader[1])) expectedType = SUMMARY_TYPES.READ_ONLY;
    else if (IMPLEMENTATION_KEYS.has(firstHeader[1])) expectedType = SUMMARY_TYPES.IMPLEMENTATION;
    else return { summary: null, summary_missing: true };
  }

  const allowedKeys = expectedType === SUMMARY_TYPES.READ_ONLY ? READ_ONLY_KEYS : IMPLEMENTATION_KEYS;
  if (!allowedKeys.has(firstHeader[1])) {
    return { summary: null, summary_missing: true };
  }

  const sections = new Map();
  let currentKey = null;
  let lastLineIdx = firstIdx - 1;

  for (let i = firstIdx; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmedLine = rawLine.trim();

    if (trimmedLine === '') {
      let nextIdx = i + 1;
      while (nextIdx < lines.length && lines[nextIdx].trim() === '') nextIdx++;
      if (nextIdx >= lines.length) break;
      const nextTrimmed = lines[nextIdx].trim();
      const nextHeader = nextTrimmed.match(HEADER_RE);
      if (nextHeader && allowedKeys.has(nextHeader[1])) continue;
      if (currentKey && currentKey !== 'VERDICT' && LIST_ITEM_RE.test(lines[nextIdx])) continue;
      break;
    }

    if (/^(?:[-*_]){3,}$/.test(trimmedLine)) break;

    const headerMatch = trimmedLine.match(HEADER_RE);
    if (headerMatch) {
      const key = headerMatch[1];
      if (!allowedKeys.has(key) || sections.has(key)) break;
      currentKey = key;
      const inline = (headerMatch[2] ?? '').trim();
      const bucket = [];
      if (inline) {
        const listInLine = inline.match(LIST_ITEM_RE);
        bucket.push(listInLine ? listInLine[1].trim() : inline);
      }
      sections.set(key, bucket);
      lastLineIdx = i;
      continue;
    }

    if (!currentKey) break;

    if (currentKey === 'VERDICT') {
      const bucket = sections.get('VERDICT');
      if (bucket.length === 0 && !LIST_ITEM_RE.test(rawLine) && !trimmedLine.startsWith('#')) {
        bucket.push(trimmedLine);
        lastLineIdx = i;
        continue;
      }
      break;
    }

    const listMatch = rawLine.match(LIST_ITEM_RE);
    if (listMatch) {
      sections.get(currentKey).push(listMatch[1].trim());
      lastLineIdx = i;
      continue;
    }

    const bucket = sections.get(currentKey);
    if (bucket.length > 0 && /^\s{2,}\S/.test(rawLine)) {
      bucket[bucket.length - 1] = `${bucket[bucket.length - 1]} ${trimmedLine}`;
      lastLineIdx = i;
      continue;
    }

    break;
  }

  const rawBlock = lines.slice(firstIdx, lastLineIdx + 1).join('\n').trim();

  if (expectedType === SUMMARY_TYPES.READ_ONLY) {
    const verdictParts = sections.get('VERDICT') ?? [];
    const verdict = verdictParts.join(' ').trim();
    const findingsRaw = sections.get('FINDINGS');
    if (!verdict || !findingsRaw) return { summary: null, summary_missing: true };
    const findingsNorm = normalizeSectionItems(findingsRaw);
    if (!findingsNorm.hasEntry) return { summary: null, summary_missing: true };
    return {
      summary: {
        type: SUMMARY_TYPES.READ_ONLY,
        verdict,
        findings: findingsNorm.items,
        raw: rawBlock,
      },
      summary_missing: false,
    };
  }

  const changedRaw = sections.get('CHANGED');
  const verifiedRaw = sections.get('VERIFIED');
  const unverifiedRaw = sections.get('UNVERIFIED');
  if (!changedRaw || !verifiedRaw || !unverifiedRaw) {
    return { summary: null, summary_missing: true };
  }
  const changedNorm = normalizeSectionItems(changedRaw);
  const verifiedNorm = normalizeSectionItems(verifiedRaw);
  const unverifiedNorm = normalizeSectionItems(unverifiedRaw);
  if (!changedNorm.hasEntry || !verifiedNorm.hasEntry || !unverifiedNorm.hasEntry) {
    return { summary: null, summary_missing: true };
  }

  return {
    summary: {
      type: SUMMARY_TYPES.IMPLEMENTATION,
      changed: changedNorm.items,
      verified: verifiedNorm.items,
      unverified: unverifiedNorm.items,
      raw: rawBlock,
    },
    summary_missing: false,
  };
}
