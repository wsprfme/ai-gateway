import path from 'node:path';
import dotenv from 'dotenv';
import { ROOT } from './paths.js';

dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const { Hono } = await import('hono');
const { serve } = await import('@hono/node-server');
const { serveStatic } = await import('@hono/node-server/serve-static');
const { cors } = await import('hono/cors');
const { db, getSetting } = await import('./db.js');
const { handleProxy, authenticate, listModels, getModel } = await import('./proxy.js');
const { admin } = await import('./admin.js');
const { attachRealtime } = await import('./realtime.js');
const { renderModelsMarkdown } = await import('./modelsmd.js');
const { buildOpenApiSpec, renderDocsHtml } = await import('./openapi.js');
const { renderIndex, renderModule } = await import('./assets.js');

const app = new Hono();

// Endpoint OpenAI-compatible
app.use('/v1/*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type', 'x-api-key'] }));
app.post('/v1/chat/completions', (c) => handleProxy(c, '/chat/completions'));
app.post('/v1/completions', (c) => handleProxy(c, '/completions'));
app.post('/v1/embeddings', (c) => handleProxy(c, '/embeddings'));
app.post('/v1/responses', (c) => handleProxy(c, '/responses'));
app.post('/v1/images/generations', (c) => handleProxy(c, '/images/generations'));
app.post('/v1/images/edits', (c) => handleProxy(c, '/images/edits'));
app.post('/v1/audio/transcriptions', (c) => handleProxy(c, '/audio/transcriptions'));
app.post('/v1/asr/transcribe', (c) => handleProxy(c, '/asr/transcribe'));
app.get('/v1/models', (c) => {
  if (!authenticate(c)) return c.json({ error: { message: 'API key tidak valid.', type: 'invalid_api_key', code: 'invalid_api_key' } }, 401);
  return c.json(listModels());
});
app.get('/v1/models/:id{.+}', (c) => {
  if (!authenticate(c)) return c.json({ error: { message: 'API key tidak valid.', type: 'invalid_api_key', code: 'invalid_api_key' } }, 401);
  let id = c.req.param('id');
  try { id = decodeURIComponent(id); } catch {}
  const model = getModel(id);
  if (!model) {
    return c.json({ error: { message: `Model '${id}' tidak ditemukan.`, type: 'invalid_request_error', param: 'model', code: 'model_not_found' } }, 404);
  }
  return c.json(model);
});
// Pastikan route /v1/* yang tidak dikenal tetap membalas error JSON gaya OpenAI (bukan redirect HTML).
app.all('/v1/*', (c) =>
  c.json({ error: { message: `Endpoint ${c.req.method} ${c.req.path} tidak didukung.`, type: 'invalid_request_error', code: 'unsupported_endpoint' } }, 404)
);

app.get('/health', (c) => c.json({ ok: true }));

// Halaman publik daftar model (tanpa auth), format Markdown mentah.
app.get('/models.md', (c) => {
  c.header('content-type', 'text/markdown; charset=utf-8');
  c.header('cache-control', 'public, max-age=300');
  return c.body(renderModelsMarkdown());
});

// Spesifikasi OpenAPI 3.1 + dokumentasi interaktif (tanpa auth).
app.get('/openapi.json', (c) => {
  const proto = c.req.header('x-forwarded-proto') || new URL(c.req.url).protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') || c.req.header('host') || new URL(c.req.url).host;
  c.header('cache-control', 'public, max-age=300');
  return c.json(buildOpenApiSpec(`${proto}://${host}`));
});
app.get('/docs', (c) => {
  c.header('cache-control', 'public, max-age=300');
  return c.html(renderDocsHtml());
});

// Dashboard
app.route('/api/admin', admin);
// Static caching: icons and fonts rarely change; the app shell is revalidated on each full load.
// JS/CSS dengan ?v=<hash isi> tidak pernah berubah di URL yang sama, jadi boleh di-cache selamanya.
app.use('/*', async (c, next) => {
  await next();
  const p = c.req.path;
  if (c.res.status !== 200 || p.startsWith('/api/') || p.startsWith('/v1/') || p === '/models.md' || p === '/openapi.json' || p === '/docs') return;
  const cc = c.req.query('v')
    ? 'public, max-age=31536000, immutable'
    : p.startsWith('/icons/') || p.startsWith('/fonts/')
      ? 'public, max-age=604800'
      : 'no-cache';
  c.res.headers.set('cache-control', cc);
});
// Shell dashboard + modul JS disajikan dengan URL aset yang sudah diberi versi.
app.get('/', (c) => c.html(renderIndex()));
app.get('/index.html', (c) => c.html(renderIndex()));
for (const f of ['app.js', 'ui.js']) {
  app.get('/' + f, (c) => {
    c.header('content-type', 'text/javascript; charset=utf-8');
    return c.body(renderModule(f));
  });
}
app.use('/*', serveStatic({ root: path.relative(process.cwd(), path.join(ROOT, 'public')) || '.' }));
app.get('*', (c) => c.redirect('/'));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: { message: 'Internal server error', type: 'server_error' } }, 500);
});

// Hapus log lama sesuai pengaturan retensi.
function cleanup() {
  const days = getSetting('log_retention_days');
  if (days > 0) db.prepare('DELETE FROM requests WHERE ts < ?').run(Date.now() - days * 86400000);
}
cleanup();
setInterval(cleanup, 6 * 3600 * 1000).unref();

const port = Number(process.env.PORT) || 8787;
const hostname = process.env.HOST || '0.0.0.0';
const server = serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`AI Gateway jalan di http://localhost:${port}`);
});
attachRealtime(server);

// Port tambahan untuk Cloudflare (proxy CF connect ke origin di port 80/443, bukan 8787).
const httpPort = Number(process.env.HTTP_PORT);
if (httpPort && httpPort !== port) {
  const extra = serve({ fetch: app.fetch, port: httpPort, hostname }, () => {
    console.log(`AI Gateway juga dengar di http port ${httpPort} (untuk Cloudflare)`);
  });
  attachRealtime(extra);
}

// HTTPS untuk mode Cloudflare "Full": CF connect ke origin di 443. Sertifikat self-signed
// cukup untuk Full (bukan Full strict). Set TLS_PORT dan TLS_KEY/TLS_CERT di .env.
const tlsPort = Number(process.env.TLS_PORT);
if (tlsPort) {
  try {
    const { createServer } = await import('node:https');
    const fs = await import('node:fs');
    const tls = {
      key: fs.readFileSync(path.resolve(ROOT, process.env.TLS_KEY)),
      cert: fs.readFileSync(path.resolve(ROOT, process.env.TLS_CERT)),
    };
    const secure = serve({ fetch: app.fetch, port: tlsPort, hostname, createServer, serverOptions: tls }, () => {
      console.log(`AI Gateway dengar TLS di port ${tlsPort} (untuk Cloudflare Full)`);
    });
    attachRealtime(secure);
  } catch (e) {
    console.error('Gagal start HTTPS:', e.message);
  }
}
