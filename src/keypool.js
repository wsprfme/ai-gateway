// Pool API key per provider dengan strategi fill-first:
// selalu pakai key dengan urutan teratas yang masih sehat, supaya semua percakapan tetap di satu akun
// (prompt cache provider biasanya per akun). Pindah ke key berikutnya hanya kalau key itu bermasalah.
import { db } from './db.js';
import { encrypt, decrypt, sha256 } from './crypto.js';

db.exec(`
CREATE TABLE IF NOT EXISTS provider_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_enc TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ok',      -- ok | cooldown | exhausted | invalid
  cooldown_until INTEGER,
  last_error TEXT,
  last_error_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(provider_id, key_hash)
);
CREATE INDEX IF NOT EXISTS idx_provider_keys_provider ON provider_keys(provider_id, priority, id);
`);

{
  const cols = db.prepare('PRAGMA table_info(requests)').all().map((c) => c.name);
  if (!cols.includes('provider_key_id')) db.exec('ALTER TABLE requests ADD COLUMN provider_key_id INTEGER');
}
{
  // Kredensial OAuth langganan (Codex/Antigravity): access token di key_enc,
  // refresh token di refresh_enc, dan meta JSON (account_id, id_token, dll) terenkripsi.
  const cols = db.prepare('PRAGMA table_info(provider_keys)').all().map((c) => c.name);
  if (!cols.includes('refresh_enc')) db.exec('ALTER TABLE provider_keys ADD COLUMN refresh_enc TEXT');
  if (!cols.includes('expires_at')) db.exec('ALTER TABLE provider_keys ADD COLUMN expires_at INTEGER');
  if (!cols.includes('meta_enc')) db.exec('ALTER TABLE provider_keys ADD COLUMN meta_enc TEXT');
}

const hintOf = (key) => '••••' + String(key).slice(-4);

const insertKey = db.prepare(`INSERT INTO provider_keys (provider_id, name, key_enc, key_hash, key_hint, priority, created_at)
  VALUES (@provider_id, @name, @key_enc, @key_hash, @key_hint, @priority, @created_at)`);
const nextPriority = db.prepare('SELECT COALESCE(MAX(priority), -1) + 1 AS p FROM provider_keys WHERE provider_id = ?');
const byHash = db.prepare('SELECT id FROM provider_keys WHERE provider_id = ? AND key_hash = ?');

export function addProviderKey(providerId, apiKey, name) {
  const key = String(apiKey).trim();
  if (!key) throw new Error('API key kosong.');
  const hash = sha256(key);
  const dup = byHash.get(providerId, hash);
  if (dup) return { id: dup.id, duplicate: true };
  const priority = nextPriority.get(providerId).p;
  const r = insertKey.run({
    provider_id: providerId,
    name: (name || `Key ${priority + 1}`).slice(0, 60),
    key_enc: encrypt(key),
    key_hash: hash,
    key_hint: hintOf(key),
    priority,
    created_at: Date.now(),
  });
  return { id: Number(r.lastInsertRowid), duplicate: false };
}

const insertOAuth = db.prepare(`INSERT INTO provider_keys
  (provider_id, name, key_enc, key_hash, key_hint, refresh_enc, expires_at, meta_enc, priority, created_at)
  VALUES (@provider_id, @name, @key_enc, @key_hash, @key_hint, @refresh_enc, @expires_at, @meta_enc, @priority, @created_at)`);

// Tambah akun OAuth langganan ke pool. dedupeId menandai akun yang sama (mis. account_id/email)
// supaya login ulang memperbarui kredensial, bukan menambah baris baru.
export function addOAuthKey(providerId, { name, accessToken, refreshToken, expiresAt, meta, dedupeId }) {
  if (!accessToken && !refreshToken) throw new Error('Kredensial OAuth kosong.');
  const hash = sha256(`oauth:${providerId}:${dedupeId || refreshToken || accessToken}`);
  const cur = byHash.get(providerId, hash);
  const row = {
    provider_id: providerId,
    key_enc: encrypt(accessToken || ''),
    key_hash: hash,
    key_hint: dedupeId ? '••••' + String(dedupeId).slice(-4) : hintOf(accessToken || refreshToken || ''),
    refresh_enc: refreshToken ? encrypt(refreshToken) : null,
    expires_at: expiresAt || null,
    meta_enc: meta ? encrypt(JSON.stringify(meta)) : null,
  };
  if (cur) {
    db.prepare(`UPDATE provider_keys SET key_enc=@key_enc, key_hint=@key_hint, refresh_enc=@refresh_enc,
      expires_at=@expires_at, meta_enc=@meta_enc, status='ok', cooldown_until=NULL, last_error=NULL WHERE id=@id`)
      .run({ ...row, id: cur.id });
    return { id: cur.id, duplicate: true };
  }
  const priority = nextPriority.get(providerId).p;
  const r = insertOAuth.run({ ...row, name: (name || `Akun ${priority + 1}`).slice(0, 60), priority, created_at: Date.now() });
  return { id: Number(r.lastInsertRowid), duplicate: false };
}

// Simpan token baru setelah refresh. Mempertahankan refresh token lama kalau respons tidak mengirim yang baru.
export function updateOAuthKey(id, { accessToken, refreshToken, expiresAt, meta }) {
  const cur = db.prepare('SELECT meta_enc FROM provider_keys WHERE id = ?').get(id);
  if (!cur) return;
  let metaEnc = cur.meta_enc;
  if (meta) {
    const prev = cur.meta_enc ? safeJson(decrypt(cur.meta_enc)) : {};
    metaEnc = encrypt(JSON.stringify({ ...prev, ...meta }));
  }
  db.prepare(`UPDATE provider_keys SET key_enc=?, refresh_enc=COALESCE(?, refresh_enc), expires_at=?, meta_enc=?,
    status='ok', cooldown_until=NULL, last_error=NULL WHERE id=?`)
    .run(encrypt(accessToken || ''), refreshToken ? encrypt(refreshToken) : null, expiresAt || null, metaEnc, id);
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// Migrasi dari versi lama: satu key di kolom providers.api_key_enc dipindah ke pool.
for (const p of db.prepare('SELECT id, api_key_enc FROM providers WHERE api_key_enc IS NOT NULL').all()) {
  try {
    addProviderKey(p.id, decrypt(p.api_key_enc), 'Key 1');
  } catch (e) {
    console.error(`Migrasi key provider ${p.id} gagal: ${e.message}`);
    continue;
  }
  db.prepare('UPDATE providers SET api_key_enc = NULL WHERE id = ?').run(p.id);
}

const usable = db.prepare(`SELECT * FROM provider_keys
  WHERE provider_id = ? AND enabled = 1 AND status NOT IN ('exhausted', 'invalid')
    AND (cooldown_until IS NULL OR cooldown_until <= ?)
  ORDER BY priority, id`);

// Rate limit Meta dan River berlaku per model per akun, jadi cooldown 429 disimpan per (key, model).
// Model lain di key yang sama tetap bisa dipakai. Disimpan di memori: cukup untuk cooldown yang hanya detik/menit.
const modelCooldowns = new Map(); // "keyId|model" -> { until, error }
const cdKey = (id, model) => `${id}|${model}`;

export function keyCooldowns(keyId) {
  const now = Date.now();
  const out = [];
  for (const [k, v] of modelCooldowns) {
    const [id, model] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
    if (Number(id) !== keyId) continue;
    if (v.until <= now) modelCooldowns.delete(k);
    else out.push({ model, until: v.until, error: v.error });
  }
  return out;
}

export function clearKeyCooldowns(keyId) {
  for (const k of modelCooldowns.keys()) if (k.startsWith(keyId + '|')) modelCooldowns.delete(k);
}

// Cache pemeriksaan kuota akun langganan (Codex/Antigravity) agar tidak memanggil endpoint kuota tiap request.
const quotaCheckedAt = new Map(); // keyId -> timestamp ms
const QUOTA_CHECK_TTL_MS = () => Number(process.env.QUOTA_CHECK_TTL_MS) || 5 * 60_000;

export function shouldCheckQuota(keyId) {
  const last = quotaCheckedAt.get(keyId) || 0;
  return Date.now() - last >= QUOTA_CHECK_TTL_MS();
}

export function markQuotaChecked(keyId) {
  quotaCheckedAt.set(keyId, Date.now());
}

export function invalidateQuotaCache(keyId) {
  quotaCheckedAt.delete(keyId);
}

const getKeyCooldown = db.prepare('SELECT status, cooldown_until FROM provider_keys WHERE id = ?');

export function isKeyCooledDown(keyId, model = null) {
  const now = Date.now();
  const row = getKeyCooldown.get(keyId);
  if (row && row.status === 'cooldown' && row.cooldown_until && row.cooldown_until > now) return true;
  if (model) {
    const cd = modelCooldowns.get(cdKey(keyId, model));
    if (cd && cd.until > now) return true;
  }
  return false;
}

const clearAccountCooldown = db.prepare(`UPDATE provider_keys SET status = 'ok', cooldown_until = NULL WHERE id = ? AND status = 'cooldown'`);

// Sinkronkan status cooldown akun langganan berdasarkan info kuota live (limitReached / remainingPercent / resetAt).
export function applyQuotaCooldown(keyId, usage) {
  if (!usage || typeof usage !== 'object') return;
  const now = Date.now();
  const parseReset = (iso) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) && t > now ? t : now + 15 * 60_000;
  };

  if (Array.isArray(usage.models) && usage.models.length > 0) {
    let depleted = 0;
    let counted = 0;
    let earliestReset = Infinity;
    for (const m of usage.models) {
      if (m.remainingPercent == null) continue;
      counted++;
      const k = cdKey(keyId, m.id);
      if (m.remainingPercent <= 0) {
        depleted++;
        const until = Math.max(now + 60_000, parseReset(m.resetAt));
        if (until < earliestReset) earliestReset = until;
        modelCooldowns.set(k, { until, error: 'Kuota model habis (auto-cooldown)' });
      } else {
        const cur = modelCooldowns.get(k);
        if (cur && /auto-cooldown/.test(cur.error || '')) modelCooldowns.delete(k);
      }
    }
    if (counted > 0 && depleted === counted) {
      const ms = Math.max(60_000, (Number.isFinite(earliestReset) ? earliestReset : now + 15 * 60_000) - now);
      markKeyFailed(keyId, 'cooldown', 'Semua kuota model habis (auto-cooldown)', ms, null);
    } else {
      clearAccountCooldown.run(keyId);
    }
    return;
  }

  if (usage.limitReached) {
    const hitWindows = (usage.windows || []).filter((w) => w.limitReached && w.resetAt);
    const resets = hitWindows.map((w) => Date.parse(w.resetAt)).filter((t) => Number.isFinite(t) && t > now);
    const until = resets.length ? Math.min(...resets) : now + 15 * 60_000;
    markKeyFailed(keyId, 'cooldown', 'Kuota langganan habis (auto-cooldown)', Math.max(60_000, until - now), null);
  } else if (usage.limitReached === false) {
    clearAccountCooldown.run(keyId);
  }
}

/** Key yang bisa dipakai sekarang untuk model ini, urut fill-first. */
export function usableKeys(providerId, model = null) {
  const now = Date.now();
  return usable
    .all(providerId, now)
    .filter((k) => {
      if (!model) return true;
      const cd = modelCooldowns.get(cdKey(k.id, model));
      return !cd || cd.until <= now;
    })
    .map((k) => ({
      ...k,
      secret: k.key_enc ? decrypt(k.key_enc) : '',
      refreshToken: k.refresh_enc ? decrypt(k.refresh_enc) : null,
      meta: k.meta_enc ? safeJson(decrypt(k.meta_enc)) : {},
    }));
}

export const countKeys = db.prepare('SELECT COUNT(*) AS n FROM provider_keys WHERE provider_id = ?');

const setOk = db.prepare(`UPDATE provider_keys SET status = 'ok', cooldown_until = NULL, last_used_at = ? WHERE id = ?`);
const setState = db.prepare(`UPDATE provider_keys SET status = ?, cooldown_until = ?, last_error = ?, last_error_at = ? WHERE id = ?`);

export function markKeyOk(id) {
  setOk.run(Date.now(), id);
}

const setError = db.prepare('UPDATE provider_keys SET last_error = ?, last_error_at = ? WHERE id = ?');

export function markKeyFailed(id, state, error, cooldownMs = 0, model = null) {
  const now = Date.now();
  const msg = String(error || '').slice(0, 500);
  if (state === 'cooldown') {
    if (model) {
      // Cooldown hanya untuk model ini; status key tetap sehat.
      modelCooldowns.set(cdKey(id, model), { until: now + cooldownMs, error: msg });
      setError.run(msg, now, id);
    } else {
      // Cooldown seluruh akun (mis. kuota sesi/mingguan langganan habis).
      setState.run('cooldown', now + Math.max(cooldownMs, 5_000), msg, now, id);
    }
    return;
  }
  setState.run(state, null, msg, now, id);
}

const CREDIT_RE = /insufficient|credit|balance|quota|billing|payment|top.?up|exceeded your/i;
const SUB_RESET_RE = /quotaResetTimeStamp|resets?\s+in|reset_at|usage_limit_reached|RESOURCE_EXHAUSTED/i;

function parseBodyResetMs(text) {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    for (const d of j?.error?.details || []) {
      const ts = d?.metadata?.quotaResetTimeStamp;
      if (ts) {
        const ms = Date.parse(ts) - Date.now();
        if (Number.isFinite(ms) && ms > 0) return Math.min(Math.max(ms, 5_000), 24 * 3_600_000);
      }
    }
    const rAt = j?.error?.resets_at ?? j?.resets_at;
    if (rAt) {
      const n = Number(rAt);
      const ms = (Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(rAt)) - Date.now();
      if (Number.isFinite(ms) && ms > 0) return Math.min(Math.max(ms, 5_000), 24 * 3_600_000);
    }
  } catch {}
  return null;
}

/**
 * Apakah kegagalan ini masalah key (pindah ke key lain) atau masalah upstream/model (pakai fallback model)?
 * Return { state, cooldownMs } atau null.
 */
export function classifyKeyFailure(status, text, headers) {
  if (status === 401 || status === 403) {
    return CREDIT_RE.test(text) ? { state: 'exhausted' } : { state: 'invalid' };
  }
  if (status === 402) return { state: 'exhausted' };
  if (status === 429) {
    // Kuota langganan yang punya waktu reset adalah cooldown sementara, bukan exhausted permanen.
    if (SUB_RESET_RE.test(text)) {
      return { state: 'cooldown', cooldownMs: parseBodyResetMs(text) ?? retryAfterMs(headers) };
    }
    // Kuota/kredit habis permanen sering juga dikirim sebagai 429.
    if (CREDIT_RE.test(text) && !/rate/i.test(text)) return { state: 'exhausted' };
    return { state: 'cooldown', cooldownMs: retryAfterMs(headers) };
  }
  if (status === 400 && CREDIT_RE.test(text) && /credit|balance|billing|payment/i.test(text)) return { state: 'exhausted' };
  return null;
}

function retryAfterMs(headers) {
  const v = headers?.get?.('retry-after');
  let ms = 60_000;
  if (v) {
    const n = Number(v);
    if (Number.isFinite(n)) ms = n * 1000;
    else if (!Number.isNaN(Date.parse(v))) ms = Date.parse(v) - Date.now();
  }
  return Math.min(Math.max(ms, 5_000), 3_600_000);
}

export function keyHint(key) {
  return hintOf(key);
}
