import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listProviderCatalog, normalizeModelEntry } from '../src/provider-catalog.mjs';
import { apply } from '../src/hub/index.mjs';

test('normalizeModelEntry handles strings, objects, and blank entries', () => {
  assert.deepEqual(normalizeModelEntry('deepseek-v4.1-flash'), { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' });
  assert.deepEqual(normalizeModelEntry({ id: ' glm-5.3-flash ', name: ' GLM 5.3 Flash ' }), { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' });
  assert.deepEqual(normalizeModelEntry({ model: 'qwen3:8b' }), { id: 'qwen3:8b', name: 'qwen3:8b' });
  assert.equal(normalizeModelEntry('   '), null);
  assert.equal(normalizeModelEntry({}), null);
  assert.equal(normalizeModelEntry(null), null);
});

test('listProviderCatalog aggregates models per provider, deduplicates, and flags deepseek-vision', async () => {
  const llm = {
    listProviders: () => [
      { id: 'deepseek-official', name: 'DeepSeek' },
      { id: 'workbuddy', name: 'WorkBuddy' },
      { id: 'deepseek-vision', name: 'DeepSeek (Vision)' },
    ],
    async listModels(provider) {
      if (provider === 'deepseek-official') {
        return [
          { provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
          { provider, id: 'deepseek-v4-flash', name: 'Duplicate' },
        ];
      }
      if (provider === 'workbuddy') {
        return [
          { provider, id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
          { provider, id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' },
        ];
      }
      if (provider === 'deepseek-vision') {
        return [{ provider, id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash ◉' }];
      }
      return [];
    },
  };

  const catalog = await listProviderCatalog(llm);
  assert.equal(catalog.length, 3);
  assert.deepEqual(catalog[0], {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  });
  assert.deepEqual(catalog[1], {
    id: 'workbuddy',
    name: 'WorkBuddy',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' },
    ],
  });
  assert.equal(catalog[2].id, 'deepseek-vision');
  assert.equal(catalog[2].worker_unsupported, true);
});

test('listProviderCatalog isolates per-provider errors without leaking credentials', async () => {
  const llm = {
    listProviders: () => [
      { id: 'broken', name: 'Broken Provider' },
      { id: 'healthy', name: 'Healthy Provider' },
    ],
    async listModels(provider) {
      if (provider === 'broken') throw new Error('HTTP 401 bearer secret-token-xyz');
      return [{ id: 'model-a', name: 'Model A' }];
    },
  };

  const catalog = await listProviderCatalog(llm);
  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog[0], {
    id: 'broken',
    name: 'Broken Provider',
    models: [],
    models_error: 'list_failed',
  });
  assert.equal(JSON.stringify(catalog).includes('secret-token-xyz'), false);
  assert.deepEqual(catalog[1].models, [{ id: 'model-a', name: 'Model A' }]);
});

test('listProviderCatalog bounds hung listModels calls with a timeout', async () => {
  let aborted = false;
  const llm = {
    listProviders: () => [
      { id: 'slow', name: 'Slow Provider' },
      { id: 'slow-reject-on-abort', name: 'Rejecting Slow Provider' },
      { id: 'fast', name: 'Fast Provider' },
    ],
    async listModels(provider, signal) {
      if (provider === 'slow') {
        signal?.addEventListener('abort', () => { aborted = true; });
        return new Promise(() => {});
      }
      if (provider === 'slow-reject-on-abort') {
        return new Promise((_, reject) => {
          signal?.addEventListener('abort', () => {
            setTimeout(() => reject(new Error('AbortError')), 5);
          });
        });
      }
      return [{ id: 'fast-1', name: 'Fast 1' }];
    },
  };

  const catalog = await listProviderCatalog(llm, { timeoutMs: 40 });
  assert.deepEqual(catalog[0], {
    id: 'slow',
    name: 'Slow Provider',
    models: [],
    models_error: 'timeout',
  });
  assert.deepEqual(catalog[1], {
    id: 'slow-reject-on-abort',
    name: 'Rejecting Slow Provider',
    models: [],
    models_error: 'timeout',
  });
  assert.equal(aborted, true);
  assert.deepEqual(catalog[2].models, [{ id: 'fast-1', name: 'Fast 1' }]);
  await new Promise((r) => setTimeout(r, 20));
});

test('listProviderCatalog degrades gracefully when llm.listModels is absent', async () => {
  const catalog = await listProviderCatalog({
    listProviders: () => [{ id: 'workbuddy', name: 'WorkBuddy' }],
  });
  assert.deepEqual(catalog, [
    { id: 'workbuddy', name: 'WorkBuddy', models: [], models_error: 'unsupported' },
  ]);
});

test('GET /_dsh/dsh-crew/providers publishes providers with models and enforces GET + loopback', async () => {
  const handlers = new Map();
  const webServer = { register: (spec) => { handlers.set(spec.path, spec.handler); return () => {}; } };
  const ctx = {
    inject: (deps, cb) => { if (deps?.includes?.('webServer')) cb({ webServer }); },
    settings: { get: () => undefined },
    logger: { info: () => {}, warn: () => {} },
    llm: {
      listProviders: () => [{ id: 'workbuddy', name: 'WorkBuddy' }],
      listModels: async () => [{ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' }],
    },
  };
  const dispose = await apply(ctx);
  try {
    const handler = handlers.get('/_dsh/dsh-crew/providers');
    assert.equal(typeof handler, 'function');

    const invoke = async (method, remoteAddress = '127.0.0.1') => {
      const res = { out: null };
      res.writeHead = (status, headers) => { res.out = { status, headers, body: '' }; };
      res.end = (data) => { res.out.body = String(data); };
      await handler({
        method,
        url: '/_dsh/dsh-crew/providers',
        socket: { remoteAddress },
        headers: { host: '127.0.0.1:3080' },
      }, res);
      return { status: res.out.status, headers: res.out.headers, json: JSON.parse(res.out.body) };
    };

    const okRes = await invoke('GET');
    assert.equal(okRes.status, 200);
    assert.equal(okRes.json.ok, true);
    assert.deepEqual(okRes.json.providers, [
      { id: 'workbuddy', name: 'WorkBuddy', models: [{ id: 'glm-5.3-flash', name: 'GLM-5.3 Flash' }] },
    ]);
    assert.ok(okRes.json.bindings?.flash && okRes.json.bindings?.pro);

    const postRes = await invoke('POST');
    assert.equal(postRes.status, 405);
    assert.equal(postRes.headers.allow, 'GET');

    const remoteRes = await invoke('GET', '10.0.0.5');
    assert.equal(remoteRes.status, 403);
  } finally {
    await dispose().catch(() => {});
  }
});
