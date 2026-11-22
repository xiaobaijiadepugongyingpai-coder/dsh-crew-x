import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Isolate HOME / USERPROFILE before importing any config-reading module so
// tests never touch the real %USERPROFILE%\.config\dsh-crew\.
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'dsh-crew-offload-home-'));
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
process.env.HOME = ISOLATED_HOME;
process.env.USERPROFILE = ISOLATED_HOME;

const {
  DEFAULT_OUTPUT_TOKEN_LIMIT,
  DEFAULT_CHAR_LIMIT,
  resolveOffloadLimits,
  shouldOffloadResult,
  ensureGitignoreHasReports,
  offloadWorkerResult,
} = await import('../src/result-offload.mjs');

after(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

test('result-offload.mjs keeps strict realm isolation (zero @deepseek-ai/* imports)', () => {
  const src = readFileSync(join(ROOT, 'src', 'result-offload.mjs'), 'utf8');
  assert.equal(/(?:from|import\s*\()\s*['"]@deepseek-ai\//.test(src), false);
});

test('resolveOffloadLimits and shouldOffloadResult apply default and proportional inline_limit thresholds', () => {
  assert.deepEqual(resolveOffloadLimits(), {
    tokenLimit: DEFAULT_OUTPUT_TOKEN_LIMIT,
    charLimit: DEFAULT_CHAR_LIMIT,
  });
  assert.deepEqual(resolveOffloadLimits(1500), { tokenLimit: 1500, charLimit: 4000 });
  assert.deepEqual(resolveOffloadLimits(300), { tokenLimit: 300, charLimit: 800 });
  assert.throws(() => resolveOffloadLimits(0), RangeError);
  assert.throws(() => resolveOffloadLimits(-5), RangeError);
  assert.throws(() => resolveOffloadLimits(12.5), RangeError);

  assert.equal(shouldOffloadResult({ result: 'a'.repeat(4000), tokens: { output: 1500 } }), false);
  assert.equal(shouldOffloadResult({ result: 'short', tokens: { output: 1501 } }), true);
  assert.equal(shouldOffloadResult({ result: 'a'.repeat(4001), tokens: undefined }), true);
  assert.equal(shouldOffloadResult({ result: 'a'.repeat(800), tokens: { output: 300 }, inlineLimit: 300 }), false);
  assert.equal(shouldOffloadResult({ result: 'a'.repeat(801), tokens: { output: 10 }, inlineLimit: 300 }), true);
  assert.equal(shouldOffloadResult({ result: 'short', tokens: { output: 301 }, inlineLimit: 300 }), true);
});

test('small done results stay inline with parsed summary and create no report file', () => {
  const ws = mkdtempSync(join(ISOLATED_HOME, 'ws-small-'));
  const view = {
    id: 'hub-small-1',
    status: 'done',
    stopReason: 'completed',
    tier: 'flash',
    model: 'deepseek-v4-flash',
    provider: 'deepseek-official',
    effort: 'max',
    cwd: ws,
    mode: 'hub',
    permission: 'read-only',
    effective_sandbox_mode: 'read-only',
    preset: 'minimal',
    tokens: { input: 100, output: 120, reasoning: 0 },
    toolCalls: 1,
    result: 'VERDICT: PASS\nFINDINGS:\n- none\n\nLooks clean.',
  };

  const out = offloadWorkerResult(view, { fallbackRoot: join(ISOLATED_HOME, 'fb') });
  assert.equal(out.result, view.result);
  assert.equal(out.report_path, undefined);
  assert.equal(out.summary_missing, false);
  assert.equal(out.summary.type, 'read-only');
  assert.equal(out.summary.verdict, 'PASS');
  assert.deepEqual(out.summary.findings, []);
  assert.equal(existsSync(join(ws, '.dsh-reports')), false);
});

test('large done results offload to <cwd>/.dsh-reports, maintain .gitignore idempotently, and omit result unless fullReply', () => {
  const ws = mkdtempSync(join(ISOLATED_HOME, 'ws-large-'));
  writeFileSync(join(ws, '.gitignore'), 'node_modules/', 'utf8'); // deliberately no trailing newline

  const longBody = 'x'.repeat(4500);
  const view = {
    id: 'job-large-1',
    status: 'done',
    stopReason: 'completed',
    tier: 'pro',
    model: 'deepseek-v4-pro',
    provider: 'deepseek-official',
    effort: 'max',
    cwd: ws,
    mode: 'standalone',
    permission: 'workspace-write',
    effective_sandbox_mode: 'workspace-write',
    preset: 'default',
    tokens: { input: 200, output: 1800, reasoning: 50 },
    toolCalls: 4,
    result: `CHANGED:\n- src/a.mjs\nVERIFIED:\n- npm test (pass)\nUNVERIFIED:\n- none\n\n${longBody}`,
  };

  const fixedNow = new Date(2026, 10, 22, 15, 30, 45);
  const out = offloadWorkerResult(view, {
    now: fixedNow,
    fallbackRoot: join(ISOLATED_HOME, 'fb'),
  });

  assert.equal('result' in out, false);
  assert.equal(isAbsolute(out.report_path), true);
  assert.equal(out.report_path, join(ws, '.dsh-reports', '20261122-153045-job-large-1.md'));
  assert.equal(existsSync(out.report_path), true);
  const fileText = readFileSync(out.report_path, 'utf8');
  assert.ok(fileText.includes(longBody));
  assert.equal(out.summary_missing, false);
  assert.deepEqual(out.summary.changed, ['src/a.mjs']);
  assert.equal(out.tokens.output, 1800);
  assert.equal(out.toolCalls, 4);

  const giAfterFirst = readFileSync(join(ws, '.gitignore'), 'utf8');
  assert.equal(giAfterFirst, 'node_modules/\n.dsh-reports/\n');

  // Second offload must NOT duplicate .dsh-reports/ in .gitignore; fullReply keeps result inline.
  const outFull = offloadWorkerResult(
    { ...view, id: 'job-large-2' },
    { now: fixedNow, fullReply: true, fallbackRoot: join(ISOLATED_HOME, 'fb') },
  );
  assert.equal(outFull.result, view.result);
  assert.equal(existsSync(outFull.report_path), true);
  assert.equal(readFileSync(join(ws, '.gitignore'), 'utf8'), 'node_modules/\n.dsh-reports/\n');

  // ensureGitignoreHasReports creates .gitignore when missing and recognizes .dsh-reports without trailing slash.
  const wsNoGi = mkdtempSync(join(ISOLATED_HOME, 'ws-nogi-'));
  assert.equal(ensureGitignoreHasReports(wsNoGi).updated, true);
  assert.equal(readFileSync(join(wsNoGi, '.gitignore'), 'utf8'), '.dsh-reports/\n');
  writeFileSync(join(wsNoGi, '.gitignore'), '.dsh-reports\n', 'utf8');
  assert.equal(ensureGitignoreHasReports(wsNoGi).updated, false);
});

test('unwritable primary directory falls back safely to isolated fallbackRoot/<workspace-slug>/', () => {
  const ws = mkdtempSync(join(ISOLATED_HOME, 'ws-ro-'));
  const fbRoot = join(ISOLATED_HOME, 'isolated-reports-root');
  const view = {
    id: 'hub-fb-1',
    status: 'done',
    stopReason: 'completed',
    tier: 'flash',
    cwd: ws,
    mode: 'hub',
    permission: 'read-only',
    tokens: { input: 50, output: 2000, reasoning: 0 },
    toolCalls: 2,
    result: 'VERDICT: PASS\nFINDINGS:\n- none\n',
  };

  // Simulate EACCES on primary directory while allowing fallbackRoot writes.
  const fsOps = {
    existsSync,
    readFileSync,
    unlinkSync,
    mkdirSync(dir, opts) {
      if (resolve(dir).startsWith(resolve(ws))) {
        const err = new Error('permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return mkdirSync(dir, opts);
    },
    writeFileSync(file, data, opts) {
      if (resolve(file).startsWith(resolve(ws))) {
        const err = new Error('permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return writeFileSync(file, data, opts);
    },
  };

  const out = offloadWorkerResult(view, {
    fallbackRoot: fbRoot,
    now: new Date(2026, 10, 22, 9, 5, 3),
    fsOps,
  });

  assert.equal('result' in out, false);
  assert.ok(out.report_path.startsWith(fbRoot), `expected ${out.report_path} under ${fbRoot}`);
  assert.match(out.report_path, /20261122-090503-hub-fb-1\.md$/);
  assert.equal(existsSync(out.report_path), true);
  assert.equal(existsSync(join(ws, '.gitignore')), false);
});

test('failed jobs always write report_path and preserve error, stopReason, and short or truncated partial result', () => {
  const ws = mkdtempSync(join(ISOLATED_HOME, 'ws-fail-'));
  const shortFailed = offloadWorkerResult({
    id: 'job-fail-1',
    status: 'failed',
    error: 'tool crashed',
    stopReason: 'error',
    tier: 'flash',
    cwd: ws,
    mode: 'standalone',
    permission: 'workspace-write',
    tokens: { input: 10, output: 25, reasoning: 0 },
    toolCalls: 1,
    result: 'partial output before crash',
  });

  assert.equal(shortFailed.error, 'tool crashed');
  assert.equal(shortFailed.stopReason, 'error');
  assert.equal(shortFailed.result, 'partial output before crash');
  assert.equal(shortFailed.summary_missing, true);
  assert.equal(existsSync(shortFailed.report_path), true);
  const reportText = readFileSync(shortFailed.report_path, 'utf8');
  assert.match(reportText, /- error: tool crashed/);
  assert.match(reportText, /partial output before crash/);

  const longPartial = 'z'.repeat(2000);
  const longFailed = offloadWorkerResult({
    id: 'job-fail-2',
    status: 'failed',
    error: 'max_tokens',
    stopReason: 'max_tokens',
    cwd: ws,
    permission: 'workspace-write',
    tokens: { input: 10, output: 1900, reasoning: 0 },
    result: longPartial,
  });
  assert.match(longFailed.result, /… \[truncated; see report_path\]$/);
  assert.ok(longFailed.result.length < longPartial.length);
  assert.ok(readFileSync(longFailed.report_path, 'utf8').includes(longPartial));
});

test('MCP server integrates summary contract, offload, inline_limit, full_reply, and report_dir end-to-end', async () => {
  const ws = mkdtempSync(join(ISOLATED_HOME, 'ws-mcp-'));
  const customDir = 'custom-reports';
  const spawnedRequests = [];
  const hubJobs = new Map();

  const hubServer = http.createServer(async (req, res) => {
    if (req.url === '/_dsh/dsh-crew/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'dsh-crew-hub' }));
      return;
    }
    if (req.url === '/_dsh/dsh-crew/providers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, providers: [] }));
      return;
    }
    if (req.url === '/_dsh/dsh-crew/jobs' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw);
      spawnedRequests.push(payload);
      const id = `hub-e2e-${spawnedRequests.length}`;
      const isFail = payload.task.includes('FAIL_CASE');
      const isMedium = payload.task.includes('MEDIUM_CASE');
      const job = isFail
        ? {
            id,
            status: 'failed',
            error: 'worker aborted',
            stopReason: 'error',
            tier: payload.tier,
            model: 'deepseek-v4-flash',
            provider: 'deepseek-official',
            effort: payload.effort,
            cwd: payload.cwd,
            mode: 'hub',
            permission: payload.permission,
            effective_sandbox_mode: 'workspace-write',
            preset: payload.preset,
            tokens: { input: 40, output: 50, reasoning: 0 },
            toolCalls: 1,
            result: 'incomplete output without summary',
          }
        : {
            id,
            status: 'done',
            stopReason: 'completed',
            tier: payload.tier,
            model: 'deepseek-v4-flash',
            provider: 'deepseek-official',
            effort: payload.effort,
            cwd: payload.cwd,
            mode: 'hub',
            permission: payload.permission,
            effective_sandbox_mode: payload.permission === 'read-only' ? 'read-only' : 'workspace-write',
            preset: payload.preset,
            tokens: { input: 80, output: isMedium ? 250 : 1800, reasoning: 0 },
            toolCalls: 2,
            result: isMedium
              ? 'VERDICT: PASS\nFINDINGS:\n- none\n\nMedium detail.'
              : `VERDICT: PASS\nFINDINGS:\n- none\n\n${'L'.repeat(4500)}`,
          };
      hubJobs.set(id, job);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, job: { id, status: 'running', permission: payload.permission } }));
      return;
    }
    if (req.url?.startsWith('/_dsh/dsh-crew/jobs/')) {
      const id = req.url.split('/').pop().split('?')[0];
      const job = hubJobs.get(id);
      if (!job) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no such job' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, job }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolveListen) => hubServer.listen(0, '127.0.0.1', resolveListen));
  const { port } = hubServer.address();
  const env = { ...process.env, HOME: ISOLATED_HOME, USERPROFILE: ISOLATED_HOME, DSHPLUGIN_CREW_HUB: `http://127.0.0.1:${port}` };

  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buf = '';
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
  });

  const request = (method, params) => new Promise((resolveReq, rejectReq) => {
    const id = nextId++;
    const timer = setTimeout(() => rejectReq(new Error(`timeout waiting for ${method}`)), 10_000);
    pending.set(id, { resolve: resolveReq, reject: rejectReq, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  try {
    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'offload-e2e', version: '0.0.0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const listed = await request('tools/list', {});
    const tools = new Map((listed.result?.tools ?? []).map((t) => [t.name, t]));
    for (const toolName of ['dsh_run_worker', 'dsh_worker_result']) {
      const props = tools.get(toolName)?.inputSchema?.properties ?? {};
      assert.equal(props.inline_limit?.type, 'integer');
      assert.equal(props.full_reply?.type, 'boolean');
    }
    assert.equal(tools.get('dsh_worker_config')?.inputSchema?.properties?.report_dir?.type, 'string');

    // Configure hub mode + custom report_dir, then verify reset via empty string.
    const cfg1 = await request('tools/call', {
      name: 'dsh_worker_config',
      arguments: { mode: 'hub', report_dir: customDir },
    });
    assert.equal(JSON.parse(cfg1.result.content[0].text).report_dir, customDir);

    // 1. Large read-only blocking run -> offloaded to custom report_dir, summary parsed, result omitted.
    const runLarge = await request('tools/call', {
      name: 'dsh_run_worker',
      arguments: { task: 'Audit file', cwd: ws, permission: 'read-only' },
    });
    const largePayload = JSON.parse(runLarge.result.content[0].text);
    assert.match(spawnedRequests[0].task, /\bVERDICT\b/);
    assert.match(spawnedRequests[0].task, /\bFINDINGS\b/);
    assert.equal('result' in largePayload, false);
    assert.equal(largePayload.summary_missing, false);
    assert.equal(largePayload.summary.verdict, 'PASS');
    assert.ok(largePayload.report_path.startsWith(resolve(ws, customDir)));
    assert.equal(existsSync(largePayload.report_path), true);

    // 2. Reset report_dir to '' -> returns to <cwd>/.dsh-reports; full_reply: true retains result.
    await request('tools/call', { name: 'dsh_worker_config', arguments: { report_dir: '' } });
    const runFull = await request('tools/call', {
      name: 'dsh_run_worker',
      arguments: { task: 'Audit again\nVERDICT: PASS\nFINDINGS:\n- none', cwd: ws, permission: 'read-only', full_reply: true },
    });
    // Task already had VERDICT & FINDINGS -> not appended twice.
    assert.equal(spawnedRequests[1].task, 'Audit again\nVERDICT: PASS\nFINDINGS:\n- none');
    const fullPayload = JSON.parse(runFull.result.content[0].text);
    assert.ok(fullPayload.result.includes('LLLL'));
    assert.ok(fullPayload.report_path.startsWith(resolve(ws, '.dsh-reports')));
    assert.equal(existsSync(join(ws, '.gitignore')), true);

    // 3. Async spawn + dsh_worker_result with inline_limit override.
    const spawnMed = await request('tools/call', {
      name: 'dsh_spawn_worker',
      arguments: { task: 'MEDIUM_CASE check', cwd: ws, permission: 'read-only' },
    });
    const medJobId = JSON.parse(spawnMed.result.content[0].text).id;
    const medRes = await request('tools/call', {
      name: 'dsh_worker_result',
      arguments: { job_id: medJobId, inline_limit: 200 },
    });
    const medPayload = JSON.parse(medRes.result.content[0].text);
    assert.equal('result' in medPayload, false);
    assert.equal(medPayload.summary_missing, false);
    assert.equal(existsSync(medPayload.report_path), true);

    // 4. Failed job via dsh_spawn_worker + dsh_worker_result -> offloaded with error/stopReason/summary_missing.
    const spawnFail = await request('tools/call', {
      name: 'dsh_spawn_worker',
      arguments: { task: 'FAIL_CASE edit', cwd: ws },
    });
    assert.match(spawnedRequests[3].task, /\bCHANGED\b/);
    assert.match(spawnedRequests[3].task, /\bVERIFIED\b/);
    assert.match(spawnedRequests[3].task, /\bUNVERIFIED\b/);
    const failJobId = JSON.parse(spawnFail.result.content[0].text).id;
    const failRes = await request('tools/call', {
      name: 'dsh_worker_result',
      arguments: { job_id: failJobId },
    });
    const failPayload = JSON.parse(failRes.result.content[0].text);
    assert.equal(failPayload.status, 'failed');
    assert.equal(failPayload.error, 'worker aborted');
    assert.equal(failPayload.stopReason, 'error');
    assert.equal(failPayload.summary_missing, true);
    assert.equal(failPayload.result, 'incomplete output without summary');
    assert.equal(existsSync(failPayload.report_path), true);

    // Repeated dsh_worker_result calls reuse the same report_path (even across seconds).
    await new Promise((r) => setTimeout(r, 1100));
    const failRes2 = await request('tools/call', {
      name: 'dsh_worker_result',
      arguments: { job_id: failJobId },
    });
    const failPayload2 = JSON.parse(failRes2.result.content[0].text);
    assert.equal(failPayload2.report_path, failPayload.report_path);

    // CLI worker profiles reject explicit permission since they cannot enforce DSH sandbox modes.
    const cliPermErr = await request('tools/call', {
      name: 'dsh_run_worker',
      arguments: { task: 'check', worker: 'agy', permission: 'read-only', cwd: ws },
    });
    assert.equal(cliPermErr.result.isError, true);
    assert.match(cliPermErr.result.content[0].text, /cannot enforce DSH sandbox permission/);
  } finally {
    child.kill();
    await new Promise((resolveExit) => child.once('exit', resolveExit));
    await new Promise((resolveClose) => hubServer.close(resolveClose));
  }
});
