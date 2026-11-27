// Tes end-to-end dengan upstream palsu. Jalankan: node scripts/e2e-test.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const UP_PORT = 18901;
const GW_PORT = 18902;
const GW = `http://127.0.0.1:${GW_PORT}`;
const tmpDb = path.join(os.tmpdir(), `gw-test-${Date.now()}.db`);

// ---- Upstream palsu (OpenAI-compatible) ----
const seen = [];
const poolFlags = { limitA: false, codexQuotaLimitAcc1: false };
const upstream = http.createServer(async (req, res) => {
  let raw = '';
  for await (const ch of req) raw += ch;
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { _raw: raw };
  }
  seen.push({ url: req.url, auth: req.headers.authorization, accept: req.headers.accept, ctype: req.headers['content-type'],
    accountId: req.headers['chatgpt-account-id'], originator: req.headers['originator'], version: req.headers['version'], body });
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  // ---- Mock models.dev/api.json ----
  if (req.url === '/models-dev.json') {
    return json({
      groq: {
        name: 'Groq',
        api: `http://127.0.0.1:${UP_PORT}/v1`,
        npm: '@ai-sdk/openai-compatible',
        doc: 'https://console.groq.com/docs',
        models: {
          'llama-3.3-70b-versatile': { name: 'Llama 3.3 70B', cost: { input: 0.59, output: 0.79 }, limit: { context: 131072, output: 32768 }, reasoning: false },
          'qwen-qwq-32b': { name: 'Qwen QwQ 32B', cost: { input: 0.29, output: 0.39 }, limit: { context: 131072, output: 16384 }, reasoning: true },
        },
      },
      'non-oai': {
        name: 'Non-OpenAI SDK',
        api: 'https://example.com',
        npm: '@ai-sdk/anthropic',
        models: { 'x': { name: 'X', cost: { input: 1, output: 2 } } },
      },
    });
  }
  // ---- Codex (langganan ChatGPT) palsu ----
  if (req.url === '/codex-token') return json({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600, id_token: '' });
  if (req.url === '/codex-usage') {
    const isAcc1 = req.headers['chatgpt-account-id'] === 'acc1';
    const limited = isAcc1 && poolFlags.codexQuotaLimitAcc1;
    return json({
      plan_type: 'plus',
      rate_limit: {
        limit_reached: limited,
        primary_window: { used_percent: limited ? 100 : 10, limit_reached: limited, reset_at: Math.floor(Date.now() / 1000) + 3600 },
      },
    });
  }
  if (req.url === '/codex-images/generations') {
    return json({ created: 1, data: [{ b64_json: 'CODEXIMG' }], usage: { input_tokens: 10, output_tokens: 20 } });
  }
  if (req.url === '/codex-responses') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    ev({ type: 'response.created', response: { id: 'r', model: body.model } });
    ev({ type: 'response.reasoning_summary_text.delta', delta: 'Mikir dulu' });
    ev({ type: 'response.output_text.delta', delta: 'Halo' });
    ev({ type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } } } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  // ---- Antigravity (langganan Google) palsu ----
  if (req.url === '/ag-token') return json({ access_token: 'GT2', refresh_token: 'GRT2', expires_in: 3600 });
  if (req.url.includes('loadCodeAssist')) return json({ cloudaicompanionProject: { id: 'proj-xyz' }, allowedTiers: [{ id: 'free-tier', isDefault: true }] });
  if (req.url.includes('onboardUser')) return json({ done: true, response: { cloudaicompanionProject: { id: 'proj-xyz' } } });
  if (req.url.includes(':fetchAvailableModels')) {
    return json({ models: { 'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', quotaInfo: { remainingFraction: 0.9 } } } });
  }
  if (req.url.includes(':retrieveUserQuotaSummary')) {
    return json({ groups: [] });
  }
  if (req.url.includes(':generateContent') && !req.url.includes(':streamGenerateContent')) {
    return json({ response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AGIMG' } }] } }] } });
  }
  if (req.url.includes(':streamGenerateContent')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    ev({ response: { candidates: [{ content: { parts: [{ text: 'Rencana...', thought: true }] } }], modelVersion: body.model } });
    ev({ response: { candidates: [{ content: { parts: [{ text: 'Halo' }] } }], modelVersion: body.model } });
    ev({ response: { candidates: [{ content: { parts: [{ text: ' dunia' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, thoughtsTokenCount: 3 } } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  // ---- Meta non-teks ----
  if (req.url === '/v1/images/generations') return json({ created: 1, data: Array.from({ length: body.n || 1 }, () => ({ b64_json: 'AAA' })), usage: { input_tokens: 10, output_tokens: 5 } });
  if (req.url === '/v1/images/edits') return json({ created: 1, data: [{ b64_json: 'BBB' }] });
  if (req.url.startsWith('/v1/asr/transcribe')) {
    if (req.headers.accept === 'text/plain') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('Halo dunia'); }
    // Verifikasi multipart Meta: bila request datang dari adapter /v1/audio/transcriptions, wajib ada audioEncoding: "WAV".
    const m = String(raw || '').match(/name="request"[\s\S]*?\r?\n\r?\n(\{[\s\S]*?\})\r?\n/);
    if (m) {
      let reqJson;
      try { reqJson = JSON.parse(m[1]); } catch {}
      if (reqJson && !reqJson.audioEncoding && reqJson._requireEncoding) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: "You must specify the 'audioEncoding' field" } }));
      }
    }
    return json({ sessionId: 's1', transcript: 'Halo dunia', audioDurationMs: 30400, turns: [{ startMs: 0, endMs: 30400, transcript: 'Halo dunia' }] });
  }
  if (req.url === '/v1/responses' && body.model === 'sam-3.1') {
    const isVideo = JSON.stringify(body.input).includes('input_video');
    return json({ id: 'r', model: 'sam-3.1', output: [], usage: isVideo ? { input_tokens: 0, output_tokens: 0, video_frames_processed: 30 } : { input_tokens: 0, output_tokens: 0 } });
  }
  if (req.url === '/v1/responses' && body.model === 'muse-image-1.0' && body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    ev('response.output_item.done', { item: { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: 'AAA' } });
    ev('response.completed', { response: { id: 'r', model: 'muse-image-1.0', output: [{ type: 'image_generation_call', id: 'ig_1', status: 'completed' }], usage: { input_tokens: 9, output_tokens: 3 } } });
    return res.end();
  }
  if (req.url === '/v1/responses' && Array.isArray(body.tools) && body.tools.some((t) => t.type === 'web_search')) {
    return json({ id: 'r', model: body.model, output: [{ type: 'web_search_call', id: 'ws1', status: 'completed' }, { type: 'web_search_call', id: 'ws2', status: 'completed' }, { type: 'message', content: [] }],
      usage: { input_tokens: 1000, output_tokens: 100 } });
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'real-a' }, { id: 'real-b' }] }));
  }
  if (body.model === 'broken') {
    res.writeHead(503, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'overloaded' } }));
  }
  if (body.model === 'pool-model') {
    const auth = req.headers.authorization;
    if (auth === 'Bearer KA' && poolFlags.limitA) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
      return res.end(JSON.stringify({ error: { message: 'Rate limit reached' } }));
    }
    if (auth === 'Bearer KC') {
      res.writeHead(402, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Insufficient credit balance' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'p', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 } }));
  }
  if (req.url === '/v1/responses' && body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    ev('response.created', { response: { id: 'r1', model: body.model, status: 'in_progress' } });
    ev('response.output_text.delta', { delta: 'Halo' });
    ev('response.completed', {
      response: { id: 'r1', model: body.model, status: 'completed',
        usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 20 } } },
    });
    return res.end();
  }
  if (body.model === 'muse-ember-1.0') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'z', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 300000, completion_tokens: 1000, completion_tokens_details: { reasoning_tokens: 400 } } }));
  }
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ id: 'x', model: body.model, choices: [{ index: 0, delta: { content: 'Hal' } }] });
    chunk({ id: 'x', model: body.model, choices: [{ index: 0, delta: { content: 'o!' }, finish_reason: 'stop' }] });
    if (body.stream_options?.include_usage)
      chunk({ id: 'x', model: body.model, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'y',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Halo!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 1000 } },
    })
  );
});
// Upstream WebSocket transkripsi live
const wsSeen = [];
const upWss = new WebSocketServer({ server: upstream, path: '/v1/asr/realtime' });
upWss.on('connection', (ws) => {
  let ms = 0;
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      const m = JSON.parse(data.toString());
      if (m.authorization) {
        wsSeen.push(m);
        return ws.send(JSON.stringify({ sessionId: 'rt-1' }));
      }
      if (m.type === 'endStream') {
        ws.send(JSON.stringify({ type: 'transcript', transcript: 'halo', final: true, audioProcessedMs: ms }));
        return ws.close(1000);
      }
      return;
    }
    ms += Math.round((data.length / 48000) * 1000);
    ws.send(JSON.stringify({ type: 'audioProgress', audioProcessedMs: ms }));
  });
});
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

// ---- Jalankan gateway ----
const gw = spawn(process.execPath, ['src/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: GW_PORT, HOST: '127.0.0.1', TLS_PORT: '', HTTP_PORT: '', DB_PATH: tmpDb, ADMIN_PASSWORD: 'test-pass', APP_SECRET: 'test-secret-0123456789',
    CODEX_BASE_URL: `http://127.0.0.1:${UP_PORT}/codex-responses`, CODEX_TOKEN_URL: `http://127.0.0.1:${UP_PORT}/codex-token`,
    CODEX_USAGE_URL: `http://127.0.0.1:${UP_PORT}/codex-usage`, CODEX_IMAGES_URL: `http://127.0.0.1:${UP_PORT}/codex-images/generations`,
    AG_BASE_URL: `http://127.0.0.1:${UP_PORT}`, AG_TOKEN_URL: `http://127.0.0.1:${UP_PORT}/ag-token`,
    AG_CODEASSIST_URL: `http://127.0.0.1:${UP_PORT}/v1internal:loadCodeAssist`, AG_ONBOARD_URL: `http://127.0.0.1:${UP_PORT}/v1internal:onboardUser`,
    AG_OAUTH_CLIENT_ID: 'test-ag-client-id', AG_OAUTH_CLIENT_SECRET: 'test-ag-client-secret',
    MODELS_DEV_URL: `http://127.0.0.1:${UP_PORT}/models-dev.json`,
    QUOTA_CHECK_TTL_MS: '50' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let gwOut = '';
gw.stdout.on('data', (d) => (gwOut += d));
gw.stderr.on('data', (d) => (gwOut += d));
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(GW + '/health')).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

let cookie = '';
async function admin(p, method = 'GET', body) {
  const res = await fetch(GW + '/api/admin' + p, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
}

try {
  await test('admin butuh login', async () => assert.equal((await admin('/providers')).status, 401));
  await test('login salah ditolak', async () => assert.equal((await admin('/login', 'POST', { password: 'x' })).status, 401));
  await test('login benar', async () => assert.equal((await admin('/login', 'POST', { password: 'test-pass' })).status, 200));

  let metaId, riverId;
  await test('tambah provider', async () => {
    const a = await admin('/providers', 'POST', { slug: 'meta', name: 'Meta', base_url: `http://127.0.0.1:${UP_PORT}/v1`, api_key: 'UP-KEY-META' });
    const b = await admin('/providers', 'POST', { slug: 'river-ai', base_url: `http://127.0.0.1:${UP_PORT}/v1`, api_key: 'UP-KEY-RIVER', allow_passthrough: true });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    metaId = a.data.id;
    riverId = b.data.id;
    const list = (await admin('/providers')).data;
    assert.equal(list.length, 2);
    assert.ok(!JSON.stringify(list).includes('UP-KEY-META'), 'key provider tidak boleh bocor');
  });
  await test('tes koneksi provider', async () => {
    const r = await admin(`/providers/${metaId}/upstream-models`);
    assert.deepEqual(r.data.models, ['real-a', 'real-b']);
  });
  await test('tambah model', async () => {
    assert.equal((await admin('/models', 'POST', { id: 'meta/muse-ember-xx', provider_id: metaId, upstream_model: 'real-a', input_price: 1, output_price: 2, cached_price: 0.5 })).status, 200);
    assert.equal((await admin('/models', 'POST', { id: 'river-ai/deepseek-ai-V4.1-Flash-1017', provider_id: riverId, upstream_model: 'real-b', input_price: 0.2, output_price: 0.8 })).status, 200);
    assert.equal((await admin('/models', 'POST', { id: 'meta/broken', provider_id: metaId, upstream_model: 'broken', fallback_model: 'river-ai/deepseek-ai-V4.1-Flash-1017' })).status, 200);
  });

  let key;
  await test('buat api key', async () => {
    key = (await admin('/keys', 'POST', { name: 'tes' })).data.key;
    assert.match(key, /^sk-gw-/);
  });
  const chat = (body, k = key) =>
    fetch(GW + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  await test('tanpa key ditolak 401', async () => assert.equal((await chat({ model: 'meta/muse-ember-xx' }, 'salah')).status, 401));
  await test('model tidak dikenal 404', async () => assert.equal((await chat({ model: 'meta/xxx', messages: [] })).status, 404));
  await test('/v1/models', async () => {
    const r = await (await fetch(GW + '/v1/models', { headers: { authorization: `Bearer ${key}` } })).json();
    assert.deepEqual(r.data.map((m) => m.id).sort(), ['meta/broken', 'meta/muse-ember-xx', 'river-ai/deepseek-ai-V4.1-Flash-1017']);
  });

  await test('chat non-stream: routing, key upstream, rewrite model', async () => {
    const r = await chat({ model: 'meta/muse-ember-xx', messages: [{ role: 'user', content: 'hi' }] });
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.model, 'meta/muse-ember-xx');
    const last = seen.at(-1);
    assert.equal(last.body.model, 'real-a');
    assert.equal(last.auth, 'Bearer UP-KEY-META');
  });

  await test('chat stream: usage disuntik & tidak diteruskan ke client', async () => {
    const r = await chat({ model: 'river-ai/deepseek-ai-V4.1-Flash-1017', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes('"content":"Hal"'));
    assert.ok(text.includes('[DONE]'));
    assert.ok(!text.includes('"usage"'), 'chunk usage seharusnya disembunyikan');
    assert.ok(text.includes('"model":"river-ai/deepseek-ai-V4.1-Flash-1017"'));
    assert.equal(seen.at(-1).body.stream_options.include_usage, true);
    assert.equal(seen.at(-1).auth, 'Bearer UP-KEY-RIVER');
  });

  await test('stream dengan include_usage dari client tetap meneruskan usage', async () => {
    const r = await chat({ model: 'river-ai/deepseek-ai-V4.1-Flash-1017', stream: true, stream_options: { include_usage: true }, messages: [] });
    assert.ok((await r.text()).includes('"usage"'));
  });

  await test('fallback saat upstream 503', async () => {
    const r = await chat({ model: 'meta/broken', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    assert.equal(seen.at(-1).body.model, 'real-b');
  });

  await test('passthrough model river-ai/apa-saja', async () => {
    const r = await chat({ model: 'river-ai/model-baru', messages: [] });
    assert.equal(r.status, 200);
    assert.equal(seen.at(-1).body.model, 'model-baru');
  });

  await test('katalog berisi meta dan river-ai', async () => {
    const cat = (await admin('/catalog')).data;
    assert.deepEqual(cat.map((p) => p.slug).sort(), ['antigravity', 'codex', 'meta', 'river-ai']);
    assert.ok(cat.find((p) => p.slug === 'meta').models.some((m) => m.id === 'meta/muse-ember-1.0'));
  });

  await test('pasang katalog meta (provider lama dipakai ulang)', async () => {
    const r = await admin('/catalog/meta/install', 'POST', {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.added, 10);
    const again = await admin('/catalog/meta/install', 'POST', {});
    assert.equal(again.data.added, 0);
    assert.equal(again.data.updated, 10);
    const ember = (await admin('/models')).data.find((m) => m.id === 'meta/muse-ember-1.0');
    assert.equal(ember.long_threshold, 200000);
    assert.equal(ember.output_price_long, 1.5);
    assert.equal(ember.context_window, 1048576);
  });

  await test('tier konteks panjang Muse Ember', async () => {
    const r = await chat({ model: 'meta/muse-ember-1.0', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 200);
  });

  await test('Responses API streaming: usage + reasoning tercatat', async () => {
    const r = await fetch(GW + '/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'meta/muse-spark-1.3', input: 'hi', stream: true }),
    });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes('event: response.completed'));
    assert.ok(text.includes('"model":"meta/muse-spark-1.3"'));
    assert.equal(seen.at(-1).url, '/v1/responses');
    assert.equal(seen.at(-1).body.stream_options, undefined, 'stream_options tidak disuntik ke Responses');
  });

  // ---- Pool API key provider (fill-first) ----
  let poolId;
  const poolKeys = async () => (await admin('/providers')).data.find((p) => p.id === poolId).keys;
  const poolChat = () => chat({ model: 'pool/m', messages: [{ role: 'user', content: 'x' }] });
  const authsSince = (n) => seen.slice(n).filter((s) => s.body.model === 'pool-model').map((s) => s.auth);

  await test('pool: tambah 2 key, duplikat ditolak', async () => {
    poolId = (await admin('/providers', 'POST', { slug: 'pool', base_url: `http://127.0.0.1:${UP_PORT}/v1`, api_key: 'KA', key_name: 'Akun A' })).data.id;
    assert.equal((await admin(`/providers/${poolId}/keys`, 'POST', { name: 'Akun B', api_key: 'KB' })).status, 200);
    assert.equal((await admin(`/providers/${poolId}/keys`, 'POST', { name: 'lagi', api_key: 'KA' })).status, 400);
    await admin('/models', 'POST', { id: 'pool/m', provider_id: poolId, upstream_model: 'pool-model', input_price: 1, output_price: 1 });
    const ks = await poolKeys();
    assert.deepEqual(ks.map((k) => k.name), ['Akun A', 'Akun B']);
    assert.ok(ks[0].active && !ks[1].active);
    assert.ok(!JSON.stringify(ks).includes('"KA"'), 'key asli tidak boleh bocor');
  });

  await test('pool: fill-first selalu ke key teratas', async () => {
    const n = seen.length;
    assert.equal((await poolChat()).status, 200);
    assert.equal((await poolChat()).status, 200);
    assert.deepEqual(authsSince(n), ['Bearer KA', 'Bearer KA']);
  });

  await test('pool: 429 di key A pindah ke B, A cooldown dan dilewati', async () => {
    poolFlags.limitA = true;
    let n = seen.length;
    assert.equal((await poolChat()).status, 200);
    assert.deepEqual(authsSince(n), ['Bearer KA', 'Bearer KB']);
    const ks = await poolKeys();
    assert.equal(ks[0].state, 'ok', 'key tetap sehat, cooldown hanya per model');
    assert.equal(ks[0].cooldowns.length, 1);
    assert.equal(ks[0].cooldowns[0].model, 'pool-model');
    assert.ok(ks[0].cooldowns[0].until > Date.now() + 20000, 'retry-after 30 dtk dipakai');
    n = seen.length;
    assert.equal((await poolChat()).status, 200);
    assert.deepEqual(authsSince(n), ['Bearer KB'], 'key cooldown tidak dicoba lagi untuk model ini');
  });

  await test('pool: model lain di key A tetap jalan saat A kena rate limit', async () => {
    await admin('/models', 'POST', { id: 'pool/other', provider_id: poolId, upstream_model: 'pool-other' });
    await chat({ model: 'pool/other', messages: [{ role: 'user', content: 'x' }] });
    const last = seen.at(-1);
    assert.equal(last.body.model, 'pool-other');
    assert.equal(last.auth, 'Bearer KA');
  });

  await test('pool: aktifkan lagi, kembali ke key A', async () => {
    poolFlags.limitA = false;
    const ka = (await poolKeys())[0];
    await admin('/provider-keys/' + ka.id, 'PUT', { reset: true });
    const n = seen.length;
    await poolChat();
    assert.deepEqual(authsSince(n), ['Bearer KA']);
  });

  await test('pool: kredit habis (402) ditandai exhausted', async () => {
    const r = await admin(`/providers/${poolId}/keys`, 'POST', { name: 'Akun C', api_key: 'KC' });
    const ks = await poolKeys();
    await admin(`/providers/${poolId}/keys/order`, 'PUT', { ids: [r.data.id, ...ks.filter((k) => k.id !== r.data.id).map((k) => k.id)] });
    const n = seen.length;
    assert.equal((await poolChat()).status, 200);
    assert.deepEqual(authsSince(n), ['Bearer KC', 'Bearer KA']);
    const after = await poolKeys();
    assert.equal(after[0].name, 'Akun C');
    assert.equal(after[0].state, 'exhausted');
    assert.ok(after[1].active);
  });

  await test('pool: semua key tidak bisa dipakai -> 429 jelas', async () => {
    for (const k of await poolKeys()) if (k.name !== 'Akun C') await admin('/provider-keys/' + k.id, 'PUT', { enabled: false });
    const r = await poolChat();
    assert.equal(r.status, 429);
    assert.match((await r.json()).error.message, /Semua API key pool/);
  });

  await test('pool: log mencatat key provider', async () => {
    const { rows } = (await admin('/logs?model=pool/m&limit=50')).data;
    assert.ok(rows.some((r) => r.provider_key_name === 'Akun B' && r.status === 200));
    assert.ok(rows.some((r) => r.provider_key_name === 'Akun A' && r.status === 429));
    const br = (await admin('/stats/breakdown?days=1')).data;
    assert.ok(br.provider_keys.some((x) => x.name === 'pool · Akun A'));
  });

  // ---- Model non-teks Meta ----
  const post = (p, body, headers = {}) =>
    fetch(GW + p, { method: 'POST', headers: { authorization: `Bearer ${key}`, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...headers }, body: body instanceof FormData ? body : JSON.stringify(body) });

  await test('Muse Image: generations JSON, 2 gambar', async () => {
    const r = await post('/v1/images/generations', { model: 'meta/muse-image-1.0', prompt: 'rubah', n: 2 });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).data.length, 2);
    assert.equal(seen.at(-1).body.model, 'muse-image-1.0');
  });

  await test('Muse Image: edits multipart, model diganti', async () => {
    const fd = new FormData();
    fd.append('model', 'meta/muse-image-1.0');
    fd.append('prompt', 'tambah topi');
    fd.append('image', new Blob([Buffer.from('fakeimage')], { type: 'image/png' }), 'a.png');
    const r = await post('/v1/images/edits', fd);
    assert.equal(r.status, 200);
    const s = seen.at(-1);
    assert.match(s.ctype, /multipart\/form-data/);
    assert.ok(s.body._raw.includes('muse-image-1.0') && !s.body._raw.includes('meta/muse-image-1.0'));
    assert.ok(s.body._raw.includes('fakeimage'));
  });

  await test('Muse Image lewat Responses streaming', async () => {
    const r = await post('/v1/responses', { model: 'meta/muse-image-1.0', input: 'rubah', stream: true });
    assert.ok((await r.text()).includes('image_generation_call'));
  });

  await test('Voice Transcribe: JSON + text/plain', async () => {
    const fd = new FormData();
    fd.append('request', new Blob([JSON.stringify({ model: 'meta/muse-voice-transcribe-1.0', audioEncoding: 'WAV', mode: 'PUSH_TO_TALK' })], { type: 'application/json' }));
    // WAV 2 detik, 24 kHz mono 16-bit
    const pcm = Buffer.alloc(96000);
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
    hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(24000, 24);
    hdr.writeUInt32LE(48000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
    const wav = Buffer.concat([hdr, pcm]);
    fd.append('audio', new Blob([wav], { type: 'audio/wav' }), 'a.wav');
    const r = await post('/v1/asr/transcribe?sessionId=abc', fd);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).transcript, 'Halo dunia');
    const s = seen.at(-1);
    assert.equal(s.url, '/v1/asr/transcribe?sessionId=abc');
    assert.ok(s.body._raw.includes('"model":"muse-voice-transcribe-1.0"'));

    const fd2 = new FormData();
    fd2.append('request', new Blob([JSON.stringify({ model: 'meta/muse-voice-transcribe-1.0', audioEncoding: 'WAV' })], { type: 'application/json' }));
    fd2.append('audio', new Blob([wav], { type: 'audio/wav' }), 'a.wav');
    const r2 = await post('/v1/asr/transcribe', fd2, { accept: 'text/plain' });
    assert.equal(await r2.text(), 'Halo dunia');
    assert.equal(seen.at(-1).accept, 'text/plain');
  });

  await test('SAM 3.1: gambar dan video', async () => {
    const img = await post('/v1/responses', { model: 'meta/sam-3.1', input: [{ role: 'user', content: [{ type: 'input_text', text: 'kacamata' }, { type: 'input_image', image_url: 'https://x/y.png' }] }] });
    assert.equal(img.status, 200);
    const vid = await post('/v1/responses', { model: 'meta/sam-3.1', input: [{ role: 'user', content: [{ type: 'input_text', text: 'sepeda' }, { type: 'input_video', video_url: 'https://x/y.mp4' }] }] });
    assert.equal(vid.status, 200);
  });

  await test('Web search di Responses', async () => {
    const r = await post('/v1/responses', { model: 'meta/muse-spark-1.3', input: 'berita', tools: [{ type: 'web_search' }] });
    assert.equal(r.status, 200);
  });

  await test('Realtime WebSocket transkripsi', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/v1/asr/realtime?sessionId=live1`);
    const got = [];
    const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    ws.on('message', (d) => got.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ authorization: { accessToken: `Bearer ${key}` }, model: 'meta/muse-voice-transcribe-1.0', audioEncoding: 'PCM_24KHZ' }));
    ws.send(Buffer.alloc(48000 * 3)); // 3 detik audio
    await new Promise((r) => setTimeout(r, 300));
    ws.send(JSON.stringify({ type: 'endStream' }));
    assert.equal(await closed, 1000);
    assert.equal(got[0].sessionId, 'rt-1');
    assert.ok(got.some((e) => e.type === 'transcript' && e.final));
    assert.equal(wsSeen.at(-1).authorization.accessToken, 'Bearer UP-KEY-META');
    assert.equal(wsSeen.at(-1).model, 'muse-voice-transcribe-1.0');

    const bad = new WebSocket(`ws://127.0.0.1:${GW_PORT}/v1/asr/realtime`);
    const badMsgs = [];
    bad.on('message', (d) => badMsgs.push(JSON.parse(d.toString())));
    const badClose = new Promise((resolve) => bad.on('close', (code) => resolve(code)));
    await new Promise((r) => bad.on('open', r));
    bad.send(JSON.stringify({ authorization: { accessToken: 'Bearer salah' }, model: 'meta/muse-voice-transcribe-1.0' }));
    assert.equal(await badClose, 1008);
    assert.match(badMsgs[0].message, /API key tidak valid/);
  });

  await new Promise((r) => setTimeout(r, 300));
  await test('biaya unit non-teks', async () => {
    const { rows } = (await admin('/logs?limit=200')).data;
    const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
    const gen = rows.find((r) => r.endpoint === '/images/generations');
    assert.equal(gen.images, 2); near(gen.cost, 0.02, 'generations');
    const edit = rows.find((r) => r.endpoint === '/images/edits');
    assert.equal(edit.images, 1); near(edit.cost, 0.01, 'edits');
    const imgResp = rows.find((r) => r.model === 'meta/muse-image-1.0' && r.endpoint === '/responses');
    assert.equal(imgResp.images, 1); near(imgResp.cost, 0.01, 'image responses');
    const asr = rows.filter((r) => r.endpoint === '/asr/transcribe');
    const asrJson = asr.find((r) => r.audio_ms === 30400);
    near(asrJson.cost, (30 / 3600) * 0.18, 'asr json (30.4 dtk -> 30 dtk)');
    const asrPlain = asr.find((r) => r.estimated === 1);
    assert.equal(asrPlain.audio_ms, 2000, 'durasi dari header WAV');
    const sam = rows.filter((r) => r.model === 'meta/sam-3.1');
    const samImg = sam.find((r) => r.images === 1);
    near(samImg.cost, 0.0025, 'sam image');
    const samVid = sam.find((r) => r.frames === 30);
    near(samVid.cost, 50 * 0.0002, 'sam video minimal 50 frame');
    const ws = rows.find((r) => r.searches === 2);
    near(ws.cost, (1000 * 1.25 + 100 * 4.25) / 1e6 + 2 * 0.0025, 'web search');
    const rt = rows.find((r) => r.endpoint === '/asr/realtime' && r.status === 200);
    assert.equal(rt.audio_ms, 3000);
    near(rt.cost, (3 / 3600) * 0.18, 'realtime');
  });

  await test('menu chat: streaming + event metrics, key dashboard tersembunyi', async () => {
    const res = await fetch(GW + '/api/admin/chat', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'meta/muse-spark-1.3', stream: true, messages: [{ role: 'user', content: 'hi' }], max_completion_tokens: 64 }),
    });
    assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));
    const text = await res.text();
    assert.ok(text.includes('"content":"Hal"'), 'teks jawaban diteruskan');
    assert.ok(!text.includes('"usage"'), 'chunk usage internal tidak bocor ke client');
    const lines = text.split('\n');
    const mi = lines.findIndex((l) => l === 'event: gateway.metrics');
    assert.ok(mi >= 0 && lines[mi + 1].startsWith('data:'), 'ada event gateway.metrics');
    const metrics = JSON.parse(lines[mi + 1].slice(5));
    assert.equal(metrics.completion_tokens, 500);
    assert.ok(metrics.cost > 0 && metrics.ttft_ms != null);
    // Key internal tidak muncul di daftar, tapi request-nya tercatat di log
    assert.ok(!(await admin('/keys')).data.some((k) => k.name === '(dashboard)'));
    assert.ok((await admin('/logs?limit=5')).data.rows.some((r) => r.key_name === '(dashboard)' && r.endpoint === '/chat/completions'));
  });

  // ---- Codex: langganan ChatGPT sebagai API ----
  await test('Codex: hubungkan akun via paste auth.json', async () => {
    const content = JSON.stringify({ tokens: { access_token: 'AT', refresh_token: 'RT', account_id: 'acc1' } });
    const r = await admin('/oauth/codex/paste', 'POST', { content, name: 'akun1' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const prov = (await admin('/providers')).data.find((p) => p.slug === 'codex');
    assert.ok(prov && prov.auth_type === 'codex', 'provider codex dibuat dengan auth_type codex');
    assert.equal(prov.keys.length, 1);
    const models = (await admin('/models')).data;
    assert.ok(models.some((m) => m.id === 'codex/gpt-6.2-sol'), 'model codex baru terpasang');
    assert.ok(models.some((m) => m.id === 'codex/gpt-image-2.5' && m.kind === 'image'), 'model image codex terpasang');
  });

  await test('Codex: login ulang akun sama tidak menggandakan', async () => {
    const content = JSON.stringify({ tokens: { access_token: 'AT-new', refresh_token: 'RT', account_id: 'acc1' } });
    const r = await admin('/oauth/codex/paste', 'POST', { content, name: 'akun1' });
    assert.equal(r.data.duplicate, true);
    assert.equal((await admin('/providers')).data.find((p) => p.slug === 'codex').keys.length, 1);
  });

  await test('Codex: chat streaming (refresh + reasoning_content + effort suffix)', async () => {
    const n = seen.length;
    const res = await chat({ model: 'codex/gpt-6.2-sol-ultra', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('"reasoning_content":"Mikir dulu"'), 'reasoning summary diteruskan ke stream');
    assert.ok(text.includes('"content":"Halo"'), 'teks jawaban diterjemahkan ke chunk chat');
    assert.ok(text.includes('data: [DONE]'));
    const up = seen.slice(n).find((s) => s.url === '/codex-responses');
    assert.ok(up, 'request diteruskan ke backend Codex');
    assert.equal(up.auth, 'Bearer AT2', 'token di-refresh sebelum dipakai');
    assert.equal(up.accountId, 'acc1', 'header chatgpt-account-id dikirim');
    assert.equal(up.originator, 'codex_cli_rs');
    assert.equal(up.body.store, false);
    assert.equal(up.body.stream, true);
    assert.ok(Array.isArray(up.body.input) && up.body.input[0].type === 'message', 'pesan diubah ke input Responses');
    assert.equal(up.body.reasoning?.effort, 'max', 'effort ultra dari suffix dipetakan ke max');
    assert.ok(up.body.include?.includes('reasoning.encrypted_content'));
    assert.equal(up.body.model, 'gpt-6.2-sol', 'suffix effort dibuang dari wire model');
  });

  await test('Codex: chat non-stream menghasilkan chat.completion + reasoning_content', async () => {
    const r = await chat({ model: 'codex/gpt-6.2-sol', messages: [{ role: 'user', content: 'hi' }] });
    const d = await r.json();
    assert.equal(d.object, 'chat.completion');
    assert.equal(d.choices[0].message.content, 'Halo');
    assert.equal(d.choices[0].message.reasoning_content, 'Mikir dulu');
    assert.equal(d.usage.completion_tokens, 5);
  });

  await test('Codex: /v1/images/generations native Images API', async () => {
    const r = await fetch(GW + '/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex/gpt-image-2.5', prompt: 'a tiny red dot' }),
    });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.data[0].b64_json, 'CODEXIMG');
  });

  await test('Codex: pool fill-first + auto-cooldown berbasis kuota', async () => {
    // Tambah akun kedua ke pool Codex (priority lebih rendah dari akun1)
    const content2 = JSON.stringify({ tokens: { access_token: 'AT-acc2', refresh_token: 'RT2', account_id: 'acc2' } });
    assert.equal((await admin('/oauth/codex/paste', 'POST', { content: content2, name: 'akun2' })).status, 200);
    // Tunggu TTL cache kuota (50ms) lalu set kuota akun1 habis
    await new Promise((r) => setTimeout(r, 70));
    poolFlags.codexQuotaLimitAcc1 = true;
    const n = seen.length;
    const r = await chat({ model: 'codex/gpt-6.2-sol', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    const calls = seen.slice(n).filter((s) => s.url === '/codex-responses');
    assert.equal(calls.length, 1, 'tidak mengirim request ke akun1 yang kuotanya habis');
    assert.equal(calls[0].accountId, 'acc2', 'otomatis pindah fill-first ke akun2');
    const prov = (await admin('/providers')).data.find((p) => p.slug === 'codex');
    assert.equal(prov.keys[0].state, 'cooldown', 'akun1 ditandai cooldown di DB');
    assert.equal(prov.keys[1].active, true, 'akun2 jadi akun aktif (fill-first)');
    poolFlags.codexQuotaLimitAcc1 = false;
  });

  await test('Codex: /v1/responses passthrough streaming', async () => {
    const res = await fetch(GW + '/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex/gpt-6.2-sol', input: 'hi', stream: true }),
    });
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('response.completed'));
  });

  // ---- Antigravity: langganan Google (Gemini) sebagai API ----
  await test('Antigravity: hubungkan akun via OAuth finish', async () => {
    const s = await admin('/oauth/antigravity/start', 'POST', {});
    assert.equal(s.status, 200, JSON.stringify(s.data));
    const redirect = `http://localhost:8788/?code=AGCODE&state=${s.data.state}`;
    const r = await admin('/oauth/antigravity/finish', 'POST', { redirect, verifier: s.data.verifier, name: 'g-akun' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const prov = (await admin('/providers')).data.find((p) => p.slug === 'antigravity');
    assert.ok(prov && prov.auth_type === 'antigravity', 'provider antigravity dibuat');
    const models = (await admin('/models')).data;
    assert.ok(models.some((m) => m.id === 'antigravity/gemini-3.8-flash'), 'model antigravity bersih terpasang');
    assert.ok(models.some((m) => m.id === 'antigravity/gemini-4-hydrogen'), 'model gemini-4-hydrogen bersih terpasang');
    assert.ok(models.some((m) => m.id === 'antigravity/gemini-3.1-flash-image' && m.kind === 'image'), 'model image antigravity terpasang');
    assert.ok(!models.some((m) => m.id.includes('claude') || m.id.includes('gpt-oss')), 'tanpa claude/gpt-oss');
  });

  await test('Antigravity: login ulang akun sama tidak menggandakan', async () => {
    const s = await admin('/oauth/antigravity/start', 'POST', {});
    const redirect = `http://localhost:8788/?code=AGCODE&state=${s.data.state}`;
    const r = await admin('/oauth/antigravity/finish', 'POST', { redirect, verifier: s.data.verifier, name: 'g-akun' });
    assert.equal(r.data.duplicate, true);
    assert.equal((await admin('/providers')).data.find((p) => p.slug === 'antigravity').keys.length, 1);
  });

  await test('Antigravity: chat non-stream via reasoning_effort standar + reasoning_content', async () => {
    const n = seen.length;
    const r = await chat({ model: 'antigravity/gemini-3.8-flash', reasoning_effort: 'high', messages: [{ role: 'user', content: 'halo' }] });
    const d = await r.json();
    assert.equal(d.object, 'chat.completion');
    assert.equal(d.choices[0].message.content, 'Halo dunia', 'teks SSE Gemini diagregasi');
    assert.equal(d.choices[0].message.reasoning_content, 'Rencana...', 'thought diteruskan ke reasoning_content');
    assert.equal(d.usage.prompt_tokens, 20);
    assert.equal(d.usage.completion_tokens, 11, 'candidates(8)+thoughts(3)');
    const up = seen.slice(n).find((s) => s.url && s.url.includes(':streamGenerateContent'));
    assert.ok(up, 'request diteruskan ke backend Antigravity (selalu stream ke upstream)');
    assert.equal(up.auth, 'Bearer GT2', 'token di-refresh sebelum dipakai');
    assert.equal(up.body.project, 'proj-xyz', 'projectId dari loadCodeAssist dipakai di envelope');
    assert.equal(up.body.model, 'gemini-3.8-flash-high', 'base model + reasoning_effort → wire model bersuffix');
    assert.equal(up.body.request.generationConfig.thinkingConfig.thinkingLevel, 'high', 'reasoning_effort → thinkingLevel');
  });

  await test('Antigravity: chat streaming meneruskan reasoning_content', async () => {
    const res = await chat({ model: 'antigravity/gemini-3.8-flash', stream: true, reasoning_effort: 'low', messages: [{ role: 'user', content: 'halo' }] });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('"reasoning_content":"Rencana..."'), 'thought diteruskan sebagai delta.reasoning_content');
    assert.ok(text.includes('"content":"Halo"'));
    const up = seen.at(-1);
    assert.equal(up.body.model, 'gemini-3.8-flash-low', 'reasoning_effort low → gemini-3.8-flash-low');
  });

  await test('Antigravity: multimodal input (audio, video, PDF) diterjemahkan ke inlineData Gemini', async () => {
    const n = seen.length;
    const r = await chat({
      model: 'antigravity/gemini-4-hydrogen',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Analisis semua file ini' },
          { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
          { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } },
          { type: 'file', file: { filename: 'doc.pdf', file_data: 'JVBERi0=' } },
        ],
      }],
    });
    assert.equal(r.status, 200);
    const up = seen.slice(n).find((s) => s.url && s.url.includes(':streamGenerateContent'));
    const parts = up.body.request.contents[0].parts;
    assert.equal(parts[0].text, 'Analisis semua file ini');
    assert.deepEqual(parts[1], { inlineData: { mimeType: 'audio/wav', data: 'UklGRg==' } });
    assert.deepEqual(parts[2], { inlineData: { mimeType: 'video/mp4', data: 'AAAA' } });
    assert.deepEqual(parts[3], { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } });
  });

  await test('Antigravity: /v1/images/generations', async () => {
    const r = await fetch(GW + '/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'antigravity/gemini-3.1-flash-image', prompt: 'a tiny blue dot', size: '1792x1024' }),
    });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.data[0].b64_json, 'AGIMG');
  });

  await new Promise((r) => setTimeout(r, 200));
  await test('Antigravity: estimasi biaya API terhitung dan tercatat per akun', async () => {
    const { rows } = (await admin('/logs?model=antigravity/gemini-3.8-flash&limit=20')).data;
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((r) => r.cost > 0), 'estimasi biaya API Antigravity > 0');
    assert.ok(rows.some((r) => r.provider_key_name === 'g-akun'));
  });

  await new Promise((r) => setTimeout(r, 200));
  await test('Codex: estimasi biaya API terhitung dan tercatat per akun', async () => {
    const { rows } = (await admin('/logs?model=codex/gpt-6.2-sol&limit=20')).data;
    assert.ok(rows.length >= 2);
    assert.ok(rows.every((r) => r.cost > 0), 'estimasi biaya API Codex > 0');
    assert.ok(rows.some((r) => r.provider_key_name === 'akun1'));
    assert.ok(rows.some((r) => r.provider_key_name === 'akun2'));
    assert.ok(rows.some((r) => r.completion_tokens === 5));
  });

  await new Promise((r) => setTimeout(r, 200));
  await test('biaya tier panjang & reasoning tokens', async () => {
    const { rows } = (await admin('/logs?limit=200')).data;
    const ember = rows.find((r) => r.model === 'meta/muse-ember-1.0');
    // 300000 * 0.30 + 1000 * 1.50 = 91500 / 1e6
    assert.ok(Math.abs(ember.cost - 0.0915) < 1e-12, 'ember cost=' + ember.cost);
    assert.equal(ember.reasoning_tokens, 400);
    const resp = rows.find((r) => r.endpoint === '/responses' && r.model === 'meta/muse-spark-1.3' && r.stream === 1);
    // 100 * 1.25 + 50 * 4.25 = 337.5 / 1e6
    assert.ok(Math.abs(resp.cost - 0.0003375) < 1e-12, 'responses cost=' + resp.cost);
    assert.equal(resp.reasoning_tokens, 20);
    assert.equal(resp.estimated, 0);
  });

  await test('log & perhitungan biaya', async () => {
    const { rows } = (await admin('/logs?limit=200')).data;
    const nonStream = rows.find((r) => r.model === 'meta/muse-ember-xx');
    // (2000-1000)*1 + 1000*0.5 + 1000*2 = 3500 / 1e6
    assert.ok(Math.abs(nonStream.cost - 0.0035) < 1e-12, 'cost=' + nonStream.cost);
    assert.equal(nonStream.cached_tokens, 1000);
    const streamed = rows.find((r) => r.model === 'river-ai/deepseek-ai-V4.1-Flash-1017' && r.stream === 1);
    // 1000*0.2 + 500*0.8 = 600 / 1e6
    assert.ok(Math.abs(streamed.cost - 0.0006) < 1e-12, 'stream cost=' + streamed.cost);
    assert.equal(streamed.estimated, 0);
    assert.ok(rows.some((r) => r.model === 'meta/broken' && r.status === 503));
    assert.ok(rows.some((r) => r.fallback_from === 'meta/broken' && r.status === 200));
  });

  await test('summary, daily, breakdown', async () => {
    const s = (await admin('/stats/summary')).data;
    assert.ok(s.today.requests >= 6);
    assert.ok(s.today.cost > 0.004);
    const d = (await admin('/stats/daily?days=7')).data;
    assert.equal(d.length, 7);
    assert.ok(d.at(-1).requests >= 6, 'hari ini harus ada di bucket terakhir');
    const b = (await admin('/stats/breakdown?days=7')).data;
    assert.ok(b.models.length >= 3 && b.providers.length >= 2 && b.keys.length >= 1);
  });

  await test('budget harian memblokir', async () => {
    await admin('/settings', 'PUT', { daily_budget_usd: 0.001 });
    const r = await chat({ model: 'meta/muse-ember-xx', messages: [] });
    assert.equal(r.status, 429);
    await admin('/settings', 'PUT', { daily_budget_usd: 0 });
  });

  await test('GET /v1/models/{model} (ID dengan /, URL-encoded, dan 404 JSON)', async () => {
    const r1 = await fetch(GW + '/v1/models/codex/gpt-6.2-sol', { headers: { authorization: `Bearer ${key}` } });
    assert.equal(r1.status, 200);
    const m1 = await r1.json();
    assert.equal(m1.id, 'codex/gpt-6.2-sol');
    assert.equal(m1.object, 'model');
    assert.deepEqual(m1.supported_endpoints, ['/v1/chat/completions', '/v1/responses']);
    assert.deepEqual(m1.input_modalities, ['text', 'image']);
    assert.equal(m1.pricing.input, 2);
    assert.equal(m1.upstream_model, undefined, 'detail internal tidak bocor');

    const rAg = await fetch(GW + '/v1/models/antigravity/gemini-4-hydrogen', { headers: { authorization: `Bearer ${key}` } });
    assert.equal(rAg.status, 200);
    assert.deepEqual((await rAg.json()).input_modalities, ['text', 'image', 'audio', 'video', 'file']);

    const r2 = await fetch(GW + '/v1/models/' + encodeURIComponent('antigravity/gemini-3.1-flash-image'), { headers: { authorization: `Bearer ${key}` } });
    assert.equal(r2.status, 200);
    const m2 = await r2.json();
    assert.deepEqual(m2.supported_endpoints, ['/v1/images/generations', '/v1/images/edits']);

    const r404 = await fetch(GW + '/v1/models/codex/tidak-ada', { headers: { authorization: `Bearer ${key}` } });
    assert.equal(r404.status, 404);
    const e404 = await r404.json();
    assert.equal(e404.error.code, 'model_not_found');
  });

  await test('POST /v1/audio/transcriptions (adapter OpenAI → Meta ASR: audioEncoding, mode, languageBias, 3 format)', async () => {
    const makeForm = (fmt, lang) => {
      const f = new FormData();
      f.append('model', 'meta/muse-voice-transcribe-1.0');
      f.append('file', new Blob([Buffer.from('RIFF....WAVE')], { type: 'audio/wav' }), 'clip.wav');
      if (fmt) f.append('response_format', fmt);
      if (lang) f.append('language', lang);
      return f;
    };
    const rJson = await fetch(GW + '/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: makeForm('json', 'id') });
    assert.equal(rJson.status, 200);
    assert.deepEqual(await rJson.json(), { text: 'Halo dunia' });
    const rawJson = String(seen.at(-1).body?._raw || '');
    assert.ok(rawJson.includes('"audioEncoding":"WAV"'), 'audioEncoding WAV dikirim ke Meta');
    assert.ok(rawJson.includes('"mode":"PUSH_TO_TALK"'), 'mode PUSH_TO_TALK untuk json');
    assert.ok(rawJson.includes('"languageBias":["Indonesian"]'), 'language id dipetakan ke languageBias Indonesian');

    const rText = await fetch(GW + '/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: makeForm('text') });
    assert.equal(rText.status, 200);
    assert.equal(await rText.text(), 'Halo dunia');

    const rVerb = await fetch(GW + '/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: makeForm('verbose_json', 'en') });
    assert.equal(rVerb.status, 200);
    const vj = await rVerb.json();
    assert.equal(vj.task, 'transcribe');
    assert.equal(vj.text, 'Halo dunia');
    assert.equal(vj.duration, 30.4);
    assert.equal(vj.segments.length, 1);
    assert.equal(vj.segments[0].text, 'Halo dunia');
    assert.equal(vj.segments[0].end, 30.4);
    const rawVerb = String(seen.at(-1).body?._raw || '');
    assert.ok(rawVerb.includes('"mode":"ENDPOINTING"'), 'mode ENDPOINTING untuk verbose_json');
    assert.ok(rawVerb.includes('"languageBias":["English"]'), 'language en dipetakan ke languageBias English');
  });

  await test('kombinasi model+endpoint tidak didukung (termasuk River /v1/completions) & route /v1/* tak dikenal → error JSON OpenAI', async () => {
    const badRiver = await fetch(GW + '/v1/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'river-ai/deepseek-ai-V4.1-Flash-1017', prompt: 'Reply with exactly OK.', max_tokens: 16 }),
    });
    assert.equal(badRiver.status, 400);
    const br = await badRiver.json();
    assert.equal(br.error.code, 'unsupported_endpoint');
    assert.equal(br.error.param, 'model');

    const riverMeta = await (await fetch(GW + '/v1/models/river-ai/deepseek-ai-V4.1-Flash-1017', { headers: { authorization: `Bearer ${key}` } })).json();
    assert.deepEqual(riverMeta.supported_endpoints, ['/v1/chat/completions']);

    const bad1 = await chat({ model: 'codex/gpt-image-2.5', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(bad1.status, 400);
    const b1 = await bad1.json();
    assert.equal(b1.error.code, 'unsupported_endpoint');
    assert.equal(b1.error.param, 'model');

    const bad2 = await fetch(GW + '/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'codex/gpt-6.2-sol', prompt: 'dot' }),
    });
    assert.equal(bad2.status, 400);
    assert.equal((await bad2.json()).error.code, 'unsupported_endpoint');

    const bad3 = await fetch(GW + '/v1/responses/resp_123', { headers: { authorization: `Bearer ${key}` }, redirect: 'manual' });
    assert.equal(bad3.status, 404);
    assert.equal((await bad3.json()).error.code, 'unsupported_endpoint');
  });

  await test('/models.md publik ringkas tanpa detail internal', async () => {
    const md = await (await fetch(GW + '/models.md')).text();
    assert.ok(md.includes('`codex/gpt-6.2-sol`'));
    assert.ok(md.includes('`/v1/audio/transcriptions`'));
    assert.ok(!md.includes('| Upstream |'), 'kolom Upstream internal tidak tampil di /models.md');
    assert.ok(!md.includes('Base URL:'), 'base URL internal tidak tampil di /models.md');
  });

  await test('direktori models.dev: filter OpenAI-compatible, cari, dan install model terpilih', async () => {
    const d = (await admin('/directory?q=groq')).data;
    assert.ok(d.providers.some((p) => p.slug === 'groq' && p.model_count === 2), 'groq ditemukan dari models.dev');
    assert.ok(!d.providers.some((p) => p.slug === 'non-oai'), 'provider non-OpenAI disaring');

    const det = (await admin('/directory/groq')).data;
    assert.equal(det.models.length, 2);
    assert.equal(det.logo, 'https://models.dev/logos/groq.svg');

    const ins = (await admin('/directory/groq/install', 'POST', { api_key: 'GROQ-KEY-1', models: ['llama-3.3-70b-versatile'] })).data;
    assert.equal(ins.ok, true);
    assert.equal(ins.added, 1, 'hanya memasang model yang dipilih');
    assert.equal(ins.has_key, true);

    const ms = (await admin('/models')).data;
    const groqM = ms.find((m) => m.id === 'groq/llama-3.3-70b-versatile');
    assert.ok(groqM && groqM.input_price === 0.59 && groqM.output_price === 0.79);
  });

  await test('OpenAPI /openapi.json, /docs, dan impor model custom dari /v1/models', async () => {
    const rSpec = await fetch(GW + '/openapi.json');
    assert.equal(rSpec.status, 200);
    const spec = await rSpec.json();
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.paths['/v1/models/{model}'] && spec.paths['/v1/audio/transcriptions'] && spec.paths['/v1/chat/completions']);
    assert.ok(spec.servers[0].url.includes(`127.0.0.1:${GW_PORT}`));

    const rDocs = await fetch(GW + '/docs');
    assert.equal(rDocs.status, 200);
    assert.ok((await rDocs.text()).includes('/openapi.json'));

    const custom = (await admin('/providers', 'POST', { slug: 'my-ollama', name: 'My Ollama', base_url: `http://127.0.0.1:${UP_PORT}/v1`, api_key: 'OLLAMA-KEY' })).data;
    const up = (await admin(`/providers/${custom.id}/upstream-models`)).data;
    assert.equal(up.items.length, 2);
    const imp = (await admin(`/providers/${custom.id}/import-models`, 'POST', { models: ['real-a', 'real-b'] })).data;
    assert.equal(imp.ok, true);
    assert.equal(imp.added, 2);
    const ms = (await admin('/models')).data;
    assert.ok(ms.some((m) => m.id === 'my-ollama/real-a') && ms.some((m) => m.id === 'my-ollama/real-b'));
  });

  await test('key dinonaktifkan ditolak', async () => {
    const k = (await admin('/keys')).data[0];
    await admin('/keys/' + k.id, 'PUT', { enabled: false });
    assert.equal((await chat({ model: 'meta/muse-ember-xx', messages: [] })).status, 401);
  });

  await test('export CSV', async () => {
    const r = await fetch(GW + '/api/admin/logs/export.csv', { headers: { cookie } });
    assert.ok((await r.text()).startsWith('ts,model,'));
  });

  await test('dashboard HTML disajikan', async () => {
    const r = await fetch(GW + '/');
    assert.ok((await r.text()).includes('AI Gateway'));
  });
} finally {
  gw.kill();
  upWss.close();
  upstream.closeAllConnections?.();
  upstream.close();
  await new Promise((r) => setTimeout(r, 300));
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) fs.rmSync(f, { force: true });
}

for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
if (failed) console.log('\nOutput gateway:\n' + gwOut);
console.log(`\n${results.length - failed}/${results.length} lulus`);
process.exit(failed ? 1 : 0);
