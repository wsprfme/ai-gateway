import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db, getAllSettings, setSetting, DEFAULT_SETTINGS, startOfToday, startOfMonth } from './db.js';
import { encrypt, decrypt, sha256, generateApiKey, safeEqual, signSession, verifySession } from './crypto.js';
import { CATALOG, publicModelId, fetchRiverPricing } from './catalog.js';
import { handleProxy } from './proxy.js';
import * as codexAdapter from './adapters/codex.js';
import * as antigravityAdapter from './adapters/antigravity.js';
import { addProviderKey, usableKeys, markKeyOk, markKeyFailed, classifyKeyFailure, countKeys, keyCooldowns, clearKeyCooldowns, addOAuthKey, updateOAuthKey, applyQuotaCooldown, markQuotaChecked } from './keypool.js';
import { scanLocal, readCodexAuth, readAntigravityCred, antigravityCredToStd } from './credimport.js';

const COOKIE = 'gw_session';
const SESSION_MS = 7 * 24 * 3600 * 1000;
const loginAttempts = new Map();

export const admin = new Hono();

const bad = (c, message, status = 400) => c.json({ error: message }, status);

admin.post('/login', async (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || 'local';
  const rec = loginAttempts.get(ip) || { n: 0, until: 0 };
  if (rec.until > Date.now()) return bad(c, 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.', 429);

  const { password } = await c.req.json().catch(() => ({}));
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return bad(c, 'ADMIN_PASSWORD belum diatur di .env', 500);
  if (typeof password !== 'string' || !safeEqual(password, expected)) {
    rec.n += 1;
    if (rec.n >= 5) Object.assign(rec, { n: 0, until: Date.now() + 5 * 60 * 1000 });
    loginAttempts.set(ip, rec);
    return bad(c, 'Password salah.', 401);
  }
  loginAttempts.delete(ip);
  setCookie(c, COOKIE, signSession({ exp: Date.now() + SESSION_MS }), {
    httpOnly: true,
    sameSite: 'Strict',
    secure: c.req.url.startsWith('https') || c.req.header('x-forwarded-proto') === 'https',
    path: '/',
    maxAge: SESSION_MS / 1000,
  });
  return c.json({ ok: true });
});

admin.post('/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

admin.use('*', async (c, next) => {
  if (!verifySession(getCookie(c, COOKIE))) return bad(c, 'Belum login.', 401);
  await next();
});

admin.get('/me', (c) => c.json({ ok: true }));

// ---------- Providers ----------
const keyStats = db.prepare(`SELECT provider_key_id AS id,
    COUNT(*) AS requests, COALESCE(SUM(cost),0) AS cost,
    COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(cached_tokens),0) AS cached_tokens,
    COALESCE(SUM(CASE WHEN ts >= @today THEN cost ELSE 0 END),0) AS cost_today,
    COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) AS errors
  FROM requests WHERE provider_key_id IS NOT NULL GROUP BY provider_key_id`);

function keyState(k) {
  if (!k.enabled) return 'off';
  if (k.status === 'cooldown') return k.cooldown_until && k.cooldown_until > Date.now() ? 'cooldown' : 'ok';
  return k.status;
}

function providerKeysOut(providerId, stats) {
  const now = Date.now();
  const keys = db.prepare('SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY priority, id').all(providerId);
  // Key aktif = key pertama yang sehat (fill-first).
  const activeId = keys.find((k) => keyState(k) === 'ok')?.id ?? null;
  return keys.map((k) => {
    const s = stats.get(k.id) || { requests: 0, cost: 0, prompt_tokens: 0, cached_tokens: 0, cost_today: 0, errors: 0 };
    return {
      id: k.id,
      name: k.name,
      hint: k.key_hint,
      priority: k.priority,
      enabled: !!k.enabled,
      state: keyState(k),
      active: k.id === activeId,
      cooldown_until: k.status === 'cooldown' && k.cooldown_until > now ? k.cooldown_until : null,
      cooldowns: keyCooldowns(k.id),
      last_error: k.last_error,
      last_error_at: k.last_error_at,
      last_used_at: k.last_used_at,
      requests: s.requests,
      cost: s.cost,
      cost_today: s.cost_today,
      errors: s.errors,
      cache_rate: s.prompt_tokens ? s.cached_tokens / s.prompt_tokens : null,
    };
  });
}

function providerOut(p, stats) {
  const keys = providerKeysOut(p.id, stats);
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    base_url: p.base_url,
    auth_type: p.auth_type || 'apikey',
    has_key: keys.length > 0,
    keys,
    stream_usage: !!p.stream_usage,
    allow_passthrough: !!p.allow_passthrough,
    enabled: !!p.enabled,
  };
}

const statsMap = () => new Map(keyStats.all({ today: startOfToday() }).map((s) => [s.id, s]));

function validateProvider(b, partial = false) {
  if (!partial || b.slug !== undefined) {
    if (typeof b.slug !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,40}$/.test(b.slug))
      return 'Slug hanya boleh huruf kecil, angka, titik, strip, underscore.';
  }
  if (!partial || b.base_url !== undefined) {
    try {
      const u = new URL(b.base_url);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    } catch {
      return 'Base URL tidak valid.';
    }
  }
  return null;
}

admin.get('/providers', (c) => {
  const stats = statsMap();
  return c.json(db.prepare('SELECT * FROM providers ORDER BY slug').all().map((p) => providerOut(p, stats)));
});

admin.post('/providers', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const err = validateProvider(b);
  if (err) return bad(c, err);
  try {
    const r = db
      .prepare(
        `INSERT INTO providers (slug, name, base_url, stream_usage, allow_passthrough, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        b.slug,
        b.name || b.slug,
        b.base_url.trim(),
        b.stream_usage === false ? 0 : 1,
        b.allow_passthrough ? 1 : 0,
        b.enabled === false ? 0 : 1,
        Date.now()
      );
    const id = Number(r.lastInsertRowid);
    if (b.api_key) addProviderKey(id, b.api_key, b.key_name);
    return c.json({ id });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return bad(c, 'Slug sudah dipakai.');
    throw e;
  }
});

admin.put('/providers/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const b = await c.req.json().catch(() => ({}));
  const err = validateProvider(b, true);
  if (err) return bad(c, err);
  const cur = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
  if (!cur) return bad(c, 'Provider tidak ditemukan.', 404);
  db.prepare(`UPDATE providers SET slug=?, name=?, base_url=?, stream_usage=?, allow_passthrough=?, enabled=? WHERE id=?`).run(
    b.slug ?? cur.slug,
    b.name ?? cur.name,
    (b.base_url ?? cur.base_url).trim(),
    b.stream_usage === undefined ? cur.stream_usage : b.stream_usage ? 1 : 0,
    b.allow_passthrough === undefined ? cur.allow_passthrough : b.allow_passthrough ? 1 : 0,
    b.enabled === undefined ? cur.enabled : b.enabled ? 1 : 0,
    id
  );
  if (b.api_key) addProviderKey(id, b.api_key, b.key_name);
  return c.json({ ok: true });
});

admin.delete('/providers/:id', (c) => {
  db.prepare('DELETE FROM providers WHERE id = ?').run(Number(c.req.param('id')));
  return c.json({ ok: true });
});

async function listUpstreamModels(baseUrl, secret) {
  const started = Date.now();
  const res = await fetch(baseUrl.replace(/\/+$/, '') + '/models', {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(`Upstream ${res.status}: ${text.slice(0, 500)}`);
    e.status = res.status;
    e.text = text;
    e.headers = res.headers;
    throw e;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Respons /models bukan JSON.');
  }
  const models = (data.data || data.models || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
  return { latency_ms: Date.now() - started, models };
}

// Cek koneksi + ambil daftar model dari provider memakai key aktif.
admin.get('/providers/:id/upstream-models', async (c) => {
  const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(Number(c.req.param('id')));
  if (!p) return bad(c, 'Provider tidak ditemukan.', 404);
  const key = usableKeys(p.id)[0];
  if (!key) return bad(c, 'Tidak ada API key yang bisa dipakai untuk provider ini.');
  try {
    return c.json({ ok: true, key: key.name, ...(await listUpstreamModels(p.base_url, key.secret)) });
  } catch (e) {
    return bad(c, `Gagal terhubung: ${e.message}`, 502);
  }
});

// ---------- Pool API key provider ----------
admin.post('/providers/:id/keys', async (c) => {
  const id = Number(c.req.param('id'));
  if (!db.prepare('SELECT 1 FROM providers WHERE id = ?').get(id)) return bad(c, 'Provider tidak ditemukan.', 404);
  const b = await c.req.json().catch(() => ({}));
  if (!b.api_key || !String(b.api_key).trim()) return bad(c, 'API key wajib diisi.');
  const r = addProviderKey(id, b.api_key, b.name);
  if (r.duplicate) return bad(c, 'Key ini sudah ada di provider ini.');
  return c.json({ id: r.id });
});

// Urutan fill-first: ids dari atas (dipakai duluan) ke bawah.
admin.put('/providers/:id/keys/order', async (c) => {
  const id = Number(c.req.param('id'));
  const { ids } = await c.req.json().catch(() => ({}));
  if (!Array.isArray(ids)) return bad(c, 'ids wajib berupa array.');
  const upd = db.prepare('UPDATE provider_keys SET priority = ? WHERE id = ? AND provider_id = ?');
  db.transaction(() => ids.forEach((kid, i) => upd.run(i, Number(kid), id)))();
  return c.json({ ok: true });
});

admin.put('/provider-keys/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const cur = db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(id);
  if (!cur) return bad(c, 'Key tidak ditemukan.', 404);
  const b = await c.req.json().catch(() => ({}));
  db.prepare('UPDATE provider_keys SET name = ?, enabled = ? WHERE id = ?').run(
    typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : cur.name,
    b.enabled === undefined ? cur.enabled : b.enabled ? 1 : 0,
    id
  );
  // Aktifkan lagi: hapus status cooldown/habis/tidak valid (mis. setelah top-up kredit).
  if (b.reset) {
    db.prepare("UPDATE provider_keys SET status = 'ok', cooldown_until = NULL, last_error = NULL WHERE id = ?").run(id);
    clearKeyCooldowns(id);
  }
  return c.json({ ok: true });
});

admin.delete('/provider-keys/:id', (c) => {
  db.prepare('DELETE FROM provider_keys WHERE id = ?').run(Number(c.req.param('id')));
  return c.json({ ok: true });
});

// Tes satu key: kalau berhasil statusnya dipulihkan, kalau gagal statusnya ditandai.
admin.post('/provider-keys/:id/test', async (c) => {
  const k = db.prepare('SELECT * FROM provider_keys WHERE id = ?').get(Number(c.req.param('id')));
  if (!k) return bad(c, 'Key tidak ditemukan.', 404);
  const p = db.prepare('SELECT * FROM providers WHERE id = ?').get(k.provider_id);
  try {
    const r = await listUpstreamModels(p.base_url, decrypt(k.key_enc));
    markKeyOk(k.id);
    return c.json({ ok: true, ...r });
  } catch (e) {
    const f = e.status ? classifyKeyFailure(e.status, e.text || '', e.headers) : null;
    if (f && f.state !== 'cooldown') markKeyFailed(k.id, f.state, e.message);
    return bad(c, e.message, 502);
  }
});

// ---------- Models ----------
const MODEL_NUM_FIELDS = ['input_price', 'output_price', 'cached_price', 'input_price_long', 'output_price_long',
  'cached_price_long', 'long_threshold', 'context_window', 'max_output',
  'price_image', 'price_frame', 'min_frames', 'price_audio_hour', 'price_search'];
const MODEL_TEXT_FIELDS = ['display_name', 'reasoning', 'notes'];
const MODEL_KINDS = ['text', 'image', 'transcribe', 'segment'];

function validateModel(b) {
  if (typeof b.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,120}$/.test(b.id)) return 'Model ID tidak valid.';
  if (!b.provider_id) return 'Provider wajib dipilih.';
  if (typeof b.upstream_model !== 'string' || !b.upstream_model.trim()) return 'Nama model upstream wajib diisi.';
  for (const k of MODEL_NUM_FIELDS) {
    const v = b[k];
    if (v !== undefined && v !== null && v !== '' && !(Number(v) >= 0)) return `${k} harus angka >= 0.`;
  }
  if (b.fallback_model && b.fallback_model === b.id) return 'Fallback tidak boleh model itu sendiri.';
  if (b.kind !== undefined && b.kind !== null && !MODEL_KINDS.includes(b.kind)) return 'Jenis model tidak dikenal.';
  return null;
}

const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const textOrNull = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 1000) : null);

function modelRow(b) {
  const row = {
    id: b.id.trim(),
    provider_id: Number(b.provider_id),
    upstream_model: b.upstream_model.trim(),
    fallback_model: b.fallback_model || null,
    enabled: b.enabled === false || b.enabled === 0 ? 0 : 1,
  };
  for (const k of MODEL_NUM_FIELDS) row[k] = numOrNull(b[k]);
  row.input_price ??= 0;
  row.output_price ??= 0;
  for (const k of MODEL_TEXT_FIELDS) row[k] = textOrNull(b[k]);
  row.kind = MODEL_KINDS.includes(b.kind) ? b.kind : 'text';
  return row;
}

const MODEL_COLS = ['provider_id', 'upstream_model', 'fallback_model', 'enabled', 'kind', ...MODEL_NUM_FIELDS, ...MODEL_TEXT_FIELDS];
const insertModel = db.prepare(
  `INSERT INTO models (id, created_at, ${MODEL_COLS.join(', ')}) VALUES (@id, @created_at, ${MODEL_COLS.map((k) => '@' + k).join(', ')})`
);
const updateModel = db.prepare(`UPDATE models SET ${MODEL_COLS.map((k) => `${k}=@${k}`).join(', ')} WHERE id=@id`);

admin.get('/models', (c) =>
  c.json(
    db
      .prepare(
        `SELECT m.*, p.slug AS provider_slug, p.name AS provider_name,
          (SELECT COUNT(*) FROM requests r WHERE r.model = m.id) AS total_requests,
          (SELECT COALESCE(SUM(cost),0) FROM requests r WHERE r.model = m.id) AS total_cost
         FROM models m JOIN providers p ON p.id = m.provider_id ORDER BY p.slug, m.id`
      )
      .all()
      .map((m) => ({ ...m, enabled: !!m.enabled }))
  )
);

admin.post('/models', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const err = validateModel(b);
  if (err) return bad(c, err);
  try {
    insertModel.run({ ...modelRow(b), created_at: Date.now() });
    return c.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE') || String(e.message).includes('PRIMARY')) return bad(c, 'Model ID sudah ada.');
    throw e;
  }
});

admin.put('/models/:id{.+}', async (c) => {
  const id = c.req.param('id');
  const cur = db.prepare('SELECT * FROM models WHERE id = ?').get(id);
  if (!cur) return bad(c, 'Model tidak ditemukan.', 404);
  const b = { ...cur, ...(await c.req.json().catch(() => ({}))), id };
  const err = validateModel(b);
  if (err) return bad(c, err);
  updateModel.run(modelRow(b));
  return c.json({ ok: true });
});

// ---------- Katalog bawaan (Meta, River) ----------
admin.get('/catalog', (c) => {
  const installed = new Set(db.prepare('SELECT id FROM models').all().map((r) => r.id));
  const providers = new Map(db.prepare('SELECT slug, id FROM providers').all().map((p) => [p.slug, p]));
  return c.json(
    Object.entries(CATALOG).map(([slug, p]) => ({
      slug,
      name: p.name,
      base_url: p.base_url,
      icon: p.icon,
      docs: p.docs,
      auth_type: p.auth_type || 'apikey',
      oauth: !!p.oauth,
      live_pricing: !!p.live_pricing,
      provider_installed: providers.has(slug),
      provider_has_key: providers.has(slug) && countKeys.get(providers.get(slug).id).n > 0,
      key_count: providers.has(slug) ? countKeys.get(providers.get(slug).id).n : 0,
      models: p.models.map((m) => ({
        id: publicModelId(slug, m.upstream),
        upstream: m.upstream,
        display_name: m.display_name,
        kind: m.kind || 'text',
        input: m.input,
        cached: m.cached,
        output: m.output,
        price_image: m.price_image ?? null,
        price_frame: m.price_frame ?? null,
        price_audio_hour: m.price_audio_hour ?? null,
        context_window: m.context_window ?? null,
        installed: installed.has(publicModelId(slug, m.upstream)),
      })),
    }))
  );
});

// Pasang atau perbarui provider dan semua modelnya. Harga model yang sudah ada ikut diperbarui;
// fallback dan status aktif yang kamu atur tetap dipertahankan.
admin.post('/catalog/:slug/install', async (c) => {
  const slug = c.req.param('slug');
  const preset = CATALOG[slug];
  if (!preset) return bad(c, 'Katalog tidak dikenal.', 404);
  const b = await c.req.json().catch(() => ({}));

  let live = null;
  let priceSource = 'katalog bawaan';
  if (preset.live_pricing) {
    try {
      live = await fetchRiverPricing();
      priceSource = 'harga live River';
    } catch (e) {
      priceSource = `katalog bawaan (harga live gagal: ${e.message})`;
    }
  }

  let provider = db.prepare('SELECT * FROM providers WHERE slug = ?').get(slug);
  if (!provider) {
    db.prepare(
      `INSERT INTO providers (slug, name, base_url, stream_usage, allow_passthrough, enabled, auth_type, created_at)
       VALUES (?, ?, ?, 1, ?, 1, ?, ?)`
    ).run(slug, preset.name, preset.base_url, preset.allow_passthrough ? 1 : 0, preset.auth_type || 'apikey', Date.now());
  }
  provider = db.prepare('SELECT * FROM providers WHERE slug = ?').get(slug);
  // Provider langganan (Codex): akun dihubungkan lewat OAuth, bukan API key.
  if (b.api_key && !preset.oauth) addProviderKey(provider.id, b.api_key, b.key_name);

  let added = 0;
  let updated = 0;
  db.transaction(() => {
    for (const m of preset.models) {
      const price = live?.get(m.upstream) || { input: m.input, cached: m.cached, output: m.output };
      const id = publicModelId(slug, m.upstream);
      const cur = db.prepare('SELECT * FROM models WHERE id = ?').get(id);
      const row = modelRow({
        ...(cur || {}),
        id,
        provider_id: provider.id,
        upstream_model: m.upstreamModelId || m.upstream,
        display_name: m.display_name,
        input_price: price.input,
        output_price: price.output,
        cached_price: price.cached,
        long_threshold: m.long_threshold,
        input_price_long: m.input_long,
        output_price_long: m.output_long,
        cached_price_long: m.cached_long,
        context_window: m.context_window,
        max_output: m.max_output,
        reasoning: m.reasoning,
        notes: m.notes,
        kind: m.kind || 'text',
        price_image: m.price_image,
        price_frame: m.price_frame,
        min_frames: m.min_frames,
        price_audio_hour: m.price_audio_hour,
        price_search: m.price_search,
        enabled: cur ? cur.enabled : 1,
      });
      if (cur) {
        updateModel.run(row);
        updated++;
      } else {
        insertModel.run({ ...row, created_at: Date.now() });
        added++;
      }
    }
  })();
  return c.json({
    ok: true,
    added,
    updated,
    price_source: priceSource,
    has_key: countKeys.get(provider.id).n > 0,
    provider_id: provider.id,
    auth_type: provider.auth_type,
    oauth: !!preset.oauth,
  });
});

// ---------- OAuth langganan (Codex) ----------
const OAUTH_ADAPTERS = { codex: codexAdapter, antigravity: antigravityAdapter };
const oauthDedupeId = (adapter, cred) => (adapter.dedupeIdFrom ? adapter.dedupeIdFrom(cred) : cred.meta?.accountId);

function ensureSubscriptionProvider(slug) {
  const preset = CATALOG[slug];
  if (!preset || !preset.oauth) throw new Error('Provider langganan tidak dikenal.');
  let p = db.prepare('SELECT * FROM providers WHERE slug = ?').get(slug);
  if (!p) {
    db.prepare(
      `INSERT INTO providers (slug, name, base_url, stream_usage, allow_passthrough, enabled, auth_type, created_at)
       VALUES (?, ?, ?, 1, 1, 1, ?, ?)`
    ).run(slug, preset.name, preset.base_url, preset.auth_type, Date.now());
    p = db.prepare('SELECT * FROM providers WHERE slug = ?').get(slug);
    // Pasang model bawaan (harga 0, langganan).
    for (const m of preset.models) {
      const id = publicModelId(slug, m.upstream);
      if (db.prepare('SELECT 1 FROM models WHERE id = ?').get(id)) continue;
      insertModel.run({
        ...modelRow({
          id,
          provider_id: p.id,
          upstream_model: m.upstreamModelId || m.upstream,
          display_name: m.display_name,
          input_price: m.input ?? 0,
          cached_price: m.cached ?? null,
          output_price: m.output ?? 0,
          price_image: m.price_image ?? null,
          context_window: m.context_window,
          max_output: m.max_output,
          reasoning: m.reasoning,
          notes: m.notes,
          kind: m.kind || 'text',
        }),
        created_at: Date.now(),
      });
    }
  }
  return p;
}

// Mulai alur OAuth: kembalikan URL login + verifier (PKCE). Verifier dipegang dashboard, dikirim balik saat finish.
admin.post('/oauth/:slug/start', (c) => {
  const slug = c.req.param('slug');
  const adapter = OAUTH_ADAPTERS[slug];
  if (!adapter) return bad(c, 'Provider OAuth tidak dikenal.', 404);
  const { url, verifier, state } = adapter.startAuth();
  return c.json({ url, verifier, state });
});

// Selesaikan OAuth: tukar code jadi token, simpan sebagai akun di pool.
admin.post('/oauth/:slug/finish', async (c) => {
  const slug = c.req.param('slug');
  const adapter = OAUTH_ADAPTERS[slug];
  if (!adapter) return bad(c, 'Provider OAuth tidak dikenal.', 404);
  const b = await c.req.json().catch(() => ({}));
  const { code } = adapter.extractCode(b.redirect || b.code);
  if (!code) return bad(c, 'Tidak ada authorization code di URL yang ditempel.');
  if (!b.verifier) return bad(c, 'Verifier hilang. Mulai ulang proses login.');
  let cred;
  try {
    cred = await adapter.exchangeCode({ code, verifier: b.verifier });
  } catch (e) {
    return bad(c, e.message, 502);
  }
  const provider = ensureSubscriptionProvider(slug);
  const r = addOAuthKey(provider.id, {
    name: b.name,
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken,
    expiresAt: cred.expiresAt,
    meta: cred.meta,
    dedupeId: oauthDedupeId(adapter, cred),
  });
  return c.json({ ok: true, provider_id: provider.id, account_id: r.id, duplicate: r.duplicate });
});

// Alur tempel: untuk Codex, tempel isi file ~/.codex/auth.json.
admin.post('/oauth/:slug/paste', async (c) => {
  const slug = c.req.param('slug');
  const adapter = OAUTH_ADAPTERS[slug];
  if (!adapter?.parseAuthJson) return bad(c, 'Provider ini tidak mendukung tempel kredensial.', 404);
  const b = await c.req.json().catch(() => ({}));
  let cred;
  try {
    cred = adapter.parseAuthJson(b.content);
  } catch (e) {
    return bad(c, e.message);
  }
  const provider = ensureSubscriptionProvider(slug);
  const r = addOAuthKey(provider.id, {
    name: b.name,
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken,
    expiresAt: cred.expiresAt,
    meta: cred.meta,
    dedupeId: oauthDedupeId(adapter, cred),
  });
  return c.json({ ok: true, provider_id: provider.id, account_id: r.id, duplicate: r.duplicate });
});

// Apa yang bisa diimpor dari aplikasi di komputer ini (tanpa buka nilai token).
admin.get('/oauth/local', (c) => c.json(scanLocal()));

// Impor kredensial dari aplikasi lokal (Codex auth.json / Antigravity Credential Manager).
admin.post('/oauth/:slug/import', async (c) => {
  const slug = c.req.param('slug');
  const adapter = OAUTH_ADAPTERS[slug];
  if (!adapter) return bad(c, 'Provider OAuth tidak dikenal.', 404);
  const b = await c.req.json().catch(() => ({}));
  let cred;
  try {
    if (slug === 'codex') {
      const raw = readCodexAuth();
      if (!raw) return bad(c, 'Tidak menemukan ~/.codex/auth.json di komputer ini.', 404);
      cred = adapter.parseAuthJson(raw);
    } else if (slug === 'antigravity') {
      const raw = readAntigravityCred();
      if (!raw) return bad(c, 'Tidak menemukan kredensial Antigravity (hanya didukung di Windows, aplikasi harus sudah login).', 404);
      cred = await adapter.fromCredential(antigravityCredToStd(raw));
    } else {
      return bad(c, 'Impor lokal belum didukung untuk provider ini.', 400);
    }
  } catch (e) {
    return bad(c, e.message, 502);
  }
  const provider = ensureSubscriptionProvider(slug);
  const r = addOAuthKey(provider.id, {
    name: b.name || cred.meta?.email || cred.meta?.accountId,
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken,
    expiresAt: cred.expiresAt,
    meta: cred.meta,
    dedupeId: oauthDedupeId(adapter, cred),
  });
  return c.json({ ok: true, provider_id: provider.id, account_id: r.id, duplicate: r.duplicate });
});

// Kuota/limit tiap akun langganan (port logika 9router). Refresh token kalau perlu, lalu panggil adapter.getUsage.
admin.get('/oauth/:slug/usage', async (c) => {
  const slug = c.req.param('slug');
  const adapter = OAUTH_ADAPTERS[slug];
  if (!adapter?.getUsage) return bad(c, 'Provider ini tidak punya info kuota.', 404);
  const provider = db.prepare('SELECT * FROM providers WHERE slug = ?').get(slug);
  if (!provider) return c.json({ accounts: [] });
  const keys = db.prepare('SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY priority, id').all(provider.id);
  const accounts = [];
  for (const k of keys) {
    let accessToken = k.key_enc ? decrypt(k.key_enc) : '';
    const refreshToken = k.refresh_enc ? decrypt(k.refresh_enc) : null;
    let meta = {};
    try {
      meta = k.meta_enc ? JSON.parse(decrypt(k.meta_enc)) : {};
    } catch {
      meta = {};
    }
    try {
      if (adapter.needsRefresh({ refreshToken, expiresAt: k.expires_at }) && refreshToken) {
        const nt = await adapter.refresh({ refreshToken });
        updateOAuthKey(k.id, nt);
        accessToken = nt.accessToken;
      }
      const usage = await adapter.getUsage({ accessToken, accountId: meta.accountId, meta });
      markQuotaChecked(k.id);
      applyQuotaCooldown(k.id, usage);
      const latest = db.prepare('SELECT status, cooldown_until FROM provider_keys WHERE id = ?').get(k.id);
      accounts.push({ id: k.id, name: k.name, status: latest ? keyState({ ...k, ...latest }) : k.status, usage });
    } catch (e) {
      accounts.push({ id: k.id, name: k.name, status: k.status, error: e.message });
    }
  }
  return c.json({ accounts });
});

admin.delete('/models/:id{.+}', (c) => {
  db.prepare('DELETE FROM models WHERE id = ?').run(c.req.param('id'));
  return c.json({ ok: true });
});

// ---------- Menu chat / benchmark ----------
// Key internal untuk request dari dashboard (disembunyikan dari daftar key). Request tetap dicatat
// dan dihitung biayanya seperti biasa, ditandai key "(dashboard)".
const DASHBOARD_KEY = '(dashboard)';
function dashboardKeyId() {
  const row = db.prepare('SELECT id FROM api_keys WHERE name = ?').get(DASHBOARD_KEY);
  if (row) return row.id;
  const key = generateApiKey();
  const r = db
    .prepare('INSERT INTO api_keys (name, key_hash, key_hint, created_at) VALUES (?, ?, ?, ?)')
    .run(DASHBOARD_KEY, sha256(key), 'dashboard', Date.now());
  return Number(r.lastInsertRowid);
}

// Jalankan satu percakapan lewat gateway dengan streaming + event metrics di akhir.
admin.post('/chat', (c) => handleProxy(c, '/chat/completions', { keyId: dashboardKeyId(), emitMetrics: true }));

// ---------- API keys ----------
admin.get('/keys', (c) =>
  c.json(
    db
      .prepare(
        `SELECT k.id, k.name, k.key_hint, k.enabled, k.created_at, k.last_used_at,
          (SELECT COALESCE(SUM(cost),0) FROM requests r WHERE r.key_id = k.id) AS total_cost,
          (SELECT COUNT(*) FROM requests r WHERE r.key_id = k.id) AS total_requests
         FROM api_keys k WHERE k.name != '${DASHBOARD_KEY}' ORDER BY k.id`
      )
      .all()
      .map((k) => ({ ...k, enabled: !!k.enabled }))
  )
);

admin.post('/keys', async (c) => {
  const { name } = await c.req.json().catch(() => ({}));
  const key = generateApiKey();
  db.prepare('INSERT INTO api_keys (name, key_hash, key_hint, created_at) VALUES (?, ?, ?, ?)').run(
    (name || 'default').slice(0, 60),
    sha256(key),
    key.slice(0, 9) + '…' + key.slice(-4),
    Date.now()
  );
  // Key lengkap hanya ditampilkan sekali.
  return c.json({ key });
});

admin.put('/keys/:id', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const cur = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(Number(c.req.param('id')));
  if (!cur) return bad(c, 'Key tidak ditemukan.', 404);
  db.prepare('UPDATE api_keys SET name=?, enabled=? WHERE id=?').run(
    b.name ?? cur.name,
    b.enabled === undefined ? cur.enabled : b.enabled ? 1 : 0,
    cur.id
  );
  return c.json({ ok: true });
});

admin.delete('/keys/:id', (c) => {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(Number(c.req.param('id')));
  return c.json({ ok: true });
});

// ---------- Settings ----------
admin.get('/settings', (c) => c.json(getAllSettings()));

admin.put('/settings', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (b[k] === undefined) continue;
    const v = Number(b[k]);
    if (!(v >= 0)) return bad(c, `${k} harus angka >= 0.`);
    setSetting(k, v);
  }
  return c.json(getAllSettings());
});

// ---------- Statistik ----------
const sumSql = `SELECT COUNT(*) AS requests, COALESCE(SUM(cost),0) AS cost,
  COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(completion_tokens),0) AS completion_tokens,
  COALESCE(SUM(cached_tokens),0) AS cached_tokens, COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
  COALESCE(SUM(images),0) AS images, COALESCE(SUM(audio_ms),0) AS audio_ms, COALESCE(SUM(frames),0) AS frames,
  COALESCE(SUM(searches),0) AS searches,
  COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) AS errors,
  AVG(CASE WHEN status < 400 THEN latency_ms END) AS avg_latency,
  AVG(ttft_ms) AS avg_ttft
  FROM requests WHERE ts >= ?`;

admin.get('/stats/summary', (c) => {
  const q = db.prepare(sumSql);
  return c.json({
    today: q.get(startOfToday()),
    month: q.get(startOfMonth()),
    all: q.get(0),
    settings: getAllSettings(),
  });
});

// Agregasi harian berdasarkan zona waktu server.
admin.get('/stats/daily', (c) => {
  const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 365);
  const since = startOfToday() - (days - 1) * 86400000;
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') AS day,
        COUNT(*) AS requests, SUM(cost) AS cost, SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens,
        SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
       FROM requests WHERE ts >= ? GROUP BY day ORDER BY day`
    )
    .all(since);
  const map = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since + i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push(map.get(key) || { day: key, requests: 0, cost: 0, prompt_tokens: 0, completion_tokens: 0, errors: 0 });
  }
  return c.json(out);
});

admin.get('/stats/breakdown', (c) => {
  const days = Math.min(Math.max(Number(c.req.query('days')) || 30, 1), 3650);
  const since = startOfToday() - (days - 1) * 86400000;
  const by = (expr, join = '') =>
    db
      .prepare(
        `SELECT ${expr} AS name, COUNT(*) AS requests, SUM(r.cost) AS cost,
          SUM(r.prompt_tokens) AS prompt_tokens, SUM(r.completion_tokens) AS completion_tokens,
          SUM(CASE WHEN r.status >= 400 THEN 1 ELSE 0 END) AS errors,
          AVG(CASE WHEN r.status < 400 THEN r.latency_ms END) AS avg_latency
         FROM requests r ${join} WHERE r.ts >= ? GROUP BY 1 ORDER BY cost DESC, requests DESC`
      )
      .all(since);
  return c.json({
    models: by('r.model'),
    providers: by("COALESCE(p.slug, '-')", 'LEFT JOIN providers p ON p.id = r.provider_id'),
    keys: by("COALESCE(k.name, '(terhapus)')", 'LEFT JOIN api_keys k ON k.id = r.key_id'),
    provider_keys: by("COALESCE(pp.slug || ' · ' || pk.name, '(tanpa key)')", 'LEFT JOIN provider_keys pk ON pk.id = r.provider_key_id LEFT JOIN providers pp ON pp.id = pk.provider_id'),
  });
});

admin.get('/logs', (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const where = [];
  const params = [];
  const model = c.req.query('model');
  if (model) {
    where.push('r.model = ?');
    params.push(model);
  }
  const status = c.req.query('status');
  if (status === 'error') where.push('r.status >= 400');
  if (status === 'ok') where.push('r.status < 400');
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db
    .prepare(
      `SELECT r.*, p.slug AS provider_slug, k.name AS key_name, pk.name AS provider_key_name FROM requests r
       LEFT JOIN providers p ON p.id = r.provider_id LEFT JOIN api_keys k ON k.id = r.key_id
       LEFT JOIN provider_keys pk ON pk.id = r.provider_key_id
       ${w} ORDER BY r.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM requests r ${w}`).get(...params).n;
  return c.json({ rows, total });
});

admin.get('/logs/export.csv', (c) => {
  const rows = db
    .prepare(
      `SELECT r.ts, r.model, p.slug AS provider, r.upstream_model, k.name AS key_name, r.status, r.stream,
        r.prompt_tokens, r.completion_tokens, r.cached_tokens, r.reasoning_tokens, r.images, r.audio_ms, r.frames, r.searches, r.cost, r.latency_ms, r.ttft_ms, r.estimated, r.error
       FROM requests r LEFT JOIN providers p ON p.id = r.provider_id LEFT JOIN api_keys k ON k.id = r.key_id
       ORDER BY r.id DESC`
    )
    .all();
  const cols = ['ts', 'model', 'provider', 'upstream_model', 'key_name', 'status', 'stream', 'prompt_tokens',
    'completion_tokens', 'cached_tokens', 'reasoning_tokens', 'images', 'audio_ms', 'frames', 'searches', 'cost', 'latency_ms', 'ttft_ms', 'estimated', 'error'];
  const esc = (v) => {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // cegah formula injection di Excel
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) {
    r.ts = new Date(r.ts).toISOString();
    lines.push(cols.map((k) => esc(r[k])).join(','));
  }
  return c.body(lines.join('\n'), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="requests.csv"',
  });
});
