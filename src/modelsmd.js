// Halaman publik /models.md: katalog ringkas model aktif untuk pengguna API.
// Detail internal (upstream model, base URL, mekanisme langganan/routing) didokumentasikan di how.md.
import { db } from './db.js';
import { supportedEndpointsFor, inputModalitiesFor } from './catalog.js';

const TABLE_HEAD = '| Model ID | Jenis | Input | Endpoint | Konteks | Max output | Harga (in/cache/out per 1Jt) | Reasoning / Catatan |';
const TABLE_SEP = '|---|---|---|---|---|---|---|---|';

// Harga kecil (mis. cached $0.0075) tetap terbaca: minimal 2 desimal, maksimal 4.
const money = (v) =>
  v == null ? '—' : v === 0 ? '$0' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();

const KIND_LABEL = {
  text: 'Teks / chat',
  image: 'Gambar',
  transcribe: 'Transkripsi audio',
  segment: 'Segmentasi',
};

function priceCell(m) {
  if (m.kind === 'image') {
    const parts = [];
    if (m.price_image != null) parts.push(`${money(m.price_image)}/gambar`);
    if (m.input_price || m.output_price) parts.push(`${money(m.input_price)} / ${money(m.cached_price)} / ${money(m.output_price)}`);
    return parts.join(', ') || '—';
  }
  if (m.kind === 'transcribe') return m.price_audio_hour != null ? `${money(m.price_audio_hour)}/jam audio` : '—';
  if (m.kind === 'segment') return m.price_frame != null ? `${money(m.price_frame)}/frame` : '—';
  const base = `${money(m.input_price)} / ${money(m.cached_price)} / ${money(m.output_price)}`;
  if (m.long_threshold) {
    return `${base} (≤${num(m.long_threshold)} tok)<br>${money(m.input_price_long)} / ${money(m.cached_price_long)} / ${money(m.output_price_long)} (>${num(m.long_threshold)} tok)`;
  }
  return base;
}

function endpointsCell(m) {
  return supportedEndpointsFor(m)
    .map((e) => `\`${e}\``)
    .join(', ');
}

function infoCell(m) {
  const bits = [];
  if (m.reasoning) bits.push(esc(m.reasoning));
  else if (m.notes) bits.push(esc(m.notes));
  return bits.join(' · ') || '—';
}

export function renderModelsMarkdown() {
  const providers = db
    .prepare('SELECT id, slug, name, auth_type FROM providers WHERE enabled = 1 ORDER BY slug')
    .all();
  const models = db.prepare('SELECT * FROM models WHERE enabled = 1 ORDER BY id').all();
  const byProvider = new Map();
  for (const m of models) {
    if (!byProvider.has(m.provider_id)) byProvider.set(m.provider_id, []);
    byProvider.get(m.provider_id).push(m);
  }

  const now = new Date().toISOString().slice(0, 10);
  const out = [];
  out.push('# Katalog Model AI Gateway');
  out.push('');
  out.push(`API OpenAI-compatible. Gunakan \`model\` persis seperti kolom **Model ID** dengan header \`Authorization: Bearer <API_KEY>\`. Detail satu model juga tersedia lewat \`GET /v1/models/{model}\`. Diperbarui ${now}.`);
  out.push('');
  out.push(`Total **${models.length}** model aktif dari **${providers.filter((p) => byProvider.has(p.id)).length}** provider.`);
  out.push('');

  for (const p of providers) {
    const list = byProvider.get(p.id);
    if (!list || !list.length) continue;
    out.push(`## ${p.name}`);
    out.push('');
    out.push(TABLE_HEAD);
    out.push(TABLE_SEP);
    for (const m of list) {
      const row = { ...m, slug: p.slug, auth_type: p.auth_type };
      out.push(
        `| \`${m.id}\` | ${KIND_LABEL[m.kind] || m.kind} | ${inputModalitiesFor(row).join(', ')} | ${endpointsCell(row)} | ${num(m.context_window)} | ${num(m.max_output)} | ${priceCell(row)} | ${infoCell(row)} |`
      );
    }
    out.push('');
  }

  out.push('## Pemakaian umum');
  out.push('');
  out.push('- **Chat & Reasoning:** kirim `reasoning_effort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` sesuai dukungan model di tabel).');
  out.push('- **Gambar:** gunakan `POST /v1/images/generations` atau `POST /v1/images/edits` pada model berjenis *Gambar*.');
  out.push('- **Audio (Transkripsi):** gunakan `POST /v1/audio/transcriptions` (multipart `file` WAV + `model`, `response_format`: `json`/`text`/`verbose_json`) pada model berjenis *Transkripsi audio*.');
  out.push('- **Metadata model:** `GET /v1/models` (daftar semua) dan `GET /v1/models/{model}` (detail satu model, termasuk `supported_endpoints` dan `pricing`).');
  out.push('');
  return out.join('\n');
}
