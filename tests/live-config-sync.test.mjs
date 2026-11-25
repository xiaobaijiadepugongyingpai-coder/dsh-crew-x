import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GLOBAL_CONFIG_DEFAULTS } from '../src/install/install.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PATH = join(ROOT, 'src', 'server.mjs');

test('GLOBAL_CONFIG_DEFAULTS.preset_flash defaults to "default" rather than tool-stripped "minimal"', () => {
  assert.equal(GLOBAL_CONFIG_DEFAULTS.preset_flash, 'default');
  assert.equal(GLOBAL_CONFIG_DEFAULTS.preset_pro, 'default');
});

test('running MCP server picks up live config.json edits while preserving explicit session overrides', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-live-cfg-'));
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-live-cwd-'));
  const cfgDir = join(home, '.config', 'dsh-crew');
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, 'config.json');

  const spawnedPayloads = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;

    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && url.pathname === '/_dsh/dsh-crew/ping') {
      res.end(JSON.stringify({ ok: true, service: 'dsh-crew-hub' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/_dsh/dsh-crew/providers') {
      res.end(JSON.stringify({ ok: true, providers: [] }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/_dsh/dsh-crew/jobs') {
      res.end(JSON.stringify({ ok: true, jobs: [] }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/_dsh/dsh-crew/jobs') {
      spawnedPayloads.push(json);
      const id = `hub-${spawnedPayloads.length}`;
      res.end(JSON.stringify({
        ok: true,
        job: { id, status: 'running', tier: json.tier, preset: json.preset, cwd: json.cwd },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const hubUrl = `http://127.0.0.1:${port}`;

  writeFileSync(cfgPath, JSON.stringify({
    mode: 'hub',
    hub_url: hubUrl,
    preset_flash: 'minimal',
    preset_pro: 'default',
    persistent_sessions: false,
  }, null, 2));

  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: workDir,
    env: { ...process.env, HOME: home, USERPROFILE: home, DSHPLUGIN_CREW_HUB: hubUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d.toString();
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
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    }
  });

  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const callTool = async (name, args) => {
    const res = await rpc('tools/call', { name, arguments: args });
    return JSON.parse(res.content[0].text);
  };

  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

    // Sanity check initial startup state
    const initialCfg = await callTool('dsh_worker_config', {});
    assert.equal(initialCfg.preset_flash, 'minimal');
    assert.equal(initialCfg.persistent_sessions, false);

    // Simulate user editing DSH settings panel while MCP server stays running
    writeFileSync(cfgPath, JSON.stringify({
      mode: 'hub',
      hub_url: hubUrl,
      preset_flash: 'default',
      preset_pro: 'default',
      persistent_sessions: true,
    }, null, 2));

    const updatedCfg = await callTool('dsh_worker_config', {});
    assert.equal(updatedCfg.preset_flash, 'default');
    assert.equal(updatedCfg.persistent_sessions, true);

    await callTool('dsh_spawn_worker', { task: 'test flash dispatch', tier: 'flash', cwd: workDir });
    assert.equal(spawnedPayloads[0].preset, 'default');

    // Explicit session override wins over disk config until reset
    await callTool('dsh_worker_config', { preset_flash: 'custom-override' });
    await callTool('dsh_spawn_worker', { task: 'test overridden dispatch', tier: 'flash', cwd: workDir, allow_concurrent_cwd: true, permission: 'read-only' });
    assert.equal(spawnedPayloads[1].preset, 'custom-override');

    const afterReset = await callTool('dsh_worker_config', { reset: true });
    assert.equal(afterReset.preset_flash, 'default');
  } finally {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))]);
    await new Promise((resolve) => server.close(resolve));
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
});
