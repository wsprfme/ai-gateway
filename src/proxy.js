import { db, getSetting, startOfToday, startOfMonth } from './db.js';
import { sha256 } from './crypto.js';
import {
  usableKeys, countKeys, markKeyOk, markKeyFailed, classifyKeyFailure, updateOAuthKey,
  applyQuotaCooldown, isKeyCooledDown, shouldCheckQuota, markQuotaChecked, invalidateQuotaCache,
} from './keypool.js';
import { supportedEndpointsFor, formatModelObject } from './catalog.js';
import * as codex from './adapters/codex.js';
import * as antigravity from './adapters/antigravity.js';

// Adapter provider langganan OAuth. Tiap adapter: refresh(cred), needsRefresh(cred),
// buildBody(endpoint, raw, ctx), buildHeaders({...}), buildUrl/url, createCollector/feedLine,
// normalizeUsage, dan flag responsesPassthrough.
const ADAPTERS = { codex, antigravity };

const findKey = db.prepare('SELECT id, enabled FROM api_keys WHERE key_hash = ?');
const touchKey = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');
const findModel = db.prepare(`
  SELECT m.*, p.slug, p.base_url, p.stream_usage, p.auth_type, p.enabled AS provider_enabled
  FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?`);
const findProvider = db.prepare('SELECT * FROM providers WHERE slug = ?');
const spendSince = db.prepare('SELECT COALESCE(SUM(cost), 0) AS s FROM requests WHERE ts >= ?');
const insertLog = db.prepare(`
  INSERT INTO requests (ts, key_id, model, provider_id, upstream_model, endpoint, stream, status,
    prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, images, audio_ms, frames, searches,
    cost, latency_ms, ttft_ms, estimated, fallback_from, error, provider_key_id)
  VALUES (@ts, @key_id, @model, @provider_id, @upstream_model, @endpoint, @stream, @status,
    @prompt_tokens, @completion_tokens, @cached_tokens, @reasoning_tokens, @images, @audio_ms, @frames, @searches,
    @cost, @latency_ms, @ttft_ms, @estimated, @fallback_from, @error, @provider_key_id)`);

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

function oaiError(c, status, message, type = 'gateway_error', extra = {}) {
  return c.json(
    { error: { message, type, code: extra.code ?? status, ...(extra.param ? { param: extra.param } : {}) } },
    status
  );
}

export function authenticateToken(token) {
  if (!token) return null;
  const row = findKey.get(sha256(token));
  if (!row || !row.enabled) return null;
  touchKey.run(Date.now(), row.id);
  return row.id;
}

export function authenticate(c) {
  const header = c.req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : c.req.header('x-api-key');
  return authenticateToken(token);
}

// Cari model: dulu di tabel models (alias), kalau tidak ada coba passthrough "slug/nama-model-asli".
export function resolveModel(id) {
  const m = findModel.get(id);
  if (m) {
    if (!m.enabled || !m.provider_enabled) return { error: `Model '${id}' sedang dinonaktifkan.` };
    return { route: m };
  }
  const slash = id.indexOf('/');
  if (slash > 0) {
    const p = findProvider.get(id.slice(0, slash));
    if (p && p.enabled && p.allow_passthrough) {
      const upstream = id.slice(slash + 1);
      return {
        route: {
          id,
          provider_id: p.id,
          slug: p.slug,
          base_url: p.base_url,
          stream_usage: p.stream_usage,
          auth_type: p.auth_type,
          upstream_model: upstream,
          kind: /image/i.test(upstream) ? 'image' : 'text',
          input_price: 0,
          output_price: 0,
          cached_price: null,
          fallback_model: null,
        },
      };
    }
  }
  return { error: `Model '${id}' tidak terdaftar.` };
}

export function checkBudget() {
  const daily = getSetting('daily_budget_usd');
  if (daily > 0 && spendSince.get(startOfToday()).s >= daily) return `Budget harian ($${daily}) sudah habis.`;
  const monthly = getSetting('monthly_budget_usd');
  if (monthly > 0 && spendSince.get(startOfMonth()).s >= monthly) return `Budget bulanan ($${monthly}) sudah habis.`;
  return null;
}

/**
 * Biaya satu request, dari semua unit yang ditagih provider:
 * - token (harga per 1 juta; tier konteks panjang menggantikan seluruh tarif bila input melewati batas)
 * - gambar yang dihasilkan / disegmentasi (price_image per gambar)
 * - frame video SAM (price_frame per frame, minimal min_frames per request)
 * - audio transkripsi (price_audio_hour per jam, dibulatkan ke bawah per detik)
 * - web search (price_search per query)
 */
export function computeCost(route, u) {
  const long = route.long_threshold && u.prompt_tokens > route.long_threshold;
  const input = long ? route.input_price_long ?? route.input_price : route.input_price;
  const output = long ? route.output_price_long ?? route.output_price : route.output_price;
  const cachedRate = long ? route.cached_price_long ?? route.cached_price ?? input : route.cached_price ?? input;
  const cached = Math.min(u.cached_tokens || 0, u.prompt_tokens || 0);
  let cost = (((u.prompt_tokens || 0) - cached) * (input || 0) + cached * (cachedRate || 0) + (u.completion_tokens || 0) * (output || 0)) / 1e6;
  if (u.images && route.price_image) cost += u.images * route.price_image;
  if (u.frames && route.price_frame) cost += Math.max(u.frames, route.min_frames || 0) * route.price_frame;
  if (u.audio_ms && route.price_audio_hour) cost += (Math.floor(u.audio_ms / 1000) / 3600) * route.price_audio_hour;
  if (u.searches && route.price_search) cost += u.searches * route.price_search;
  return cost;
}

function readUsage(usage) {
  if (!usage) return null;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0;
  const reasoning =
    usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, cached_tokens: cached, reasoning_tokens: reasoning };
}

// Perkiraan kasar (~4 karakter per token) kalau provider tidak mengirim usage.
function estimateTokens(value) {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}

function anySignal(signals) {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

export function log(entry) {
  try {
    insertLog.run({
      ts: Date.now(),
      key_id: null,
      provider_id: null,
      upstream_model: null,
      stream: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_tokens: 0,
      reasoning_tokens: 0,
      images: 0,
      audio_ms: 0,
      frames: 0,
      searches: 0,
      cost: 0,
      latency_ms: null,
      ttft_ms: null,
      estimated: 0,
      fallback_from: null,
      error: null,
      provider_key_id: null,
      ...entry,
    });
  } catch (e) {
    console.error('Gagal menulis log:', e.message);
  }
}

// ---------- Membaca request dari client ----------
// Tiap format body (JSON, multipart gambar, multipart transkripsi) dibaca jadi satu bentuk:
// model yang diminta, apakah streaming, dan cara membangun body untuk upstream dengan nama model asli.

const ENDPOINTS = {
  '/chat/completions': 'json',
  '/completions': 'json',
  '/embeddings': 'json',
  '/responses': 'json',
  '/images/generations': 'json',
  '/images/edits': 'json-or-multipart',
  '/audio/transcriptions': 'audio-multipart',
  '/asr/transcribe': 'asr-multipart',
};

// Durasi WAV dari header RIFF, untuk perkiraan biaya kalau respons tidak memuat durasi.
function wavDurationMs(buf) {
  try {
    const b = Buffer.from(buf);
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return 0;
    let off = 12;
    let byteRate = 0;
    while (off + 8 <= b.length) {
      const id = b.toString('ascii', off, off + 4);
      const size = b.readUInt32LE(off + 4);
      if (id === 'fmt ') byteRate = b.readUInt32LE(off + 16);
      if (id === 'data' && byteRate) return Math.floor((Math.min(size, b.length - off - 8) / byteRate) * 1000);
      off += 8 + size + (size % 2);
    }
  } catch {
    /* bukan WAV yang bisa dibaca */
  }
  return 0;
}

// Peta kode ISO-639-1 umum → nama bahasa yang diterima Meta languageBias (dev.meta.ai/docs/speech-to-text).
const META_LANG_NAMES = {
  en: 'English', id: 'Indonesian', ms: 'Malay', fr: 'French', de: 'German', es: 'Spanish',
  it: 'Italian', pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', pl: 'Polish', tr: 'Turkish',
  ar: 'Arabic', hi: 'Hindi', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', vi: 'Vietnamese',
  th: 'Thai', sv: 'Swedish', uk: 'Ukrainian', fil: 'Tagalog', tl: 'Tagalog',
};

function toMetaLanguageBias(lang) {
  if (!lang) return [];
  return lang
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const code = s.toLowerCase().split(/[-_]/)[0];
      return META_LANG_NAMES[code] || s.charAt(0).toUpperCase() + s.slice(1);
    });
}

async function readClientRequest(c, endpoint) {
  const kind = ENDPOINTS[endpoint];
  const ctype = c.req.header('content-type') || '';

  if (kind === 'asr-multipart' || kind === 'audio-multipart' || (kind === 'json-or-multipart' && ctype.startsWith('multipart/form-data'))) {
    let form;
    try {
      form = await c.req.formData();
    } catch {
      return { error: 'Body harus multipart/form-data yang valid.' };
    }
    if (kind === 'audio-multipart') {
      const file = form.get('file');
      const model = form.get('model');
      if (!file || typeof file === 'string') return { error: "Field 'file' (audio) wajib diunggah." };
      if (typeof model !== 'string' || !model.trim()) return { error: "Field 'model' wajib diisi." };
      const responseFormat = String(form.get('response_format') || 'json').toLowerCase();
      if (!['json', 'text', 'verbose_json'].includes(responseFormat)) {
        return { error: `response_format '${responseFormat}' tidak didukung. Pilihan: json, text, verbose_json.` };
      }
      const language = typeof form.get('language') === 'string' ? form.get('language').trim() : '';
      const languageBias = toMetaLanguageBias(language);
      const audioBuf = await file.arrayBuffer();
      const audioMs = wavDurationMs(audioBuf);
      return {
        model: model.trim(),
        stream: false,
        audioMs,
        responseFormat,
        language,
        upstreamEndpoint: '/asr/transcribe',
        promptForEstimate: null,
        build: (upstreamModel) => {
          const settings = {
            model: upstreamModel,
            audioEncoding: 'WAV',
            mode: responseFormat === 'verbose_json' ? 'ENDPOINTING' : 'PUSH_TO_TALK',
            ...(languageBias.length ? { languageBias } : {}),
          };
          const out = new FormData();
          out.append('request', new Blob([JSON.stringify(settings)], { type: 'application/json' }), 'request.json');
          out.append('audio', new Blob([audioBuf], { type: file.type || 'audio/wav' }), file.name || 'audio.wav');
          return { body: out, headers: { accept: 'application/json' } };
        },
      };
    }
    if (kind === 'asr-multipart') {
      const reqPart = form.get('request');
      let settings;
      try {
        settings = JSON.parse(typeof reqPart === 'string' ? reqPart : await reqPart.text());
      } catch {
        return { error: "Part 'request' harus JSON pengaturan transkripsi." };
      }
      const audio = form.get('audio');
      const audioMs = audio && typeof audio !== 'string' ? wavDurationMs(await audio.arrayBuffer()) : 0;
      return {
        model: settings.model,
        stream: (c.req.header('accept') || '').includes('text/event-stream'),
        audioMs,
        promptForEstimate: null,
        build: (upstreamModel) => {
          const out = new FormData();
          out.append('request', new Blob([JSON.stringify({ ...settings, model: upstreamModel })], { type: 'application/json' }), 'request.json');
          for (const [k, v] of form.entries()) if (k !== 'request') out.append(k, v);
          return { body: out, headers: {} };
        },
      };
    }
    const model = form.get('model');
    return {
      model: typeof model === 'string' ? model : undefined,
      stream: form.get('stream') === 'true',
      promptForEstimate: form.get('prompt'),
      toJson: async () => {
        const out = { images: [] };
        for (const [k, v] of form.entries()) {
          if (typeof v === 'string') {
            out[k] = v;
          } else if (k === 'image' || k === 'image[]' || k === 'images') {
            const buf = Buffer.from(await v.arrayBuffer());
            const mime = v.type || 'image/png';
            out.images.push(`data:${mime};base64,${buf.toString('base64')}`);
          }
        }
        return out;
      },
      build: (upstreamModel) => {
        const out = new FormData();
        for (const [k, v] of form.entries()) out.append(k, k === 'model' ? upstreamModel : v);
        return { body: out, headers: {} };
      },
    };
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    return { error: 'Body harus JSON yang valid.' };
  }
  if (!body || typeof body !== 'object') return { error: 'Body harus JSON object.' };
  return {
    model: body.model,
    stream: body.stream === true,
    json: body,
    promptForEstimate: body.messages ?? body.prompt ?? body.input,
    build: (upstreamModel, extra = {}) => ({
      body: JSON.stringify({ ...body, ...extra, model: upstreamModel }),
      headers: { 'content-type': 'application/json' },
    }),
  };
}

// ---------- Menghitung unit dari respons ----------
function countOutput(output, type) {
  return Array.isArray(output) ? output.filter((o) => o?.type === type && o.status !== 'failed').length : 0;
}

/** Unit yang ditagih dari respons JSON (non-streaming). */
function unitsFromJson(route, data, req) {
  const u = readUsage(data.usage) || {};
  const out = {
    prompt_tokens: u.prompt_tokens || 0,
    completion_tokens: u.completion_tokens || 0,
    cached_tokens: u.cached_tokens || 0,
    reasoning_tokens: u.reasoning_tokens || 0,
    images: 0,
    frames: 0,
    audio_ms: 0,
    searches: countOutput(data.output, 'web_search_call'),
    estimated: 0,
  };
  if (route.kind === 'image') {
    out.images = Array.isArray(data.data) ? data.data.length : countOutput(data.output, 'image_generation_call');
  } else if (route.kind === 'segment') {
    out.frames = data.usage?.video_frames_processed || 0;
    if (!out.frames) out.images = 1;
  } else if (route.kind === 'transcribe') {
    out.audio_ms = data.audioDurationMs || 0;
    if (!out.audio_ms && req.audioMs) Object.assign(out, { audio_ms: req.audioMs, estimated: 1 });
  } else if (!data.usage) {
    out.estimated = 1;
    out.prompt_tokens = estimateTokens(req.promptForEstimate);
    out.completion_tokens = estimateTokens(data.output_text ?? data.choices?.map((ch) => ch.message?.content ?? ch.text));
  }
  return out;
}

// ---------- Handler utama ----------
// opts.keyId: lewati auth header (dipakai menu chat dashboard yang sudah login lewat cookie).
// opts.emitMetrics: tambahkan event SSE "gateway.metrics" di akhir stream berisi token, biaya, dan TTFT.
export async function handleProxy(c, endpoint, opts = {}) {
  const keyId = opts.keyId ?? authenticate(c);
  if (!keyId) return oaiError(c, 401, 'API key tidak valid.', 'invalid_api_key');

  const req = await readClientRequest(c, endpoint);
  if (req.error) return oaiError(c, 400, req.error, 'invalid_request_error');
  if (typeof req.model !== 'string' || !req.model) {
    return oaiError(c, 400, "Field 'model' wajib diisi.", 'invalid_request_error');
  }

  const budgetError = checkBudget();
  if (budgetError) return oaiError(c, 429, budgetError, 'budget_exceeded');

  const requestedModel = req.model;

  // Cek ketersediaan model & kompatibilitas endpoint sebelum mengirim ke upstream.
  const probe = resolveModel(requestedModel);
  if (probe.route) {
    const supported = supportedEndpointsFor(probe.route);
    if (!supported.includes('/v1' + endpoint)) {
      return oaiError(
        c,
        400,
        `Model '${requestedModel}' tidak mendukung endpoint /v1${endpoint}. Endpoint yang didukung: ${supported.join(', ')}.`,
        'invalid_request_error',
        { param: 'model', code: 'unsupported_endpoint' }
      );
    }
  }

  // Provider langganan OAuth (Codex, Antigravity) punya jalur sendiri: translasi + refresh token + pool akun.
  if (probe.route && ADAPTERS[probe.route.auth_type]) {
    return handleSubscription(c, endpoint, probe.route, req, { keyId, emitMetrics: opts.emitMetrics });
  }

  const started = Date.now();
  const timeoutMs = getSetting('upstream_timeout_sec') * 1000;
  const clientSignal = c.req.raw.signal;
  const query = new URL(c.req.url).search;
  const accept = c.req.header('accept');

  // Coba model utama, lalu rantai fallback (maks. 3 lompatan, tanpa loop).
  const tried = new Set();
  let modelId = requestedModel;
  let lastFailure = null;

  for (let hop = 0; hop < 4 && modelId && !tried.has(modelId); hop++) {
    tried.add(modelId);
    const { route, error } = resolveModel(modelId);
    if (!route) {
      if (hop === 0) return oaiError(c, 404, error, 'model_not_found');
      break;
    }

    // Chat/Completions: minta usage di akhir stream. Endpoint lain mengirim usage sendiri.
    const extra = {};
    let injectedUsage = false;
    if (req.stream && req.json && (endpoint === '/chat/completions' || endpoint === '/completions') && route.stream_usage) {
      if (!req.json.stream_options?.include_usage) injectedUsage = true;
      extra.stream_options = { ...(req.json.stream_options || {}), include_usage: true };
    }

    const base = {
      key_id: keyId,
      model: modelId,
      provider_id: route.provider_id,
      upstream_model: route.upstream_model,
      endpoint,
      stream: req.stream ? 1 : 0,
      fallback_from: hop > 0 ? requestedModel : null,
    };

    // Fill-first: pakai key teratas yang sehat; pindah ke key berikutnya hanya kalau key itu bermasalah.
    const keys = usableKeys(route.provider_id, route.upstream_model);
    if (!keys.length) {
      const total = countKeys.get(route.provider_id).n;
      const status = total ? 429 : 500;
      const message = total
        ? `Semua API key ${route.slug} sedang tidak bisa dipakai untuk ${route.upstream_model} (rate limit, kredit habis, atau tidak valid). Coba lagi sebentar.`
        : `Provider '${route.slug}' belum punya API key.`;
      log({ ...base, status, latency_ms: 0, error: message });
      lastFailure = { status, message };
      modelId = route.fallback_model;
      continue;
    }

    let res = null;
    let usedKey = null;
    const upstreamPath = req.upstreamEndpoint || endpoint;
    for (const k of keys) {
      const attempt = { ...base, provider_key_id: k.id };
      const { body, headers } = req.build(route.upstream_model, extra);
      try {
        res = await fetch(route.base_url.replace(/\/+$/, '') + upstreamPath + query, {
          method: 'POST',
          headers: { ...(accept ? { accept } : {}), ...headers, authorization: `Bearer ${k.secret}` },
          body,
          signal: anySignal([clientSignal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (e) {
        if (clientSignal?.aborted) {
          log({ ...attempt, status: 499, latency_ms: Date.now() - started, error: 'Client membatalkan request.' });
          return new Response(null, { status: 499 });
        }
        // Timeout/jaringan bukan salah key: langsung ke fallback model.
        const message = e.name === 'TimeoutError' ? 'Upstream timeout.' : `Gagal menghubungi upstream: ${e.message}`;
        log({ ...attempt, status: 502, latency_ms: Date.now() - started, error: message });
        lastFailure = { status: 502, message };
        res = null;
        break;
      }

      if (res.ok) {
        usedKey = k;
        markKeyOk(k.id);
        break;
      }

      const text = await res.text().catch(() => '');
      log({ ...attempt, status: res.status, latency_ms: Date.now() - started, error: text.slice(0, 2000) });
      const keyFailure = classifyKeyFailure(res.status, text, res.headers);
      if (keyFailure) {
        markKeyFailed(k.id, keyFailure.state, `${res.status} ${route.upstream_model}: ${text.slice(0, 300)}`, keyFailure.cooldownMs, route.upstream_model);
        lastFailure = { status: res.status, message: text };
        res = null;
        continue;
      }
      if (RETRYABLE.has(res.status) && route.fallback_model && !tried.has(route.fallback_model)) {
        lastFailure = { status: res.status, message: text };
        res = null;
        break;
      }
      // Error dari request itu sendiri (mis. 400 parameter salah): teruskan apa adanya.
      return new Response(text, {
        status: res.status,
        headers: { 'content-type': res.headers.get('content-type') || 'application/json' },
      });
    }

    if (!usedKey) {
      modelId = route.fallback_model;
      continue;
    }
    base.provider_key_id = usedKey.id;

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream') && res.body) {
      return streamResponse(res, route, { ...base, stream: 1 }, started, req, requestedModel, injectedUsage, opts.emitMetrics);
    }

    if (!ctype.includes('json')) {
      // Mis. transkripsi dengan Accept: text/plain. Tidak ada usage di respons, jadi pakai perkiraan.
      const text = await res.text();
      const units = route.kind === 'transcribe' ? { audio_ms: req.audioMs || 0, estimated: 1 } : { estimated: 1 };
      log({ ...base, status: res.status, ...units, cost: computeCost(route, units), latency_ms: Date.now() - started });
      return new Response(text, { status: res.status, headers: { 'content-type': ctype || 'text/plain' } });
    }

    const data = await res.json().catch(() => null);
    if (!data) {
      log({ ...base, status: 502, latency_ms: Date.now() - started, error: 'Respons upstream bukan JSON.' });
      return oaiError(c, 502, 'Respons upstream bukan JSON.');
    }
    const units = unitsFromJson(route, data, req);
    log({ ...base, status: res.status, ...units, cost: computeCost(route, units), latency_ms: Date.now() - started });
    if (endpoint === '/audio/transcriptions') {
      const turns = Array.isArray(data.turns) ? data.turns : [];
      const transcript =
        data.transcript ??
        data.text ??
        turns.map((t) => t?.transcript ?? t?.text ?? '').filter(Boolean).join(' ');
      if (req.responseFormat === 'text') {
        return new Response(transcript, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      if (req.responseFormat === 'verbose_json') {
        const duration = data.audioDurationMs
          ? data.audioDurationMs / 1000
          : units.audio_ms
            ? units.audio_ms / 1000
            : null;
        const segments = turns.map((t, i) => ({
          id: i,
          start: typeof t?.startMs === 'number' ? t.startMs / 1000 : typeof t?.start_ms === 'number' ? t.start_ms / 1000 : typeof t?.start === 'number' ? t.start : 0,
          end: typeof t?.endMs === 'number' ? t.endMs / 1000 : typeof t?.end_ms === 'number' ? t.end_ms / 1000 : typeof t?.end === 'number' ? t.end : duration ?? 0,
          text: t?.transcript ?? t?.text ?? '',
          ...(t?.speaker != null ? { speaker: t.speaker } : {}),
        }));
        return c.json(
          {
            task: 'transcribe',
            language: req.language || null,
            duration,
            text: transcript,
            segments,
          },
          200
        );
      }
      return c.json({ text: transcript }, 200);
    }
    if (typeof data.model === 'string') data.model = requestedModel;
    return c.json(data, res.status);
  }

  const status = lastFailure?.status ?? 502;
  return oaiError(c, status, lastFailure?.message || 'Semua upstream gagal.');
}

// ---------- Provider langganan OAuth (Codex / Antigravity) ----------
async function handleSubscription(c, endpoint, route, req, { keyId, emitMetrics }) {
  const adapter = ADAPTERS[route.auth_type];
  const isImageEndpoint = endpoint === '/images/generations' || endpoint === '/images/edits';
  if (endpoint !== '/chat/completions' && endpoint !== '/responses' && !(isImageEndpoint && adapter.generateImage)) {
    return oaiError(c, 400, `Endpoint ${endpoint} belum didukung untuk provider '${route.slug}'. Pakai /v1/chat/completions, /v1/responses, atau /v1/images/generations.`, 'invalid_request_error');
  }
  const started = Date.now();
  const timeoutMs = getSetting('upstream_timeout_sec') * 1000;
  const clientSignal = c.req.raw.signal;
  const wantStream = req.stream === true;
  const reqBody = req.json || (req.toJson ? await req.toJson() : {});
  const cdModel = adapter.cooldownModel ? adapter.cooldownModel(route.upstream_model, reqBody) : route.upstream_model;
  const base = {
    key_id: keyId,
    model: req.model,
    provider_id: route.provider_id,
    upstream_model: route.upstream_model,
    endpoint,
    stream: wantStream ? 1 : 0,
  };

  // Fill-first: urutan berdasarkan priority, id (sama seperti Meta dan River).
  const keys = usableKeys(route.provider_id, cdModel);
  if (!keys.length) {
    const total = countKeys.get(route.provider_id).n;
    const msg = total
      ? `Semua akun ${route.slug} sedang tidak bisa dipakai (cooldown, limit, atau perlu login ulang).`
      : `Provider '${route.slug}' belum terhubung. Hubungkan akun dulu di halaman Provider.`;
    log({ ...base, status: total ? 429 : 500, latency_ms: 0, error: msg });
    return oaiError(c, total ? 429 : 500, msg, total ? 'rate_limit' : 'gateway_error');
  }

  const sessionId = sha256(JSON.stringify(reqBody.messages || reqBody.input || reqBody.prompt || route.id)).slice(0, 32);
  const upstreamStreaming = adapter.upstreamStream ? adapter.upstreamStream(endpoint, wantStream) : true;
  const fireUrl = adapter.buildUrl ? adapter.buildUrl(endpoint, upstreamStreaming) : adapter.url;

  const fire = (accessToken, meta) => {
    const upstreamBody = adapter.buildBody(endpoint, reqBody, { upstreamModel: route.upstream_model, cred: { accessToken, meta } });
    return fetch(fireUrl, {
      method: 'POST',
      headers: adapter.buildHeaders({ accessToken, accountId: meta?.accountId, meta, sessionId, stream: upstreamStreaming }),
      body: JSON.stringify(upstreamBody),
      signal: anySignal([clientSignal, AbortSignal.timeout(timeoutMs)]),
    });
  };

  let lastErr = null;
  for (const k of keys) {
    const attempt = { ...base, provider_key_id: k.id };
    let meta = k.meta || {};
    let accessToken = k.secret;

    if (adapter.needsRefresh({ refreshToken: k.refreshToken, expiresAt: k.expires_at })) {
      try {
        const nt = await adapter.refresh({ refreshToken: k.refreshToken });
        updateOAuthKey(k.id, nt);
        accessToken = nt.accessToken;
      } catch (e) {
        if (e.permanent) {
          markKeyFailed(k.id, 'invalid', e.message);
          lastErr = { status: 401, message: `Akun ${k.name} perlu login ulang: ${e.message}` };
          continue;
        }
        lastErr = { status: 502, message: e.message };
        continue;
      }
    }

    // Auto-cooldown berbasis kuota (di-cache per akun) sebelum mengirim request, supaya langsung pindah ke akun sehat berikutnya (fill-first).
    if (adapter.getUsage && shouldCheckQuota(k.id)) {
      markQuotaChecked(k.id);
      try {
        const usage = await adapter.getUsage({ accessToken, accountId: meta.accountId, meta });
        applyQuotaCooldown(k.id, usage);
        if (isKeyCooledDown(k.id, cdModel)) {
          lastErr = { status: 429, message: `Kuota akun ${k.name} habis (auto-cooldown).` };
          continue;
        }
      } catch {
        /* pengecekan kuota best-effort; tetap lanjut request bila endpoint kuota gagal */
      }
    }

    if (isImageEndpoint) {
      let imgRes;
      try {
        imgRes = await adapter.generateImage(endpoint, reqBody, {
          upstreamModel: route.upstream_model,
          accessToken,
          meta,
          sessionId,
          signal: anySignal([clientSignal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (e) {
        if (clientSignal?.aborted) {
          log({ ...attempt, status: 499, latency_ms: Date.now() - started, error: 'Client membatalkan request.' });
          return new Response(null, { status: 499 });
        }
        lastErr = { status: 502, message: e.name === 'TimeoutError' ? 'Upstream timeout.' : e.message };
        log({ ...attempt, status: 502, latency_ms: Date.now() - started, error: lastErr.message });
        continue;
      }
      if (imgRes.status === 401 && k.refreshToken) {
        try {
          const nt = await adapter.refresh({ refreshToken: k.refreshToken });
          updateOAuthKey(k.id, nt);
          accessToken = nt.accessToken;
          imgRes = await adapter.generateImage(endpoint, reqBody, {
            upstreamModel: route.upstream_model,
            accessToken,
            meta,
            sessionId,
            signal: anySignal([clientSignal, AbortSignal.timeout(timeoutMs)]),
          });
        } catch (e) {
          markKeyFailed(k.id, 'invalid', e.message);
          lastErr = { status: 401, message: `Akun ${k.name} perlu login ulang.` };
          continue;
        }
      }
      if (!imgRes.ok) {
        const text = imgRes.text || '';
        log({ ...attempt, status: imgRes.status, latency_ms: Date.now() - started, error: text.slice(0, 2000) });
        const f = classifyKeyFailure(imgRes.status, text, imgRes.headers);
        if (f) {
          invalidateQuotaCache(k.id);
          markKeyFailed(k.id, f.state, `${imgRes.status}: ${text.slice(0, 200)}`, f.cooldownMs, cdModel);
          lastErr = { status: imgRes.status, message: text };
          continue;
        }
        return new Response(text, { status: imgRes.status, headers: { 'content-type': 'application/json' } });
      }
      markKeyOk(k.id);
      const u = imgRes.usage || { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 };
      const units = { ...u, images: imgRes.data?.data?.length || 1, frames: 0, audio_ms: 0, searches: 0 };
      log({ ...attempt, status: 200, ...units, cost: computeCost(route, units), latency_ms: Date.now() - started, estimated: imgRes.usage ? 0 : 1 });
      return c.json(imgRes.data, 200);
    }

    let res;
    try {
      res = await fire(accessToken, meta);
    } catch (e) {
      if (clientSignal?.aborted) {
        log({ ...attempt, status: 499, latency_ms: Date.now() - started, error: 'Client membatalkan request.' });
        return new Response(null, { status: 499 });
      }
      lastErr = { status: 502, message: e.name === 'TimeoutError' ? 'Upstream timeout.' : e.message };
      log({ ...attempt, status: 502, latency_ms: Date.now() - started, error: lastErr.message });
      continue;
    }

    // Token ditolak: refresh sekali, coba lagi akun yang sama.
    if (res.status === 401 && k.refreshToken) {
      try {
        const nt = await adapter.refresh({ refreshToken: k.refreshToken });
        updateOAuthKey(k.id, nt);
        res = await fire(nt.accessToken, meta);
      } catch (e) {
        markKeyFailed(k.id, 'invalid', e.message);
        lastErr = { status: 401, message: `Akun ${k.name} perlu login ulang.` };
        continue;
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log({ ...attempt, status: res.status, latency_ms: Date.now() - started, error: text.slice(0, 2000) });
      const f = classifyKeyFailure(res.status, text, res.headers);
      if (f) {
        invalidateQuotaCache(k.id);
        markKeyFailed(k.id, f.state, `${res.status}: ${text.slice(0, 200)}`, f.cooldownMs, cdModel);
        lastErr = { status: res.status, message: text };
        continue;
      }
      return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'application/json' } });
    }

    markKeyOk(k.id);
    // Codex bicara format Responses: untuk client /responses yang streaming, teruskan apa adanya.
    if (endpoint === '/responses' && wantStream && adapter.responsesPassthrough) {
      return streamResponse(res, route, { ...attempt, stream: 1 }, started, req, req.model, false, emitMetrics);
    }
    return subscriptionChat(c, res, route, attempt, started, req, endpoint, wantStream, emitMetrics, sessionId, adapter);
  }

  const status = lastErr?.status ?? 502;
  return oaiError(c, status, lastErr?.message || `Semua akun ${route.slug} gagal.`, 'gateway_error');
}

// Translasi respons adapter langganan (Responses/Gemini SSE) ke format client (chat/completions atau responses).
function subscriptionChat(c, res, route, base, started, req, endpoint, wantStream, emitMetrics, sessionId, adapter) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = adapter.createCollector();
  const ctx = {};
  const id = 'chatcmpl-' + sessionId.slice(0, 20);
  const created = Math.floor(Date.now() / 1000);
  const model = req.model;
  let ttft = null;
  let logged = false;

  const finalize = (status, error = null) => {
    if (logged) return null;
    logged = true;
    const u = adapter.normalizeUsage(state.usage) || { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 };
    const units = { ...u, images: 0, frames: 0, audio_ms: 0, searches: 0 };
    const cost = computeCost(route, units);
    const metrics = { ...units, cost, ttft_ms: ttft, latency_ms: Date.now() - started, status, estimated: state.usage ? 0 : 1 };
    log({ ...base, status, ...units, cost, latency_ms: Date.now() - started, ttft_ms: ttft, estimated: state.usage ? 0 : 1, error: error || state.error });
    return metrics;
  };

  const toolCallsArray = () =>
    [...state.toolCalls.values()].map((t, i) => ({ index: i, id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } }));

  // ----- Non-streaming: kumpulkan semua lalu balas satu JSON -----
  if (!wantStream) {
    return (async () => {
      const text = await res.text();
      for (const raw of text.split('\n')) adapter.feedLine(state, raw.endsWith('\r') ? raw.slice(0, -1) : raw, ctx);
      if (state.text && ttft === null) ttft = Date.now() - started;
      const metrics = finalize(state.error ? 502 : 200);
      if (state.error) return oaiError(c, 502, state.error);
      const usage = adapter.normalizeUsage(state.usage) || {};
      const openaiUsage = {
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      };
      if (endpoint === '/responses') {
        return c.json({
          id: 'resp_' + sessionId.slice(0, 20),
          object: 'response',
          created_at: created,
          model,
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: state.text }] }],
          output_text: state.text,
          usage: { input_tokens: openaiUsage.prompt_tokens, output_tokens: openaiUsage.completion_tokens, total_tokens: openaiUsage.total_tokens },
        });
      }
      const message = { role: 'assistant', content: state.text || '' };
      if (state.reasoning) message.reasoning_content = state.reasoning;
      const tcs = toolCallsArray();
      if (tcs.length) message.tool_calls = tcs.map(({ index, ...t }) => t);
      return c.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message, finish_reason: tcs.length ? 'tool_calls' : 'stop' }],
        usage: openaiUsage,
      });
    })();
  }

  // ----- Streaming chat/completions: ubah event Responses/Gemini jadi chunk chat -----
  const chunk = (delta, finish = null) =>
    encoder.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);

  const emitFeed = (controller, out) => {
    if (!out) return false;
    let sent = false;
    const text = typeof out === 'string' ? out : out.text;
    const reasoning = typeof out === 'string' ? null : out.reasoning;
    if (reasoning) {
      if (ttft === null) ttft = Date.now() - started;
      controller.enqueue(chunk({ reasoning_content: reasoning }));
      sent = true;
    }
    if (text) {
      if (ttft === null) ttft = Date.now() - started;
      controller.enqueue(chunk({ content: text }));
      sent = true;
    }
    return sent;
  };

  let buffer = '';
  const upstream = res.body.getReader();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(chunk({ role: 'assistant' }));
    },
    async pull(controller) {
      try {
        // Loop sampai minimal satu chunk di-enqueue atau upstream selesai,
        // supaya stream tidak macet ketika event upstream (mis. response.created) tidak menghasilkan teks.
        while (true) {
          const { done, value } = await upstream.read();
          if (done) {
            if (buffer) emitFeed(controller, adapter.feedLine(state, buffer, ctx));
            const tcs = toolCallsArray();
            if (tcs.length) controller.enqueue(chunk({ tool_calls: tcs }));
            const metrics = finalize(state.error ? 502 : 200);
            const u = adapter.normalizeUsage(state.usage) || {};
            const usage = { prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0, total_tokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0) };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: state.finish === 'length' ? 'length' : tcs.length ? 'tool_calls' : 'stop' }], usage })}\n\n`)
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            if (emitMetrics && metrics) controller.enqueue(encoder.encode(`event: gateway.metrics\ndata: ${JSON.stringify(metrics)}\n\n`));
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          let sent = false;
          for (const raw of lines) {
            if (emitFeed(controller, adapter.feedLine(state, raw.endsWith('\r') ? raw.slice(0, -1) : raw, ctx))) sent = true;
          }
          if (sent) return;
        }
      } catch (e) {
        finalize(502, `Stream terputus: ${e.message}`);
        controller.error(e);
      }
    },
    cancel() {
      finalize(499, 'Client menutup koneksi.');
      upstream.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  });
}

function streamResponse(res, route, base, started, req, requestedModel, injectedUsage, emitMetrics = false) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let usage = null;
  let ttft = null;
  let completionText = '';
  let finished = false;
  // Unit non-token, dihitung dari event stream.
  const imageIds = new Set();
  const searchIds = new Set();
  let imageEvents = 0;
  let frames = 0;
  let audioMs = 0;
  let finalOutput = null;
  let metricsForClient = null;

  const finish = (status, error = null) => {
    if (finished) return;
    finished = true;
    let estimated = 0;
    let u = usage;
    if (!u) {
      u = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 };
      if (route.kind === 'text' || !route.kind) {
        estimated = 1;
        u.prompt_tokens = estimateTokens(req.promptForEstimate);
        u.completion_tokens = estimateTokens(completionText);
      }
    }
    if (finalOutput) {
      for (const o of finalOutput) {
        if (o?.type === 'image_generation_call' && o.status !== 'failed') imageIds.add(o.id || Math.random());
        if (o?.type === 'web_search_call' && o.status !== 'failed') searchIds.add(o.id || Math.random());
      }
    }
    const units = { ...u, images: 0, frames: 0, audio_ms: 0, searches: searchIds.size };
    if (route.kind === 'image') units.images = imageEvents || imageIds.size;
    if (route.kind === 'segment') {
      units.frames = frames;
      if (!frames && status === 200) units.images = 1;
    }
    if (route.kind === 'transcribe') {
      units.audio_ms = audioMs;
      if (!audioMs && req.audioMs) {
        units.audio_ms = req.audioMs;
        estimated = 1;
      }
    }
    const latency = Date.now() - started;
    const cost = computeCost(route, units);
    metricsForClient = { ...units, cost, ttft_ms: ttft, latency_ms: latency, status, estimated };
    log({ ...base, status, ...units, cost, latency_ms: latency, ttft_ms: ttft, estimated, error });
  };

  const processLine = (line) => {
    if (!line.startsWith('data:')) return line;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]' || !payload) return line;
    try {
      const chunk = JSON.parse(payload);
      if (chunk.usage) usage = readUsage(chunk.usage) || usage;
      // Responses API: usage dan output akhir ada di event response.completed / response.incomplete.
      if (chunk.response?.usage) {
        usage = readUsage(chunk.response.usage) || usage;
        frames = chunk.response.usage.video_frames_processed || frames;
      }
      if (Array.isArray(chunk.response?.output) && chunk.response.output.length) finalOutput = chunk.response.output;
      if (chunk.response?.model) chunk.response.model = requestedModel;
      if (chunk.type === 'response.output_item.done' && chunk.item) {
        if (chunk.item.type === 'image_generation_call' && chunk.item.status !== 'failed') imageIds.add(chunk.item.id);
        if (chunk.item.type === 'web_search_call' && chunk.item.status !== 'failed') searchIds.add(chunk.item.id);
      }
      // Endpoint gambar
      if (chunk.type === 'image_generation.completed' || chunk.type === 'image_edit.completed') imageEvents++;
      // Transkripsi: audioProcessedMs naik terus; ambil yang terbesar.
      if (typeof chunk.audioProcessedMs === 'number') audioMs = Math.max(audioMs, chunk.audioProcessedMs);

      const delta = chunk.choices?.[0]?.delta;
      const piece =
        delta?.content ??
        delta?.reasoning_content ??
        chunk.choices?.[0]?.text ??
        (chunk.type === 'response.output_text.delta' ? chunk.delta : null) ??
        (chunk.type === 'transcript' ? chunk.transcript : null);
      if (piece || chunk.b64_json) {
        if (ttft === null) ttft = Date.now() - started;
        if (!usage && piece) completionText += piece;
      }
      // Chunk usage yang kita minta sendiri tidak diteruskan ke client agar formatnya tetap sama.
      if (injectedUsage && chunk.usage && (!chunk.choices || chunk.choices.length === 0)) return null;
      if (injectedUsage && chunk.usage) delete chunk.usage;
      if (typeof chunk.model === 'string') chunk.model = requestedModel;
      return 'data: ' + JSON.stringify(chunk);
    } catch {
      return line;
    }
  };

  const transform = new TransformStream({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      const out = [];
      for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        const processed = processLine(line);
        // Baris yang dibuang menyisakan baris kosong; menurut spec SSE itu tidak memicu event.
        if (processed !== null) out.push(processed);
      }
      if (out.length) controller.enqueue(encoder.encode(out.join('\n') + '\n'));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) {
        const processed = processLine(buffer);
        if (processed !== null) controller.enqueue(encoder.encode(processed));
      }
      finish(200);
      // Event khusus gateway untuk menu chat/benchmark; client lain berhenti di [DONE] dan mengabaikannya.
      if (emitMetrics && metricsForClient) {
        controller.enqueue(encoder.encode(`event: gateway.metrics\ndata: ${JSON.stringify(metricsForClient)}\n\n`));
      }
    },
  });

  const reader = res.body.pipeThrough(transform).getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (e) {
        finish(502, `Stream terputus: ${e.message}`);
        controller.error(e);
      }
    },
    cancel() {
      finish(499, 'Client menutup koneksi saat streaming.');
      reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

const MODEL_META_SQL = `SELECT m.*, p.slug, p.auth_type FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.enabled = 1 AND p.enabled = 1`;

export function listModels() {
  const rows = db.prepare(`${MODEL_META_SQL} ORDER BY m.id`).all();
  return {
    object: 'list',
    data: rows.map((r) => formatModelObject(r)),
  };
}

export function getModel(id) {
  const row = db.prepare(`${MODEL_META_SQL} AND m.id = ?`).get(id);
  return row ? formatModelObject(row) : null;
}
