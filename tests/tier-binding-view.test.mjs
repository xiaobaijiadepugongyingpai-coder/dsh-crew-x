import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const COPY = {
  tierProviderDefault: '默认 · deepseek-official',
  tierModelDefault: (id) => `默认 · ${id}`,
  providerUnknown: '未在当前列表',
  providerUnsupported: '不支持 worker',
  probeVerified: '连通正常',
  probeNoToolCall: '未调用工具',
  probeTimeout: '超时',
  probeRouteError: '路线错误',
  probeFailed: (m) => `失败: ${m}`,
};

const CATALOG = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' },
      { id: 'glm-5.3-flash', name: 'glm-5.3-flash' },
    ],
  },
  {
    id: 'deepseek-vision',
    name: 'DeepSeek (Vision)',
    worker_unsupported: true,
    models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash ◉' }],
  },
  {
    id: 'empty-prov',
    name: 'Empty',
    models: [],
  },
];

async function loadHelperModule() {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-tier-view-'));
  const outfile = join(tmp, 'tier-binding-view.mjs');
  await build({
    entryPoints: [join(ROOT, 'src', 'client', 'tier-binding-view.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

test('tier-binding-view selects, patches, fallbacks, and probe formatting', async () => {
  const { mod, cleanup } = await loadHelperModule();
  try {
    const {
      resolveEffectiveBinding,
      providerSelectOptions,
      modelSelectOptions,
      patchForProviderChange,
      patchForModelChange,
      formatProbeOutcome,
    } = mod;

    // 1. Provider options exclude worker_unsupported and preserve unknown saved value.
    const opts = providerSelectOptions(CATALOG, '', COPY);
    assert.deepEqual(opts.map((o) => o.value), ['', 'deepseek-official', 'workbuddy', 'empty-prov']);
    assert.equal(opts.some((o) => o.value === 'deepseek-vision'), false);
    assert.equal(opts[2].label, 'WorkBuddy (workbuddy)');

    const optsWithSaved = providerSelectOptions(CATALOG, 'ollama-local', COPY);
    assert.deepEqual(optsWithSaved.at(-1), { value: 'ollama-local', label: 'ollama-local (未在当前列表)' });

    const optsWithUnsupported = providerSelectOptions(CATALOG, 'deepseek-vision', COPY);
    assert.deepEqual(optsWithUnsupported.at(-1), { value: 'deepseek-vision', label: 'deepseek-vision (不支持 worker)' });

    // 2. Model options list provider's models and preserve custom/unknown saved model.
    const wbModels = modelSelectOptions('flash', CATALOG, { flash_provider: 'workbuddy', flash_model: 'deepseek-v4.1-flash' }, COPY);
    assert.deepEqual(wbModels.map((o) => o.value), ['deepseek-v4.1-flash', 'glm-5.3-flash']);

    const wbEmptyModel = modelSelectOptions('pro', CATALOG, { pro_provider: 'workbuddy', pro_model: '' }, COPY);
    assert.deepEqual(wbEmptyModel.map((o) => o.value), ['', 'deepseek-v4.1-flash', 'glm-5.3-flash']);

    const customSavedModels = modelSelectOptions('pro', CATALOG, { pro_provider: 'workbuddy', pro_model: 'custom-model-x' }, COPY);
    assert.deepEqual(customSavedModels.map((o) => o.value), ['deepseek-v4.1-flash', 'glm-5.3-flash', 'custom-model-x']);

    const emptyProvModels = modelSelectOptions('flash', CATALOG, { flash_provider: 'empty-prov', flash_model: '' }, COPY);
    assert.deepEqual(emptyProvModels, [{ value: '', label: '默认 · deepseek-v4-flash' }]);

    // 3. Provider switch updates model cleanly and clearing restores both fields to ''.
    assert.deepEqual(
      patchForProviderChange('flash', 'workbuddy', CATALOG, { flash_provider: '', flash_model: '' }),
      { flash_provider: 'workbuddy', flash_model: 'deepseek-v4.1-flash' },
    );
    assert.deepEqual(
      patchForProviderChange('pro', 'workbuddy', CATALOG, { pro_provider: 'workbuddy', pro_model: 'glm-5.3-flash' }),
      { pro_provider: 'workbuddy', pro_model: 'glm-5.3-flash' },
    );
    assert.deepEqual(
      patchForProviderChange('flash', '', CATALOG, { flash_provider: 'workbuddy', flash_model: 'deepseek-v4.1-flash' }),
      { flash_provider: '', flash_model: '' },
    );
    assert.deepEqual(
      patchForProviderChange('flash', 'empty-prov', CATALOG, { flash_provider: 'workbuddy', flash_model: 'deepseek-v4.1-flash' }),
      { flash_provider: 'empty-prov', flash_model: '' },
    );
    assert.deepEqual(patchForModelChange('pro', '  glm-5.3-flash  '), { pro_model: 'glm-5.3-flash' });
    assert.deepEqual(patchForModelChange('pro', '   '), { pro_model: '' });

    // 4. Effective binding matches tier-binding semantics.
    assert.deepEqual(resolveEffectiveBinding('flash', {}), { provider: 'deepseek-official', model: 'deepseek-v4-flash', custom: false });
    assert.deepEqual(resolveEffectiveBinding('pro', { pro_provider: 'workbuddy', pro_model: 'glm-5.3-flash' }), {
      provider: 'workbuddy', model: 'glm-5.3-flash', custom: true,
    });

    // 5. Probe outcomes format all statuses clearly, including boolean fallback when status is absent.
    assert.equal(formatProbeOutcome(null, COPY), null);
    assert.equal(formatProbeOutcome({ busy: true, provider: 'workbuddy', model: 'glm-5.3-flash' }, COPY), null);
    assert.equal(formatProbeOutcome({ busy: false, provider: 'w', model: 'm', result: { status: 'verified' } }, COPY)?.color, '#3fb950');
    assert.equal(formatProbeOutcome({ busy: false, provider: 'w', model: 'm', result: { status: 'no_tool_call' } }, COPY)?.color, '#d29922');
    assert.equal(formatProbeOutcome({ busy: false, provider: 'w', model: 'm', result: { status: 'timeout' } }, COPY)?.text, '超时');
    assert.equal(formatProbeOutcome({ busy: false, provider: 'w', model: 'm', result: { status: 'route_error' } }, COPY)?.text, '路线错误');
    assert.equal(formatProbeOutcome({ busy: false, provider: 'w', model: 'm', result: { route_callable: true, tool_call_verified: true } }, COPY)?.color, '#3fb950');
    assert.equal(formatProbeOutcome({ busy: false, provider: 'w', model: 'm', result: { route_callable: true, tool_call_verified: false } }, COPY)?.color, '#d29922');
    assert.equal(formatProbeOutcome({ busy: false, provider: 'w', model: 'm', result: { route_callable: false } }, COPY)?.text, '路线错误');
    assert.equal(formatProbeOutcome({ busy: false, provider: 'w', model: 'm', error: 'ECONNREFUSED' }, COPY)?.text, '失败: ECONNREFUSED');
  } finally {
    cleanup();
  }
});
