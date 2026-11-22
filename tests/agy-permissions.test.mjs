import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED_SAFE_RULES = [
  'mcp(dsh-crew/dsh_worker_status)',
  'mcp(dsh-crew/dsh_worker_result)',
  'mcp(dsh-crew/dsh_worker_config)',
  'mcp(dsh-crew/dsh_worker_probe)',
];

const EXPECTED_DISPATCH_RULES = [
  'mcp(dsh-crew/dsh_run_worker)',
  'mcp(dsh-crew/dsh_spawn_worker)',
  'mcp(dsh-crew/dsh_worker_cancel)',
];

const EXPECTED_ALL_RULES = [...EXPECTED_SAFE_RULES, ...EXPECTED_DISPATCH_RULES];

let isolatedHome;
let installMod;

before(async () => {
  isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-crew-agy-perm-'));
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  installMod = await import('../src/install/install.mjs');
});

after(() => {
  if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
});

function makeTempHome(tag) {
  return mkdtempSync(join(isolatedHome, `${tag}-`));
}

function listBackups(filePath) {
  const dir = dirname(filePath);
  const base = filePath.slice(dir.length + 1);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(`${base}.dsh-crew-backup-`));
}

test('installAgy with permissions="none" / false leaves settings.json untouched on clean home', () => {
  for (const flag of ['none', false]) {
    const home = makeTempHome('none');
    const res = installMod.installAgy({ home, agyPermissions: flag });
    assert.equal(res.ok, true);
    assert.equal(res.permissions.mode, 'none');
    assert.deepEqual(res.permissions.rules, []);
    assert.equal(res.desktopPermissionsText, '');
    assert.equal(res.permissions.safeText, EXPECTED_SAFE_RULES.join('\n'));
    assert.equal(res.permissions.allText, EXPECTED_ALL_RULES.join('\n'));

    const settingsFile = join(home, '.gemini', 'antigravity-cli', 'settings.json');
    assert.equal(existsSync(settingsFile), false);
    assert.equal(existsSync(join(home, '.gemini', 'config', 'mcp_config.json')), true);
    assert.equal(existsSync(join(home, '.gemini', 'config', 'agents', 'ds-flash.md')), true);
    assert.equal(existsSync(join(home, '.gemini', 'config', 'agents', 'ds-pro.md')), true);

    const status = installMod.installStatus({ home });
    assert.equal(status.agy.installed, true);
    assert.equal(status.agy.permissions.mode, 'none');
  }
});

test('installAgy defaults to "safe" and writes only the 4 low-risk rules', () => {
  const home = makeTempHome('safe-default');
  const res = installMod.installAgy({ home });
  assert.equal(res.ok, true);
  assert.equal(res.permissions.mode, 'safe');
  assert.deepEqual(res.permissions.rules, EXPECTED_SAFE_RULES);
  assert.equal(res.desktopPermissionsText, EXPECTED_SAFE_RULES.join('\n'));

  const settingsFile = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  assert.equal(existsSync(settingsFile), true);
  const parsed = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(parsed.permissions.allow, EXPECTED_SAFE_RULES);
  for (const r of EXPECTED_DISPATCH_RULES) {
    assert.equal(parsed.permissions.allow.includes(r), false);
  }

  const status = installMod.installStatus({ home });
  assert.equal(status.agy.permissions.mode, 'safe');
  assert.equal(status.agy.permissions.allowSafe, true);
  assert.equal(status.agy.permissions.allowDispatch, false);
});

test('installAgy preserves non-dsh-crew rules/fields, creates backup, and supports tier switching + idempotence', () => {
  const home = makeTempHome('switch');
  const settingsFile = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({
    theme: 'dark',
    customFlag: 42,
    permissions: {
      allow: ['mcp(other-server/ping)', 'shell(git status)'],
      deny: ['shell(rm -rf /)'],
    },
  }, null, 2) + '\n');

  // 1. Upgrade to 'all' via boolean flags
  const resAll = installMod.installAgy({
    home,
    allowSafePermissions: true,
    allowDispatchPermissions: true,
  });
  assert.equal(resAll.permissions.mode, 'all');
  assert.deepEqual(resAll.permissions.rules, EXPECTED_ALL_RULES);
  assert.equal(listBackups(settingsFile).length >= 1, true);

  let parsed = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.customFlag, 42);
  assert.deepEqual(parsed.permissions.deny, ['shell(rm -rf /)']);
  assert.deepEqual(parsed.permissions.allow, [
    'mcp(other-server/ping)',
    'shell(git status)',
    ...EXPECTED_ALL_RULES,
  ]);

  // 2. Idempotent re-run on 'all'
  installMod.installAgy({ home, permissions: 'all' });
  parsed = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(parsed.permissions.allow, [
    'mcp(other-server/ping)',
    'shell(git status)',
    ...EXPECTED_ALL_RULES,
  ]);

  // 3. Downgrade from 'all' to 'safe' -> removes dispatch rules, keeps safe + user rules
  const resSafe = installMod.installAgy({ home, agyPermissions: 'safe' });
  assert.equal(resSafe.permissions.mode, 'safe');
  parsed = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.deepEqual(parsed.permissions.allow, [
    'mcp(other-server/ping)',
    'shell(git status)',
    ...EXPECTED_SAFE_RULES,
  ]);

  // 4. Switch from 'safe' to 'none' -> removes all dsh-crew rules, keeps user rules & fields
  const resNone = installMod.installAgy({ home, agyPermissions: 'none' });
  assert.equal(resNone.permissions.mode, 'none');
  parsed = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.equal(parsed.theme, 'dark');
  assert.deepEqual(parsed.permissions.deny, ['shell(rm -rf /)']);
  assert.deepEqual(parsed.permissions.allow, [
    'mcp(other-server/ping)',
    'shell(git status)',
  ]);
});

test('uninstallAgy backs up settings.json and removes only mcp(dsh-crew/...) rules', () => {
  const home = makeTempHome('uninstall');
  const settingsFile = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({
    keepMe: true,
    permissions: {
      allow: ['mcp(other/tool)'],
      deny: ['shell(sudo)'],
    },
  }, null, 2) + '\n');

  installMod.installAgy({ home, agyPermissions: 'all' });
  const beforeBackups = listBackups(settingsFile).length;

  const unres = installMod.uninstallAgy({ home });
  assert.equal(unres.ok, true);
  assert.equal(listBackups(settingsFile).length > beforeBackups, true);

  const parsed = JSON.parse(readFileSync(settingsFile, 'utf8'));
  assert.equal(parsed.keepMe, true);
  assert.deepEqual(parsed.permissions.deny, ['shell(sudo)']);
  assert.deepEqual(parsed.permissions.allow, ['mcp(other/tool)']);
  assert.equal(installMod.installStatus({ home }).agy.installed, false);
  assert.equal(installMod.installStatus({ home }).agy.permissions.mode, 'none');
});

test('Desktop UI rules helpers in install.mjs and client agy-permissions-view.ts agree', async () => {
  const tmpBuild = makeTempHome('view-build');
  await build({
    entryPoints: [join(ROOT, 'src', 'client', 'agy-permissions-view.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: join(tmpBuild, 'agy-permissions-view.mjs'),
    logLevel: 'silent',
  });
  const view = await import(pathToFileURL(join(tmpBuild, 'agy-permissions-view.mjs')).href);

  assert.deepEqual([...view.AGY_SAFE_PERMISSION_RULES], installMod.AGY_SAFE_PERMISSION_RULES);
  assert.deepEqual([...view.AGY_DISPATCH_PERMISSION_RULES], installMod.AGY_DISPATCH_PERMISSION_RULES);
  assert.equal(
    view.agyDesktopPermissionsText(true, false),
    installMod.formatAgyDesktopPermissionsText({ agyPermissions: 'safe' }),
  );
  assert.equal(
    view.agyDesktopPermissionsText(true, true),
    installMod.formatAgyDesktopPermissionsText({ agyPermissions: 'all' }),
  );
  assert.equal(
    view.agyDesktopPermissionsText(false, false),
    installMod.formatAgyDesktopPermissionsText({ agyPermissions: 'none' }),
  );
  assert.deepEqual(view.agyInitialPermissionSelection(null), { allowSafe: true, allowDispatch: false });
  assert.deepEqual(
    view.agyInitialPermissionSelection({ installed: true, permissions: { allowSafe: true, allowDispatch: true } }),
    { allowSafe: true, allowDispatch: true },
  );
});

test('agy/agents/ds-flash.md and ds-pro.md enforce one-shot low-tier forwarding, permission passthrough, and verbatim relay', () => {
  for (const [file, expectedTier] of [
    ['ds-flash.md', '"flash"'],
    ['ds-pro.md', '"pro"'],
  ]) {
    const text = readFileSync(join(ROOT, 'agy', 'agents', file), 'utf8');
    assert.match(text, /^---[\s\S]*?\nmodel:\s*gemini-3\.8-flash-low\r?\n/m, `${file} must pin forwarding model to gemini-3.8-flash-low`);
    assert.equal(/\nmodel:\s*flash\r?\n/m.test(text), false, `${file} must not use bare model: flash`);
    assert.match(text, /\bsubagent:\s*true\b/);
    assert.match(text, /ONE-SHOT/i);
    assert.match(text, /NEVER reuse/i);
    assert.match(text, /NEVER poll/i);
    assert.match(text, new RegExp(`tier.*${expectedTier}`));
    assert.match(text, /workspace-write/);
    assert.match(text, /do NOT force `"read-only"`/i);
    for (const field of ['permission', 'preset', 'allow_concurrent_cwd', 'inline_limit', 'full_reply']) {
      assert.ok(text.includes(field), `${file} must document passthrough of ${field}`);
    }
    for (const outputField of ['report_path', 'summary', 'summary_missing']) {
      assert.ok(text.includes(outputField), `${file} must document verbatim relay of ${outputField}`);
    }
  }
});

test('hub POST /_dsh/dsh-crew/install forwards Antigravity permission options in isolated home', () => {
  const childHome = makeTempHome('hub-child');
  const script = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { apply } from ${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'hub', 'index.mjs')).href)};

    const routes = new Map();
    const webServer = {
      register(spec) {
        routes.set(spec.path, spec.handler);
        return () => routes.delete(spec.path);
      },
    };
    const ctx = {
      agents: {}, sessions: {}, agentDefaultModel: {}, tools: { register: () => () => {} },
      llm: {}, attachments: {},
      get: () => undefined,
      inject(_deps, cb) { return cb({ webServer }); },
      effect: (fn) => fn(),
      logger: { info: () => {}, warn: () => {} },
    };

    const dispose = await apply(ctx);

    async function callRoute(path, method, body) {
      const handler = routes.get(path);
      assert.ok(handler, 'missing route ' + path);
      const req = Object.assign(new EventEmitter(), {
        method,
        url: path,
        headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(JSON.stringify(body));
        },
      });
      let status = 0;
      let raw = '';
      const res = {
        writeHead(s) { status = s; },
        end(chunk) { raw = String(chunk ?? ''); },
      };
      await handler(req, res);
      return { status, json: JSON.parse(raw) };
    }

    const rAll = await callRoute('/_dsh/dsh-crew/install', 'POST', {
      target: 'agy',
      allowSafePermissions: true,
      allowDispatchPermissions: true,
    });
    assert.equal(rAll.status, 200);
    assert.equal(rAll.json.ok, true);
    assert.equal(rAll.json.permissions.mode, 'all');
    assert.equal(rAll.json.desktopPermissionsText.split('\\n').length, 7);

    const settingsFile = join(${JSON.stringify(childHome)}, '.gemini', 'antigravity-cli', 'settings.json');
    let saved = JSON.parse(readFileSync(settingsFile, 'utf8'));
    assert.equal(saved.permissions.allow.length, 7);

    const rStatus = await callRoute('/_dsh/dsh-crew/install/status', 'GET');
    assert.equal(rStatus.status, 200);
    assert.equal(rStatus.json.status.agy.installed, true);
    assert.equal(rStatus.json.status.agy.permissions.mode, 'all');

    const rSafe = await callRoute('/_dsh/dsh-crew/install', 'POST', {
      target: 'agy',
      agyPermissions: 'safe',
    });
    assert.equal(rSafe.status, 200);
    assert.equal(rSafe.json.permissions.mode, 'safe');
    saved = JSON.parse(readFileSync(settingsFile, 'utf8'));
    assert.equal(saved.permissions.allow.length, 4);

    const rUn = await callRoute('/_dsh/dsh-crew/install', 'POST', { target: 'agy-uninstall' });
    assert.equal(rUn.status, 200);
    assert.equal(rUn.json.ok, true);
    saved = JSON.parse(readFileSync(settingsFile, 'utf8'));
    assert.equal(saved.permissions.allow.length, 0);

    await dispose();
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env: { ...process.env, HOME: childHome, USERPROFILE: childHome },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `isolated hub /install test failed:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
});
