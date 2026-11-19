// Pure view helpers for per-tier LLM provider/model binding and route probing
// in the DSH Crew settings panel. No React or window globals so unit tests
// can bundle and exercise every edge case directly.

export type TierName = 'flash' | 'pro';

export interface ModelEntry {
  id: string;
  name?: string;
}

export interface ProviderCatalogEntry {
  id: string;
  name?: string;
  models?: ModelEntry[];
  models_error?: string;
  worker_unsupported?: boolean;
}

export interface ProbeResult {
  provider?: string;
  model?: string;
  checked_at?: string;
  route_callable?: boolean;
  tool_call_verified?: boolean;
  status?: string;
}

export interface TierProbeState {
  busy: boolean;
  provider: string;
  model: string;
  result?: ProbeResult;
  error?: string;
}

export const DEFAULT_TIER_BINDING: Record<TierName, { provider: string; model: string }> = {
  flash: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  pro: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
};

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveEffectiveBinding(
  tier: TierName,
  config: any = {},
): { provider: string; model: string; custom: boolean } {
  const fallback = DEFAULT_TIER_BINDING[tier];
  const rawProvider = clean(config?.[`${tier}_provider`]);
  const rawModel = clean(config?.[`${tier}_model`]);
  const provider = rawProvider || fallback.provider;
  const model = rawModel || fallback.model;
  return {
    provider,
    model,
    custom: provider !== fallback.provider || model !== fallback.model,
  };
}

export function providerSelectOptions(
  catalog: ProviderCatalogEntry[] | null | undefined,
  currentProvider: string | undefined,
  copy: any,
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [
    { value: '', label: copy.tierProviderDefault },
  ];
  const seen = new Set<string>(['']);

  for (const p of catalog ?? []) {
    const id = clean(p?.id);
    if (id === '' || p?.worker_unsupported || seen.has(id)) continue;
    seen.add(id);
    const name = clean(p?.name);
    options.push({
      value: id,
      label: name !== '' && name !== id ? `${name} (${id})` : id,
    });
  }

  const saved = clean(currentProvider);
  if (saved !== '' && !seen.has(saved)) {
    const matched = (catalog ?? []).find((p) => clean(p?.id) === saved);
    const suffix = matched?.worker_unsupported ? copy.providerUnsupported : copy.providerUnknown;
    options.push({
      value: saved,
      label: `${saved} (${suffix})`,
    });
  }

  return options;
}

export function modelSelectOptions(
  tier: TierName,
  catalog: ProviderCatalogEntry[] | null | undefined,
  config: any = {},
  copy: any,
): Array<{ value: string; label: string }> {
  const fallback = DEFAULT_TIER_BINDING[tier];
  const rawProvider = clean(config?.[`${tier}_provider`]);
  const rawModel = clean(config?.[`${tier}_model`]);
  const effectiveProvider = rawProvider || fallback.provider;
  const prov = (catalog ?? []).find((p) => clean(p?.id) === effectiveProvider);
  const models = Array.isArray(prov?.models) ? prov.models : [];

  const options: Array<{ value: string; label: string }> = [];
  const seen = new Set<string>();

  if (rawProvider === '' || effectiveProvider === fallback.provider || models.length === 0 || rawModel === '') {
    options.push({ value: '', label: copy.tierModelDefault(fallback.model) });
    seen.add('');
  }

  for (const m of models) {
    const id = clean(m?.id);
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const name = clean(m?.name);
    options.push({
      value: id,
      label: name !== '' && name !== id ? `${name} (${id})` : id,
    });
  }

  if (rawModel !== '' && !seen.has(rawModel)) {
    options.push({ value: rawModel, label: rawModel });
  }

  return options;
}

export function patchForProviderChange(
  tier: TierName,
  nextProvider: string,
  catalog: ProviderCatalogEntry[] | null | undefined,
  config: any = {},
): Record<string, string> {
  const provider = clean(nextProvider);
  if (provider === '') {
    return { [`${tier}_provider`]: '', [`${tier}_model`]: '' };
  }

  const fallback = DEFAULT_TIER_BINDING[tier];
  const prov = (catalog ?? []).find((p) => clean(p?.id) === provider);
  const models = Array.isArray(prov?.models) ? prov.models : [];
  const curModel = clean(config?.[`${tier}_model`]);

  let nextModel = '';
  if (models.length > 0) {
    if (curModel !== '' && models.some((m) => clean(m?.id) === curModel)) {
      nextModel = curModel;
    } else if (provider === fallback.provider && models.some((m) => clean(m?.id) === fallback.model)) {
      nextModel = '';
    } else {
      nextModel = clean(models[0]?.id);
    }
  }

  return {
    [`${tier}_provider`]: provider,
    [`${tier}_model`]: nextModel,
  };
}

export function patchForModelChange(tier: TierName, nextModel: string): Record<string, string> {
  return { [`${tier}_model`]: clean(nextModel) };
}

export function formatProbeOutcome(
  state: TierProbeState | null | undefined,
  copy: any,
): { color: string; icon: string; text: string } | null {
  if (!state || state.busy) return null;
  if (state.error) {
    return { color: '#f85149', icon: '✗', text: copy.probeFailed(state.error) };
  }
  let status = clean(state.result?.status);
  if (status === '' && state.result && typeof state.result === 'object') {
    if (state.result.route_callable === false) {
      status = 'route_error';
    } else if (state.result.tool_call_verified === true) {
      status = 'verified';
    } else if (state.result.route_callable === true && state.result.tool_call_verified === false) {
      status = 'no_tool_call';
    }
  }
  if (status === 'verified') {
    return { color: '#3fb950', icon: '✓', text: copy.probeVerified };
  }
  if (status === 'no_tool_call') {
    return { color: '#d29922', icon: '⚠', text: copy.probeNoToolCall };
  }
  if (status === 'timeout') {
    return { color: '#f85149', icon: '✗', text: copy.probeTimeout };
  }
  if (status === 'route_error') {
    return { color: '#f85149', icon: '✗', text: copy.probeRouteError };
  }
  return { color: '#f85149', icon: '✗', text: copy.probeFailed(status || 'unknown') };
}
