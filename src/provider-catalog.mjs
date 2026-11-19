// Enumerates the DSH host's registered LLM providers and their models.
//
// Realm discipline: zero @deepseek-ai/* imports. Everything touches ctx.llm
// purely by duck-typed method calls and normalizes the result into plain JSON
// objects for /_dsh/dsh-crew/providers.

export const LIST_MODELS_TIMEOUT_MS = 5000;

// Routes that are registered as adapters for internal host features (e.g.
// vision-paste re-routing in src/vision-route.mjs) cannot serve worker agent
// dispatches because they do not implement full tool-calling / prepareCall.
const WORKER_UNSUPPORTED_PROVIDERS = new Set(['deepseek-vision']);

const TIMEOUT_SENTINEL = Symbol('listModelsTimeout');

/**
 * Normalize one model descriptor (string or object) into `{ id, name }`.
 * Returns `null` when the entry carries no usable model id.
 */
export function normalizeModelEntry(entry) {
  if (typeof entry === 'string') {
    const id = entry.trim();
    return id === '' ? null : { id, name: id };
  }
  if (!entry || typeof entry !== 'object') return null;
  const rawId = typeof entry.id === 'string' ? entry.id : typeof entry.model === 'string' ? entry.model : '';
  const id = rawId.trim();
  if (id === '') return null;
  const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id;
  return { id, name };
}

function normalizeProviders(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const p of raw) {
    let id = '';
    let name = '';
    if (typeof p === 'string') {
      id = p.trim();
      name = id;
    } else if (p && typeof p === 'object') {
      id = typeof p.id === 'string' ? p.id.trim() : '';
      name = typeof p.name === 'string' && p.name.trim() !== '' ? p.name.trim() : id;
    }
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

async function fetchModelsForProvider(llm, provider, timeoutMs) {
  const unsupported = WORKER_UNSUPPORTED_PROVIDERS.has(provider.id);
  const base = {
    id: provider.id,
    name: provider.name,
    ...(unsupported ? { worker_unsupported: true } : {}),
  };

  if (typeof llm?.listModels !== 'function') {
    return { ...base, models: [], models_error: 'unsupported' };
  }

  const controller = new AbortController();
  let timer;
  try {
    const listPromise = Promise.resolve().then(() => llm.listModels(provider.id, controller.signal));
    // Absorb post-timeout abort rejections so a slow adapter rejecting on
    // signal abort never leaks an UnhandledPromiseRejection.
    listPromise.catch(() => {});
    const raw = await Promise.race([
      listPromise,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(TIMEOUT_SENTINEL);
        }, timeoutMs);
      }),
    ]);

    if (raw === TIMEOUT_SENTINEL) {
      return { ...base, models: [], models_error: 'timeout' };
    }

    const models = [];
    const seen = new Set();
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const normalized = normalizeModelEntry(item);
        if (!normalized || seen.has(normalized.id)) continue;
        seen.add(normalized.id);
        models.push(normalized);
      }
    }
    return { ...base, models };
  } catch {
    // Provider errors may include headers or endpoint credentials; expose only a
    // fixed error code instead of raw exception text.
    return { ...base, models: [], models_error: 'list_failed' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

/**
 * List every registered LLM provider on `llm` together with its advertised
 * models. Per-provider failures or timeouts are isolated so one stalled
 * adapter never hides working providers.
 */
export async function listProviderCatalog(llm, { timeoutMs = LIST_MODELS_TIMEOUT_MS } = {}) {
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : LIST_MODELS_TIMEOUT_MS;
  let rawProviders;
  try {
    rawProviders = typeof llm?.listProviders === 'function' ? llm.listProviders() : [];
  } catch {
    return [];
  }
  const providers = normalizeProviders(rawProviders);
  if (providers.length === 0) return [];
  return Promise.all(providers.map((p) => fetchModelsForProvider(llm, p, effectiveTimeout)));
}
