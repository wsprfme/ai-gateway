import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';

const file = process.env.DB_PATH
  ? path.resolve(ROOT, process.env.DB_PATH)
  : path.join(ROOT, 'data', 'gateway.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_enc TEXT,
  stream_usage INTEGER NOT NULL DEFAULT 1,
  allow_passthrough INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_model TEXT NOT NULL,
  input_price REAL NOT NULL DEFAULT 0,
  output_price REAL NOT NULL DEFAULT 0,
  cached_price REAL,
  fallback_model TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key_id INTEGER,
  model TEXT NOT NULL,
  provider_id INTEGER,
  upstream_model TEXT,
  endpoint TEXT NOT NULL,
  stream INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  ttft_ms INTEGER,
  estimated INTEGER NOT NULL DEFAULT 0,
  fallback_from TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_model_ts ON requests(model, ts);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Migrasi ringan: tambah kolom baru kalau database lama belum punya.
function addColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumn('models', 'display_name', 'TEXT');
addColumn('models', 'context_window', 'INTEGER');
addColumn('models', 'max_output', 'INTEGER');
addColumn('models', 'reasoning', 'TEXT');
addColumn('models', 'notes', 'TEXT');
// Harga tier konteks panjang: kalau input > long_threshold, seluruh request memakai harga *_long.
addColumn('models', 'long_threshold', 'INTEGER');
addColumn('models', 'input_price_long', 'REAL');
addColumn('models', 'output_price_long', 'REAL');
addColumn('models', 'cached_price_long', 'REAL');
addColumn('requests', 'reasoning_tokens', 'INTEGER NOT NULL DEFAULT 0');
// Jenis autentikasi provider: apikey (default) atau adapter langganan OAuth (codex, antigravity).
addColumn('providers', 'auth_type', "TEXT NOT NULL DEFAULT 'apikey'");
// Model non-teks: jenis model dan harga per unit (gambar, frame video, jam audio, query web search).
addColumn('models', 'kind', "TEXT NOT NULL DEFAULT 'text'"); // text | image | transcribe | segment
addColumn('models', 'price_image', 'REAL');
addColumn('models', 'price_frame', 'REAL');
addColumn('models', 'min_frames', 'INTEGER');
addColumn('models', 'price_audio_hour', 'REAL');
addColumn('models', 'price_search', 'REAL');
addColumn('requests', 'images', 'INTEGER NOT NULL DEFAULT 0');
addColumn('requests', 'audio_ms', 'INTEGER NOT NULL DEFAULT 0');
addColumn('requests', 'frames', 'INTEGER NOT NULL DEFAULT 0');
addColumn('requests', 'searches', 'INTEGER NOT NULL DEFAULT 0');

export const DEFAULT_SETTINGS = {
  monthly_budget_usd: 0, // 0 = tanpa batas
  daily_budget_usd: 0,
  log_retention_days: 90,
  upstream_timeout_sec: 300,
};

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export function getSetting(key) {
  const row = getStmt.get(key);
  return row ? Number(row.value) : DEFAULT_SETTINGS[key];
}

export function getAllSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = getSetting(k);
  return out;
}

export function setSetting(key, value) {
  setStmt.run(key, String(value));
}

export function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfMonth() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
