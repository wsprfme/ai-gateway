// Adapter Codex: pakai langganan ChatGPT (Sign in with ChatGPT) sebagai API.
// Referensi: 9router open-sse (registry/codex.js, executors/codex.js, tokenRefresh), dan
// dokumentasi/catatan komunitas. Endpoint & header meniru Codex CLI resmi.
//
// Alur: OAuth PKCE di auth.openai.com → access_token + refresh_token. Request dikirim ke
// chatgpt.com/backend-api/codex/responses dalam format Responses API, dibebankan ke kuota
// langganan ChatGPT (bukan tagihan API). Token di-refresh otomatis.
//
// CATATAN: ini area abu-abu ToS OpenAI. Untuk pemakaian pribadi. Risiko: akun bisa dibatasi
// atau disuspend; endpoint internal bisa berubah sewaktu-waktu.
import crypto from 'node:crypto';

export const CODEX = {
  authType: 'codex',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  // Override via env dipakai untuk pengujian (mengarahkan ke upstream palsu).
  tokenUrl: process.env.CODEX_TOKEN_URL || 'https://auth.openai.com/oauth/token',
  scope: 'openid profile email offline_access',
  redirectUri: 'http://localhost:1455/auth/callback',
  baseUrl: process.env.CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex/responses',
  imagesUrl: process.env.CODEX_IMAGES_URL || 'https://chatgpt.com/backend-api/codex/images/generations',
  cliVersion: '0.167.1',
  refreshLeadMs: 600_000, // refresh 10 menit sebelum kedaluwarsa
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ---------- OAuth PKCE ----------
export function startAuth() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX.clientId,
    redirect_uri: CODEX.redirectUri,
    scope: CODEX.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
    state,
  });
  return { url: `${CODEX.authorizeUrl}?${params}`, verifier, state };
}

// Ambil "code" dari URL redirect yang ditempel user (http://localhost:1455/auth/callback?code=...&state=...).
export function extractCode(redirectInput) {
  const s = String(redirectInput || '').trim();
  try {
    if (s.includes('://') || s.startsWith('/') || s.includes('?')) {
      const u = new URL(s.includes('://') ? s : 'http://localhost' + (s.startsWith('/') ? s : '/?' + s));
      return { code: u.searchParams.get('code'), state: u.searchParams.get('state') };
    }
  } catch {
    /* bukan URL, anggap kode mentah */
  }
  return { code: s || null, state: null };
}

function decodeJwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function accountIdFrom(tokens) {
  if (tokens.account_id) return tokens.account_id;
  for (const t of [tokens.id_token, tokens.access_token]) {
    const p = decodeJwtPayload(t);
    const auth = p['https://api.openai.com/auth'];
    if (auth?.chatgpt_account_id) return auth.chatgpt_account_id;
  }
  return null;
}

function toCredential(tokens) {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    meta: { accountId: accountIdFrom(tokens), idToken: tokens.id_token || null },
  };
}

export async function exchangeCode({ code, verifier }) {
  const res = await fetch(CODEX.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CODEX.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: CODEX.redirectUri,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Tukar kode gagal (${res.status}): ${text.slice(0, 300)}`);
  const tokens = JSON.parse(text);
  if (!tokens.access_token) throw new Error('Respons token tidak berisi access_token.');
  return toCredential(tokens);
}

// Untuk alur tempel file ~/.codex/auth.json.
export function parseAuthJson(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error('File auth.json bukan JSON yang valid.');
  }
  const t = data.tokens || data;
  if (!t.access_token) throw new Error('auth.json tidak berisi tokens.access_token.');
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token || null,
    expiresAt: null, // tidak diketahui; akan di-refresh saat dipakai
    meta: { accountId: t.account_id || accountIdFrom(t), idToken: t.id_token || null },
  };
}

export async function refresh({ refreshToken }) {
  if (!refreshToken) throw new Error('Tidak ada refresh token.');
  const res = await fetch(CODEX.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: CODEX.clientId, grant_type: 'refresh_token', refresh_token: refreshToken }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) {
    const permanent = /invalid_grant|refresh_token|invalid_request/i.test(text);
    throw Object.assign(new Error(`Refresh token Codex gagal (${res.status}): ${text.slice(0, 200)}`), { permanent });
  }
  const tokens = JSON.parse(text);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    meta: { idToken: tokens.id_token || undefined },
  };
}

export function needsRefresh(cred) {
  if (!cred.refreshToken) return false;
  if (!cred.expiresAt) return true; // tidak tahu umur token → refresh untuk aman
  return cred.expiresAt - Date.now() < CODEX.refreshLeadMs;
}

// ---------- Translasi request ----------
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function stripEffortSuffix(model) {
  const s = String(model || '');
  for (const lv of EFFORTS) if (s.endsWith(`-${lv}`)) return { model: s.slice(0, -(lv.length + 1)), level: lv };
  return { model: s, level: null };
}

export const cooldownModel = (upstreamModel) => stripEffortSuffix(upstreamModel).model;

// Ubah pesan Chat Completions menjadi input Responses API.
function chatMessagesToInput(messages = []) {
  const input = [];
  for (const m of messages) {
    const role = m.role === 'system' ? 'developer' : m.role;
    if (role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: String(m.content ?? '') });
      continue;
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments || '{}' });
      }
      if (!m.content) continue;
    }
    const textType = role === 'assistant' ? 'output_text' : 'input_text';
    let content;
    if (typeof m.content === 'string') content = [{ type: textType, text: m.content }];
    else if (Array.isArray(m.content))
      content = m.content.map((p) =>
        p.type === 'image_url'
          ? { type: 'input_image', image_url: typeof p.image_url === 'string' ? p.image_url : p.image_url?.url }
          : { type: textType, text: p.text ?? '' }
      );
    else content = [{ type: textType, text: String(m.content ?? '') }];
    input.push({ type: 'message', role, content });
  }
  return input;
}

function chatToolsToResponses(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools
    .map((t) => {
      const fn = t.function || t;
      if (!fn?.name) return null;
      return { type: 'function', name: fn.name, description: fn.description, parameters: fn.parameters || { type: 'object', properties: {} }, strict: fn.strict };
    })
    .filter(Boolean);
}

function applyReasoning(body, suffixLevel) {
  let effort = body.reasoning?.effort || body.reasoning_effort || suffixLevel || 'medium';
  if (effort === 'none' || effort === 'minimal') effort = 'low';
  if (effort === 'ultra') effort = 'max'; // backend Codex menolak 'ultra', tertinggi 'max'
  body.reasoning = { effort, summary: 'auto' };
  if (effort !== 'none') body.include = ['reasoning.encrypted_content'];
  delete body.reasoning_effort;
}

const STRIP = ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'logprobs', 'top_logprobs',
  'n', 'seed', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'user', 'metadata',
  'stream_options', 'previous_response_id', 'service_tier', 'safety_identifier', 'parallel_tool_calls'];

// endpoint: '/chat/completions' atau '/responses'. Kembalikan body Responses untuk upstream Codex.
export function buildBody(endpoint, raw, ctx) {
  const body = { ...raw };
  // Buang suffix effort dari nama model (mis. gpt-6-sol-high → gpt-6-sol) sambil menyimpan levelnya.
  const { model, level } = stripEffortSuffix(ctx?.upstreamModel || body.model || '');

  if (endpoint === '/chat/completions') {
    body.input = chatMessagesToInput(body.messages);
    const tools = chatToolsToResponses(body.tools);
    if (tools?.length) body.tools = tools;
    else delete body.tools;
    delete body.messages;
  } else if (typeof body.input === 'string') {
    body.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }];
  }
  if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
    body.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }];
  }
  applyReasoning(body, level);
  body.model = model;
  body.store = false;
  body.stream = true;
  for (const k of STRIP) delete body[k];
  return body;
}

export function buildHeaders({ accessToken, accountId, sessionId }) {
  const h = {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    originator: 'codex_cli_rs',
    version: CODEX.cliVersion,
    'user-agent': `codex_cli_rs/${CODEX.cliVersion}`,
    'openai-beta': 'responses=experimental',
    session_id: sessionId || crypto.randomUUID(),
  };
  if (accountId) h['chatgpt-account-id'] = accountId;
  return h;
}

export const url = CODEX.baseUrl;
export const authType = 'codex';
export const responsesPassthrough = true; // Codex native-nya Responses API.
export const buildUrl = () => CODEX.baseUrl;
export const upstreamStream = () => true; // Codex selalu streaming ke upstream.

// Usage dari respons Codex berbentuk Responses API → normalkan ke OpenAI.
export function normalizeUsage(u) {
  if (!u) return null;
  return {
    prompt_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    cached_tokens: u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0,
    reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

// ---------- Translasi respons (Responses SSE → OpenAI) ----------
// Mengembalikan state kolektor; panggil feed(event) per event SSE, lalu baca hasil.
export function createCollector() {
  return { text: '', reasoning: '', toolCalls: new Map(), usage: null, finish: null, error: null };
}

// line: satu baris SSE mentah ("event: ..." atau "data: {...}"). Return { text, reasoning } atau null.
export function feedLine(state, line, ctx) {
  if (line.startsWith('event:')) { ctx.event = line.slice(6).trim(); return null; }
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  let ev;
  try {
    ev = JSON.parse(payload);
  } catch {
    return null;
  }
  const type = ev.type || ctx.event;
  let text = null;
  let reasoning = null;
  switch (type) {
    case 'response.output_text.delta':
      text = ev.delta || '';
      state.text += text;
      break;
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      reasoning = ev.delta || '';
      state.reasoning += reasoning;
      break;
    case 'response.output_item.added':
    case 'response.output_item.done':
      if (ev.item?.type === 'function_call') {
        state.toolCalls.set(ev.item.id || ev.output_index, {
          id: ev.item.call_id || ev.item.id,
          name: ev.item.name,
          arguments: ev.item.arguments || '',
        });
      }
      break;
    case 'response.completed':
    case 'response.incomplete':
      state.usage = ev.response?.usage || state.usage;
      state.finish = type === 'response.completed' ? 'stop' : 'length';
      break;
    case 'response.failed':
    case 'error':
      state.error = ev.response?.error?.message || ev.error?.message || ev.message || 'Codex error';
      break;
  }
  return text || reasoning ? { text, reasoning } : null;
}

// ---------- Image generation & edits (port dari 9router handlers/imageProviders/codex.js) ----------
const CODEX_TOOL_IMAGE_MODELS = new Set([
  'gpt-image-1.5',
  'gpt-image-2',
  'gpt-image-2.5',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.6-flare',
  'gpt-image-2.6-sunburst',
]);
const CODEX_IMAGES_MAIN_MODEL = 'gpt-6-sol';
const CODEX_IMAGES_FALLBACK_MODEL = 'gpt-5.6-terra';

function toDataUrl(input) {
  if (!input || typeof input !== 'string') return null;
  if (/^data:image\//i.test(input) || /^https?:\/\//i.test(input)) return input;
  return `data:image/png;base64,${input}`;
}

function collectImageRefs(body) {
  const refs = [];
  if (Array.isArray(body?.images)) for (const i of body.images) { const u = toDataUrl(typeof i === 'string' ? i : i?.image_url || i?.url); if (u) refs.push(u); }
  const single = toDataUrl(typeof body?.image === 'string' ? body.image : body?.image?.image_url || body?.image?.url);
  if (single) refs.push(single);
  return refs;
}

function canUseNativeImages(model, body) {
  return (
    CODEX_TOOL_IMAGE_MODELS.has(model) &&
    (body.n == null || Number(body.n) === 1) &&
    (!body.size || body.size === 'auto') &&
    (!body.output_format || String(body.output_format).toLowerCase() === 'png') &&
    (!body.background || ['auto', 'opaque'].includes(body.background)) &&
    (!body.quality || ['auto', 'low', 'medium', 'high'].includes(body.quality)) &&
    body.output_compression == null
  );
}

export async function generateImage(endpoint, raw, { upstreamModel, accessToken, meta, sessionId, signal }) {
  const model = upstreamModel || raw.model;
  const refs = collectImageRefs(raw);
  const isEdit = endpoint === '/images/edits' || refs.length > 0;
  const useNative = canUseNativeImages(model, raw);
  const baseHeaders = {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    originator: 'codex_cli_rs',
    version: CODEX.cliVersion,
    'user-agent': `codex_cli_rs/${CODEX.cliVersion}`,
    session_id: sessionId || crypto.randomUUID(),
    'x-client-request-id': crypto.randomUUID(),
  };
  if (meta?.accountId) baseHeaders['chatgpt-account-id'] = meta.accountId;

  if (useNative) {
    const targetUrl = isEdit ? CODEX.imagesUrl.replace(/\/generations$/, '/edits') : CODEX.imagesUrl;
    const payload = isEdit
      ? { model, prompt: raw.prompt, images: refs.map((image_url) => ({ image_url })), n: 1, size: 'auto', quality: raw.quality || 'auto', background: raw.background || 'auto' }
      : { model, prompt: raw.prompt, n: 1, size: 'auto', quality: raw.quality || 'auto', background: raw.background || 'auto', output_format: 'png' };
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { ...baseHeaders, accept: 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) return { ok: false, status: res.status, text: await res.text().catch(() => ''), headers: res.headers };
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.data) || !data.data.some((d) => d?.b64_json || d?.url)) {
      return { ok: false, status: 502, text: JSON.stringify({ error: { message: data?.error?.message || 'Codex Images API tidak mengembalikan gambar.' } }), headers: res.headers };
    }
    return { ok: true, status: 200, data: { created: data.created || Math.floor(Date.now() / 1000), data: data.data }, usage: normalizeUsage(data.usage) };
  }

  // Fallback ke Responses SSE dengan tool image_generation (untuk gpt-6-sol-image atau kontrol size/format).
  const toolModel = CODEX_TOOL_IMAGE_MODELS.has(model) ? model : null;
  const responsesModel = toolModel ? CODEX_IMAGES_MAIN_MODEL : model.replace(/-image$/, '');
  const content = [];
  refs.forEach((url, i) => {
    content.push({ type: 'input_text', text: `<image name=image${i + 1}>` });
    content.push({ type: 'input_image', image_url: url, detail: raw.image_detail || 'high' });
    content.push({ type: 'input_text', text: '</image>' });
  });
  content.push({ type: 'input_text', text: raw.prompt || '' });
  const imgTool = { type: 'image_generation', output_format: String(raw.output_format || 'png').toLowerCase() };
  if (toolModel) { imgTool.action = isEdit ? 'edit' : 'generate'; imgTool.model = toolModel; }
  if (raw.size) imgTool.size = raw.size;
  if (raw.quality) imgTool.quality = raw.quality;
  if (raw.background) imgTool.background = raw.background;

  const buildReq = (m) => ({
    model: m,
    instructions: '',
    input: [{ type: 'message', role: 'user', content }],
    tools: [imgTool],
    tool_choice: toolModel ? { type: 'image_generation' } : 'auto',
    parallel_tool_calls: false,
    prompt_cache_key: crypto.randomUUID(),
    stream: true,
    store: false,
    reasoning: null,
  });

  const fire = (m) => fetch(CODEX.baseUrl, {
    method: 'POST',
    headers: { ...baseHeaders, accept: 'text/event-stream, application/json' },
    body: JSON.stringify(buildReq(m)),
    signal,
  });

  let res = await fire(responsesModel);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 400 && toolModel && /model is not supported when using Codex/i.test(errText)) {
      res = await fire(CODEX_IMAGES_FALLBACK_MODEL);
      if (!res.ok) return { ok: false, status: res.status, text: await res.text().catch(() => ''), headers: res.headers };
    } else {
      return { ok: false, status: res.status, text: errText, headers: res.headers };
    }
  }

  const sseText = await res.text();
  let imageB64 = null;
  let usage = null;
  let errMsg = null;
  let assistantText = '';
  for (const rawLine of sseText.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let ev;
    try { ev = JSON.parse(payload); } catch { continue; }
    if (ev.type === 'response.output_text.delta') assistantText += ev.delta || '';
    if (ev.type === 'response.output_item.done' && ev.item?.type === 'image_generation_call' && ev.item.result) imageB64 = ev.item.result;
    if (ev.type === 'response.completed' || ev.type === 'response.done') {
      usage = normalizeUsage(ev.response?.usage || ev.usage) || usage;
      for (const item of ev.response?.output || ev.output || []) {
        if (item?.type === 'image_generation_call' && item.result) imageB64 = item.result;
      }
    }
    if (ev.type === 'error' || ev.type === 'response.failed') {
      errMsg = ev.error?.message || ev.response?.error?.message || 'Codex image generation failed';
    }
  }
  if (!imageB64) {
    const msg = errMsg || (assistantText ? `Codex membalas teks alih-alih gambar: "${assistantText.trim().slice(0, 200)}"` : 'Codex selesai tanpa menghasilkan gambar.');
    return { ok: false, status: 502, text: JSON.stringify({ error: { message: msg } }), headers: res.headers };
  }
  return { ok: true, status: 200, data: { created: Math.floor(Date.now() / 1000), data: [{ b64_json: imageB64 }] }, usage };
}

// ---------- Kuota / limit (port dari 9router services/usage/codex.js) ----------
// GET backend-api/wham/usage → rate_limit {primary_window, secondary_window} berisi used_percent,
// reset_at, dan limit_reached. primary = jendela sesi (mis. 5 jam), secondary = mingguan.
export const usageUrl = process.env.CODEX_USAGE_URL || 'https://chatgpt.com/backend-api/wham/usage';

const pctRemain = (used) => Math.max(0, 100 - Math.max(0, Math.min(100, Number(used) || 0)));
function codexWindow(key, label, w) {
  if (!w) return null;
  const used = Math.max(0, Math.min(100, Number(w.used_percent ?? w.percent_used) || 0));
  const resetRaw = w.reset_at ?? w.resets_at ?? w.resetAt;
  let resetAt = null;
  if (resetRaw != null) {
    const n = Number(resetRaw);
    resetAt = Number.isFinite(n) ? new Date((n < 1e12 ? n * 1000 : n)).toISOString() : (Date.parse(resetRaw) ? new Date(resetRaw).toISOString() : null);
  }
  return { key, label, usedPercent: used, remainingPercent: pctRemain(used), resetAt, limitReached: !!w.limit_reached };
}

export async function getUsage({ accessToken, accountId } = {}) {
  if (!accessToken) throw new Error('Tidak ada access token Codex.');
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', originator: 'codex_cli_rs' };
  if (accountId) headers['ChatGPT-Account-ID'] = accountId;
  const res = await fetch(usageUrl, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw Object.assign(new Error(`Usage Codex tidak tersedia (${res.status}).`), { status: res.status });
  const data = await res.json();
  const rl = data.rate_limit || data.rate_limits || data.rate_limits_by_limit_id?.codex || data;
  const windows = [
    codexWindow('session', 'Sesi', rl.primary_window || rl.primary || data.primary_window),
    codexWindow('weekly', 'Mingguan', rl.secondary_window || rl.secondary || data.secondary_window),
  ].filter(Boolean);
  return {
    plan: data.plan_type || data.summary?.plan || null,
    limitReached: !!(rl.limit_reached || windows.some((w) => w.limitReached)),
    windows,
    models: [],
  };
}
