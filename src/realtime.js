// Proxy WebSocket untuk transkripsi live: ws(s)://gateway/v1/asr/realtime
// Alurnya sama dengan Meta: frame JSON pertama adalah handshake, dengan
// authorization.accessToken = "Bearer <API key gateway>" dan model = model ID gateway
// (mis. "meta/muse-voice-transcribe-1.0"). Gateway menukar key dan nama model, lalu meneruskan
// semua frame dua arah. Biaya dihitung dari audioProcessedMs terbesar yang dilaporkan server.
import { WebSocketServer, WebSocket } from 'ws';
import { authenticateToken, resolveModel, checkBudget, computeCost, log } from './proxy.js';
import { usableKeys, markKeyOk, markKeyFailed, classifyKeyFailure } from './keypool.js';

const PATH = '/v1/asr/realtime';
const BYTES_PER_SEC = { PCM_24KHZ: 48000, PCM_16KHZ: 32000 };

function sendError(ws, message, code = 1008) {
  try {
    ws.send(JSON.stringify({ type: 'error', message }));
  } catch {
    /* socket sudah tertutup */
  }
  ws.close(code, message.slice(0, 120));
}

const safeCode = (code) => (code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1011);

function connectUpstream(route, key, query) {
  const url = route.base_url.replace(/^http/, 'ws').replace(/\/+$/, '') + '/asr/realtime' + query;
  return new Promise((resolve, reject) => {
    const up = new WebSocket(url, { handshakeTimeout: 15000 });
    up.once('open', () => resolve(up));
    up.once('unexpected-response', (_req, res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => reject(Object.assign(new Error(`Upstream ${res.statusCode}: ${text.slice(0, 200)}`), { status: res.statusCode, text, headers: new Headers(res.headers) })));
    });
    up.once('error', reject);
  });
}

function onClient(client, request) {
  const query = new URL(request.url, 'http://x').search;
  const started = Date.now();
  let handshakeTimer = setTimeout(() => sendError(client, 'Handshake tidak dikirim dalam 10 detik.'), 10000);
  let upstream = null;
  const pending = [];
  let state = 'handshake';
  let base = null;
  let route = null;
  let clientBytes = 0;
  let bytesPerSec = BYTES_PER_SEC.PCM_24KHZ;
  let audioMs = 0;
  let ttft = null;
  let logged = false;

  const finish = (status, error = null) => {
    if (logged || !base) return;
    logged = true;
    const estimated = audioMs ? 0 : 1;
    const units = { audio_ms: audioMs || Math.floor((clientBytes / bytesPerSec) * 1000) };
    log({ ...base, status, ...units, cost: computeCost(route, units), latency_ms: Date.now() - started, ttft_ms: ttft, estimated, error });
  };

  client.on('message', async (data, isBinary) => {
    if (state === 'open') {
      if (isBinary) clientBytes += data.length;
      upstream.send(data, { binary: isBinary });
      return;
    }
    if (state === 'connecting') {
      pending.push([data, isBinary]);
      return;
    }
    if (state !== 'handshake') return;
    clearTimeout(handshakeTimer);
    if (isBinary) return sendError(client, 'Frame pertama harus handshake JSON.');

    let hs;
    try {
      hs = JSON.parse(data.toString());
    } catch {
      return sendError(client, 'Handshake harus JSON.');
    }
    const token = String(hs.authorization?.accessToken || '').replace(/^Bearer\s+/i, '');
    const keyId = authenticateToken(token);
    if (!keyId) return sendError(client, 'API key tidak valid.');
    const budgetError = checkBudget();
    if (budgetError) return sendError(client, budgetError, 1013);
    const resolved = resolveModel(String(hs.model || ''));
    if (!resolved.route) return sendError(client, resolved.error);
    route = resolved.route;
    if (route.kind !== 'transcribe') return sendError(client, `Model '${hs.model}' bukan model transkripsi.`);
    bytesPerSec = BYTES_PER_SEC[hs.audioEncoding] || bytesPerSec;

    state = 'connecting';
    base = {
      key_id: keyId,
      model: hs.model,
      provider_id: route.provider_id,
      upstream_model: route.upstream_model,
      endpoint: '/asr/realtime',
      stream: 1,
    };

    let lastErr = null;
    let secret = '';
    for (const k of usableKeys(route.provider_id, route.upstream_model)) {
      try {
        upstream = await connectUpstream(route, k, query);
        base.provider_key_id = k.id;
        secret = k.secret;
        markKeyOk(k.id);
        break;
      } catch (e) {
        lastErr = e;
        const f = e.status ? classifyKeyFailure(e.status, e.text || '', e.headers) : null;
        if (f) {
          markKeyFailed(k.id, f.state, e.message, f.cooldownMs, route.upstream_model);
          continue;
        }
        break;
      }
    }
    if (!upstream) {
      const msg = lastErr ? `Gagal terhubung ke provider: ${lastErr.message}` : 'Tidak ada API key provider yang bisa dipakai.';
      finish(lastErr?.status || 502, msg);
      return sendError(client, msg, 1011);
    }
    if (client.readyState !== WebSocket.OPEN) {
      upstream.close();
      return finish(499, 'Client menutup koneksi sebelum sesi dimulai.');
    }

    upstream.send(JSON.stringify({ ...hs, model: route.upstream_model, authorization: { accessToken: `Bearer ${secret}` } }));
    upstream.on('message', (msg, binary) => {
      if (!binary) {
        try {
          const ev = JSON.parse(msg.toString());
          if (typeof ev.audioProcessedMs === 'number') audioMs = Math.max(audioMs, ev.audioProcessedMs);
          if (ev.type === 'transcript' && ttft === null) ttft = Date.now() - started;
        } catch {
          /* teruskan apa adanya */
        }
      }
      if (client.readyState === WebSocket.OPEN) client.send(msg, { binary });
    });
    upstream.on('close', (code, reason) => {
      finish(code === 1000 ? 200 : 502, code === 1000 ? null : `Upstream menutup sesi (${code}) ${reason}`);
      if (client.readyState === WebSocket.OPEN) client.close(safeCode(code), reason);
    });
    upstream.on('error', (e) => finish(502, `Upstream error: ${e.message}`));

    state = 'open';
    for (const [d, b] of pending.splice(0)) {
      if (b) clientBytes += d.length;
      upstream.send(d, { binary: b });
    }
  });

  client.on('close', (code, reason) => {
    clearTimeout(handshakeTimer);
    if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close(safeCode(code), reason);
    if (state === 'open' || state === 'connecting') finish(200, null);
  });
  client.on('error', () => {});
}

export function attachRealtime(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url, 'http://x').pathname;
    if (path !== PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => onClient(ws, request));
  });
}

export { PATH as REALTIME_PATH };
