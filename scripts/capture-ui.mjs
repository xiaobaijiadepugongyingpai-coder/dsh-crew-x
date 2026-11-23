// scripts/capture-ui.mjs
// Automated high-res screenshot capture of DSH Crew X settings panel & Jobs Board.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// 1. Locate Playwright from npm cache or local
const PLAYWRIGHT_PATH = 'C:/Users/soyori/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
const { chromium } = await import(pathToFileURL(PLAYWRIGHT_PATH).href);

// 2. Read dependencies and compiled client bundle
const reactCode = fs.readFileSync(path.join(ROOT, 'node_modules/react/umd/react.production.min.js'), 'utf8');
const reactDomCode = fs.readFileSync(path.join(ROOT, 'node_modules/react-dom/umd/react-dom.production.min.js'), 'utf8');
const clientBundleCode = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

// 3. Mock Data meeting all 4 highlights
const mockConfig = {
  mode: 'hub',
  default_tier: 'flash',
  default_effort: 'high',
  default_timeout_seconds: 300,
  tier_policy: 'auto',
  escalate_on_failure: true,
  hub_url: 'http://127.0.0.1:41285',
  flash_provider: 'deepseek-official',
  flash_model: 'deepseek-v4-flash',
  pro_provider: 'deepseek-official',
  pro_model: 'deepseek-v4-pro',
  persistent_sessions: true,
  persistent_session_idle_timeout_enabled: true,
  persistent_session_idle_timeout_minutes: 30,
  preset_flash: 'default',
  preset_pro: 'default',
};

const mockProviders = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek Official',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-reasoner'],
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy Gateway',
    models: ['glm-5.3-flash', 'kimi-k2.5-pro'],
  },
];

const mockPresets = {
  ok: true,
  defaultId: 'default',
  presets: [
    { id: 'default', name: 'Default Coding Agent', trust: 'system' },
    { id: 'reviewer', name: 'Security Reviewer', trust: 'user' },
  ],
};

const mockInstallStatus = {
  ok: true,
  status: {
    claude: true,
    codex: true,
    agy: {
      installed: true,
      permissions: [
        'mcp(dsh-crew/dsh_worker_status)',
        'mcp(dsh-crew/dsh_worker_result)',
        'mcp(dsh-crew/dsh_worker_config)',
        'mcp(dsh-crew/dsh_worker_probe)',
      ],
    },
    grok: true,
  },
};

const mockSessions = [
  {
    session_id: 'session-9b1c-4f8a-92bc-33e1',
    dsh_session_id: 'dsh-sess-001',
    status: 'idle',
    cwd: '/workspace/ecommerce-core',
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    preset: 'pro',
    turn_index: 3,
    turns: 3,
    created_at_iso: new Date(Date.now() - 3600000).toISOString(),
    last_active_iso: new Date(Date.now() - 120000).toISOString(),
    active_job: null,
  },
  {
    session_id: 'session-4a7e-81cd-55ff-1092',
    dsh_session_id: 'dsh-sess-002',
    status: 'running',
    cwd: '/workspace/payment-gateway',
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    preset: 'pro',
    turn_index: 2,
    turns: 2,
    created_at_iso: new Date(Date.now() - 1800000).toISOString(),
    last_active_iso: new Date(Date.now() - 15000).toISOString(),
    active_job: { id: 'job-81cd-t2' },
  },
];

const now = Date.now();
const mockJobs = [
  {
    id: 'job-81cd-t2',
    sessionId: 'session-4a7e-81cd-55ff-1092',
    turnIndex: 2,
    status: 'running',
    cwd: '/workspace/payment-gateway',
    tier: 'pro',
    effort: 'high',
    backend: 'dsh',
    startedAt: new Date(now - 38000).toISOString(),
    turn: 2,
    step: 4,
    currentTool: 'fs_write',
    toolCalls: 9,
    tokens: { input: 6420, output: 1280 },
  },
  {
    id: 'job-81cd-t1',
    sessionId: 'session-4a7e-81cd-55ff-1092',
    turnIndex: 1,
    status: 'done',
    cwd: '/workspace/payment-gateway',
    tier: 'pro',
    effort: 'high',
    backend: 'dsh',
    startedAt: new Date(now - 320000).toISOString(),
    endedAt: new Date(now - 195000).toISOString(),
    turn: 1,
    step: 12,
    toolCalls: 15,
    tokens: { input: 8200, output: 2150 },
  },
  {
    id: 'job-9b1c-t3',
    sessionId: 'session-9b1c-4f8a-92bc-33e1',
    turnIndex: 3,
    status: 'done',
    cwd: '/workspace/ecommerce-core',
    tier: 'pro',
    effort: 'high',
    backend: 'dsh',
    startedAt: new Date(now - 600000).toISOString(),
    endedAt: new Date(now - 480000).toISOString(),
    turn: 3,
    step: 6,
    toolCalls: 9,
    tokens: { input: 4500, output: 920 },
  },
  {
    kind: 'cwd-lock',
    cwd: '/workspace/payment-gateway',
    holder: { jobId: 'job-81cd-t2', backend: 'dsh', startedAt: new Date(now - 38000).toISOString() },
  },
];

// 4. Create Mock HTTP Server
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>DSH Desktop - Settings</title>
  <style>
    :root {
      color-scheme: dark;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: #0f141c;
      color: #e1e7f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    /* Simulated DSH Desktop Navigation Sidebar */
    .dsh-sidebar {
      width: 240px;
      background: #141b26;
      border-right: 1px solid rgba(255,255,255,0.08);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .dsh-brand {
      height: 54px;
      padding: 0 18px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 15px;
      color: #3b82f6;
      border-bottom: 1px solid rgba(255,255,255,0.06);
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
      border-radius: 6px;
      font-size: 13px;
      color: #94a3b8;
      cursor: pointer;
    }
    .dsh-nav-item.active {
      background: rgba(59, 130, 246, 0.12);
      color: #60a5fa;
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
    /* Simulated DSH Desktop Content Area */
    .dsh-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .dsh-header {
      height: 54px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      padding: 0 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #121822;
    }
    .dsh-header-title {
      font-size: 16px;
      font-weight: 600;
      color: #f1f5f9;
    }
    .dsh-content {
      flex: 1;
      overflow-y: auto;
      padding: 24px 32px 48px;
    }
  </style>
</head>
<body>
  <div class="dsh-sidebar">
    <div class="dsh-brand">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
      DeepSeek Harness
    </div>
    <div class="dsh-nav">
      <div class="dsh-nav-item">💬 活跃会话</div>
      <div class="dsh-nav-item">🤖 模型管理</div>
      <div class="dsh-nav-item">🧩 插件市场</div>
      <div class="dsh-nav-item active">⚙️ DSH Crew X <span class="badge">❶</span></div>
      <div class="dsh-nav-item">🛡️ 沙盒安全</div>
    </div>
  </div>
  <div class="dsh-main">
    <div class="dsh-header">
      <div class="dsh-header-title">设置 &gt; DSH Crew X</div>
      <div style="font-size: 12px; color: #10b981; display: flex; align-items: center; gap: 6px;">
        <span style="width: 8px; height: 8px; border-radius: 50%; background: #10b981; display: inline-block;"></span>
        Hub 端口动态自愈已连接 (PID: 12480 · :41285)
      </div>
    </div>
    <div class="dsh-content">
      <div id="root"></div>
    </div>
  </div>

  <script>${reactCode}</script>
  <script>${reactDomCode}</script>
  <script>
    // Polyfill JSX runtime for compiled bundle
    window.__jsx_runtime = {
      jsx: function(type, props, key) {
        return React.createElement(type, key !== undefined ? Object.assign({}, props, { key: key }) : props);
      },
      jsxs: function(type, props, key) {
        return React.createElement(type, key !== undefined ? Object.assign({}, props, { key: key }) : props);
      },
      Fragment: React.Fragment
    };

    // Polyfill ModuleLoader
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
          locale: {
            getLocale: function() { return { active: 'zh' }; }
          },
          on: function() { return function() {}; },
          slots: {
            inject: function(slot, fn) { fn(); },
            register: function(opts, comp) {
              registeredComponent = comp;
              return function() {};
            }
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
</html>`);
    return;
  }

  if (req.url === '/_dsh/dsh-crew/config') {
    res.end(JSON.stringify({ ok: true, config: mockConfig }));
    return;
  }
  if (req.url === '/_dsh/dsh-crew/providers') {
    res.end(JSON.stringify({ ok: true, providers: mockProviders }));
    return;
  }
  if (req.url === '/_dsh/dsh-crew/presets') {
    res.end(JSON.stringify(mockPresets));
    return;
  }
  if (req.url === '/_dsh/dsh-crew/install/status') {
    res.end(JSON.stringify(mockInstallStatus));
    return;
  }
  if (req.url === '/_dsh/dsh-crew/sessions') {
    res.end(JSON.stringify({ ok: true, sessions: mockSessions }));
    return;
  }
  if (req.url === '/_dsh/dsh-crew/jobs') {
    res.end(JSON.stringify({ ok: true, jobs: mockJobs }));
    return;
  }
  if (req.url === '/_dsh/dsh-crew/worker-probe') {
    res.end(JSON.stringify({
      ok: true,
      status: 'connected',
      route_callable: true,
      tool_call_verified: true,
      checked_at: new Date().toISOString(),
    }));
    return;
  }

  res.statusCode = 404;
  res.end('{}');
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  console.log(`Mock DSH server running at http://127.0.0.1:${port}`);

  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // Retina 2x DPR
  });

  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Click the "Test route" (测试连通性) button on the Flash tier to trigger the verified badge
  const probeButtons = await page.$$('button:has-text("测试连通性"), button:has-text("Test route")');
  if (probeButtons.length > 0) {
    await probeButtons[0].click();
    await page.waitForTimeout(600);
  }

  // Ensure assets dir exists
  fs.mkdirSync(path.join(ROOT, 'docs/assets'), { recursive: true });
  const outPath = path.join(ROOT, 'docs/assets/hero-settings.png');

  await page.screenshot({ path: outPath });
  console.log(`Saved screenshot to ${outPath}`);

  await browser.close();
  server.close();
  process.exit(0);
});
