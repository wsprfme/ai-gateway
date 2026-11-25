// Probe read-only: baca kredensial lokal, cek kuota/limit + daftar model live.
// Tidak mencetak token. Jalankan: node scripts/probe-subs.mjs
import * as codex from '../src/adapters/codex.js';
import * as ag from '../src/adapters/antigravity.js';
import { readCodexAuth, readAntigravityCred, antigravityCredToStd, scanLocal } from '../src/credimport.js';

const line = (s) => console.log(s);
const fmtWin = (w) => `    ${w.label}: sisa ${w.remainingPercent}% (pakai ${w.usedPercent}%)${w.limitReached ? ' [LIMIT]' : ''}${w.resetAt ? ` · reset ${w.resetAt}` : ''}`;

console.log('== scanLocal ==');
console.log(JSON.stringify(scanLocal(), null, 1));

async function withFreshCodex() {
  const raw = readCodexAuth();
  if (!raw) return null;
  const cred = codex.parseAuthJson(raw);
  // Token tersimpan belum kedaluwarsa; pakai langsung. Kalau 401, baru refresh.
  try {
    const u = await codex.getUsage({ accessToken: cred.accessToken, accountId: cred.meta.accountId });
    return u;
  } catch (e) {
    if (e.status === 401 && cred.refreshToken) {
      const r = await codex.refresh({ refreshToken: cred.refreshToken });
      return codex.getUsage({ accessToken: r.accessToken, accountId: cred.meta.accountId });
    }
    throw e;
  }
}

async function withFreshAg() {
  const raw = readAntigravityCred();
  if (!raw) return null;
  let cred = antigravityCredToStd(raw);
  if (ag.needsRefresh(cred) && cred.refreshToken) {
    const r = await ag.refresh({ refreshToken: cred.refreshToken });
    cred = { ...cred, accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt };
    console.log('  (antigravity token di-refresh)');
  }
  cred = await ag.fromCredential(cred);
  console.log('  projectId resolved:', cred.meta.projectId ? 'ya' : 'tidak');
  return ag.getUsage(cred);
}

line('\n== Codex usage ==');
try {
  const u = await withFreshCodex();
  if (!u) line('  (tidak ada auth.json)');
  else {
    line(`  plan: ${u.plan} · limitReached: ${u.limitReached}`);
    u.windows.forEach((w) => line(fmtWin(w)));
  }
} catch (e) {
  line('  ERROR: ' + e.message);
}

line('\n== Antigravity usage + model ==');
try {
  const u = await withFreshAg();
  if (!u) line('  (tidak ada kredensial)');
  else {
    line(`  limitReached: ${u.limitReached}`);
    line('  windows:');
    u.windows.forEach((w) => line(fmtWin(w)));
    line(`  models (${u.models.length}):`);
    u.models
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach((m) => line(`    ${m.id} — sisa ${m.remainingPercent ?? '?'}%${m.resetAt ? ` · reset ${m.resetAt}` : ''}`));
  }
} catch (e) {
  line('  ERROR: ' + e.message);
}
process.exit(0);
