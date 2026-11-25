// Buat API key gateway dari terminal: npm run create-key -- "nama-key"
import path from 'node:path';
import dotenv from 'dotenv';
import { ROOT } from '../src/paths.js';

dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
const { db } = await import('../src/db.js');
const { generateApiKey, sha256 } = await import('../src/crypto.js');

const name = process.argv[2] || 'default';
const key = generateApiKey();
db.prepare('INSERT INTO api_keys (name, key_hash, key_hint, created_at) VALUES (?, ?, ?, ?)').run(
  name,
  sha256(key),
  key.slice(0, 9) + '…' + key.slice(-4),
  Date.now()
);
console.log(`API key "${name}" dibuat. Simpan sekarang, tidak akan ditampilkan lagi:\n${key}`);
