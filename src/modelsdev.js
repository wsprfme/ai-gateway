// Katalog provider OpenAI-compatible langsung dari models.dev (proyek @opencode-ai/models, MIT).
// Di-fetch live lalu di-cache di memori agar ringan dan harga/model selalu mutakhir.

const MODELS_DEV_URL = () => process.env.MODELS_DEV_URL || 'https://models.dev/api.json';
const CACHE_TTL_MS = 12 * 3600 * 1000;

const POPULAR = [
  'openai', 'openrouter', 'google', 'groq', 'deepseek', 'xai', 'togetherai', 'fireworks-ai',
  'mistral', 'perplexity', 'cerebras', 'moonshotai', 'zai', 'alibaba', 'nvidia',
  'siliconflow', 'nebius', 'deepinfra', 'novita-ai', 'hyperbolic', 'chutes', 'baseten',
];
const POPULAR_RANK = new Map(POPULAR.map((id, i) => [id, i]));
// Provider populer di models.dev yang punya endpoint OpenAI-compatible resmi, namun field `api`
// di models.dev kosong atau memakai package SDK khusus (@ai-sdk/groq, @openrouter/ai-sdk-provider, dll.).
const KNOWN_OAI_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  xai: 'https://api.x.ai/v1',
  togetherai: 'https://api.together.xyz/v1',
  mistral: 'https://api.mistral.ai/v1',
  perplexity: 'https://api.perplexity.ai',
  cerebras: 'https://api.cerebras.ai/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
};
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/;

let cache = { at: 0, providers: null, map: null, error: null };

function inferKind(m) {
  const out = m.modalities?.output;
  if (Array.isArray(out) && out.includes('image') && !out.includes('text')) return 'image';
  return 'text';
}

function normalizeModel(id, m) {
  const cost = m.cost || {};
  const limit = m.limit || {};
  return {
    upstream: id,
    display_name: m.name || id,
    kind: inferKind(m),
    input: typeof cost.input === 'number' ? cost.input : 0,
    cached: typeof cost.cache_read === 'number' ? cost.cache_read : null,
    output: typeof cost.output === 'number' ? cost.output : 0,
    context_window: typeof limit.context === 'number' && limit.context > 0 ? limit.context : null,
    max_output: typeof limit.output === 'number' && limit.output > 0 ? limit.output : null,
    reasoning: m.reasoning ? 'Mendukung reasoning.' : null,
    notes: m.description ? String(m.description).slice(0, 300) : null,
  };
}

function validHttpUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function loadModelsDev(force = false) {
  const now = Date.now();
  if (!force && cache.providers && now - cache.at < CACHE_TTL_MS) {
    return cache;
  }
  try {
    const res = await fetch(MODELS_DEV_URL(), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
    const raw = await res.json();
    const list = [];
    const map = new Map();
    for (const [slug, p] of Object.entries(raw || {})) {
      if (!SLUG_RE.test(slug)) continue;
      if (!p) continue;
      const knownUrl = KNOWN_OAI_BASE_URLS[slug];
      const apiUrl = typeof p.api === 'string' && validHttpUrl(p.api.trim()) ? p.api.trim() : knownUrl;
      if (!apiUrl) continue;
      // Hanya ambil provider OpenAI-compatible (atau yang terdaftar punya endpoint OpenAI-compatible resmi).
      if (!knownUrl && p.npm && !/openai/i.test(p.npm)) continue;
      const modelsObj = p.models && typeof p.models === 'object' ? p.models : {};
      const models = Object.entries(modelsObj)
        .filter(([, m]) => m && typeof m === 'object')
        .map(([id, m]) => normalizeModel(id, m));
      if (!models.length) continue;
      const item = {
        slug,
        name: p.name || slug,
        base_url: apiUrl.replace(/\/+$/, ''),
        docs: typeof p.doc === 'string' ? p.doc : '',
        logo: `https://models.dev/logos/${slug}.svg`,
        auth_type: 'apikey',
        oauth: false,
        source: 'models.dev',
        models,
      };
      list.push(item);
      map.set(slug, item);
    }
    list.sort((a, b) => {
      const ra = POPULAR_RANK.has(a.slug) ? POPULAR_RANK.get(a.slug) : 9999;
      const rb = POPULAR_RANK.has(b.slug) ? POPULAR_RANK.get(b.slug) : 9999;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
    cache = { at: now, providers: list, map, error: null };
  } catch (e) {
    cache = {
      at: cache.providers ? cache.at : now - CACHE_TTL_MS + 60_000,
      providers: cache.providers || [],
      map: cache.map || new Map(),
      error: e.message,
    };
  }
  return cache;
}

export async function getModelsDevProvider(slug) {
  const { map } = await loadModelsDev();
  return map.get(slug) || null;
}
