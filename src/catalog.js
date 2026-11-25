// Katalog bawaan provider. Harga USD per 1 juta token.
// Sumber:
//   Meta  : https://dev.meta.ai/docs/models, https://dev.meta.ai/docs/pricing-rate-limits, https://dev.meta.ai/docs/reasoning,
//           https://dev.meta.ai/docs/image-generation, https://dev.meta.ai/docs/speech-to-text, https://dev.meta.ai/docs/sam/segmenting
//   River : https://docs.river.ai/guides/inference-models/, https://docs.river.ai/guides/inference-controls/
//           harga live dari https://console.river.ai/api/public/pricing

export const RIVER_PRICING_URL = 'https://console.river.ai/api/public/pricing';

const M = 1_048_576;
// Web search grounding Meta: $2.50 per 1.000 query, di luar biaya token (Responses dan Messages API).
const META_SEARCH = 0.0025;

export const CATALOG = {
  meta: {
    name: 'Meta Model API',
    base_url: 'https://api.meta.ai/v1',
    icon: '/icons/meta.svg',
    docs: 'https://dev.meta.ai/docs/models',
    models: [
      {
        upstream: 'muse-wonder-1.0',
        display_name: 'Muse Wonder',
        price_search: META_SEARCH,
        input: 4.0, cached: 0.2, output: 20.0,
        context_window: M,
        reasoning: 'minimal, low, medium, high, xhigh, max (default max). none ditolak.',
        notes: 'Model paling kuat dari Meta untuk coding dan agen jangka panjang. Status preview, Standard mode saja.',
      },
      {
        upstream: 'muse-spark-1.3',
        display_name: 'Muse Spark 1.3',
        price_search: META_SEARCH,
        input: 1.25, cached: 0.15, output: 4.25,
        context_window: M, max_output: 131072,
        reasoning: 'minimal sampai max (default high). none ditolak.',
        notes: 'Versi Muse Spark yang direkomendasikan untuk agen dan coding.',
      },
      {
        upstream: 'muse-spark-1.3-contributor',
        display_name: 'Muse Spark 1.3 Contributor',
        price_search: META_SEARCH,
        input: 0.1, cached: 0.002, output: 0.2,
        context_window: M,
        reasoning: 'minimal sampai max (default high). Docs Meta bilang max tidak tersedia, tapi API menerimanya (dites).',
        notes: 'Harga diskon. Prompt dan respons boleh dipakai Meta untuk training. Limit 150 RPM.',
      },
      {
        upstream: 'muse-spark-1.2',
        display_name: 'Muse Spark 1.2',
        price_search: META_SEARCH,
        input: 1.25, cached: 0.15, output: 4.25,
        context_window: M,
        reasoning: 'minimal sampai xhigh (default high).',
      },
      {
        upstream: 'muse-spark-1.2-contributor',
        display_name: 'Muse Spark 1.2 Contributor',
        price_search: META_SEARCH,
        input: 0.1, cached: 0.002, output: 0.2,
        context_window: M,
        reasoning: 'minimal sampai xhigh (default high).',
        notes: 'Harga diskon. Prompt dan respons boleh dipakai Meta untuk training. Limit 150 RPM.',
      },
      {
        upstream: 'muse-spark-1.1',
        display_name: 'Muse Spark 1.1',
        price_search: META_SEARCH,
        input: 1.25, cached: 0.15, output: 4.25,
        context_window: M,
        reasoning: 'minimal sampai xhigh (default high).',
      },
      {
        upstream: 'muse-ember-1.0',
        display_name: 'Muse Ember',
        price_search: META_SEARCH,
        input: 0.1, cached: 0.004, output: 0.5,
        long_threshold: 200_000, input_long: 0.3, cached_long: 0.012, output_long: 1.5,
        context_window: M, max_output: 524288,
        reasoning: 'minimal sampai max (default max). none ditolak.',
        notes: 'Model murah untuk volume besar: sub-agent, tool call, routing. Input di atas 200K token: seluruh request kena harga tier panjang.',
      },
      {
        upstream: 'muse-image-1.0',
        display_name: 'Muse Image',
        kind: 'image',
        input: 0, cached: null, output: 0,
        price_image: 0.01,
        notes: 'Generate dan edit gambar. Endpoint: /v1/images/generations, /v1/images/edits (JSON atau multipart), atau /v1/responses untuk edit berantai. $0.01 per gambar yang berhasil; pencarian referensi bawaan tidak ditagih terpisah.',
      },
      {
        upstream: 'muse-voice-transcribe-1.0',
        display_name: 'Muse Voice Transcribe',
        kind: 'transcribe',
        input: 0, cached: null, output: 0,
        price_audio_hour: 0.18,
        notes: 'Speech to text, 25 bahasa termasuk Indonesia. File: POST /v1/asr/transcribe (WAV mono 16-bit, 16/24 kHz, maks 10 menit / 32 MB). Live: WebSocket /v1/asr/realtime. $0.18 per jam audio, dibulatkan ke bawah per detik.',
      },
      {
        upstream: 'sam-3.1',
        display_name: 'Segment Anything 3.1',
        kind: 'segment',
        input: 0, cached: null, output: 0,
        price_image: 0.0025, price_frame: 0.0002, min_frames: 50,
        notes: 'Segmentasi gambar dan video lewat /v1/responses (input_text + input_image/input_video). Gambar $2.50 per 1.000; video $0.20 per 1.000 frame, minimal 50 frame per request.',
      },
    ],
  },
  'river-ai': {
    name: 'River',
    base_url: 'https://api.river.ai/v1',
    icon: '/icons/river-ai.png',
    docs: 'https://docs.river.ai/guides/inference-models/',
    live_pricing: RIVER_PRICING_URL,
    models: [
      {
        upstream: 'moonshotai/Kimi-K3.1-Pro', display_name: 'Kimi K3.1 Pro',
        input: 2.0, cached: 0.2, output: 10.0, context_window: M, max_output: 1048575,
        reasoning: 'none, low, high, max (default max).',
        notes: 'Default output budget 131.072 token.',
      },
      {
        upstream: 'moonshotai/Kimi-K3', display_name: 'Kimi K3',
        input: 3.0, cached: 0.3, output: 15.0, context_window: M, max_output: 1048575,
        reasoning: 'none, low, high, max (default max).',
        notes: 'Default output budget 131.072 token.',
      },
      {
        upstream: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', display_name: 'DeepSeek V4.1 Flash 1017',
        input: 0.12, cached: 0.0024, output: 0.48, context_window: M, max_output: 393216,
        reasoning: 'none, low, high, max (default off). Thinking tanpa effort = high.',
      },
      {
        upstream: 'deepseek-ai/DeepSeek-V4.1-Flash', display_name: 'DeepSeek V4.1 Flash',
        input: 0.12, cached: 0.0024, output: 0.48, context_window: M, max_output: 393216,
        reasoning: 'none, low, high, max (default off). Thinking tanpa effort = high.',
      },
      {
        upstream: 'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4', display_name: 'Nemotron 3.5 Super VL 120B',
        input: 0.07, cached: 0.024, output: 0.37, context_window: M, max_output: 1048575,
        reasoning: 'none, medium, high (default high).',
      },
      {
        upstream: 'zai-org/GLM-5.3-Flash', display_name: 'GLM 5.3 Flash',
        input: 0.12, cached: 0.024, output: 0.4, context_window: M, max_output: 131072,
        reasoning: 'low, high, max (default max). none ditolak.',
        notes: 'Default output budget 65.536 token dan top_p 0.95.',
      },
      {
        upstream: 'GLM-5.3', display_name: 'GLM 5.3',
        input: 1.12, cached: 0.208, output: 3.52, context_window: M, max_output: 131072,
        reasoning: 'low, high, max (default max). none ditolak.',
        notes: 'Default output budget 65.536 token dan top_p 0.95.',
      },
      {
        upstream: 'Qwen/Qwen3.8-27B-FP8', display_name: 'Qwen3.8 27B',
        input: 0.1, cached: 0.02, output: 2.0, context_window: 262144, max_output: 262143,
        reasoning: 'none, low, medium, xhigh (default xhigh).',
      },
    ],
  },
  // Langganan ChatGPT (Sign in with ChatGPT) dipakai sebagai API lewat backend Codex.
  // Tagihan sebenarnya masuk kuota plan ChatGPT, tapi harga API resmi OpenAI (USD/1Jt token)
  // disimpan di katalog supaya gateway bisa menghitung estimasi nilai pemakaian API.
  // Sumber: https://developers.openai.com/api/docs/pricing
  codex: {
    name: 'ChatGPT (Codex)',
    base_url: 'https://chatgpt.com/backend-api/codex/responses',
    icon: '/icons/openai.svg',
    docs: 'https://developers.openai.com/codex/',
    auth_type: 'codex',
    oauth: true,
    allow_passthrough: true,
    models: [
      { upstream: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol', input: 2.0, cached: 0.1, output: 10.0, context_window: 500000, reasoning: 'low, medium, high, xhigh, max (default low).', notes: 'Langganan ChatGPT; harga = estimasi tarif resmi OpenAI API.' },
      { upstream: 'gpt-6.2-astra', display_name: 'GPT-6.2 Astra', input: 10.0, cached: 1.0, output: 50.0, context_window: 272000, reasoning: 'low, medium, high, xhigh, max (default low).', notes: 'Langganan ChatGPT; estimasi tarif resmi OpenAI API.' },
      { upstream: 'gpt-6.1-terra', display_name: 'GPT-6.1 Terra', input: 1.0, cached: 0.05, output: 5.0, context_window: 500000, reasoning: 'low, medium, high, xhigh, max (default low).', notes: 'Langganan ChatGPT; estimasi tarif resmi OpenAI API.' },
      { upstream: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', input: 2.0, cached: 0.1, output: 10.0, context_window: 500000, reasoning: 'low, medium, high, xhigh, max (default low).', notes: 'Langganan ChatGPT; estimasi tarif resmi OpenAI API.' },
      { upstream: 'gpt-6-astra', display_name: 'GPT-6 Astra', input: 10.0, cached: 1.0, output: 50.0, context_window: 272000, reasoning: 'low, medium, high, xhigh, max (default low).', notes: 'Langganan ChatGPT; estimasi tarif resmi OpenAI API.' },
      { upstream: 'gpt-6-sol', display_name: 'GPT-6 Sol', input: 2.0, cached: 0.2, output: 10.0, context_window: 272000, reasoning: 'low, medium, high, xhigh, max (default medium).', notes: 'Langganan ChatGPT; estimasi tarif resmi OpenAI API.' },
      { upstream: 'gpt-6-luna', display_name: 'GPT-6 Luna', input: 0.1, cached: 0.01, output: 0.5, context_window: 272000, reasoning: 'low, medium, high, xhigh, max (default medium).', notes: 'Langganan ChatGPT; estimasi tarif resmi OpenAI API.' },
      { upstream: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', input: 4.0, cached: 0.4, output: 20.0, context_window: 272000, reasoning: 'low, medium, high, xhigh, max (default low).', notes: 'Langganan ChatGPT; estimasi tarif resmi OpenAI API.' },
      { upstream: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', input: 2.0, cached: 0.2, output: 12.0, context_window: 272000, reasoning: 'low, medium, high, xhigh, max (default medium).', notes: 'Langganan ChatGPT; estimasi tarif resmi OpenAI API.' },
      { upstream: 'gpt-5.6-luna', display_name: 'GPT-5.6 Luna', input: 0.2, cached: 0.02, output: 1.2, context_window: 272000, reasoning: 'low, medium, high, xhigh, max (default medium).', notes: 'Langganan ChatGPT; estimasi tarif resmi OpenAI API.' },
      // Image generation & edit (butuh akun ChatGPT Plus atau lebih tinggi). OpenAI API menagih per token ($5 in / $1.25 cached / $30 out per 1Jt token).
      { upstream: 'gpt-image-2.6-flare', display_name: 'GPT Image 2.6 Flare', kind: 'image', input: 5.0, cached: 1.25, output: 30.0, notes: 'Generate dan edit gambar (/v1/images/generations, /v1/images/edits). Estimasi tarif token OpenAI API ($5/$30 per 1Jt). Butuh ChatGPT Plus+.' },
      { upstream: 'gpt-image-2.6-sunburst', display_name: 'GPT Image 2.6 Sunburst', kind: 'image', input: 5.0, cached: 1.25, output: 30.0, notes: 'Generate dan edit gambar (/v1/images/generations, /v1/images/edits). Estimasi tarif token OpenAI API ($5/$30 per 1Jt). Butuh ChatGPT Plus+.' },
      { upstream: 'gpt-image-2.5', display_name: 'GPT Image 2.5', kind: 'image', input: 5.0, cached: 1.25, output: 30.0, notes: 'Generate dan edit gambar (/v1/images/generations, /v1/images/edits). Estimasi tarif token OpenAI API ($5/$30 per 1Jt). Butuh ChatGPT Plus+.' },
      { upstream: 'gpt-image-2.5-flare', display_name: 'GPT Image 2.5 Flare', kind: 'image', input: 5.0, cached: 1.25, output: 30.0, notes: 'Generate dan edit gambar (/v1/images/generations, /v1/images/edits). Estimasi tarif token OpenAI API ($5/$30 per 1Jt). Butuh ChatGPT Plus+.' },
      { upstream: 'gpt-image-2.5-sunburst', display_name: 'GPT Image 2.5 Sunburst', kind: 'image', input: 5.0, cached: 1.25, output: 30.0, notes: 'Generate dan edit gambar (/v1/images/generations, /v1/images/edits). Estimasi tarif token OpenAI API ($5/$30 per 1Jt). Butuh ChatGPT Plus+.' },
      { upstream: 'gpt-image-2', display_name: 'GPT Image 2', kind: 'image', input: 5.0, cached: 1.25, output: 30.0, notes: 'Generate dan edit gambar (/v1/images/generations, /v1/images/edits). Estimasi tarif token OpenAI API ($5/$30 per 1Jt). Butuh ChatGPT Plus+.' },
      { upstream: 'gpt-image-1.5', display_name: 'GPT Image 1.5', kind: 'image', input: 5.0, cached: 1.25, output: 30.0, notes: 'Generate dan edit gambar (/v1/images/generations, /v1/images/edits). Estimasi tarif token OpenAI API ($5/$30 per 1Jt). Butuh ChatGPT Plus+.' },
      { upstream: 'gpt-6-sol-image', display_name: 'GPT-6 Sol Image', kind: 'image', input: 2.0, cached: 0.2, output: 10.0, price_image: 0.04, notes: 'Generate dan edit gambar via Responses image_generation tool. Estimasi tarif OpenAI API (+$0.04/gambar). Butuh ChatGPT Plus+.' },
    ],
  },
  // Langganan Google Antigravity (Gemini) dipakai sebagai API lewat backend Cloud Code.
  // Harga API resmi Google Gemini (USD/1Jt token) disimpan untuk estimasi nilai pemakaian.
  // Sumber: https://ai.google.dev/gemini-api/docs/pricing
  antigravity: {
    name: 'Antigravity (Gemini)',
    base_url: 'https://daily-cloudcode-pa.googleapis.com',
    icon: '/icons/antigravity.svg',
    docs: 'https://antigravity.google',
    auth_type: 'antigravity',
    oauth: true,
    allow_passthrough: true,
    models: [
      { upstream: 'gemini-4-hydrogen', display_name: 'Gemini 4 Hydrogen', input: 1.5, cached: 0.075, output: 7.5, context_window: M, max_output: 65535, reasoning: 'low, medium, high, xhigh (default high).', notes: 'Langganan Antigravity; estimasi tarif resmi Gemini API.' },
      { upstream: 'gemini-4-hydrogen-sonar', display_name: 'Gemini 4 Hydrogen Sonar', input: 1.5, cached: 0.075, output: 7.5, context_window: M, max_output: 65535, reasoning: 'varian sonar.', notes: 'Langganan Antigravity; estimasi tarif resmi Gemini API.' },
      { upstream: 'gemini-4-hydrogen-tiered', display_name: 'Gemini 4 Hydrogen Tiered', input: 1.5, cached: 0.075, output: 7.5, context_window: M, max_output: 65535, reasoning: 'high, xhigh (default high).', notes: 'Langganan Antigravity; estimasi tarif resmi Gemini API.' },
      { upstream: 'gemini-4-neon', display_name: 'Gemini 4 Neon', input: 3.0, cached: 0.15, output: 15.0, context_window: M, max_output: 65535, reasoning: 'low, medium, high, xhigh (default high).', notes: 'Langganan Antigravity; estimasi tarif resmi Gemini API.' },
      { upstream: 'gemini-4-argon', display_name: 'Gemini 4 Argon', input: 2.0, cached: 0.1, output: 10.0, context_window: M, max_output: 65535, reasoning: 'low, medium, high (default high).', notes: 'Tarif promo Gemini API s.d. 30 Nov 2026 ($4/$20 mulai 1 Des 2026).' },
      { upstream: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon', input: 2.0, cached: 0.1, output: 10.0, context_window: M, max_output: 65535, reasoning: 'low, medium, high (default high).', notes: 'Tarif promo Gemini API s.d. 30 Nov 2026 ($4/$20 mulai 1 Des 2026).' },
      { upstream: 'gemini-3.8-flash', display_name: 'Gemini 3.8 Flash', input: 0.75, cached: 0.075, output: 3.75, context_window: M, max_output: 65535, reasoning: 'low, medium, high (default medium).', notes: 'Tarif promo Gemini API s.d. 31 Des 2026 ($1.50/$7.50 mulai 1 Jan 2027).' },
      { upstream: 'gemini-3.8-flash-tiered', display_name: 'Gemini 3.8 Flash Tiered', input: 0.75, cached: 0.075, output: 3.75, context_window: M, max_output: 65535, reasoning: 'opsional lewat reasoning_effort.', notes: 'Tarif promo Gemini API s.d. 31 Des 2026 ($1.50/$7.50 mulai 1 Jan 2027).' },
      { upstream: 'gemini-3-flash', display_name: 'Gemini 3 Flash', input: 0.5, cached: 0.05, output: 3.0, context_window: M, max_output: 65535, reasoning: 'opsional lewat reasoning_effort.', notes: 'Langganan Antigravity; estimasi tarif resmi Gemini API.' },
      { upstream: 'gemini-3.5-flash-lite', display_name: 'Gemini 3.5 Flash Lite', input: 0.3, cached: 0.03, output: 2.5, context_window: M, max_output: 65535, reasoning: 'opsional lewat reasoning_effort.', notes: 'Langganan Antigravity; estimasi tarif resmi Gemini API.' },
      { upstream: 'gemini-3.1-flash-lite', display_name: 'Gemini 3.1 Flash Lite', input: 0.25, cached: 0.025, output: 1.5, context_window: M, max_output: 65535, reasoning: 'opsional lewat reasoning_effort.', notes: 'Langganan Antigravity; estimasi tarif resmi Gemini API.' },
      { upstream: 'gemini-2.5-flash', display_name: 'Gemini 2.5 Flash', input: 0.3, cached: 0.03, output: 2.5, context_window: M, max_output: 65535, reasoning: 'opsional lewat reasoning_effort.', notes: 'Langganan Antigravity; estimasi tarif resmi Gemini API.' },
      { upstream: 'gemini-2.5-flash-thinking', display_name: 'Gemini 2.5 Flash Thinking', input: 0.3, cached: 0.03, output: 2.5, context_window: M, max_output: 65535, reasoning: 'thinking bawaan.', notes: 'Langganan Antigravity; estimasi tarif resmi Gemini API.' },
      { upstream: 'gemini-2.5-flash-lite', display_name: 'Gemini 2.5 Flash Lite', input: 0.1, cached: 0.01, output: 0.4, context_window: M, max_output: 65535, reasoning: 'ringan, tanpa thinking bawaan.', notes: 'Langganan Antigravity; estimasi tarif resmi Gemini API.' },
      { upstream: 'gemini-3.1-flash-image', display_name: 'Gemini 3.1 Flash (Image)', kind: 'image', input: 0.5, cached: 0.05, output: 60.0, notes: 'Generate dan edit gambar (/v1/images/generations, /v1/images/edits). Estimasi tarif token Gemini API ($60/1Jt token output gambar, ~$0.067 per gambar 1K).' },
    ],
  },
};

// Model ID publik: "<slug>/<nama upstream>" dengan "/" di nama upstream diganti "-".
export function publicModelId(slug, upstream) {
  return `${slug}/${upstream.replace(/\//g, '-')}`;
}

// Single source of truth untuk endpoint yang didukung tiap model, berdasarkan kapabilitas upstream nyata.
const CATALOG_MODEL_INDEX = new Map();
for (const [slug, preset] of Object.entries(CATALOG)) {
  for (const m of preset.models) {
    CATALOG_MODEL_INDEX.set(publicModelId(slug, m.upstream), { slug, preset, model: m });
  }
}

export function supportedEndpointsFor(row) {
  const kind = row.kind || 'text';
  const slug = row.slug || row.provider_slug || '';
  const auth = row.auth_type || 'apikey';
  const entry = CATALOG_MODEL_INDEX.get(row.id);
  if (entry?.model?.supported_endpoints) return [...entry.model.supported_endpoints];

  if (slug === 'meta') {
    if (kind === 'image') return ['/v1/images/generations', '/v1/images/edits', '/v1/responses'];
    if (kind === 'transcribe') return ['/v1/audio/transcriptions', '/v1/asr/transcribe', '/v1/asr/realtime'];
    if (kind === 'segment') return ['/v1/responses'];
    return ['/v1/chat/completions', '/v1/responses'];
  }
  if (slug === 'river-ai') {
    if (kind === 'image') return ['/v1/images/generations', '/v1/images/edits'];
    return ['/v1/chat/completions'];
  }
  if (auth === 'codex' || auth === 'antigravity') {
    if (kind === 'image') return ['/v1/images/generations', '/v1/images/edits'];
    return ['/v1/chat/completions', '/v1/responses'];
  }
  // Provider custom (API key OpenAI-compatible generik)
  if (kind === 'image') return ['/v1/images/generations', '/v1/images/edits'];
  if (kind === 'transcribe') return ['/v1/audio/transcriptions', '/v1/asr/transcribe'];
  if (kind === 'segment') return ['/v1/responses'];
  return ['/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/embeddings'];
}

// Bentuk metadata publik satu model (dipakai bersama oleh GET /v1/models dan GET /v1/models/{model}).
export function formatModelObject(row) {
  const pricing = {
    unit: 'usd_per_1m_tokens',
    input: row.input_price ?? null,
    cached: row.cached_price ?? null,
    output: row.output_price ?? null,
  };
  if (row.long_threshold) {
    pricing.long_context_threshold = row.long_threshold;
    pricing.input_long = row.input_price_long ?? null;
    pricing.cached_long = row.cached_price_long ?? null;
    pricing.output_long = row.output_price_long ?? null;
  }
  if (row.price_image != null) pricing.image = row.price_image;
  if (row.price_frame != null) {
    pricing.video_frame = row.price_frame;
    pricing.min_frames = row.min_frames ?? 0;
  }
  if (row.price_audio_hour != null) pricing.audio_hour = row.price_audio_hour;
  if (row.price_search != null) pricing.web_search = row.price_search;

  return {
    id: row.id,
    object: 'model',
    created: Math.floor((row.created_at || Date.now()) / 1000),
    owned_by: row.slug || row.provider_slug || 'gateway',
    display_name: row.display_name || row.id,
    kind: row.kind || 'text',
    context_window: row.context_window ?? null,
    max_output: row.max_output ?? null,
    supported_endpoints: supportedEndpointsFor(row),
    reasoning: row.reasoning ?? null,
    pricing,
  };
}

export async function fetchRiverPricing() {
  const res = await fetch(RIVER_PRICING_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`River pricing HTTP ${res.status}`);
  const data = await res.json();
  const map = new Map();
  for (const p of data.inference || []) map.set(p.model, { input: p.input, cached: p.cached_input, output: p.output });
  return map;
}
