// Versi aset dashboard: hash isi file JS/CSS ditempel ke URL (?v=...), jadi browser dan Cloudflare
// selalu mengambil file baru setelah ada perubahan, tanpa perlu Ctrl+F5.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';

const PUBLIC = path.join(ROOT, 'public');
const VERSIONED = ['app.js', 'ui.js', 'style.css', 'icons.css'];

let cached = { key: '', version: '' };
// Dihitung ulang hanya kalau mtime/ukuran file berubah (cukup stat 4 file per request HTML/JS).
export function assetVersion() {
  const key = VERSIONED.map((f) => {
    const s = fs.statSync(path.join(PUBLIC, f));
    return `${f}:${s.mtimeMs}:${s.size}`;
  }).join('|');
  if (key !== cached.key) {
    const h = crypto.createHash('sha256');
    for (const f of VERSIONED) h.update(fs.readFileSync(path.join(PUBLIC, f)));
    cached = { key, version: h.digest('hex').slice(0, 10) };
  }
  return cached.version;
}

export function renderIndex() {
  const v = assetVersion();
  return fs
    .readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
    .replace(/(href|src)="\/(app\.js|style\.css|icons\.css)"/g, `$1="/$2?v=${v}"`);
}

// Import antar modul ikut diberi versi, kalau tidak ui.js lama bisa tertinggal di cache.
export function renderModule(file) {
  const v = assetVersion();
  return fs.readFileSync(path.join(PUBLIC, file), 'utf8').replace(/from '\.\/([\w-]+\.js)'/g, `from './$1?v=${v}'`);
}
