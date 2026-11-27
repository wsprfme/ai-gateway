// Adapter Antigravity: pakai langganan Google Antigravity (Gemini) sebagai API.
// Di-port dari 9router (open-sse: executors/antigravity.js, translator/*gemini*, providers/registry/antigravity.js,
// src/lib/oauth/providers/antigravity.js) — MIT, decolua and contributors.
//
// Beda penting dari Codex: variant/effort TIDAK dikirim lewat parameter reasoning_effort, tapi ENCODED
// di nama model upstream sebagai "base(level)" (mis. "gemini-3.8-flash-tiered(high)") dan diterjemahkan ke
// generationConfig.thinkingConfig.thinkingLevel. Nama model yang dikirim ke Google adalah base tanpa suffix.
// Request dibungkus envelope Cloud Code: { project, model, request:{contents, systemInstruction, generationConfig, tools} }.
//
// CATATAN: melanggar ToS Google untuk klien pihak ketiga. Untuk pemakaian pribadi; akun berisiko dibatasi.
import crypto from 'node:crypto';
import { platform, arch } from 'node:os';

const OAUTH_CLIENT_ID = process.env.AG_OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.AG_OAUTH_CLIENT_SECRET || '';
const IDE_VERSION = '2.33.0';

export const ANTIGRAVITY = {
  authType: 'antigravity',
  clientId: OAUTH_CLIENT_ID,
  clientSecret: OAUTH_CLIENT_SECRET,
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: process.env.AG_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://www.googleapis.com/oauth2/v1/userinfo',
  redirectUri: 'http://localhost:8788',
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
  ],
  baseUrl: process.env.AG_BASE_URL || 'https://daily-cloudcode-pa.googleapis.com',
  loadCodeAssistUrl: process.env.AG_CODEASSIST_URL || 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  onboardUserUrl: process.env.AG_ONBOARD_URL || 'https://cloudcode-pa.googleapis.com/v1internal:onboardUser',
  refreshLeadMs: 300_000,
  responsesPassthrough: false, // Antigravity tidak bicara format Responses; selalu diterjemahkan ke chat.
};

function platformEnum() {
  const os = platform();
  const a = arch();
  if (os === 'darwin') return a === 'arm64' ? 2 : 1;
  if (os === 'linux') return a === 'arm64' ? 4 : 3;
  if (os === 'win32') return 5;
  return 0;
}
const clientMetadata = () => ({ ideType: 9, platform: platformEnum(), pluginType: 2 });
const userAgent = () => `antigravity/hub/${IDE_VERSION} darwin/arm64`;
const AG_DEFAULT_SYSTEM =
  'You are Antigravity Agent, a powerful agentic AI coding assistant designed by the Google engineering team.\n' +
  'You are pair programming with a USER to solve their coding task.';

// ---------- OAuth (Google, authorization code + client_secret, tanpa PKCE) ----------
export function startAuth() {
  const state = Buffer.from(crypto.randomBytes(16)).toString('base64url');
  const params = new URLSearchParams({
    client_id: ANTIGRAVITY.clientId,
    response_type: 'code',
    redirect_uri: ANTIGRAVITY.redirectUri,
    scope: ANTIGRAVITY.scopes.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return { url: `${ANTIGRAVITY.authorizeUrl}?${params}`, verifier: state, state };
}

export function extractCode(redirectInput) {
  const s = String(redirectInput || '').trim();
  try {
    if (s.includes('://') || s.startsWith('/') || s.includes('?')) {
      const u = new URL(s.includes('://') ? s : 'http://localhost' + (s.startsWith('/') ? s : '/?' + s));
      return { code: u.searchParams.get('code'), state: u.searchParams.get('state') };
    }
  } catch {
    /* kode mentah */
  }
  return { code: s || null, state: null };
}

async function tokenRequest(body) {
  const res = await fetch(ANTIGRAVITY.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (!res.ok) {
    const permanent = /invalid_grant|invalid_request/i.test(text);
    throw Object.assign(new Error(`Token Antigravity gagal (${res.status}): ${text.slice(0, 200)}`), { permanent });
  }
  return JSON.parse(text);
}

async function loadProject(accessToken) {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': userAgent(),
    'x-request-source': 'local',
  };
  const meta = clientMetadata();
  let projectId = '';
  let tierId = 'legacy-tier';
  try {
    const res = await fetch(ANTIGRAVITY.loadCodeAssistUrl, { method: 'POST', headers, body: JSON.stringify({ metadata: meta }), signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      const data = await res.json();
      projectId = data.cloudaicompanionProject?.id || data.cloudaicompanionProject || '';
      if (Array.isArray(data.allowedTiers)) for (const t of data.allowedTiers) if (t.isDefault && t.id) { tierId = t.id.trim(); break; }
    }
  } catch {
    /* project discovery opsional */
  }
  // Onboard (fire-and-forget) supaya Code Assist aktif untuk project.
  if (projectId) {
    (async () => {
      for (let i = 0; i < 6; i++) {
        try {
          const r = await fetch(ANTIGRAVITY.onboardUserUrl, { method: 'POST', headers, body: JSON.stringify({ tierId, metadata: meta }), signal: AbortSignal.timeout(20000) });
          if (r.ok && (await r.json()).done === true) break;
        } catch {
          break;
        }
        await new Promise((s) => setTimeout(s, 5000));
      }
    })().catch(() => {});
  }
  return projectId;
}

export async function exchangeCode({ code }) {
  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    client_id: ANTIGRAVITY.clientId,
    client_secret: ANTIGRAVITY.clientSecret,
    code,
    redirect_uri: ANTIGRAVITY.redirectUri,
  });
  if (!tokens.access_token) throw new Error('Respons token tidak berisi access_token.');
  let email = null;
  try {
    const ui = await fetch(`${ANTIGRAVITY.userInfoUrl}?alt=json`, { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15000) });
    if (ui.ok) email = (await ui.json()).email || null;
  } catch {
    /* opsional */
  }
  const projectId = await loadProject(tokens.access_token);
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    meta: { projectId, email },
  };
}

export async function refresh({ refreshToken }) {
  if (!refreshToken) throw new Error('Tidak ada refresh token.');
  const tokens = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: ANTIGRAVITY.clientId,
    client_secret: ANTIGRAVITY.clientSecret,
  });
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    meta: {},
  };
}

export function needsRefresh(cred) {
  if (!cred.refreshToken) return false;
  if (!cred.expiresAt) return true;
  return cred.expiresAt - Date.now() < ANTIGRAVITY.refreshLeadMs;
}

export const dedupeIdFrom = (cred) => cred.meta?.email || null;

// ---------- Mapping variant/effort (seragam dengan Meta/River/Codex via reasoning_effort) ----------
// Model keluarga Gemini 4 / 3.8 Flash di upstream Google memakai ID bersuffix level
// (mis. gemini-4-hydrogen-low/medium/high/xhigh). Gateway menerima nama dasar bersih
// (antigravity/gemini-4-hydrogen) + parameter standar `reasoning_effort`, lalu memilih
// ID wire yang tepat + thinkingConfig.thinkingLevel. Suffix lama (-high atau (high))
// tetap didukung untuk kompatibilitas mundur.
const EFFORT_RANK = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const TIERED_FAMILIES = {
  'gemini-4-hydrogen': { levels: ['low', 'medium', 'high', 'xhigh'], def: 'high' },
  'gemini-4-hydrogen-tiered': { levels: ['high', 'xhigh'], def: 'high' },
  'gemini-4-neon': { levels: ['low', 'medium', 'high', 'xhigh'], def: 'high' },
  'gemini-4-argon': { levels: ['low', 'medium', 'high'], def: 'high' },
  'gemini-4-carbon': { levels: ['low', 'medium', 'high'], def: 'high' },
  'gemini-3.8-flash': { levels: ['low', 'medium', 'high'], def: 'medium' },
};

// "base(level)" → { model: base, level }
export function parseModelSuffix(upstream) {
  const m = String(upstream || '').match(/^(.*)\(([^()]+)\)\s*$/);
  if (!m) return { model: String(upstream || ''), level: null };
  return { model: m[1].trim(), level: m[2].trim().toLowerCase() };
}

// Normalisasi reasoning_effort klien ke level Gemini: minimal|low|medium|high|xhigh.
function toThinkingLevel(effort) {
  const e = String(effort || '').toLowerCase();
  if (!e) return null;
  if (e === 'none' || e === 'off') return 'minimal';
  if (e === 'max' || e === 'ultra') return 'xhigh';
  if (EFFORT_RANK.includes(e)) return e;
  return null;
}

// Pilih level terdekat yang didukung keluarga model (clamp ke terendah/tertinggi yang tersedia).
function clampLevel(level, supported) {
  if (supported.includes(level)) return level;
  const idx = EFFORT_RANK.indexOf(level);
  if (idx < 0) return supported[supported.length - 1];
  const ranks = supported.map((l) => ({ l, r: EFFORT_RANK.indexOf(l) }));
  if (idx <= ranks[0].r) return ranks[0].l;
  if (idx >= ranks.at(-1).r) return ranks.at(-1).l;
  // Pilih yang terdekat
  return ranks.reduce((best, cur) => (Math.abs(cur.r - idx) < Math.abs(best.r - idx) ? cur : best)).l;
}

// Selesaikan upstreamModel + reasoning_effort request → { wireModel, thinkingLevel }.
export function resolveWireModel(upstreamModel, raw = {}) {
  const { model: parsed, level: parenLevel } = parseModelSuffix(upstreamModel);
  const reqEffort = raw?.reasoning_effort || (typeof raw?.reasoning === 'object' ? raw.reasoning?.effort : null);

  // Cek apakah nama model adalah keluarga tiered (langsung "gemini-4-hydrogen" atau bersuffix "gemini-4-hydrogen-low")
  let family = TIERED_FAMILIES[parsed] ? parsed : null;
  let suffixLevel = parenLevel;
  if (!family) {
    for (const fam of Object.keys(TIERED_FAMILIES)) {
      if (parsed.startsWith(fam + '-')) {
        const tail = parsed.slice(fam.length + 1);
        if (TIERED_FAMILIES[fam].levels.includes(tail)) {
          family = fam;
          suffixLevel = suffixLevel || tail;
          break;
        }
      }
    }
  }

  if (family) {
    const cfg = TIERED_FAMILIES[family];
    const desired = toThinkingLevel(reqEffort || suffixLevel) || cfg.def;
    const picked = clampLevel(desired, cfg.levels);
    return { wireModel: `${family}-${picked}`, thinkingLevel: picked };
  }

  // Model non-tiered (gemini-3-flash, gemini-2.5-flash, gemini-4-hydrogen-sonar, dll.)
  let thinkingLevel = toThinkingLevel(reqEffort || suffixLevel);
  if (thinkingLevel === 'xhigh') thinkingLevel = 'high';
  return { wireModel: parsed, thinkingLevel };
}

export const cooldownModel = (upstreamModel, raw) => resolveWireModel(upstreamModel, raw).wireModel;

const MAX_OUTPUT = 65535;

// ---------- Terjemah schema tool ke Gemini (port ringkas cleanJSONSchemaForAntigravity) ----------
const BAD_SCHEMA_KEYS = new Set([
  'minLength', 'maxLength', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'format', 'multipleOf',
  'uniqueItems', 'contains', 'unevaluatedProperties', 'unevaluatedItems', 'prefixItems', 'additionalItems',
  'default', 'examples', '$schema', '$defs', 'definitions', 'const', '$ref', '$comment', 'deprecated', 'readOnly',
  'writeOnly', 'additionalProperties', 'propertyNames', 'patternProperties', 'anyOf', 'oneOf', 'allOf', 'not',
  'dependencies', 'dependentSchemas', 'dependentRequired', 'title', 'if', 'then', 'else', 'minProperties', 'maxProperties',
]);
function cleanSchema(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(cleanSchema);
  // flatten anyOf/oneOf → first non-null
  for (const k of ['anyOf', 'oneOf']) {
    if (Array.isArray(node[k]) && node[k].length) {
      const pick = node[k].find((s) => s && s.type !== 'null') || node[k][0];
      delete node[k];
      Object.assign(node, pick);
    }
  }
  if (node.const !== undefined && !node.enum) { node.enum = [node.const]; delete node.const; }
  if (Array.isArray(node.enum)) { node.enum = node.enum.map(String); if (!node.type) node.type = 'string'; }
  if (node.properties && !node.type) node.type = 'object';
  const out = {};
  for (const [key, val] of Object.entries(node)) {
    if (BAD_SCHEMA_KEYS.has(key) || key.startsWith('x-')) continue;
    out[key] = val && typeof val === 'object' ? cleanSchema(val) : val;
  }
  if (out.type === 'array' && (!out.items || typeof out.items !== 'object')) out.items = { type: 'string' };
  if (out.type !== 'array') delete out.items;
  if (out.type !== 'object') { delete out.properties; delete out.required; }
  if (out.type === 'object' && (!out.properties || !Object.keys(out.properties).length)) {
    out.properties = { reason: { type: 'string', description: 'Why you are calling this tool' } };
    out.required = ['reason'];
  }
  if (out.required && out.properties) out.required = out.required.filter((r) => r in out.properties);
  return out;
}
const fnName = (n) => (String(n || '_unknown').replace(/[^a-zA-Z0-9_.:\-]/g, '_').replace(/^([^a-zA-Z_])/, '_$1')).slice(0, 64);

// ---------- OpenAI messages → Gemini contents ----------
const AUDIO_MIME = {
  wav: 'audio/wav', wave: 'audio/wav', mp3: 'audio/mp3', mpeg: 'audio/mpeg',
  ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/m4a',
  opus: 'audio/opus', webm: 'audio/webm', amr: 'audio/amr', mp4: 'audio/mp4',
};
const EXT_MIME = {
  ...AUDIO_MIME,
  mp4: 'video/mp4', webm: 'video/webm',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  html: 'text/html', xml: 'text/xml', css: 'text/css', js: 'text/javascript', ts: 'text/x-typescript', py: 'text/x-python',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function mimeFromFilename(name, fallback = 'application/octet-stream') {
  const ext = String(name || '').toLowerCase().split('.').pop();
  return EXT_MIME[ext] || fallback;
}

function dataUrlOrUriToPart(url, fallbackMime) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('data:')) {
    const c = url.indexOf(',');
    if (c < 0) return null;
    const mimeType = url.slice(5, c).split(';')[0] || fallbackMime;
    return { inlineData: { mimeType, data: url.slice(c + 1) } };
  }
  return { fileData: { fileUri: url, mimeType: fallbackMime } };
}

function contentToParts(content) {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const it of content) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'text' || it.type === 'input_text' || it.type === 'output_text') {
      if (it.text != null) parts.push({ text: String(it.text) });
    } else if (it.type === 'image_url' || it.type === 'input_image') {
      const url = typeof it.image_url === 'string' ? it.image_url : it.image_url?.url || it.url;
      const p = dataUrlOrUriToPart(url, 'image/jpeg');
      if (p) parts.push(p);
    } else if (it.type === 'video_url' || it.type === 'input_video') {
      const url = typeof it.video_url === 'string' ? it.video_url : it.video_url?.url || it.url;
      const p = dataUrlOrUriToPart(url, 'video/mp4');
      if (p) parts.push(p);
    } else if (it.type === 'input_audio') {
      const a = it.input_audio || it;
      const rawData = a.data || a.audio || '';
      if (typeof rawData === 'string' && rawData) {
        if (rawData.startsWith('data:')) {
          const p = dataUrlOrUriToPart(rawData, 'audio/wav');
          if (p) parts.push(p);
        } else {
          const fmt = String(a.format || 'wav').toLowerCase();
          parts.push({ inlineData: { mimeType: AUDIO_MIME[fmt] || `audio/${fmt}`, data: rawData } });
        }
      }
    } else if (it.type === 'file' || it.type === 'input_file') {
      const f = it.file || it;
      const data = f.file_data || f.data;
      const url = f.file_url || f.url;
      const fallbackMime = f.mime_type || f.mimeType || mimeFromFilename(f.filename, 'application/pdf');
      if (typeof data === 'string' && data) {
        if (data.startsWith('data:')) {
          const p = dataUrlOrUriToPart(data, fallbackMime);
          if (p) parts.push(p);
        } else {
          parts.push({ inlineData: { mimeType: fallbackMime, data } });
        }
      } else if (typeof url === 'string' && url) {
        const p = dataUrlOrUriToPart(url, fallbackMime);
        if (p) parts.push(p);
      }
    }
  }
  return parts;
}
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((c) => c.type === 'text' || c.type === 'input_text').map((c) => c.text || '').join('')
      : '';

// Simpan thoughtSignature per tool_call id agar giliran kedua (tool_result) diterima Gemini 3/4.
const thoughtSignatures = new Map();
const FALLBACK_THOUGHT_SIG = 'skip_thought_signature_validator';
function saveThoughtSignature(id, sig) {
  if (!id || !sig) return;
  if (thoughtSignatures.size >= 500) thoughtSignatures.delete(thoughtSignatures.keys().next().value);
  thoughtSignatures.set(id, sig);
}

function messagesToContents(messages = []) {
  let systemInstruction = null;
  const contents = [];
  const toolResp = {};
  for (const m of messages) if (m.role === 'tool' && m.tool_call_id) (toolResp[m.tool_call_id] ||= []).push(m.content);
  const cursor = {};
  for (const m of messages) {
    if (m.role === 'system') {
      systemInstruction = { role: 'user', parts: [{ text: textOf(m.content) }] };
    } else if (m.role === 'user') {
      const parts = contentToParts(m.content);
      if (parts.length) contents.push({ role: 'user', parts });
    } else if (m.role === 'assistant') {
      const parts = [];
      const t = textOf(m.content);
      if (t) parts.push({ text: t });
      const calls = [];
      for (const tc of m.tool_calls || []) {
        if (tc.type !== 'function') continue;
        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          /* argumen bukan JSON */
        }
        const sig = thoughtSignatures.get(tc.id) || FALLBACK_THOUGHT_SIG;
        parts.push({ functionCall: { id: tc.id, name: fnName(tc.function?.name), args }, thoughtSignature: sig });
        calls.push({ id: tc.id, name: tc.function?.name });
      }
      if (parts.length) contents.push({ role: 'model', parts });
      const respParts = [];
      for (const c of calls) {
        const q = toolResp[c.id];
        const i = cursor[c.id] || 0;
        let resp = q && i < q.length ? ((cursor[c.id] = i + 1), q[i]) : '';
        let parsed;
        try {
          parsed = JSON.parse(resp);
        } catch {
          parsed = { result: resp };
        }
        respParts.push({ functionResponse: { id: c.id, name: fnName(c.name), response: { result: parsed } } });
      }
      if (respParts.length) contents.push({ role: 'user', parts: respParts });
    }
  }
  return { systemInstruction, contents };
}

function normalizeContents(contents) {
  const out = [];
  for (const c of contents) {
    if (!c?.role || !Array.isArray(c.parts) || !c.parts.length) continue;
    const last = out.at(-1);
    if (last?.role === c.role) last.parts.push(...c.parts);
    else out.push({ role: c.role, parts: [...c.parts] });
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', parts: [{ text: '...' }] });
  if (out.length && out.at(-1).role === 'model') out.push({ role: 'user', parts: [{ text: 'Continue.' }] });
  return out;
}

function toolsToGemini(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const decls = [];
  for (const t of tools) {
    const fn = t.function || t;
    if (!fn?.name) continue;
    decls.push({ name: fnName(fn.name), description: fn.description || '', parameters: cleanSchema(structuredClone(fn.parameters || { type: 'object', properties: {} })) });
  }
  return decls.length ? [{ functionDeclarations: decls }] : null;
}

// ---------- Build request (envelope Cloud Code) ----------
// ctx: { upstreamModel, cred:{meta:{projectId,email}} }
export function buildBody(endpoint, raw, ctx) {
  const { wireModel, thinkingLevel } = resolveWireModel(ctx.upstreamModel, raw);

  const { systemInstruction, contents } = messagesToContents(endpoint === '/responses' ? inputToMessages(raw.input) : raw.messages);
  // Identitas Antigravity selalu di depan system prompt (anti-flag).
  const sys = systemInstruction || { role: 'user', parts: [] };
  if (!sys.parts.some((p) => typeof p.text === 'string' && p.text.includes('You are Antigravity'))) {
    sys.parts = [{ text: AG_DEFAULT_SYSTEM }, ...sys.parts];
  }

  const generationConfig = {};
  if (typeof raw.temperature === 'number') generationConfig.temperature = raw.temperature;
  if (typeof raw.top_p === 'number') generationConfig.topP = raw.top_p;
  const maxOut = raw.max_tokens || raw.max_completion_tokens || raw.max_output_tokens;
  generationConfig.maxOutputTokens = Math.min(maxOut || MAX_OUTPUT, MAX_OUTPUT);
  if (thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel, includeThoughts: thinkingLevel !== 'minimal' };

  const tools = toolsToGemini(raw.tools);
  const request = {
    contents: normalizeContents(contents),
    systemInstruction: sys.parts.length ? sys : undefined,
    generationConfig,
    ...(tools && { tools, toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } } }),
    sessionId: ctx.cred?.meta?.email ? crypto.createHash('sha256').update(ctx.cred.meta.email).digest('hex').slice(0, 16) : crypto.randomUUID(),
  };
  return {
    project: ctx.cred?.meta?.projectId || generateProjectId(),
    model: wireModel,
    userAgent: 'antigravity',
    requestId: `agent-${crypto.randomUUID()}`,
    request,
  };
}

function inputToMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) return [];
  const msgs = [];
  for (const it of input) {
    if (it.type === 'message' || it.role) {
      const role = it.role === 'developer' ? 'system' : it.role || 'user';
      msgs.push({ role, content: Array.isArray(it.content) ? it.content : String(it.content ?? '') });
    }
  }
  return msgs;
}

function generateProjectId() {
  const adj = ['useful', 'bright', 'swift', 'calm', 'bold'][Math.floor(Math.random() * 5)];
  const noun = ['fuze', 'wave', 'spark', 'flow', 'core'][Math.floor(Math.random() * 5)];
  return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
}

export function buildUrl(_endpoint, upstreamStream) {
  const action = upstreamStream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return `${ANTIGRAVITY.baseUrl}/v1internal:${action}`;
}

export function buildHeaders({ accessToken, stream }) {
  const h = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'user-agent': userAgent() };
  if (stream) h.accept = 'text/event-stream';
  return h;
}

// Antigravity selalu streaming ke upstream; proxy mengagregasi kalau client minta non-stream.
export const upstreamStream = () => true;

// ---------- Response collector (Gemini SSE → OpenAI) ----------
export function createCollector() {
  return { text: '', reasoning: '', toolCalls: new Map(), usage: null, finish: null, error: null, _i: 0 };
}

export function feedLine(state, line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  let ev;
  try {
    ev = JSON.parse(payload);
  } catch {
    return null;
  }
  const resp = ev.response || ev;
  const cand = resp.candidates?.[0];
  let text = null;
  let reasoning = null;
  for (const part of cand?.content?.parts || []) {
    if (part.functionCall) {
      const callId = part.functionCall.id || `call_${state._i}`;
      const sig = part.thoughtSignature || part.thought_signature;
      if (sig) saveThoughtSignature(callId, sig);
      state.toolCalls.set(part.functionCall.id || state._i++, { id: callId, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) });
    } else if (part.text) {
      if (part.thought === true) { state.reasoning += part.text; reasoning = (reasoning || '') + part.text; }
      else { state.text += part.text; text = (text || '') + part.text; }
    }
  }
  const um = resp.usageMetadata || ev.usageMetadata;
  if (um) {
    state.usage = {
      prompt_tokens: um.promptTokenCount || 0,
      completion_tokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
      cached_tokens: um.cachedContentTokenCount || 0,
      reasoning_tokens: um.thoughtsTokenCount || 0,
    };
  }
  if (cand?.finishReason) state.finish = cand.finishReason === 'MAX_TOKENS' ? 'length' : 'stop';
  if (resp.error || ev.error) state.error = resp.error?.message || ev.error?.message || 'Antigravity error';
  return text || reasoning ? { text, reasoning } : null;
}

// ---------- Image generation & edits (port dari 9router handlers/imageProviders/antigravity.js) ----------
const SIZE_TO_RATIO = {
  '1024x1024': '1:1', '512x512': '1:1', '1536x1024': '3:2', '1024x1536': '2:3',
  '1792x1024': '16:9', '1024x1792': '9:16', '1280x720': '16:9', '720x1280': '9:16',
};

function resolveInlineImage(input) {
  if (input && typeof input === 'object') input = input.image_url?.url || input.url || input.data || input.b64_json;
  if (!input || typeof input !== 'string') return null;
  const m = input.match(/^data:(image\/[^;]+);base64,(.+)$/i);
  if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
  if (/^[A-Za-z0-9+/]/.test(input) && input.length > 100 && !input.startsWith('http')) {
    return { inlineData: { mimeType: 'image/png', data: input } };
  }
  return null;
}

export async function generateImage(_endpoint, raw, { upstreamModel, accessToken, meta, signal }) {
  const { model: baseModel } = parseModelSuffix(upstreamModel || raw.model);
  let targetModel = /image|imagen/i.test(baseModel) ? baseModel : 'gemini-3.1-flash-image';
  let ratio = null;
  if (raw.aspect_ratio && /^\d{1,2}:\d{1,2}$/.test(String(raw.aspect_ratio))) ratio = String(raw.aspect_ratio);
  else if (raw.size && SIZE_TO_RATIO[raw.size]) ratio = SIZE_TO_RATIO[raw.size];
  if (ratio) {
    const suffix = ratio.replace(':', 'x');
    if (!targetModel.includes(suffix)) targetModel = `${targetModel}-${suffix}`;
  }

  const prompt = raw.negative_prompt ? `${raw.prompt || ''}\n\nNegative prompt: ${raw.negative_prompt}` : raw.prompt || '';
  const refs = [raw.reference_images, raw.images, raw.reference_image, raw.image]
    .flatMap((v) => (Array.isArray(v) ? v : v ? [v] : []))
    .slice(0, 10);
  const parts = [];
  for (const r of refs) {
    const inline = resolveInlineImage(r);
    if (inline) parts.push(inline);
  }
  parts.push({ text: prompt });

  const envelope = {
    project: meta?.projectId || generateProjectId(),
    model: targetModel,
    userAgent: 'antigravity',
    requestId: `agent-${crypto.randomUUID()}`,
    request: { contents: [{ role: 'user', parts }] },
  };

  const res = await fetch(`${ANTIGRAVITY.baseUrl}/v1internal:generateContent`, {
    method: 'POST',
    headers: buildHeaders({ accessToken, stream: false }),
    body: JSON.stringify(envelope),
    signal,
  });
  if (!res.ok) return { ok: false, status: res.status, text: await res.text().catch(() => ''), headers: res.headers };
  const body = await res.json().catch(() => null);
  const resp = body?.response || body || {};
  const outParts = resp.candidates?.[0]?.content?.parts || [];
  const images = outParts.filter((p) => p.inlineData?.data).map((p) => ({ b64_json: p.inlineData.data }));
  if (!images.length) {
    return { ok: false, status: 502, text: JSON.stringify({ error: { message: 'Antigravity tidak mengembalikan gambar.' } }), headers: res.headers };
  }
  const um = resp.usageMetadata || body?.usageMetadata;
  const usage = um ? { prompt_tokens: um.promptTokenCount || 0, completion_tokens: um.candidatesTokenCount || 0, cached_tokens: um.cachedContentTokenCount || 0, reasoning_tokens: um.thoughtsTokenCount || 0 } : null;
  return { ok: true, status: 200, data: { created: Math.floor(Date.now() / 1000), data: images }, usage };
}

// Usage sudah dinormalkan di state.usage oleh feedLine.
export const normalizeUsage = (u) => u || { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 };
export const url = ANTIGRAVITY.baseUrl; // placeholder; proxy pakai buildUrl()

// ---------- Resolusi project (loadCodeAssist) ----------
async function quotaHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'user-agent': userAgent(),
    'x-client-name': 'antigravity',
    'x-client-version': IDE_VERSION,
  };
}

export async function fetchProjectId(accessToken) {
  try {
    const res = await fetch(ANTIGRAVITY.loadCodeAssistUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'user-agent': userAgent() },
      body: JSON.stringify({ metadata: clientMetadata() }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d.cloudaicompanionProject?.id || d.cloudaicompanionProject || null;
  } catch {
    return null;
  }
}

// Impor kredensial lokal → cred standar (resolusi projectId sekalian).
export async function fromCredential(std) {
  const projectId = std.accessToken ? await fetchProjectId(std.accessToken) : null;
  return { ...std, meta: { ...(std.meta || {}), projectId } };
}

// ---------- Kuota / limit (port dari 9router services/usage/google.js + antigravity-weekly.js) ----------
const AG_QUOTA_URL = process.env.AG_QUOTA_URL || `${ANTIGRAVITY.baseUrl}/v1internal:fetchAvailableModels`;
const AG_QUOTA_SUMMARY_URL = process.env.AG_QUOTA_SUMMARY_URL || `${ANTIGRAVITY.baseUrl}/v1internal:retrieveUserQuotaSummary`;

const GROUPS = [
  { re: /argon/i, weekly: 'Gemini 4 Argon (mingguan)', session: 'Gemini 4 Argon (5 jam)' },
  { re: /gemini/i, weekly: 'Gemini (mingguan)', session: 'Gemini (5 jam)' },
  { re: /claude|gpt/i, weekly: 'Claude & GPT (mingguan)', session: 'Claude & GPT (5 jam)' },
];
function resetIso(v) {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function parseQuotaSummary(data) {
  const groups = Array.isArray(data?.groups) ? data.groups : Array.isArray(data?.quotaSummary?.groups) ? data.quotaSummary.groups : [];
  const windows = [];
  for (const g of groups) {
    const name = g?.displayName || '';
    const cfg = GROUPS.find((c) => c.re.test(name));
    if (!cfg) continue;
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      const wt = String(b.window || '').toLowerCase();
      const txt = `${b.bucketId || ''} ${b.displayName || ''}`.toLowerCase();
      const isWeekly = wt === 'weekly' || txt.includes('weekly');
      const isSession = wt === '5h' || wt === 'daily' || txt.includes('5h') || txt.includes('five hour') || txt.includes('daily');
      if (!isWeekly && !isSession) continue;
      if (b.disabled === true && isWeekly) continue;
      const frac = b.disabled === true ? 0 : Number(b.remainingFraction);
      if (!Number.isFinite(frac)) continue;
      windows.push({
        key: `${cfg[isWeekly ? 'weekly' : 'session']}`,
        label: cfg[isWeekly ? 'weekly' : 'session'],
        usedPercent: Math.round((1 - frac) * 1000) / 10,
        remainingPercent: Math.round(frac * 1000) / 10,
        resetAt: resetIso(b.resetTime),
        limitReached: frac <= 0,
      });
    }
  }
  return windows;
}

export async function getUsage(cred = {}) {
  const accessToken = cred.accessToken;
  if (!accessToken) throw new Error('Tidak ada access token Antigravity.');
  const projectId = cred.meta?.projectId || (await fetchProjectId(accessToken));
  const headers = await quotaHeaders(accessToken);
  const body = JSON.stringify(projectId ? { project: projectId } : {});

  const models = [];
  try {
    const res = await fetch(AG_QUOTA_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const data = await res.json();
      for (const [id, info] of Object.entries(data.models || {})) {
        if (info.isInternal) continue;
        const frac = Number(info.quotaInfo?.remainingFraction);
        models.push({
          id,
          displayName: info.displayName || id,
          remainingPercent: Number.isFinite(frac) ? Math.round(frac * 1000) / 10 : null,
          resetAt: resetIso(info.quotaInfo?.resetTime),
        });
      }
    } else if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error(`Kuota Antigravity ditolak (${res.status}).`), { status: res.status });
    }
  } catch (e) {
    if (e.status) throw e;
  }

  let windows = [];
  try {
    const res = await fetch(AG_QUOTA_SUMMARY_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
    if (res.ok) windows = parseQuotaSummary(await res.json());
  } catch {
    /* ringkasan mingguan best-effort */
  }

  return { plan: null, limitReached: windows.some((w) => w.limitReached), windows, models };
}
