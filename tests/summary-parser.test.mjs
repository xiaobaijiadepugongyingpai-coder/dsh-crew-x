import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUMMARY_TYPES,
  appendSummaryContract,
  parseWorkerSummary,
} from '../src/summary-parser.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('summary-parser.mjs keeps strict realm isolation (zero @deepseek-ai/* imports)', () => {
  const src = readFileSync(join(ROOT, 'src', 'summary-parser.mjs'), 'utf8');
  assert.equal(/(?:from|import\s*\()\s*['"]@deepseek-ai\//.test(src), false);
});

test('appendSummaryContract appends permission-specific contract and is idempotent', () => {
  const roOnce = appendSummaryContract('Audit src/server.mjs for leaks.', { permission: 'read-only' });
  assert.match(roOnce, /\bVERDICT\b/);
  assert.match(roOnce, /\bFINDINGS\b/);
  assert.doesNotMatch(roOnce, /\bCHANGED\b/);
  assert.equal(appendSummaryContract(roOnce, { permission: 'read-only' }), roOnce);

  // Lowercase prose mentioning verdict/findings still receives the formal contract.
  const prose = appendSummaryContract('Please share your verdict and findings.', { permission: 'read-only' });
  assert.match(prose, /\bVERDICT:/);
  assert.match(prose, /\bFINDINGS:/);

  // Task that already specifies uppercase contract keywords is not duplicated.
  const preContractRo = 'Check foo.mjs.\nVERDICT: PASS|FAIL\nFINDINGS:\n- none';
  assert.equal(appendSummaryContract(preContractRo, { permission: 'read-only' }), preContractRo);

  for (const perm of ['workspace-write', 'auto', 'full-access', undefined]) {
    const implOnce = appendSummaryContract('Update src/a.mjs and run npm test.', { permission: perm });
    assert.match(implOnce, /\bCHANGED\b/);
    assert.match(implOnce, /\bVERIFIED\b/);
    assert.match(implOnce, /\bUNVERIFIED\b/);
    assert.doesNotMatch(implOnce, /\bFINDINGS\b/);
    assert.equal(appendSummaryContract(implOnce, { permission: perm }), implOnce);
  }

  const preContractImpl = 'Fix bar.\nCHANGED:\n- a\nVERIFIED:\n- b\nUNVERIFIED:\n- none';
  assert.equal(appendSummaryContract(preContractImpl, { permission: 'workspace-write' }), preContractImpl);
});

test('parseWorkerSummary parses read-only summary blocks with findings or - none', () => {
  const cleanPass = [
    'VERDICT: PASS',
    'FINDINGS:',
    '- none',
    '',
    'All checks look good across the repository.',
  ].join('\n');

  const parsedPass = parseWorkerSummary(cleanPass, { permission: 'read-only' });
  assert.equal(parsedPass.summary_missing, false);
  assert.equal(parsedPass.summary.type, SUMMARY_TYPES.READ_ONLY);
  assert.equal(parsedPass.summary.verdict, 'PASS');
  assert.deepEqual(parsedPass.summary.findings, []);
  assert.match(parsedPass.summary.raw, /^VERDICT: PASS/);
  assert.doesNotMatch(parsedPass.summary.raw, /All checks look good/);

  const withFindings = [
    '   ',
    'VERDICT: FAIL',
    '',
    'FINDINGS:',
    '- [high] src/server.mjs:42 | missing input validation | validate path before resolve',
    '- [low] src/jobs.mjs:12 | unused helper | remove dead code',
    '',
    'Extra notes below.',
  ].join('\r\n');

  const parsedFail = parseWorkerSummary(withFindings, { permission: 'read-only' });
  assert.equal(parsedFail.summary_missing, false);
  assert.equal(parsedFail.summary.verdict, 'FAIL');
  assert.deepEqual(parsedFail.summary.findings, [
    '[high] src/server.mjs:42 | missing input validation | validate path before resolve',
    '[low] src/jobs.mjs:12 | unused helper | remove dead code',
  ]);
});

test('parseWorkerSummary tolerates leading Markdown code fences and whitespace', () => {
  const fencedRo = [
    '',
    '```text',
    'VERDICT: PASS',
    'FINDINGS:',
    '- none',
    '```',
    '',
    'Detailed analysis follows.',
  ].join('\n');

  const resRo = parseWorkerSummary(fencedRo, { permission: 'read-only' });
  assert.equal(resRo.summary_missing, false);
  assert.equal(resRo.summary.type, 'read-only');
  assert.equal(resRo.summary.verdict, 'PASS');
  assert.deepEqual(resRo.summary.findings, []);

  const fencedImpl = [
    '  ```markdown',
    'CHANGED:',
    '- src/summary-parser.mjs',
    '- tests/summary-parser.test.mjs',
    '',
    'VERIFIED:',
    '- node --test tests/summary-parser.test.mjs (pass)',
    'UNVERIFIED:',
    '- none',
    '```  ',
  ].join('\n');

  const resImpl = parseWorkerSummary(fencedImpl, { permission: 'auto' });
  assert.equal(resImpl.summary_missing, false);
  assert.equal(resImpl.summary.type, 'implementation');
  assert.deepEqual(resImpl.summary.changed, ['src/summary-parser.mjs', 'tests/summary-parser.test.mjs']);
  assert.deepEqual(resImpl.summary.verified, ['node --test tests/summary-parser.test.mjs (pass)']);
  assert.deepEqual(resImpl.summary.unverified, []);
});

test('parseWorkerSummary marks missing or malformed summary blocks as summary_missing: true', () => {
  assert.deepEqual(parseWorkerSummary('', { permission: 'read-only' }), {
    summary: null,
    summary_missing: true,
  });

  // Prose before summary block fails the leading-block contract.
  const proseFirst = 'Here is what I found:\n\nVERDICT: PASS\nFINDINGS:\n- none';
  assert.deepEqual(parseWorkerSummary(proseFirst, { permission: 'read-only' }), {
    summary: null,
    summary_missing: true,
  });

  // Empty FINDINGS or missing VERDICT value is incomplete.
  assert.equal(parseWorkerSummary('VERDICT: PASS\nFINDINGS:\n', { permission: 'read-only' }).summary_missing, true);
  assert.equal(parseWorkerSummary('VERDICT:\nFINDINGS:\n- none', { permission: 'read-only' }).summary_missing, true);

  // Implementation missing UNVERIFIED or having wrong block type is incomplete.
  const missingUnverified = 'CHANGED:\n- src/a.mjs\nVERIFIED:\n- npm test';
  assert.equal(parseWorkerSummary(missingUnverified, { permission: 'workspace-write' }).summary_missing, true);
  assert.equal(parseWorkerSummary('VERDICT: PASS\nFINDINGS:\n- none', { permission: 'workspace-write' }).summary_missing, true);

  // Auto-detection without permission still parses valid blocks and rejects plain prose.
  assert.equal(parseWorkerSummary('VERDICT: PASS\nFINDINGS:\n- none').summary_missing, false);
  assert.equal(parseWorkerSummary('CHANGED:\n- none\nVERIFIED:\n- none\nUNVERIFIED:\n- none').summary_missing, false);
  assert.equal(parseWorkerSummary('just some plain prose').summary_missing, true);
});
