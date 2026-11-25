// scripts/capture-ui.mjs
// Automated high-res screenshot capture of DSH Crew X settings panel & Jobs Board.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PLAYWRIGHT_PATH = 'C:/Users/soyori/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
const { chromium } = await import(pathToFileURL(PLAYWRIGHT_PATH).href);

const reactCode = fs.readFileSync(path.join(ROOT, 'node_modules/react/umd/react.production.min.js'), 'utf8');
const reactDomCode = fs.readFileSync(path.join(ROOT, 'node_modules/react-dom/umd/react-dom.production.min.js'), 'utf8');
const clientBundleCode = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

const now = Date.now();
let serverPort = 41285;

function getMockConfig() {
  return {
    mode: 'hub',
    default_tier: 'flash',
    default_effort: 'high',
    default_timeout_seconds: 300,
    tier_policy: 'auto',
    escalate_on_failure: true,
    hub_url: `http://127.0.0.1:${serverPort}`,
    flash_provider: 'deepseek-official',
    flash_model: 'deepseek-v4-flash',
    pro_provider: 'deepseek-official',
    pro_model: 'deepseek-v4-pro',
    persistent_sessions: true,
    persistent_session_idle_timeout_enabled: true,
    persistent_session_idle_timeout_minutes: 30,
    preset_flash: 'default',
    preset_pro: 'default',
    vision_provider: 'claude-code',
    vision_model: 'haiku',
    imagegen_provider: 'codex',
  };
}

const mockProviders = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek Official',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy Gateway',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' },
    ],
  },
];

const mockPresets = {
  ok: true,
  defaultId: 'default',
  presets: [
    { id: 'standard', name: '标准模式', trust: 'system' },
    { id: 'reviewer', name: 'Security Reviewer', trust: 'user' },
  ],
};

const mockInstallStatus = {
  ok: true,
  status: {
    claude: { installed: true, hud: true },
    codex: { installed: true },
    agy: {
      installed: true,
      permissions: {
        mode: 'safe',
        rules: [
          'mcp(dsh-crew/dsh_worker_status)',
          'mcp(dsh-crew/dsh_worker_result)',
          'mcp(dsh-crew/dsh_worker_config)',
          'mcp(dsh-crew/dsh_worker_probe)',
        ],
      },
    },
    grok: { installed: true },
  },
};

const mockSessions = [
  {
    session_id: 'session-4a7e-81cd-55ff-1092',
    dsh_session_id: 'dsh-sess-002',
    status: 'running',
    cwd: 'D:\\workspace\\payment-gateway',
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    tier: 'pro',
    preset: 'default',
    turns: 2,
    isolation: 'git-worktree',
    worktree_path: 'C:\\Temp\\dsh-crew-worktrees\\session-4a7e',
    degraded_from: 'D:\\workspace\\payment-gateway',
    created_at_iso: new Date(now - 1800_000).toISOString(),
    last_active_iso: new Date(now - 15_000).toISOString(),
  },
  {
    session_id: 'session-9b1c-4f8a-92bc-33e1',
    dsh_session_id: 'dsh-sess-001',
    status: 'idle',
    cwd: 'D:\\workspace\\ecommerce-core',
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    tier: 'pro',
    preset: 'reviewer',
    turns: 3,
    created_at_iso: new Date(now - 3600_000).toISOString(),
    last_active_iso: new Date(now - 120_000).toISOString(),
  },
];

const mockJobs = [
  {
    id: 'job-81cd-t2',
    persistent: true,
    sessionId: 'session-4a7e-81cd-55ff-1092',
    turnIndex: 2,
    status: 'running',
    source: 'claude-code',
    cwd: 'D:\\workspace\\payment-gateway',
    tier: 'pro',
    effort: 'high',
    backend: 'dsh',
    startedAt: new Date(now - 42_000).toISOString(),
    turn: 2,
    step: 4,
    currentTool: 'fs_write',
    toolCalls: 9,
    tokens: { input: 6420, output: 1280 },
    task: 'Apply async mutex lock to JWT refresher and run regression suite',
  },
  {
    id: 'job-81cd-t1',
    persistent: true,
    sessionId: 'session-4a7e-81cd-55ff-1092',
    turnIndex: 1,
    status: 'done',
    source: 'claude-code',
    cwd: 'D:\\workspace\\payment-gateway',
    tier: 'pro',
    effort: 'high',
    backend: 'dsh',
    startedAt: new Date(now - 320_000).toISOString(),
    endedAt: new Date(now - 195_000).toISOString(),
    turn: 1,
    step: 12,
    toolCalls: 15,
    tokens: { input: 8200, output: 2150 },
    task: 'Diagnose intermittent timeout in token refresh pipeline',
  },
  {
    id: 'job-9b1c-t3',
    persistent: true,
    sessionId: 'session-9b1c-4f8a-92bc-33e1',
    turnIndex: 3,
    status: 'done',
    source: 'api',
    cwd: 'D:\\workspace\\ecommerce-core',
    tier: 'pro',
    effort: 'high',
    backend: 'dsh',
    startedAt: new Date(now - 600_000).toISOString(),
    endedAt: new Date(now - 480_000).toISOString(),
    turn: 3,
    step: 6,
    toolCalls: 9,
    tokens: { input: 4500, output: 920 },
    task: 'Verify idempotency guard on checkout webhook handler',
  },
  {
    id: 'job-audit-01',
    status: 'done',
    source: 'codex',
    cwd: 'D:\\workspace\\ecommerce-core',
    tier: 'flash',
    effort: 'high',
    backend: 'dsh',
    startedAt: new Date(now - 420_000).toISOString(),
    endedAt: new Date(now - 390_000).toISOString(),
    turn: 1,
    step: 5,
    toolCalls: 7,
    tokens: { input: 3100, output: 640 },
    task: 'Read-only security audit of src/db query builders (offloaded to .dsh-reports/)',
  },
];

function renderShell(lang) {
  const isZh = lang === 'zh';
  return `<!DOCTYPE html>
<html lang="${isZh ? 'zh-CN' : 'en'}">
<head>
  <meta charset="UTF-8">
  <title>DSH Desktop - Settings</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: #0d1117;
      color: #e6edf3;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
      display: flex;
      min-height: 100vh;
    }
    .dsh-sidebar {
      width: 224px;
      background: #121720;
      border-right: 1px solid rgba(255,255,255,0.08);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .dsh-brand {
      height: 52px;
      padding: 0 18px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 14.5px;
      color: #58a6ff;
      border-bottom: 1px solid rgba(255,255,255,0.07);
    }
    .dsh-nav {
      padding: 14px 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;
    }
    .dsh-nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-radius: 7px;
      font-size: 13px;
      color: #8b949e;
    }
    .dsh-nav-item.active {
      background: rgba(56, 139, 253, 0.14);
      color: #79c0ff;
      font-weight: 600;
    }
    .dsh-nav-item .badge {
      margin-left: auto;
      background: #2563eb;
      color: #fff;
      font-size: 10.5px;
      padding: 1px 7px;
      border-radius: 99px;
      font-weight: 600;
    }
    .dsh-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .dsh-header {
      height: 52px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      padding: 0 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #10151d;
    }
    .dsh-header-title {
      font-size: 15px;
      font-weight: 600;
      color: #f0f6fc;
    }
    .dsh-content {
      padding: 20px 28px 36px;
    }
  </style>
</head>
<body>
  <div class="dsh-sidebar">
    <div class="dsh-brand">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
      DeepSeek Harness
    </div>
    <div class="dsh-nav">
      <div class="dsh-nav-item">${isZh ? '通用设置' : 'General'}</div>
      <div class="dsh-nav-item">${isZh ? '模型管理' : 'Models'}</div>
      <div class="dsh-nav-item">${isZh ? 'Agent 预设' : 'Agent Presets'}</div>
      <div class="dsh-nav-item active">DSH Crew X <span class="badge">1</span></div>
      <div class="dsh-nav-item">${isZh ? '沙盒安全' : 'Sandbox'}</div>
    </div>
  </div>
  <div class="dsh-main">
    <div class="dsh-header">
      <div class="dsh-header-title">${isZh ? '设置 > DSH Crew X' : 'Settings > DSH Crew X'}</div>
      <div style="font-size: 12px; color: #3fb950; display: flex; align-items: center; gap: 6px; font-family: ui-monospace, monospace;">
        <span style="width: 8px; height: 8px; border-radius: 50%; background: #3fb950; display: inline-block;"></span>
        ${isZh ? `Hub 动态发现已连接 (PID 12480 · :${serverPort})` : `Hub dynamic discovery connected (PID 12480 · :${serverPort})`}
      </div>
    </div>
    <div class="dsh-content">
      <div id="root"></div>
    </div>
  </div>

  <script>${reactCode}</script>
  <script>${reactDomCode}</script>
  <script>
    localStorage.setItem('dsh-crew.settings.collapse.integrations', '1');
    localStorage.setItem('dsh-crew.settings.collapse.global-config', '0');

    window.__jsx_runtime = {
      jsx: function(type, props, key) {
        return React.createElement(type, key !== undefined ? Object.assign({}, props, { key: key }) : props);
      },
      jsxs: function(type, props, key) {
        return React.createElement(type, key !== undefined ? Object.assign({}, props, { key: key }) : props);
      },
      Fragment: React.Fragment
    };

    let registeredComponent = null;
    window.__ModuleLoader__ = {
      load: function(def) {
        const exports = def.factory(function(mod) {
          if (mod === 'react') return window.React;
          if (mod === 'react-dom') return window.ReactDOM;
          if (mod === 'react/jsx-runtime') return window.__jsx_runtime;
          throw new Error('Unknown module ' + mod);
        });
        const ctx = {
          locale: { getLocale: function() { return { active: '${isZh ? 'zh' : 'en'}' }; } },
          on: function() { return function() {}; },
          slots: {
            inject: function(slot, fn) { fn(); },
            register: function(opts, comp) { registeredComponent = comp; return function() {}; }
          }
        };
        exports.apply(ctx);
      }
    };
  </script>
  <script>${clientBundleCode}</script>
  <script>
    if (registeredComponent) {
      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(registeredComponent());
    }
  </script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const reqPath = url.pathname;
  const lang = url.searchParams.get('lang') === 'zh' ? 'zh' : 'en';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (reqPath === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderShell(lang));
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  if (reqPath === '/_dsh/dsh-crew/config') {
    res.end(JSON.stringify({ ok: true, config: getMockConfig() }));
    return;
  }
  if (reqPath === '/_dsh/dsh-crew/providers') {
    res.end(JSON.stringify({ ok: true, providers: mockProviders }));
    return;
  }
  if (reqPath === '/_dsh/dsh-crew/presets') {
    res.end(JSON.stringify(mockPresets));
    return;
  }
  if (reqPath === '/_dsh/dsh-crew/install/status') {
    res.end(JSON.stringify(mockInstallStatus));
    return;
  }
  if (reqPath === '/_dsh/dsh-crew/sessions') {
    res.end(JSON.stringify({ ok: true, sessions: mockSessions }));
    return;
  }
  if (reqPath === '/_dsh/dsh-crew/jobs') {
    res.end(JSON.stringify({ ok: true, jobs: mockJobs }));
    return;
  }
  if (reqPath === '/_dsh/dsh-crew/worker-probe') {
    res.end(JSON.stringify({
      ok: true,
      result: {
        status: 'verified',
        route_callable: true,
        tool_call_verified: true,
        checked_at: new Date().toISOString(),
      },
    }));
    return;
  }

  res.statusCode = 404;
  res.end('{}');
});

server.listen(0, '127.0.0.1', async () => {
  serverPort = server.address().port;
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
  });

  fs.mkdirSync(path.join(ROOT, 'docs/assets'), { recursive: true });

  for (const lang of ['en', 'zh']) {
    const page = await browser.newPage({
      viewport: { width: 1340, height: 920 },
      deviceScaleFactor: 2,
    });
    await page.goto(`http://127.0.0.1:${serverPort}/?lang=${lang}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);

    // 1. Trigger "Test route" on Flash tier to show verified badge
    const probeButtons = await page.$$('button:has-text("Test route"), button:has-text("测试连通性")');
    if (probeButtons.length > 0) {
      await probeButtons[0].click();
      await page.waitForTimeout(400);
    }

    // Scroll back to top and capture Shot A: Header + Dispatch Policy + Visual Tier Selector + Probe
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    const dispatchBottom = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('#root > div > div'));
      const target = all.find((el) => {
        const txt = el.textContent?.trim();
        return txt === 'Persistent sessions' || txt === '持久会话';
      });
      const rect = target ? target.getBoundingClientRect() : null;
      return rect ? Math.min(920, Math.round(rect.top - 10)) : 820;
    });
    await page.setViewportSize({ width: 1340, height: Math.max(760, dispatchBottom) });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    const dispatchPath = path.join(ROOT, `docs/assets/hero-dispatch-${lang}.png`);
    await page.screenshot({ path: dispatchPath });
    console.log(`Saved ${dispatchPath}`);

    // 2. Expand finished jobs rows so both sessions & multi-turn jobs are visible
    const finishedRows = await page.$$('td:has-text("Finished"), td:has-text("已结束")');
    for (const row of finishedRows) {
      await row.click();
      await page.waitForTimeout(150);
    }

    // Scroll cleanly to Active Persistent Sessions card (hide stray button above) and capture Shot B
    const sessionsClip = await page.evaluate(() => {
      const rootDivs = Array.from(document.querySelectorAll('#root > div > div'));
      const sessHeader = rootDivs.find((el) => el.textContent?.includes('Active persistent sessions') || el.textContent?.includes('活跃持久会话'));
      const top = sessHeader ? Math.max(0, Math.round(sessHeader.getBoundingClientRect().top + window.scrollY - 14)) : 800;
      const totalHeight = Math.round(document.documentElement.scrollHeight);
      return { top, height: Math.max(520, totalHeight - top + 16) };
    });
    await page.setViewportSize({ width: 1340, height: sessionsClip.height });
    await page.evaluate((y) => window.scrollTo(0, y), sessionsClip.top);
    await page.waitForTimeout(200);
    const sessionsPath = path.join(ROOT, `docs/assets/hero-sessions-${lang}.png`);
    await page.screenshot({ path: sessionsPath });
    console.log(`Saved ${sessionsPath}`);

    await page.close();
  }

  await browser.close();
  server.close();
  process.exit(0);
});
