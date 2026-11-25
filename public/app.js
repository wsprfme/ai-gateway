import {
  $, $$, esc, icon, toast, openSheet, confirmSheet, formData, copyChip, isPhone,
  fmtUsd, fmtPrice, fmtNum, fmtShort, fmtMs, fmtCtx, fmtAgo, fmtTime, pct,
} from './ui.js';

const page = $('#page');
const GATEWAY = location.origin + '/v1';

// ---------- API ----------
// GET responses are cached in memory so revisiting a page renders instantly; route() then refreshes
// it in the background. Any write clears the cache. A GET that finishes after the user navigated
// away is dropped (err.stale) so an old page never overwrites the new one.
const cache = new Map();
let navId = 0;
let revalidating = false;
let cacheHits = 0;

async function api(path, opts = {}) {
  const isGet = !opts.method || opts.method === 'GET';
  if (!isGet) cache.clear();
  if (isGet && !revalidating && cache.has(path)) {
    cacheHits++;
    return structuredClone(cache.get(path));
  }
  const nav = navId;
  const res = await fetch('/api/admin' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new Error('Sesi habis. Masuk lagi.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (isGet) {
    cache.set(path, data);
    if (nav !== navId) throw Object.assign(new Error('stale'), { stale: true });
    return structuredClone(data);
  }
  return data;
}

// ---------- Provider identity ----------
const LOGOS = { meta: '/icons/meta.svg', 'river-ai': '/icons/river-ai.png', codex: '/icons/openai.svg', antigravity: '/icons/antigravity.svg' };
function logo(slug, name, cls = '') {
  const src = LOGOS[slug];
  if (src) return `<img class="logo ${cls}" src="${src}" alt="" width="28" height="28" />`;
  return `<span class="logo-mono ${cls}" aria-hidden="true">${esc((name || slug || '?').slice(0, 1).toUpperCase())}</span>`;
}

// ---------- Navigation ----------
const ROUTES = [
  { id: 'overview', label: 'Ringkasan', icon: 'layout-dashboard' },
  { id: 'chat', label: 'Chat', icon: 'message-square' },
  { id: 'models', label: 'Model', icon: 'boxes' },
  { id: 'providers', label: 'Provider', icon: 'server' },
  { id: 'keys', label: 'API key', icon: 'key-round' },
  { id: 'logs', label: 'Log', icon: 'scroll-text' },
  { id: 'settings', label: 'Pengaturan', icon: 'sliders-horizontal' },
];
const TABS = ['overview', 'chat', 'models', 'logs'];

function buildNav() {
  $('#nav').innerHTML = ROUTES.map(
    (r) => `<a class="nav-item" href="#${r.id}" data-route="${r.id}">${icon(r.icon)}${r.label}</a>`
  ).join('');
  $('#tabbar').innerHTML =
    TABS.map((id) => {
      const r = ROUTES.find((x) => x.id === id);
      return `<a class="tab" href="#${r.id}" data-route="${r.id}">${icon(r.icon)}<span>${r.label}</span></a>`;
    }).join('') +
    `<button type="button" class="tab" id="more-tab">${icon('ellipsis')}<span>Lainnya</span></button>`;
  $('#endpoint-label').textContent = GATEWAY;

  $('#more-tab').onclick = () =>
    openSheet({
      title: 'Lainnya',
      body: `<div class="card list">
        ${['providers', 'keys', 'settings']
          .map((id) => {
            const r = ROUTES.find((x) => x.id === id);
            return `<a class="row row-link" href="#${id}" data-close style="grid-template-columns:auto 1fr">${icon(r.icon)}<span class="row-title">${r.label}</span></a>`;
          })
          .join('')}
        <button type="button" class="row row-link" id="more-logout" style="grid-template-columns:auto 1fr;border-left:0;border-right:0;border-bottom:0;background:none;font:inherit;color:var(--err);text-align:left;width:100%">${icon('log-out')}<span class="row-title">Keluar</span></button>
      </div>`,
      onOpen: ({ el }) => { $('#more-logout', el).onclick = logout; },
    });
}

async function logout() {
  await api('/logout', { method: 'POST' }).catch(() => {});
  showLogin();
}
$('#logout').onclick = logout;

// Translucent top bar gets its edge only once content scrolls under it.
addEventListener(
  'scroll',
  () => {
    $('#topbar').classList.toggle('scrolled', scrollY > 4);
  },
  { passive: true }
);

function setActive(id) {
  const r = ROUTES.find((x) => x.id === id) || ROUTES[0];
  $$('[data-route]').forEach((a) => {
    if (a.dataset.route === r.id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const more = $('#more-tab');
  if (more) {
    if (!TABS.includes(r.id)) more.setAttribute('aria-current', 'page');
    else more.removeAttribute('aria-current');
  }
  $('#topbar-title').textContent = r.label;
  document.title = `${r.label} · AI Gateway`;
}

const pages = { overview, chat, models, providers, keys, logs, settings };

async function route({ animate = false } = {}) {
  const myNav = ++navId;
  if (typeof chatAbort !== 'undefined') chatAbort?.abort(); // hentikan benchmark saat pindah halaman
  const id = location.hash.slice(1) || 'overview';
  const render = pages[id] || overview;
  setActive(id);
  document.body.dataset.route = id;
  if (!page.firstElementChild) page.innerHTML = '<div class="skeleton"></div>';
  // Only a slow load shows the in-app progress line; fast ones just swap.
  const busy = setTimeout(() => document.body.classList.add('busy'), 200);
  const hitsBefore = cacheHits;
  try {
    await renderPage(render);
    if (myNav !== navId) return;
    if (animate) {
      page.classList.remove('page-enter');
      void page.offsetWidth;
      page.classList.add('page-enter');
    }
    // Served from cache: refresh quietly so numbers stay current.
    if (cacheHits > hitsBefore) {
      revalidating = true;
      try {
        await renderPage(render);
      } catch {
        /* keep the cached view */
      } finally {
        revalidating = false;
      }
    }
  } catch (err) {
    if (err.stale || myNav !== navId) return;
    page.innerHTML = `<div class="card empty">${icon('circle-alert')}<p>${esc(err.message)}</p>
      <button class="btn" onclick="location.reload()">Muat ulang</button></div>`;
  } finally {
    clearTimeout(busy);
    if (myNav === navId) document.body.classList.remove('busy');
  }
}

async function renderPage(render) {
  page.onclick = page.onchange = page.onkeydown = null;
  onresize = null;
  $('#topbar-action').innerHTML = '';
  await render();
}

// In-app links use the History API: a hash link makes Chrome start a frame load (the browser's own
// loading indicator) on every click.
function navigate(hash, { replace = false } = {}) {
  if (hash === (location.hash || '#overview')) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', hash);
  scrollTo(0, 0);
  route({ animate: true });
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || !ROUTES.some((r) => '#' + r.id === a.getAttribute('href'))) return; // e.g. the skip link
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
addEventListener('popstate', () => route({ animate: true })); // back/forward and a hash typed by hand

// ---------- Auth ----------
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  document.title = 'Masuk · AI Gateway';
  setTimeout(() => $('#login-password').focus(), 50);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  const btn = e.target.querySelector('button');
  err.textContent = '';
  btn.disabled = true;
  try {
    await api('/login', { method: 'POST', body: { password: $('#login-password').value } });
    $('#login-password').value = '';
    await start();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

async function start() {
  try {
    await api('/me');
  } catch {
    return showLogin();
  }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  buildNav();
  route();
}

function head(title, sub, actions = '') {
  // Judul & deskripsi tidak ditampilkan (h1 tetap ada untuk pembaca layar); hanya tombol aksi yang tampil.
  return `<h1 class="sr-only">${esc(title)}</h1>${actions ? `<div class="page-head"><div class="page-actions">${actions}</div></div>` : ''}`;
}

// ==========================================================
// Ringkasan
// ==========================================================
const view = { days: Number(sessionStorage.getItem('days')) || 30, metric: 'cost' };

async function overview() {
  const [sum, daily, br, cat] = await Promise.all([
    api('/stats/summary'),
    api('/stats/daily?days=' + view.days),
    api('/stats/breakdown?days=' + view.days),
    api('/catalog'),
  ]);
  const { today, month, all, settings } = sum;
  const monthTokens = month.prompt_tokens + month.completion_tokens;
  const limit = settings.monthly_budget_usd;
  const used = limit ? Math.min(100, (month.cost / limit) * 100) : 0;
  const noProvider = !cat.some((c) => c.provider_installed);

  page.innerHTML = `
    ${head('Ringkasan', 'Pemakaian dan biaya semua model yang lewat gateway.', `
      <div class="seg" role="group" aria-label="Rentang waktu" id="range">
        ${[7, 30, 90].map((d) => `<button type="button" data-d="${d}" aria-pressed="${d === view.days}">${d} hari</button>`).join('')}
      </div>`)}

    ${noProvider ? `
      <div class="card card-pad" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
        <div style="display:flex;gap:8px">${logo('meta')}${logo('river-ai')}</div>
        <div style="flex:1;min-width:220px"><h2>Pasang Meta dan River</h2>
          <p class="muted" style="margin:4px 0 0;font-size:15px">Katalog sudah berisi semua model, harga, dan batas konteks. Tinggal tempel API key.</p></div>
        <a class="btn btn-primary" href="#models" data-open-catalog>${icon('package-plus')}Buka katalog</a>
      </div>` : ''}

    <div class="hero-stat">
      <section class="card spend" aria-labelledby="spend-label">
        <span class="label" id="spend-label">Biaya bulan ini</span>
        <span class="spend-value">${fmtUsd(month.cost)}</span>
        ${limit ? `
          <div>
            <div class="meter ${used >= 90 ? 'hot' : ''}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(used)}" aria-label="Budget bulanan terpakai"><span style="width:${used}%"></span></div>
            <p class="muted" style="margin:8px 0 0;font-size:14px">${Math.round(used)}% dari budget ${fmtUsd(limit)}</p>
          </div>` : ''}
        <div class="spend-meta">
          <span>Hari ini <b class="num">${fmtUsd(today.cost)}</b></span>
          <span>Total <b class="num">${fmtUsd(all.cost)}</b></span>
          <span>Request <b class="num">${fmtNum(month.requests)}</b></span>
        </div>
      </section>
      <div class="stats">
        <div class="stat"><span class="label">Token bulan ini</span><span class="stat-value">${fmtShort(monthTokens)}</span>
          <span class="stat-sub">${fmtShort(month.prompt_tokens)} masuk · ${fmtShort(month.completion_tokens)} keluar</span></div>
        <div class="stat"><span class="label">Dari cache</span><span class="stat-value">${pct(month.cached_tokens, month.prompt_tokens)}%</span>
          <span class="stat-sub">${fmtShort(month.cached_tokens)} token input</span></div>
        <div class="stat"><span class="label">Latency</span><span class="stat-value">${fmtMs(month.avg_latency)}</span>
          <span class="stat-sub">TTFT ${fmtMs(month.avg_ttft)}</span></div>
        <div class="stat"><span class="label">Error hari ini</span><span class="stat-value">${pct(today.errors, today.requests)}%</span>
          <span class="stat-sub">${fmtNum(today.errors)} dari ${fmtNum(today.requests)} request</span></div>
      </div>
    </div>

    <section class="section card" aria-labelledby="daily-h">
      <div class="section-head" style="padding:16px 20px 0;margin:0">
        <h2 id="daily-h">Per hari</h2>
        <div class="seg" role="group" aria-label="Metrik" id="metric">
          <button type="button" data-m="cost" aria-pressed="${view.metric === 'cost'}">Biaya</button>
          <button type="button" data-m="tokens" aria-pressed="${view.metric === 'tokens'}">Token</button>
          <button type="button" data-m="requests" aria-pressed="${view.metric === 'requests'}">Request</button>
        </div>
      </div>
      <div class="chart-wrap" id="chart"></div>
    </section>

    <div class="section" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:16px">
      ${breakdown('Model paling mahal', br.models, (r) => `<span class="row-title mono" style="font-size:14px">${esc(r.name)}</span>`)}
      ${breakdown('Per provider', br.providers, (r) => `<span class="row-main">${logo(r.name, r.name)}<span class="row-title">${esc(r.name)}</span></span>`)}
      ${br.provider_keys?.length > 1 ? breakdown('Per akun provider', br.provider_keys, (r) => `<span class="row-main">${logo(r.name.split(' · ')[0], r.name)}<span class="row-title">${esc(r.name.split(' · ')[1] || r.name)}</span></span>`) : ''}
    </div>

    <section class="section card card-pad" aria-labelledby="qs-h">
      <div class="section-head"><h2 id="qs-h">Pakai dari aplikasi</h2></div>
      <p class="muted" style="margin:0 0 12px;font-size:15px">Satu base URL untuk semua provider. Format OpenAI, jadi SDK apa pun bisa dipakai.</p>
      <div class="code-wrap">
        <pre class="code">from openai import OpenAI

client = OpenAI(base_url="${esc(GATEWAY)}", api_key="sk-gw-...")
client.chat.completions.create(
    model="meta/muse-ember-1.0",
    messages=[{"role": "user", "content": "Halo"}],
)</pre>
        <button type="button" class="btn btn-sm" data-copy="${esc(GATEWAY)}" aria-label="Salin base URL">${icon('copy', 'i-sm')}Base URL</button>
      </div>
    </section>`;

  const series = daily.map((d) => ({ ...d, tokens: (d.prompt_tokens || 0) + (d.completion_tokens || 0) }));
  const draw = () => { const host = $('#chart'); if (host) drawChart(host, series, view.metric); };
  draw();
  let lastW = innerWidth;
  onresize = () => { if (innerWidth !== lastW) { lastW = innerWidth; draw(); } };

  $('#metric').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    view.metric = b.dataset.m;
    $$('#metric button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    draw();
  };
  $('#range').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    view.days = Number(b.dataset.d);
    sessionStorage.setItem('days', view.days);
    route();
  };
  $('[data-open-catalog]')?.addEventListener('click', () => sessionStorage.setItem('open-catalog', '1'));
}

function breakdown(title, rows, nameCell) {
  const total = rows.reduce((s, r) => s + (r.cost || 0), 0);
  const body = rows.length
    ? rows
        .slice(0, 6)
        .map(
          (r) => `<div class="row bd-row">
            <div style="min-width:0">${nameCell(r)}
              <div class="share" aria-hidden="true"><span style="width:${total ? (r.cost / total) * 100 : 0}%"></span></div></div>
            <div class="cols"><div>${fmtUsd(r.cost)}</div><div class="muted">${fmtNum(r.requests)} req · ${fmtShort(r.prompt_tokens + r.completion_tokens)} tok</div></div>
          </div>`
        )
        .join('')
    : `<div class="empty"><p>Belum ada request di rentang ini.</p></div>`;
  return `<section class="card"><div class="group-head"><h2>${esc(title)}</h2></div><div class="list">${body}</div></section>`;
}

// Round the axis top up to 1, 2 or 5 x 10^n so tick labels read cleanly.
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

function drawChart(host, data, metric) {
  const fmt = metric === 'cost' ? (v) => (v === 0 ? '$0' : '$' + (v < 10 ? v.toFixed(2) : Math.round(v))) : fmtShort;
  // Drawn at the container's real pixel width so labels never scale.
  const W = Math.max(280, host.clientWidth - (isPhone() ? 24 : 40));
  const H = isPhone() ? 200 : 240;
  const L = 44, B = 24, T = 8;
  const max = niceMax(Math.max(...data.map((d) => d[metric] || 0), 0));
  const bw = (W - L) / data.length;
  const ih = H - T - B;
  let s = `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafik ${metric} per hari">`;
  for (let i = 0; i <= 2; i++) {
    const y = T + (ih * i) / 2;
    s += `<line class="grid-line" x1="${L}" x2="${W}" y1="${y}" y2="${y}"/>`;
    s += `<text class="axis" x="${L - 8}" y="${y + 4}" text-anchor="end">${esc(fmt(max * (1 - i / 2)))}</text>`;
  }
  const every = Math.ceil(data.length / Math.max(3, Math.floor(W / 110)));
  data.forEach((d, i) => {
    const v = d[metric] || 0;
    const h = (ih * v) / max;
    const x = L + i * bw + bw * 0.18;
    s += `<rect class="bar" data-i="${i}" x="${x}" y="${T + ih - h}" width="${bw * 0.64}" height="${Math.max(h, v ? 1.5 : 0)}" rx="2"/>`;
    s += `<rect class="bar-hit" data-i="${i}" x="${L + i * bw}" y="${T}" width="${bw}" height="${ih}"/>`;
    if (i % every === 0) {
      const [, m, dd] = d.day.split('-');
      s += `<text class="axis" x="${x + bw * 0.32}" y="${H - 6}" text-anchor="middle">${Number(dd)}/${Number(m)}</text>`;
    }
  });
  host.innerHTML = s + '</svg><div class="chart-tip" aria-hidden="true"></div>';

  // Pointer scrub: works for mouse and finger (touch-action pan-y keeps vertical scroll).
  const svg = host.querySelector('svg');
  const tip = host.querySelector('.chart-tip');
  const bars = $$('.bar', svg);
  const show = (e) => {
    const r = svg.getBoundingClientRect();
    const xVb = e.clientX - r.left;
    const i = Math.max(0, Math.min(data.length - 1, Math.floor((xVb - L) / bw)));
    if (xVb < L) return hide();
    const d = data[i];
    bars.forEach((b, j) => b.classList.toggle('dim', j !== i));
    const date = new Date(d.day + 'T00:00:00').toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' });
    tip.textContent = `${date} · ${fmt(d[metric] || 0)}`;
    const left = L + i * bw + bw / 2 + (r.left - host.getBoundingClientRect().left);
    tip.style.left = Math.max(70, Math.min(host.clientWidth - 70, left)) + 'px';
    tip.classList.add('show');
  };
  const hide = () => { bars.forEach((b) => b.classList.remove('dim')); tip.classList.remove('show'); };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('pointercancel', hide);
}

// ==========================================================
// Model
// ==========================================================
async function models() {
  const [list, provs, cat] = await Promise.all([api('/models'), api('/providers'), api('/catalog')]);
  const groups = new Map();
  for (const m of list) {
    if (!groups.has(m.provider_slug)) groups.set(m.provider_slug, { name: m.provider_name, rows: [] });
    groups.get(m.provider_slug).rows.push(m);
  }

  page.innerHTML = `
    ${head('Model', 'Model ID yang dipakai aplikasi, dipetakan ke model asli di provider. Harga dalam USD per 1 juta token.', `
      <button type="button" class="btn" id="add-model" ${provs.length ? '' : 'disabled'}>${icon('plus', 'i-sm')}Model manual</button>
      <button type="button" class="btn btn-primary" id="open-catalog">${icon('package-plus', 'i-sm')}Katalog</button>`)}
    ${
      groups.size
        ? [...groups.entries()]
            .map(
              ([slug, g]) => `
        <section class="card" style="margin-bottom:16px" aria-label="${esc(g.name)}">
          <div class="group-head">${logo(slug, g.name)}<h2>${esc(g.name)}</h2><span class="badge">${g.rows.length} model</span></div>
          <div class="list">
            <div class="row model-row model-head" aria-hidden="true">
              <span>Model</span><span class="cols wide">Input</span><span class="cols wide">Cached</span><span class="cols wide">Output</span><span class="cols">Biaya</span><span></span>
            </div>
            ${g.rows.map(modelRow).join('')}
          </div>
        </section>`
            )
            .join('')
        : `<div class="card empty">${icon('boxes')}<p>Belum ada model. Buka katalog untuk memasang model Meta dan River beserta harganya.</p>
           <button type="button" class="btn btn-primary" id="empty-catalog">${icon('package-plus', 'i-sm')}Buka katalog</button></div>`
    }`;

  $('#open-catalog').onclick = () => catalogSheet(cat);
  $('#empty-catalog')?.addEventListener('click', () => catalogSheet(cat));
  $('#add-model').onclick = () => modelForm(null, provs, list);

  page.onchange = async (e) => {
    const sw = e.target.closest('[data-toggle-model]');
    if (!sw) return;
    try {
      await api('/models/' + encodeURIComponent(sw.dataset.toggleModel), { method: 'PUT', body: { enabled: sw.checked } });
      toast(sw.checked ? 'Model aktif' : 'Model dinonaktifkan');
    } catch (err) {
      sw.checked = !sw.checked;
      toast(err.message, 'err');
    }
  };
  page.onclick = (e) => {
    if (e.target.closest('.switch, .copy')) return;
    const row = e.target.closest('[data-model]');
    if (row) modelDetail(list.find((m) => m.id === row.dataset.model), provs, list);
  };
  page.onkeydown = (e) => {
    const row = e.target.closest('[data-model]');
    if (row && (e.key === 'Enter' || e.key === ' ') && e.target === row) {
      e.preventDefault();
      row.click();
    }
  };

  if (sessionStorage.getItem('open-catalog')) {
    sessionStorage.removeItem('open-catalog');
    catalogSheet(cat);
  }
}

const KIND = {
  text: { label: 'Teks', badge: '' },
  image: { label: 'Gambar', badge: 'badge-accent' },
  transcribe: { label: 'Suara ke teks', badge: 'badge-accent' },
  segment: { label: 'Segmentasi', badge: 'badge-accent' },
};
const kindOf = (m) => m.kind || 'text';
const usd = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });

// Harga per unit untuk model non-teks, ditulis dengan satuan yang dipakai provider.
function unitPrice(m) {
  const k = kindOf(m);
  if (k === 'image') return `${usd(m.price_image)} / gambar`;
  if (k === 'transcribe') return `${usd(m.price_audio_hour)} / jam audio`;
  if (k === 'segment') return `${usd(m.price_image * 1000)} / 1K gambar · ${usd(m.price_frame * 1000)} / 1K frame`;
  return '';
}

// Unit yang dipakai satu request (untuk log).
function usageUnits(r) {
  const parts = [];
  if (r.images) parts.push(`${fmtNum(r.images)} gambar`);
  if (r.frames) parts.push(`${fmtNum(r.frames)} frame`);
  if (r.audio_ms) parts.push(`${fmtNum(Math.floor(r.audio_ms / 1000))} dtk audio`);
  if (r.searches) parts.push(`${fmtNum(r.searches)} search`);
  if (!parts.length || r.prompt_tokens || r.completion_tokens) parts.unshift(`${fmtShort(r.prompt_tokens)} → ${fmtShort(r.completion_tokens)}`);
  return parts.join(' · ');
}

function modelRow(m) {
  return `<div class="row model-row row-link" data-model="${esc(m.id)}" tabindex="0" role="button" aria-label="Detail ${esc(m.display_name || m.id)}">
    <div class="row-text">
      <div class="row-title">${esc(m.display_name || m.upstream_model)}
        ${kindOf(m) !== 'text' ? `<span class="badge ${KIND[kindOf(m)].badge}" style="margin-left:6px">${KIND[kindOf(m)].label}</span>` : ''}
        ${m.long_threshold ? '<span class="badge badge-warn" style="margin-left:6px">2 tier</span>' : ''}
        ${!m.enabled ? '<span class="badge" style="margin-left:6px">nonaktif</span>' : ''}</div>
      ${copyChip(m.id)}
    </div>
    ${kindOf(m) === 'text'
      ? `<span class="cols wide">${fmtPrice(m.input_price)}</span>
    <span class="cols wide">${fmtPrice(m.cached_price ?? m.input_price)}</span>
    <span class="cols wide">${fmtPrice(m.output_price)}</span>`
      : `<span class="cols wide" style="grid-column:span 3">${esc(unitPrice(m))}</span>`}
    <span class="cols"><div>${fmtUsd(m.total_cost)}</div><div class="muted">${fmtNum(m.total_requests)} req</div></span>
    <label class="switch" aria-label="Aktifkan ${esc(m.id)}"><input type="checkbox" data-toggle-model="${esc(m.id)}" ${m.enabled ? 'checked' : ''} /><span></span></label>
  </div>`;
}

function modelDetail(m, provs, all) {
  const tier = m.long_threshold
    ? `<div class="label" style="margin:0 0 8px">Input di atas ${fmtNum(m.long_threshold)} token (seluruh request)</div>
       <div class="detail-grid">
         <div><span class="label">Input</span><b>${fmtPrice(m.input_price_long)}</b></div>
         <div><span class="label">Cached</span><b>${fmtPrice(m.cached_price_long)}</b></div>
         <div><span class="label">Output</span><b>${fmtPrice(m.output_price_long)}</b></div>
       </div>`
    : '';
  openSheet({
    title: m.display_name || m.id,
    leading: logo(m.provider_slug, m.provider_name),
    wide: true,
    body: `
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px">
        <span class="label">Model ID untuk aplikasi</span>${copyChip(m.id)}
        <span class="label" style="margin-top:6px">Model di ${esc(m.provider_name)}</span><span class="mono" style="font-size:14px">${esc(m.upstream_model)}</span>
      </div>
      ${kindOf(m) === 'text' ? `
      <div class="label" style="margin:0 0 8px">Harga per 1 juta token${m.long_threshold ? ` (input sampai ${fmtNum(m.long_threshold)} token)` : ''}</div>
      <div class="detail-grid">
        <div><span class="label">Input</span><b>${fmtPrice(m.input_price)}</b></div>
        <div><span class="label">Cached</span><b>${fmtPrice(m.cached_price ?? m.input_price)}</b></div>
        <div><span class="label">Output</span><b>${fmtPrice(m.output_price)}</b></div>
      </div>
      ${tier}
      <div class="detail-grid">
        <div><span class="label">Konteks</span><b>${fmtCtx(m.context_window)}</b></div>
        <div><span class="label">Output maks</span><b>${fmtCtx(m.max_output)}</b></div>
        <div><span class="label">Web search</span><b>${m.price_search ? usd(m.price_search * 1000) + '<span class="label"> /1K</span>' : '–'}</b></div>
      </div>
      <div class="detail-grid" style="grid-template-columns:1fr 1fr">
        <div><span class="label">Biaya total</span><b>${fmtUsd(m.total_cost)}</b></div>
        <div><span class="label">Request</span><b>${fmtNum(m.total_requests)}</b></div>
      </div>` : `
      <div class="label" style="margin:0 0 8px">Harga · ${KIND[kindOf(m)].label}</div>
      <div class="detail-grid">
        ${kindOf(m) === 'image' ? `<div><span class="label">Per gambar</span><b>${usd(m.price_image)}</b></div>` : ''}
        ${kindOf(m) === 'transcribe' ? `<div><span class="label">Per jam audio</span><b>${usd(m.price_audio_hour)}</b></div><div><span class="label">Per menit</span><b>${usd(m.price_audio_hour / 60)}</b></div>` : ''}
        ${kindOf(m) === 'segment' ? `<div><span class="label">Per 1K gambar</span><b>${usd(m.price_image * 1000)}</b></div><div><span class="label">Per 1K frame</span><b>${usd(m.price_frame * 1000)}</b></div><div><span class="label">Min. frame/video</span><b>${fmtNum(m.min_frames)}</b></div>` : ''}
        <div><span class="label">Biaya total</span><b>${fmtUsd(m.total_cost)}</b></div>
        <div><span class="label">Request</span><b>${fmtNum(m.total_requests)}</b></div>
      </div>`}
      ${m.reasoning ? `<div class="label" style="margin-bottom:4px">reasoning_effort</div><p class="note">${esc(m.reasoning)}</p>` : ''}
      ${m.notes ? `<p class="note">${esc(m.notes)}</p>` : ''}
      ${m.fallback_model ? `<p class="note">Kalau error, pindah ke <span class="mono">${esc(m.fallback_model)}</span>.</p>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn" id="md-edit">${icon('pencil', 'i-sm')}Ubah</button>
        <button type="button" class="btn btn-danger" id="md-del">${icon('trash-2', 'i-sm')}Hapus</button>
      </div>`,
    onOpen: ({ el }) => {
      $('#md-edit', el).onclick = () => modelForm(m, provs, all);
      $('#md-del', el).onclick = async () => {
        if (!(await confirmSheet({ title: 'Hapus model?', message: `${m.id} tidak bisa dipanggil lagi sampai dipasang ulang. Log lama tetap tersimpan.` }))) return;
        await api('/models/' + encodeURIComponent(m.id), { method: 'DELETE' });
        toast('Model dihapus');
        route();
      };
    },
  });
}

function modelForm(m, provs, all) {
  const edit = !!m;
  const v = (k) => esc(m?.[k] ?? '');
  openSheet({
    title: edit ? 'Ubah model' : 'Tambah model manual',
    wide: true,
    submitLabel: edit ? 'Simpan model' : 'Tambah model',
    body: `
      <div class="fields-2">
        <label class="field"><span>Provider</span>
          <select class="input" name="provider_id">${provs.map((p) => `<option value="${p.id}" ${m?.provider_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Nama di provider</span>
          <input class="input" name="upstream_model" required value="${v('upstream_model')}" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="muse-ember-1.0" /></label>
      </div>
      <div class="fields-2">
        <label class="field"><span>Model ID untuk aplikasi</span>
          <input class="input" name="id" value="${v('id')}" ${edit ? 'readonly' : ''} autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="otomatis: slug/nama" /></label>
        <label class="field"><span>Nama tampilan</span><input class="input" name="display_name" value="${v('display_name')}" /></label>
      </div>
      <label class="field"><span>Jenis</span>
        <select class="input" name="kind">${Object.entries(KIND).map(([k, x]) => `<option value="${k}" ${kindOf(m || {}) === k ? 'selected' : ''}>${x.label}</option>`).join('')}</select></label>
      <fieldset><legend>Harga per unit (USD, untuk model non-teks dan web search)</legend>
        <div class="fields-3">
          <label class="field"><span>Per gambar</span><input class="input" name="price_image" inputmode="decimal" value="${v('price_image')}" /></label>
          <label class="field"><span>Per frame video</span><input class="input" name="price_frame" inputmode="decimal" value="${v('price_frame')}" /></label>
          <label class="field"><span>Min. frame</span><input class="input" name="min_frames" inputmode="numeric" value="${v('min_frames')}" /></label>
          <label class="field"><span>Per jam audio</span><input class="input" name="price_audio_hour" inputmode="decimal" value="${v('price_audio_hour')}" /></label>
          <label class="field"><span>Per web search</span><input class="input" name="price_search" inputmode="decimal" value="${v('price_search')}" /></label>
        </div>
      </fieldset>
      <fieldset><legend>Harga per 1 juta token (USD)</legend>
        <div class="fields-3">
          <label class="field"><span>Input</span><input class="input" name="input_price" inputmode="decimal" value="${m?.input_price ?? 0}" /></label>
          <label class="field"><span>Cached</span><input class="input" name="cached_price" inputmode="decimal" value="${v('cached_price')}" placeholder="= input" /></label>
          <label class="field"><span>Output</span><input class="input" name="output_price" inputmode="decimal" value="${m?.output_price ?? 0}" /></label>
        </div>
      </fieldset>
      <fieldset><legend>Tier konteks panjang (opsional)</legend>
        <div class="fields-2">
          <label class="field"><span>Mulai dari input (token)</span><input class="input" name="long_threshold" inputmode="numeric" value="${v('long_threshold')}" placeholder="200000" /></label>
          <label class="field"><span>Input</span><input class="input" name="input_price_long" inputmode="decimal" value="${v('input_price_long')}" /></label>
          <label class="field"><span>Cached</span><input class="input" name="cached_price_long" inputmode="decimal" value="${v('cached_price_long')}" /></label>
          <label class="field"><span>Output</span><input class="input" name="output_price_long" inputmode="decimal" value="${v('output_price_long')}" /></label>
        </div>
      </fieldset>
      <div class="fields-2">
        <label class="field"><span>Konteks (token)</span><input class="input" name="context_window" inputmode="numeric" value="${v('context_window')}" /></label>
        <label class="field"><span>Output maks (token)</span><input class="input" name="max_output" inputmode="numeric" value="${v('max_output')}" /></label>
      </div>
      <label class="field"><span>Kalau error 429, 5xx atau timeout, pindah ke</span>
        <select class="input" name="fallback_model"><option value="">Jangan pindah</option>
          ${all.filter((x) => x.id !== m?.id).map((x) => `<option ${m?.fallback_model === x.id ? 'selected' : ''}>${esc(x.id)}</option>`).join('')}</select></label>
      <label class="field"><span>Catatan reasoning</span><input class="input" name="reasoning" value="${v('reasoning')}" /></label>
      <label class="field"><span>Catatan</span><textarea class="input" name="notes">${v('notes')}</textarea></label>`,
    onSubmit: async (form) => {
      const d = formData(form);
      const prov = provs.find((p) => p.id === Number(d.provider_id));
      const body = { ...d, provider_id: Number(d.provider_id), fallback_model: d.fallback_model || null };
      if (edit) {
        delete body.id;
        await api('/models/' + encodeURIComponent(m.id), { method: 'PUT', body });
      } else {
        body.id = d.id.trim() || `${prov.slug}/${d.upstream_model.trim().replace(/\//g, '-')}`;
        body.enabled = true;
        await api('/models', { method: 'POST', body });
      }
      toast('Model disimpan');
      route();
    },
  });
}

function catalogSheet(cat) {
  openSheet({
    title: 'Katalog model',
    wide: true,
    body: `<p class="note">Pasang provider dan semua modelnya sekaligus. Harga Meta dari halaman pricing resminya; harga River diambil live dari API harga River saat kamu klik pasang. Memasang ulang hanya memperbarui harga dan detail.</p>
      ${cat
        .map(
          (p) => `<section class="card card-pad" style="margin-bottom:12px" data-cat="${esc(p.slug)}">
          <div class="prov-top">${logo(p.slug, p.name, 'logo-lg')}
            <div style="flex:1;min-width:0"><h2>${esc(p.name)}</h2><span class="mono muted" style="font-size:13px">${esc(p.base_url)}</span></div>
            <a class="btn btn-quiet btn-icon btn-sm" href="${esc(p.docs)}" target="_blank" rel="noopener" aria-label="Dokumentasi ${esc(p.name)}">${icon('external-link', 'i-sm')}</a>
          </div>
          <div style="margin-top:12px">
            ${p.models
              .map(
                (m) => `<div class="cat-model"><div style="min-width:0"><div class="row-title">${esc(m.display_name)}</div>
                  <span class="mono muted" style="font-size:13px">${esc(m.id)}</span></div>
                  <div class="cols"><div>${(m.kind || 'text') === 'text' ? `${fmtPrice(m.input)} / ${fmtPrice(m.output)}` : esc(unitPrice({ ...m, price_image: m.price_image, price_frame: m.price_frame, price_audio_hour: m.price_audio_hour }))}</div><div class="muted">${m.installed ? 'terpasang' : (m.kind || 'text') !== 'text' ? KIND[m.kind].label : fmtCtx(m.context_window) + ' konteks'}</div></div></div>`
              )
              .join('')}
          </div>
          ${
            p.oauth
              ? `<p class="hint" style="margin:12px 0 0">Langganan OAuth — hubungkan akun di halaman Provider setelah dipasang. Biaya dibebankan ke kuota langganan ($0).</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
            <button type="button" class="btn btn-primary" data-install="${esc(p.slug)}">${p.provider_installed ? icon('refresh-cw', 'i-sm') + 'Perbarui model' : icon('package-plus', 'i-sm') + 'Pasang ' + p.models.length + ' model'}</button>
          </div>`
              : `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
            <input class="input" style="flex:1;min-width:200px" type="password" name="key-${esc(p.slug)}" autocomplete="off" placeholder="${p.provider_has_key ? p.key_count + ' key tersimpan. Isi untuk menambah key.' : 'API key ' + esc(p.name)}" aria-label="API key ${esc(p.name)}" />
            <button type="button" class="btn btn-primary" data-install="${esc(p.slug)}">${p.provider_installed ? icon('refresh-cw', 'i-sm') + 'Perbarui harga' : icon('package-plus', 'i-sm') + 'Pasang ' + p.models.length + ' model'}</button>
          </div>`
          }
        </section>`
        )
        .join('')}`,
    onOpen: ({ el, close }) => {
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-install]');
        if (!b) return;
        const slug = b.dataset.install;
        const keyInput = el.querySelector(`[name="key-${slug}"]`);
        const key = keyInput ? keyInput.value.trim() : '';
        b.disabled = true;
        const label = b.innerHTML;
        b.textContent = 'Memasang…';
        try {
          const r = await api(`/catalog/${slug}/install`, { method: 'POST', body: key ? { api_key: key } : {} });
          toast(`${r.added} model baru, ${r.updated} diperbarui (${r.price_source})`);
          close();
          if (r.oauth) {
            route();
            return connectAccount(slug, r.auth_type, r.provider_id);
          }
          if (!r.has_key) toast('Model terpasang. Isi API key dulu supaya bisa dipanggil.', 'err');
          route();
        } catch (err) {
          toast(err.message, 'err');
          b.disabled = false;
          b.innerHTML = label;
        }
      });
    },
  });
}

// ==========================================================
// Chat / benchmark
// ==========================================================
const EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const CHAT_SETTINGS_KEY = 'chat-settings-v2';
const CHAT_CONVOS_KEY = 'chat-convos-v1';
const MAX_COMPARE = 4;
const chatState = {
  models: [],
  system: '',
  maxTokens: 4096,
  effort: 'default',
  temperature: '',
  activeId: null,
};
let chatAbort = null;
let chatBusy = false;
try {
  const s = JSON.parse(localStorage.getItem(CHAT_SETTINGS_KEY) || '{}');
  if (!Array.isArray(s.models)) s.models = s.model ? [s.model] : [];
  delete s.model;
  delete s.bench;
  delete s.tab;
  Object.assign(chatState, s);
} catch {
  /* abaikan state rusak */
}
const saveChat = () => localStorage.setItem(CHAT_SETTINGS_KEY, JSON.stringify(chatState));

// Percakapan disimpan di browser ini saja (localStorage), maksimal 50 terbaru.
// Bentuk: { id, title, models, turns: [{ user, replies: [{ model, content, reasoning, metrics, error, stopped }] }], updated }
let convos = [];
try {
  convos = JSON.parse(localStorage.getItem(CHAT_CONVOS_KEY) || '[]').map(migrateConvo);
} catch {
  convos = [];
}
// Format lama menyimpan daftar pesan datar; ubah ke giliran (turn) dengan satu atau lebih jawaban.
function migrateConvo(c) {
  if (Array.isArray(c.turns)) return c;
  const turns = [];
  for (const m of c.messages || []) {
    if (m.role === 'user') turns.push({ user: m.content, replies: [] });
    else if (m.role === 'assistant' && turns.length) {
      const { role, pending, ...r } = m;
      turns.at(-1).replies.push(r);
    }
  }
  return { id: c.id, title: c.title, models: c.models || (c.model ? [c.model] : []), turns, updated: c.updated };
}
function saveConvos() {
  convos.sort((a, b) => b.updated - a.updated);
  convos = convos.slice(0, 50);
  try {
    localStorage.setItem(CHAT_CONVOS_KEY, JSON.stringify(convos, (k, v) => (k === 'pending' ? undefined : v)));
  } catch {
    toast('Penyimpanan browser penuh. Hapus beberapa percakapan.', 'err');
  }
}
const activeConvo = () => convos.find((c) => c.id === chatState.activeId) || null;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

let chatModels = [];
async function loadTextModels() {
  // Tanpa cache: revalidasi latar tidak boleh me-render ulang halaman saat jawaban sedang di-stream.
  const all = await (await fetch('/api/admin/models', { credentials: 'same-origin' })).json();
  if (all.error) throw new Error(all.error);
  chatModels = all.filter((m) => (m.kind || 'text') === 'text' && m.enabled);
  return chatModels;
}
const modelById = (id) => chatModels.find((m) => m.id === id);
const modelName = (id) => modelById(id)?.display_name || id;

async function chat() {
  const models = await loadTextModels();
  chatState.models = chatState.models.filter((id) => modelById(id)).slice(0, MAX_COMPARE);
  if (!chatState.models.length && models.length) chatState.models = [models[0].id];

  page.innerHTML = `<div class="chat-page"><h1 class="sr-only">Chat</h1><div id="chat-body" class="chat-body"></div></div>`;
  if (!models.length) {
    $('#chat-body').innerHTML = `<div class="card empty">${icon('message-square')}<p>Belum ada model teks. Pasang dulu dari katalog di halaman Model.</p>
      <a class="btn btn-primary" href="#models">${icon('boxes', 'i-sm')}Ke halaman Model</a></div>`;
    return;
  }
  convoView();
}

// ---------- Markdown aman (teks di-escape dulu, baru diberi format) ----------
function mdInline(t) {
  const codes = [];
  t = t.replace(/`([^`\n]+)`/g, (_, c) => `\u0001${codes.push(c) - 1}\u0001`);
  t = t
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return t.replace(/\u0001(\d+)\u0001/g, (_, n) => `<code>${codes[n]}</code>`);
}

function md(src) {
  const blocks = [];
  let s = String(src || '').replace(/```([\w+#.-]*)[^\n]*\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
    blocks.push(`<div class="md-code"><div class="md-code-head"><span>${esc(lang || 'kode')}</span>
      <button type="button" class="md-copy" data-copy-code>${icon('copy', 'i-sm')}Salin</button></div><pre><code>${esc(code.replace(/\n$/, ''))}</code></pre></div>`);
    return `\n\u0000${blocks.length - 1}\u0000\n`;
  });
  s = esc(s);
  const lines = s.split('\n');
  const out = [];
  let para = [];
  let list = null;
  const flushP = () => {
    if (para.length) out.push(`<p>${mdInline(para.join('<br>'))}</p>`);
    para = [];
  };
  const flushL = () => {
    if (list) out.push(`<${list.t}>${list.items.map((i) => `<li>${mdInline(i)}</li>`).join('')}</${list.t}>`);
    list = null;
  };
  const flush = () => (flushP(), flushL());
  const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\u0000(\d+)\u0000$/))) { flush(); out.push(blocks[m[1]]); continue; }
    if (!line.trim()) { flush(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flush(); out.push(`<p class="md-h md-h${Math.min(m[1].length, 3)}">${mdInline(m[2])}</p>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr />'); continue; }
    if (line.trim().startsWith('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flush();
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      i--;
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if ((m = line.match(/^&gt;\s?(.*)$/))) { flush(); out.push(`<blockquote>${mdInline(m[1])}</blockquote>`); continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushP();
      const t = ul ? 'ul' : 'ol';
      if (list && list.t !== t) flushL();
      list ||= { t, items: [] };
      list.items.push((ul || ol)[1]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += '<br>' + line.trim(); continue; }
    flushL();
    para.push(line);
  }
  flush();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, n) => blocks[n]);
}

// ---------- Tampilan percakapan ----------
function convoView() {
  $('#chat-body').innerHTML = `<div class="convo-app">
    <aside class="convo-side" aria-label="Riwayat percakapan">
      <button type="button" class="btn convo-new" data-act="new">${icon('square-pen', 'i-sm')}Chat baru</button>
      <div class="convo-list" id="convo-list"></div>
    </aside>
    <section class="convo-main" aria-label="Percakapan">
      <header class="convo-bar">
        <button type="button" class="btn btn-quiet btn-icon convo-hist" data-act="history" aria-label="Riwayat percakapan">${icon('history')}</button>
        <div class="model-pick" id="model-pick"></div>
        <div class="convo-bar-end">
          <button type="button" class="btn btn-quiet btn-icon" data-act="settings" aria-label="Pengaturan chat">${icon('sliders-horizontal')}</button>
          <button type="button" class="btn btn-quiet btn-icon convo-new-sm" data-act="new" aria-label="Chat baru">${icon('square-pen')}</button>
        </div>
      </header>
      <div class="msgs" id="msgs"></div>
      <form class="composer" id="composer">
        <div class="composer-box">
          <textarea id="prompt" name="prompt" rows="1" placeholder="Kirim pesan…" enterkeyhint="send" aria-label="Pesan"></textarea>
          <button type="submit" class="btn btn-primary btn-icon send-btn" id="send" aria-label="Kirim">${icon('arrow-up')}</button>
        </div>
        <p class="composer-meta" id="composer-meta"></p>
      </form>
    </section>
  </div>`;

  renderModelPick();
  renderConvoList();
  renderMsgs();
  renderComposerMeta();

  $('#chat-body').onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'new') return newConvo();
    if (act === 'settings') return openChatSettings();
    if (act === 'history') return openHistorySheet();
    const open = e.target.closest('[data-open]');
    if (open) return selectConvo(open.dataset.open);
    const del = e.target.closest('[data-del]');
    if (del) return deleteConvo(del.dataset.del);
    const sug = e.target.closest('[data-suggest]');
    if (sug) return sendMessage(sug.dataset.suggest);
    const copyCode = e.target.closest('[data-copy-code]');
    if (copyCode) return copyText(copyCode.closest('.md-code').querySelector('code').textContent);
    const copyMsg = e.target.closest('[data-copy-reply]');
    if (copyMsg) return copyText(replyAt(copyMsg.dataset.copyReply)?.content || '');
    const info = e.target.closest('[data-info]');
    if (info) return toggleInfo(info);
    if (e.target.closest('[data-retry]')) return retryLast();
  };
  // Menandai details "berpikir" yang dibuka/tutup sendiri oleh pengguna, supaya tidak ditutup otomatis.
  $('#msgs').addEventListener('click', (e) => {
    const s = e.target.closest('.msg-think summary');
    if (s) s.parentElement.dataset.touched = '1';
  });

  const ta = $('#prompt');
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  };
  ta.oninput = autosize;
  ta.onkeydown = (e) => {
    // Desktop: Enter kirim, Shift+Enter baris baru. Layar sentuh: Enter = baris baru (tombol kirim terpisah).
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  };
  $('#composer').onsubmit = (e) => {
    e.preventDefault();
    if (chatBusy) return chatAbort?.abort();
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    autosize();
    sendMessage(text);
  };
  setBusy(chatBusy);
  if (!isPhone()) ta.focus({ preventScroll: true });
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast('Disalin');
  } catch {
    toast('Gagal menyalin', 'err');
  }
}

function setBusy(on) {
  chatBusy = on;
  const btn = $('#send');
  if (!btn) return;
  btn.innerHTML = on ? icon('square') : icon('arrow-up');
  btn.setAttribute('aria-label', on ? 'Hentikan' : 'Kirim');
  btn.classList.toggle('is-stop', on);
}

// ---------- Pemilih model (satu model, atau bandingkan sampai 4) ----------
function renderModelPick() {
  const ids = chatState.models;
  const first = modelById(ids[0]);
  const logos = ids
    .slice(0, 3)
    .map((id) => {
      const m = modelById(id);
      return m ? logo(m.provider_slug, m.provider_name) : '';
    })
    .join('');
  const wrap = $('#model-pick');
  wrap.innerHTML = `<button type="button" class="pick-btn" id="pick-btn" aria-haspopup="listbox" aria-expanded="false">
      <span class="pick-logos">${logos}</span>
      <span class="pick-name">${esc(ids.length > 1 ? `Bandingkan ${ids.length} model` : first?.display_name || first?.id || 'Pilih model')}</span>${icon('chevron-down', 'i-sm')}
    </button>`;
  $('#pick-btn').onclick = () => (wrap.querySelector('.pick-pop') ? closeModelPop() : openModelPop());
}

function modelRowsHtml(q) {
  const ql = q.trim().toLowerCase();
  const groups = new Map();
  for (const m of chatModels) {
    if (ql && !`${m.id} ${m.display_name || ''} ${m.provider_name || ''}`.toLowerCase().includes(ql)) continue;
    if (!groups.has(m.provider_slug)) groups.set(m.provider_slug, { name: m.provider_name, items: [] });
    groups.get(m.provider_slug).items.push(m);
  }
  if (!groups.size) return '<p class="pick-empty">Tidak ada model yang cocok.</p>';
  const full = chatState.models.length >= MAX_COMPARE;
  return [...groups.entries()]
    .map(
      ([slug, g]) => `<div class="pick-group" role="group" aria-label="${esc(g.name)}">
        <div class="pick-group-head">${logo(slug, g.name)}${esc(g.name)}</div>
        ${g.items
          .map((m) => {
            const on = chatState.models.includes(m.id);
            const only = on && chatState.models.length === 1;
            return `<div class="pick-row">
              <button type="button" class="pick-item" role="option" data-pick="${esc(m.id)}" aria-selected="${on}">
                <span class="pick-item-text"><b>${esc(m.display_name || m.id)}</b><span class="mono">${esc(m.id)}</span></span>
                <span class="pick-item-ctx">${m.context_window ? fmtCtx(m.context_window) : ''}</span>
              </button>
              <button type="button" class="pick-add" data-add="${esc(m.id)}" aria-pressed="${on}"
                aria-label="${on ? 'Keluarkan' : 'Tambahkan'} ${esc(m.display_name || m.id)} ${on ? 'dari' : 'ke'} perbandingan"
                ${(!on && full) || only ? 'disabled' : ''}>${icon(on ? 'check' : 'plus', 'i-sm')}</button>
            </div>`;
          })
          .join('')}
      </div>`
    )
    .join('');
}

function openModelPop() {
  const wrap = $('#model-pick');
  const pop = document.createElement('div');
  pop.className = 'pick-pop';
  pop.innerHTML = `<div class="pick-search">${icon('search', 'i-sm')}<input type="search" placeholder="Cari model…" aria-label="Cari model" autocomplete="off" /></div>
    <div class="pick-list" role="listbox" aria-label="Model" aria-multiselectable="true">${modelRowsHtml('')}</div>
    <p class="pick-hint">Klik nama untuk memakai satu model. Tombol ${icon('plus', 'i-xs')} membandingkan sampai ${MAX_COMPARE} model sekaligus.</p>`;
  wrap.append(pop);
  $('#pick-btn').setAttribute('aria-expanded', 'true');
  const input = pop.querySelector('input');
  const list = pop.querySelector('.pick-list');
  if (!isPhone()) input.focus();
  const refresh = () => {
    const top = list.scrollTop;
    list.innerHTML = modelRowsHtml(input.value);
    list.scrollTop = top;
  };
  input.oninput = refresh;
  list.onclick = (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      const id = add.dataset.add;
      if (chatState.models.includes(id)) chatState.models = chatState.models.filter((x) => x !== id);
      else if (chatState.models.length < MAX_COMPARE) chatState.models.push(id);
      saveChat();
      refresh();
      renderModelPick();
      $('#pick-btn').setAttribute('aria-expanded', 'true');
      renderComposerMeta();
      if (!activeConvo()) renderMsgs();
      return;
    }
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    chatState.models = [b.dataset.pick];
    saveChat();
    closeModelPop();
    renderModelPick();
    renderComposerMeta();
    if (!activeConvo()) renderMsgs();
    $('#prompt')?.focus({ preventScroll: true });
  };
  pop.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  setTimeout(() => {
    document.addEventListener('pointerdown', outsidePop, true);
    document.addEventListener('keydown', escPop, true);
  });
}
function outsidePop(e) {
  if (!e.target.closest('#model-pick')) closeModelPop();
}
function escPop(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeModelPop();
    $('#pick-btn')?.focus();
  }
}
function closeModelPop() {
  document.removeEventListener('pointerdown', outsidePop, true);
  document.removeEventListener('keydown', escPop, true);
  $('.pick-pop')?.remove();
  $('#pick-btn')?.setAttribute('aria-expanded', 'false');
}

function renderComposerMeta() {
  const el = $('#composer-meta');
  if (!el) return;
  const bits = [];
  if (chatState.models.length > 1) bits.push(`${chatState.models.length} model berdampingan`);
  if (chatState.effort !== 'default') bits.push(`reasoning ${chatState.effort}`);
  bits.push(`maks ${fmtShort(chatState.maxTokens)} token`);
  if (chatState.temperature !== '') bits.push(`temp ${chatState.temperature}`);
  if (chatState.system.trim()) bits.push('system prompt aktif');
  el.textContent = bits.join(' · ') + ' · biaya tercatat di Log';
}

// ---------- Riwayat ----------
function convoListHtml() {
  if (!convos.length) return '<p class="convo-empty">Belum ada percakapan.</p>';
  return convos
    .map(
      (c) => `<div class="convo-item" aria-current="${c.id === chatState.activeId}">
        <button type="button" class="convo-open" data-open="${esc(c.id)}" data-close><b>${esc(c.title || 'Percakapan')}</b><span>${fmtAgo(c.updated)}</span></button>
        <button type="button" class="btn btn-quiet btn-icon btn-sm convo-del" data-del="${esc(c.id)}" aria-label="Hapus ${esc(c.title || 'percakapan')}">${icon('trash-2', 'i-sm')}</button>
      </div>`
    )
    .join('');
}
function renderConvoList() {
  const el = $('#convo-list');
  if (el) el.innerHTML = convoListHtml();
}

function openHistorySheet() {
  openSheet({
    title: 'Riwayat percakapan',
    body: `<button type="button" class="btn btn-primary" data-act-new data-close style="width:100%;margin-bottom:12px">${icon('square-pen', 'i-sm')}Chat baru</button>
      <div class="convo-list convo-list-sheet">${convoListHtml()}</div>`,
    onOpen: ({ el }) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-act-new]')) return newConvo();
        const open = e.target.closest('[data-open]');
        if (open) return selectConvo(open.dataset.open);
        const del = e.target.closest('[data-del]');
        if (del) {
          deleteConvo(del.dataset.del);
          $('.convo-list-sheet', el).innerHTML = convoListHtml();
        }
      });
    },
  });
}

function newConvo() {
  if (chatBusy) chatAbort?.abort();
  chatState.activeId = null;
  saveChat();
  renderConvoList();
  renderMsgs();
  $('#prompt')?.focus({ preventScroll: true });
}
function selectConvo(id) {
  if (chatBusy) chatAbort?.abort();
  chatState.activeId = id;
  const ids = (activeConvo()?.models || []).filter((x) => modelById(x));
  if (ids.length) {
    chatState.models = ids.slice(0, MAX_COMPARE);
    renderModelPick();
    renderComposerMeta();
  }
  saveChat();
  renderConvoList();
  renderMsgs();
}
function deleteConvo(id) {
  if (id === chatState.activeId && chatBusy) chatAbort?.abort();
  convos = convos.filter((c) => c.id !== id);
  if (chatState.activeId === id) chatState.activeId = null;
  saveConvos();
  saveChat();
  renderConvoList();
  renderMsgs();
  toast('Percakapan dihapus');
}

// ---------- Render pesan ----------
const SUGGESTIONS = [
  'Jelaskan perbedaan TCP dan UDP dengan contoh sehari-hari.',
  'Tulis fungsi JavaScript untuk debounce, lengkap dengan komentar.',
  'Ringkas konsep reasoning effort pada model AI dalam 5 poin.',
  'Buat rencana belajar Rust 2 minggu untuk developer Node.js.',
];

const replyAt = (key) => {
  const [t, r] = String(key).split(':').map(Number);
  return activeConvo()?.turns[t]?.replies[r] || null;
};

function replyHtml(r, key, { isLastTurn, multi }) {
  const mod = modelById(r.model);
  const thinking = r.pending && !r.content;
  const status = r.pending ? '<span class="badge badge-accent reply-status">streaming…</span>' : '';
  const foot = r.pending
    ? ''
    : `<div class="msg-foot">
        ${r.content ? `<button type="button" class="btn btn-quiet btn-icon btn-sm" data-copy-reply="${key}" aria-label="Salin jawaban">${icon('copy', 'i-sm')}</button>` : ''}
        ${isLastTurn && !multi ? `<button type="button" class="btn btn-quiet btn-icon btn-sm" data-retry aria-label="Buat ulang jawaban">${icon('rotate-ccw', 'i-sm')}</button>` : ''}
        ${r.metrics ? `<span class="info-wrap"><button type="button" class="btn btn-quiet btn-icon btn-sm" data-info="${key}" aria-label="Detail kecepatan dan token" aria-expanded="false">${icon('info', 'i-sm')}</button></span>` : ''}
        ${r.stopped ? '<span class="msg-note">dihentikan</span>' : ''}
      </div>`;
  return `<div class="reply ${multi ? 'reply-card' : ''}" data-r="${key}">
    <div class="msg-ai-head">${mod ? logo(mod.provider_slug, mod.provider_name) : ''}<span>${esc(mod?.display_name || r.model)}</span>${status}</div>
    <details class="msg-think" ${r.reasoning ? '' : 'hidden'} ${thinking ? 'open' : ''}>
      <summary>${icon('sparkles', 'i-sm')}<span class="think-label">${thinking ? 'Sedang berpikir…' : 'Proses berpikir'}</span></summary>
      <div class="msg-think-body">${esc(r.reasoning || '')}</div>
    </details>
    <div class="md ${r.pending ? 'streaming' : ''}" ${r.content || (r.pending && !r.reasoning) ? '' : 'hidden'}>${md(r.content)}</div>
    ${r.error ? `<p class="err-text">${esc(r.error)}</p>` : ''}
    ${foot}
  </div>`;
}

function turnHtml(t, ti, isLastTurn) {
  const multi = t.replies.length > 1;
  return `<div class="turn" data-t="${ti}">
    <div class="msg-user"><div class="bubble">${esc(t.user)}</div></div>
    <div class="replies ${multi ? 'replies-multi' : ''}">${t.replies.map((r, ri) => replyHtml(r, `${ti}:${ri}`, { isLastTurn, multi })).join('')}</div>
    ${multi && isLastTurn && !t.replies.some((r) => r.pending) ? `<div class="turn-foot"><button type="button" class="btn btn-quiet btn-sm" data-retry>${icon('rotate-ccw', 'i-sm')}Buat ulang semua</button></div>` : ''}
  </div>`;
}

function renderMsgs() {
  const box = $('#msgs');
  if (!box) return;
  const c = activeConvo();
  if (!c || !c.turns.length) {
    const names = chatState.models.map((id) => `<b>${esc(modelName(id))}</b>`);
    box.innerHTML = `<div class="chat-empty">
      <h2>Mau tanya apa?</h2>
      <p class="muted">${names.length > 1 ? `${names.join(', ')} menjawab berdampingan, jadi kecepatan dan isinya bisa dibandingkan.` : `Jawaban dari ${names[0] || ''}. Ganti atau tambah model di atas kapan saja.`}</p>
      <div class="suggest">${SUGGESTIONS.map((s) => `<button type="button" class="suggest-item" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    </div>`;
    return;
  }
  const wide = c.turns.some((t) => t.replies.length > 1);
  box.innerHTML = `<div class="msgs-inner ${wide ? 'wide' : ''}">${c.turns.map((t, ti) => turnHtml(t, ti, ti === c.turns.length - 1)).join('')}</div>`;
  box.scrollTop = box.scrollHeight;
}

// Saat streaming hanya isi yang berubah ditulis ulang (bukan seluruh elemen), jadi posisi gulir
// kotak "berpikir" dan status buka/tutupnya tetap. Kotak itu ikut turun selama pengguna ada di bawah.
function patchReply(c, key) {
  const box = $('#msgs');
  const el = box?.querySelector(`[data-r="${key}"]`);
  const r = replyAt(key);
  if (!el || !r || activeConvo() !== c) return;
  const stickMsgs = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  const det = el.querySelector('.msg-think');
  if (r.reasoning) {
    const body = det.querySelector('.msg-think-body');
    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    if (det.hidden) {
      det.hidden = false;
      det.open = !r.content;
    }
    if (body.textContent.length !== r.reasoning.length) body.textContent = r.reasoning;
    if (stick) body.scrollTop = body.scrollHeight;
    det.querySelector('.think-label').textContent = r.content ? 'Proses berpikir' : 'Sedang berpikir…';
    if (r.content && det.open && !det.dataset.touched) det.open = false;
  }
  const mdEl = el.querySelector('.md');
  if (r.content) {
    mdEl.hidden = false;
    mdEl.innerHTML = md(r.content);
  } else if (r.reasoning) mdEl.hidden = true;

  if (stickMsgs) box.scrollTop = box.scrollHeight;
}

// ---------- Info kecepatan & token ----------
function infoHtml(r) {
  const mt = r.metrics || {};
  const row = (k, v) => (v == null || v === '' ? '' : `<div><dt>${k}</dt><dd>${v}</dd></div>`);
  const tok = (n) => (n == null ? null : fmtNum(n));
  return `<dl class="info-list">
    ${row('Model', `<span class="mono">${esc(r.model)}</span>`)}
    ${row('Kecepatan', mt.tps ? `${mt.tps.toFixed(1)} token/dtk` : '–')}
    ${row('TTFT', mt.ttft != null ? fmtMs(mt.ttft) : '–')}
    ${row('Waktu total', mt.latency_ms != null ? fmtMs(mt.latency_ms) : null)}
    ${row('Token input', tok(mt.prompt_tokens))}
    ${row('Token cache', mt.cached_tokens ? tok(mt.cached_tokens) : null)}
    ${row('Token output', tok(mt.completion_tokens))}
    ${row('Token reasoning', mt.reasoning_tokens ? tok(mt.reasoning_tokens) : null)}
    ${row('Biaya', mt.cost != null ? fmtUsd(mt.cost) : null)}
  </dl>
  ${mt.estimated ? '<p class="info-note">Jumlah token diestimasi karena provider tidak mengirim usage.</p>' : ''}`;
}

function closeInfo() {
  document.removeEventListener('pointerdown', outsideInfo, true);
  document.removeEventListener('keydown', escInfo, true);
  $('.info-pop')?.remove();
  $$('[data-info][aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
function outsideInfo(e) {
  if (!e.target.closest('.info-wrap')) closeInfo();
}
function escInfo(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    const b = $('[data-info][aria-expanded="true"]');
    closeInfo();
    b?.focus();
  }
}
function toggleInfo(btn) {
  const wasOpen = btn.getAttribute('aria-expanded') === 'true';
  closeInfo();
  if (wasOpen) return;
  const r = replyAt(btn.dataset.info);
  if (!r) return;
  const pop = document.createElement('div');
  pop.className = 'info-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Detail jawaban');
  pop.innerHTML = infoHtml(r);
  btn.parentElement.append(pop);
  btn.setAttribute('aria-expanded', 'true');
  // Buka ke atas kalau ruang di bawah tombol tidak cukup.
  const box = $('#msgs').getBoundingClientRect();
  const rect = btn.getBoundingClientRect();
  if (rect.bottom + pop.offsetHeight + 8 > box.bottom && rect.top - pop.offsetHeight - 8 > box.top) pop.classList.add('up');
  // Jaga agar tidak keluar dari sisi kanan area pesan.
  const pr = pop.getBoundingClientRect();
  if (pr.right > box.right - 8) pop.style.left = `${Math.min(0, box.right - 8 - pr.right)}px`;
  setTimeout(() => {
    document.addEventListener('pointerdown', outsideInfo, true);
    document.addEventListener('keydown', escInfo, true);
  });
}

// ---------- Kirim & stream ----------
// Riwayat per model: jawaban model itu sendiri di giliran sebelumnya, kalau tidak ada pakai jawaban pertama yang berhasil.
function chatPayload(c, upto, model) {
  const messages = [];
  if (chatState.system.trim()) messages.push({ role: 'system', content: chatState.system });
  for (let i = 0; i < upto; i++) {
    const t = c.turns[i];
    messages.push({ role: 'user', content: t.user });
    const own = t.replies.find((r) => r.model === model && r.content && !r.error);
    const any = own || t.replies.find((r) => r.content && !r.error);
    if (any) messages.push({ role: 'assistant', content: any.content });
  }
  messages.push({ role: 'user', content: c.turns[upto].user });
  const body = { stream: true, messages, max_completion_tokens: chatState.maxTokens };
  if (chatState.effort !== 'default') body.reasoning_effort = chatState.effort;
  if (chatState.temperature !== '' && !Number.isNaN(Number(chatState.temperature))) body.temperature = Number(chatState.temperature);
  return body;
}

async function sendMessage(text) {
  if (chatBusy || !chatState.models.length) return;
  let c = activeConvo();
  if (!c) {
    c = { id: newId(), title: text.replace(/\s+/g, ' ').slice(0, 60), models: [...chatState.models], turns: [], updated: Date.now() };
    convos.unshift(c);
    chatState.activeId = c.id;
    saveChat();
  }
  c.turns.push({ user: text, replies: [] });
  await streamTurn(c);
}

async function retryLast() {
  const c = activeConvo();
  if (!c || chatBusy || !c.turns.length) return;
  c.turns.at(-1).replies = [];
  await streamTurn(c);
}

async function streamTurn(c) {
  closeInfo();
  const ti = c.turns.length - 1;
  const turn = c.turns[ti];
  turn.replies = chatState.models.map((model) => ({ model, content: '', reasoning: '', pending: true }));
  c.models = [...chatState.models];
  c.updated = Date.now();
  saveConvos();
  renderConvoList();
  renderMsgs();

  chatAbort?.abort();
  chatAbort = new AbortController();
  const signal = chatAbort.signal;
  setBusy(true);

  const runOne = async (r, ri) => {
    const key = `${ti}:${ri}`;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        patchReply(c, key);
      });
    };
    try {
      const res = await streamOne(
        r.model,
        chatPayload(c, ti, r.model),
        { onText: (t) => ((r.content = t), schedule()), onReasoning: (t) => ((r.reasoning = t), schedule()) },
        signal
      );
      const mt = res.metrics || {};
      r.metrics = {
        tps: res.tps || null,
        ttft: res.ttft,
        latency_ms: mt.latency_ms,
        prompt_tokens: mt.prompt_tokens,
        cached_tokens: mt.cached_tokens,
        completion_tokens: mt.completion_tokens,
        reasoning_tokens: mt.reasoning_tokens,
        cost: mt.cost,
        estimated: mt.estimated,
      };
      if (!r.content && !r.reasoning) r.error = 'Model tidak mengembalikan teks.';
    } catch (err) {
      if (err.name === 'AbortError') r.stopped = true;
      else r.error = err.message;
    } finally {
      cancelAnimationFrame(frame);
      r.pending = false;
      // Jawaban lain mungkin masih jalan: ganti elemen ini saja.
      const el = $(`#msgs [data-r="${key}"]`);
      if (el && activeConvo() === c) {
        const box = $('#msgs');
        const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        const det = el.querySelector('.msg-think');
        const keepOpen = det && !det.hidden && det.open && det.dataset.touched;
        el.outerHTML = replyHtml(r, key, { isLastTurn: true, multi: turn.replies.length > 1 });
        if (keepOpen) {
          const d = $(`#msgs [data-r="${key}"] .msg-think`);
          d.open = true;
          d.dataset.touched = '1';
        }
        if (stick) box.scrollTop = box.scrollHeight;
      }
    }
  };

  await Promise.all(turn.replies.map(runOne));
  c.updated = Date.now();
  saveConvos();
  setBusy(false);
  if (activeConvo() === c && turn.replies.length > 1) {
    // Tombol "Buat ulang semua" muncul setelah semua jawaban selesai.
    const tEl = $(`#msgs [data-t="${ti}"]`);
    if (tEl) tEl.outerHTML = turnHtml(turn, ti, true);
  }
  renderConvoList();
}

function openChatSettings() {
  const ms = chatState.models.map(modelById).filter((m) => m?.reasoning);
  openSheet({
    title: 'Pengaturan chat',
    body: `
      <label class="field"><span>System prompt</span>
        <textarea class="input" name="system" rows="4" placeholder="mis. Jawab singkat dalam bahasa Indonesia.">${esc(chatState.system)}</textarea></label>
      <div class="fields-3">
        <label class="field"><span>Maks token output</span><input class="input" name="maxTokens" inputmode="numeric" value="${chatState.maxTokens}" /></label>
        <label class="field"><span>Reasoning effort</span>
          <select class="input" name="effort">${EFFORTS.map((e) => `<option ${chatState.effort === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label>
        <label class="field"><span>Temperature</span><input class="input" name="temperature" inputmode="decimal" value="${esc(chatState.temperature)}" placeholder="bawaan" /></label>
      </div>
      ${ms.map((m) => `<p class="hint">${esc(m.display_name || m.id)}: ${esc(m.reasoning)}</p>`).join('')}
      <p class="hint">Model Antigravity sudah membawa varian di ID-nya (mis. <span class="mono" style="white-space:nowrap">-high</span>). Effort di sini menimpanya kalau diisi.</p>`,
    submitLabel: 'Simpan',
    onSubmit: (form) => {
      const d = formData(form);
      const max = Number(d.maxTokens);
      if (!Number.isInteger(max) || max < 1) throw new Error('Maks token harus angka bulat positif.');
      if (d.temperature !== '' && Number.isNaN(Number(d.temperature))) throw new Error('Temperature harus angka.');
      Object.assign(chatState, { system: d.system, maxTokens: max, effort: d.effort, temperature: d.temperature.trim() });
      saveChat();
      renderComposerMeta();
    },
  });
}

// Stream satu request chat lewat gateway. cb.onText / cb.onReasoning dipanggil dengan teks kumulatif.
// Kembalikan metrics (event gateway.metrics) + tps + ttft.
async function streamOne(modelId, base, cb, signal) {
  const started = performance.now();
  const res = await fetch('/api/admin/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...base, model: modelId }),
    credentials: 'same-origin',
    signal,
  });
  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error?.message || d.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let firstAt = null;
  let lastAt = null;
  let metrics = null;
  let event = null;

  const handle = (line) => {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      return;
    }
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (event === 'gateway.metrics') {
      try {
        metrics = JSON.parse(payload);
      } catch {
        /* abaikan */
      }
      event = null;
      return;
    }
    if (payload === '[DONE]' || !payload) return;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return; // baris bukan JSON
    }
    if (chunk.error) throw new Error(chunk.error.message || 'Error dari upstream');
    const delta = chunk.choices?.[0]?.delta || {};
    const think = delta.reasoning_content ?? delta.reasoning;
    if (typeof think === 'string' && think) {
      if (firstAt === null) firstAt = performance.now();
      lastAt = performance.now();
      reasoning += think;
      cb.onReasoning?.(reasoning);
    }
    if (delta.content) {
      if (firstAt === null) firstAt = performance.now();
      lastAt = performance.now();
      text += delta.content;
      cb.onText?.(text);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const raw of lines) handle(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
  }
  if (buffer) handle(buffer);

  const completion = metrics?.completion_tokens || 0;
  // Token per detik dari token pertama (termasuk token berpikir) sampai token terakhir: kecepatan generasi murni.
  const genSec = firstAt != null && lastAt != null && lastAt > firstAt ? (lastAt - firstAt) / 1000 : null;
  const tps = completion && genSec ? completion / genSec : completion && firstAt ? completion / ((performance.now() - firstAt) / 1000) : 0;
  return { text, reasoning, metrics, tps, ttft: firstAt != null ? firstAt - started : metrics?.ttft_ms ?? null };
}

// ==========================================================
// Provider + pool API key (fill-first)
// ==========================================================
const KEY_STATE = {
  ok: ['Cadangan', ''],
  cooldown: ['Rate limit', 'badge-warn'],
  exhausted: ['Kredit habis', 'badge-err'],
  invalid: ['Key ditolak', 'badge-err'],
  off: ['Mati', ''],
};

function keyBadge(k) {
  const cd = k.cooldowns?.length ? ` <span class="badge badge-warn">Rate limit ${k.cooldowns.length} model</span>` : '';
  if (k.active) return '<span class="badge badge-ok">Dipakai sekarang</span>' + cd;
  const [label, cls] = KEY_STATE[k.state] || [k.state, ''];
  return `<span class="badge ${cls}">${label}</span>${cd}`;
}

function keyRow(p, k, i, n) {
  return `<div class="row key-row row-link" data-key="${k.id}" data-prov="${p.id}" tabindex="0" role="button" aria-label="Detail key ${esc(k.name)}">
    <span class="key-order num" aria-hidden="true">${i + 1}</span>
    <div class="row-text">
      <div class="row-title">${esc(k.name)} <span class="mono muted" style="font-size:12.5px;font-weight:400">${esc(k.hint)}</span></div>
      <div class="row-sub">${keyBadge(k)} <span>${fmtUsd(k.cost_today)} hari ini · cache ${k.cache_rate == null ? '–' : Math.round(k.cache_rate * 100) + '%'}</span></div>
    </div>
    <div class="row-end key-move">
      <button type="button" class="btn btn-quiet btn-icon btn-sm" data-move="up" data-key="${k.id}" data-prov="${p.id}" aria-label="Naikkan ${esc(k.name)}" ${i === 0 ? 'disabled' : ''}>${icon('chevron-up', 'i-sm')}</button>
      <button type="button" class="btn btn-quiet btn-icon btn-sm" data-move="down" data-key="${k.id}" data-prov="${p.id}" aria-label="Turunkan ${esc(k.name)}" ${i === n - 1 ? 'disabled' : ''}>${icon('chevron-down', 'i-sm')}</button>
    </div>
  </div>`;
}

async function providers() {
  const list = await api('/providers');
  page.innerHTML = `
    ${head('Provider', 'API asli di belakang gateway. Tiap provider bisa punya banyak API key: gateway memakai key paling atas sampai bermasalah, baru pindah ke key berikutnya.', `
      <button type="button" class="btn btn-primary" id="add-prov">${icon('plus', 'i-sm')}Tambah provider</button>`)}
    ${
      list.length
        ? `<div class="prov-list">${list
            .map(
              (p) => `<article class="card" aria-label="${esc(p.name)}">
          <div class="group-head">${logo(p.slug, p.name, 'logo-lg')}
            <div style="flex:1;min-width:0"><h2>${esc(p.name)}</h2>
              <span class="muted mono" style="font-size:13px">${esc(p.base_url)}</span></div>
            ${p.enabled ? '' : '<span class="badge">nonaktif</span>'}
            ${p.auth_type !== 'apikey' ? `<span class="badge badge-accent">langganan</span><button type="button" class="btn btn-sm" data-act="usage" data-id="${p.id}">${icon('gauge', 'i-sm')}<span class="hide-sm">Kuota</span></button>` : `<button type="button" class="btn btn-sm" data-act="test" data-id="${p.id}">${icon('plug-zap', 'i-sm')}<span class="hide-sm">Tes</span></button>`}
            <button type="button" class="btn btn-sm btn-icon" data-act="edit" data-id="${p.id}" aria-label="Ubah ${esc(p.name)}">${icon('pencil', 'i-sm')}</button>
          </div>
          <div class="section-head" style="padding:12px 20px 0;margin:0">
            <span class="label">${p.auth_type !== 'apikey' ? 'Akun · urutan pemakaian' : 'API key · urutan pemakaian'}</span>
            <button type="button" class="btn btn-sm" data-act="${p.auth_type !== 'apikey' ? 'connect' : 'add-key'}" data-id="${p.id}">${icon('plus', 'i-sm')}${p.auth_type !== 'apikey' ? 'Hubungkan akun' : 'Tambah key'}</button>
          </div>
          <div class="list">${
            p.keys.length
              ? p.keys.map((k, i) => keyRow(p, k, i, p.keys.length)).join('')
              : `<div class="empty" style="padding:24px"><p>${p.auth_type !== 'apikey' ? `Belum ada akun. Hubungkan akun ${esc(p.name)} supaya modelnya bisa dipanggil.` : `Belum ada API key. Tambahkan minimal satu supaya model ${esc(p.name)} bisa dipanggil.`}</p></div>`
          }</div>
        </article>`
            )
            .join('')}</div>`
        : `<div class="card empty">${icon('server')}<p>Belum ada provider. Cara tercepat: buka katalog di halaman Model.</p>
           <a class="btn btn-primary" href="#models" data-open-catalog>${icon('package-plus', 'i-sm')}Buka katalog</a></div>`
    }`;

  $('#add-prov').onclick = () => providerForm();
  $('[data-open-catalog]')?.addEventListener('click', () => sessionStorage.setItem('open-catalog', '1'));

  const findProv = (id) => list.find((x) => x.id === Number(id));

  page.onclick = async (e) => {
    const mv = e.target.closest('[data-move]');
    if (mv) {
      e.stopPropagation();
      const p = findProv(mv.dataset.prov);
      const ids = p.keys.map((k) => k.id);
      const i = ids.indexOf(Number(mv.dataset.key));
      const j = mv.dataset.move === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await api(`/providers/${p.id}/keys/order`, { method: 'PUT', body: { ids } });
      return route();
    }
    const row = e.target.closest('[data-key]');
    if (row) {
      const p = findProv(row.dataset.prov);
      return keyDetail(p, p.keys.find((k) => k.id === Number(row.dataset.key)));
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const p = findProv(b.dataset.id);
    if (b.dataset.act === 'edit') return providerForm(p);
    if (b.dataset.act === 'add-key') return addKeyForm(p);
    if (b.dataset.act === 'connect') return connectAccount(p.slug, p.auth_type, p.id);
    if (b.dataset.act === 'usage') return showUsage(p);
    b.disabled = true;
    try {
      const r = await api(`/providers/${p.id}/upstream-models`);
      openSheet({
        title: `${p.name} terhubung`,
        leading: logo(p.slug, p.name),
        body: `<p class="note">Lewat key "${esc(r.key)}", respons dalam ${fmtMs(r.latency_ms)}. ${r.models.length} model tersedia:</p>
          <pre class="code" style="max-height:320px">${esc(r.models.join('\n') || '(kosong)')}</pre>`,
      });
    } catch (err) {
      openSheet({ title: `${p.name} gagal`, leading: logo(p.slug, p.name), body: `<pre class="err-text">${esc(err.message)}</pre>` });
    } finally {
      b.disabled = false;
    }
  };
  page.onkeydown = (e) => {
    const row = e.target.closest('.key-row');
    if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.click(); }
  };
}

// Hubungkan akun langganan OAuth (Codex): login browser (paste-redirect PKCE) atau tempel auth.json.
function connectAccount(slug, authType, providerId) {
  const isCodex = authType === 'codex';
  const label = isCodex ? 'ChatGPT (Codex)' : 'Antigravity (Google)';
  const service = isCodex ? 'langganan ChatGPT' : 'langganan Google Antigravity (butuh Pro/Ultro berbayar)';
  const tos = isCodex ? 'ToS OpenAI' : 'ToS Google';
  const loginName = isCodex ? 'ChatGPT' : 'Google';
  let verifier = null;
  openSheet({
    title: `Hubungkan akun ${label}`,
    wide: true,
    body: `
      <p class="note">Pakai ${service} sebagai API. Area abu-abu ${tos} — untuk pemakaian pribadi; akun berisiko dibatasi. Biaya dibebankan ke kuota langgananmu ($0 di gateway).</p>
      <fieldset id="ca-local" class="hidden"><legend>Cara cepat · Impor dari komputer ini</legend>
        <p class="hint" id="ca-local-info"></p>
        <label class="field"><span>Nama akun (opsional)</span><input class="input" id="ca-name0" placeholder="akun ini" /></label>
        <button type="button" class="btn btn-primary btn-block" id="ca-importbtn">${icon('download', 'i-sm')}Impor otomatis</button>
      </fieldset>
      <fieldset><legend>Cara 1 · Login browser</legend>
        <button type="button" class="btn btn-block" id="ca-start">${icon('external-link', 'i-sm')}Buka halaman login ${loginName}</button>
        <div id="ca-step2" class="hidden" style="margin-top:12px">
          <p class="hint">Setelah menyetujui, browser diarahkan ke alamat localhost yang gagal dibuka — itu normal. Salin alamat lengkap dari address bar lalu tempel di sini.</p>
          <label class="field"><span>URL redirect (berisi ?code=…)</span><input class="input" id="ca-redirect" autocomplete="off" spellcheck="false" placeholder="http://localhost:1455/auth/callback?code=…" /></label>
          <label class="field"><span>Nama akun (opsional)</span><input class="input" id="ca-name1" placeholder="akun utama" /></label>
          <button type="button" class="btn btn-primary btn-block" id="ca-finish">Selesai & simpan</button>
        </div>
      </fieldset>
      ${
        authType === 'codex'
          ? `<fieldset><legend>Cara 2 · Tempel ~/.codex/auth.json</legend>
        <p class="hint">Sudah login lewat <code>codex login</code> di komputermu? Tempel isi file <code>~/.codex/auth.json</code>.</p>
        <label class="field"><span>Isi auth.json</span><textarea class="input" id="ca-paste" rows="3" spellcheck="false" placeholder='{"tokens":{"access_token":"…","refresh_token":"…"}}'></textarea></label>
        <label class="field"><span>Nama akun (opsional)</span><input class="input" id="ca-name2" placeholder="akun laptop" /></label>
        <button type="button" class="btn btn-primary btn-block" id="ca-pastebtn">Simpan dari auth.json</button>
      </fieldset>`
          : ''
      }
      <p class="form-error" id="ca-err" role="alert"></p>`,
    onOpen: ({ el, close }) => {
      const err = $('#ca-err', el);
      // Tawarkan impor otomatis kalau aplikasinya sudah login di komputer ini.
      api('/oauth/local')
        .then((loc) => {
          const info = loc?.[slug];
          if (!info?.available) return;
          const who = info.email || info.account || (info.source ? `dari ${info.source}` : '');
          $('#ca-local-info', el).textContent = `Terdeteksi akun ${label} di komputer ini${who ? ` (${who})` : ''}. Impor tanpa login ulang.`;
          $('#ca-local', el).classList.remove('hidden');
        })
        .catch(() => {});
      $('#ca-importbtn', el).onclick = async (ev) => {
        err.textContent = '';
        ev.currentTarget.disabled = true;
        try {
          const r = await api(`/oauth/${slug}/import`, { method: 'POST', body: { name: $('#ca-name0', el).value.trim() } });
          toast(r.duplicate ? 'Akun diperbarui' : 'Akun terhubung');
          close();
          route();
        } catch (e) {
          err.textContent = e.message;
          ev.currentTarget.disabled = false;
        }
      };
      $('#ca-start', el).onclick = async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        err.textContent = '';
        try {
          const r = await api(`/oauth/${slug}/start`, { method: 'POST' });
          verifier = r.verifier;
          window.open(r.url, '_blank', 'noopener');
          $('#ca-step2', el).classList.remove('hidden');
        } catch (e) {
          err.textContent = e.message;
        } finally {
          btn.disabled = false;
        }
      };
      $('#ca-finish', el).onclick = async (ev) => {
        err.textContent = '';
        const redirect = $('#ca-redirect', el).value.trim();
        if (!redirect) return (err.textContent = 'Tempel URL redirect-nya dulu.');
        ev.currentTarget.disabled = true;
        try {
          const r = await api(`/oauth/${slug}/finish`, { method: 'POST', body: { redirect, verifier, name: $('#ca-name1', el).value.trim() } });
          toast(r.duplicate ? 'Akun diperbarui' : 'Akun terhubung');
          close();
          route();
        } catch (e) {
          err.textContent = e.message;
          ev.currentTarget.disabled = false;
        }
      };
      const pb = $('#ca-pastebtn', el);
      if (pb)
        pb.onclick = async (ev) => {
          err.textContent = '';
          const content = $('#ca-paste', el).value.trim();
          if (!content) return (err.textContent = 'Tempel isi auth.json dulu.');
          ev.currentTarget.disabled = true;
          try {
            const r = await api(`/oauth/${slug}/paste`, { method: 'POST', body: { content, name: $('#ca-name2', el).value.trim() } });
            toast(r.duplicate ? 'Akun diperbarui' : 'Akun terhubung');
            close();
            route();
          } catch (e) {
            err.textContent = e.message;
            ev.currentTarget.disabled = false;
          }
        };
    },
  });
}

// Kuota langganan tiap akun: jendela sesi/mingguan + sisa kuota per model (Antigravity).
function usageBar(w) {
  const left = Math.max(0, Math.min(100, w.remainingPercent ?? 100 - (w.usedPercent ?? 0)));
  const cls = w.limitReached || left <= 0 ? 'hot' : left < 20 ? 'warn' : '';
  const reset = w.resetAt ? ` · reset ${fmtAgo(Date.parse(w.resetAt))}`.replace('lalu', 'lagi') : '';
  return `<div class="usage-row">
    <div class="usage-top"><span>${esc(w.label)}</span><b>${left.toFixed(0)}%<span class="muted" style="font-weight:400"> sisa</span></b></div>
    <div class="meter ${cls}"><span style="width:${left}%"></span></div>
    <div class="usage-sub muted">${w.limitReached ? 'Limit tercapai' : `terpakai ${(w.usedPercent ?? 100 - left).toFixed(0)}%`}${reset}</div>
  </div>`;
}

function showUsage(p) {
  openSheet({
    title: `Kuota ${p.name}`,
    leading: logo(p.slug, p.name),
    wide: true,
    body: `<p class="note">Kuota langganan dibaca langsung dari ${esc(p.name)} (seperti 9router). Biaya tetap $0; yang terpakai adalah jatah langgananmu.</p>
      <div id="usage-body"><div class="skeleton" style="height:80px"></div></div>`,
    onOpen: async ({ el }) => {
      const box = $('#usage-body', el);
      try {
        const { accounts } = await api(`/oauth/${p.slug}/usage`);
        if (!accounts?.length) {
          box.innerHTML = '<div class="empty" style="padding:24px"><p>Belum ada akun terhubung.</p></div>';
          return;
        }
        box.innerHTML = accounts
          .map((a) => {
            if (a.error) return `<div class="usage-acc"><div class="usage-acc-head">${esc(a.name)}</div><p class="err-text">${esc(a.error)}</p></div>`;
            const u = a.usage || {};
            const models = (u.models || []).filter((m) => m.remainingPercent != null && m.remainingPercent < 100);
            return `<div class="usage-acc">
              <div class="usage-acc-head">${esc(a.name)}${u.plan ? ` <span class="badge">${esc(u.plan)}</span>` : ''}${u.limitReached ? ' <span class="badge badge-err">limit</span>' : ''}</div>
              ${(u.windows || []).map(usageBar).join('') || '<p class="hint">Tidak ada info jendela kuota.</p>'}
              ${
                models.length
                  ? `<details class="usage-models"><summary>${models.length} model sedang terpakai</summary>
                    <div class="list" style="margin-top:8px">${models
                      .sort((x, y) => x.remainingPercent - y.remainingPercent)
                      .map((m) => `<div class="usage-sub"><span class="mono">${esc(m.id)}</span> — sisa ${m.remainingPercent}%</div>`)
                      .join('')}</div></details>`
                  : (u.models || []).length
                    ? `<p class="hint">${(u.models || []).length} model, semua kuota penuh.</p>`
                    : ''
              }
            </div>`;
          })
          .join('');
      } catch (e) {
        box.innerHTML = `<pre class="err-text">${esc(e.message)}</pre>`;
      }
    },
  });
}

function addKeyForm(p) {
  openSheet({
    title: `Tambah key ${p.name}`,
    leading: logo(p.slug, p.name),
    submitLabel: 'Tambah key',
    body: `<p class="note">Key baru ditaruh paling bawah sebagai cadangan. Urutannya bisa diubah dengan panah di daftar key.</p>
      <label class="field"><span>Nama</span><input class="input" name="name" placeholder="Akun ${p.keys.length + 1}" /></label>
      <label class="field"><span>API key</span><input class="input" name="api_key" type="password" autocomplete="off" required /></label>`,
    onSubmit: async (form) => {
      const d = formData(form);
      if (!d.api_key.trim()) throw new Error('Tempel API key dulu.');
      await api(`/providers/${p.id}/keys`, { method: 'POST', body: { name: d.name.trim() || `Akun ${p.keys.length + 1}`, api_key: d.api_key } });
      toast('Key ditambahkan');
      route();
    },
  });
}

function keyDetail(p, k) {
  const stateText = {
    ok: k.active ? 'Key ini yang sedang dipakai. Semua request masuk ke sini sampai key ini bermasalah.' : 'Cadangan. Dipakai kalau semua key di atasnya bermasalah.',
    exhausted: 'Kredit atau kuota habis. Setelah top-up, tekan "Aktifkan lagi".',
    invalid: 'Provider menolak key ini (401/403). Cek atau ganti key-nya.',
    off: 'Dimatikan manual. Tidak akan dipakai.',
  }[k.state];
  openSheet({
    title: k.name,
    leading: logo(p.slug, p.name),
    wide: true,
    body: `
      <p class="note">${keyBadge(k)} ${esc(stateText || '')}</p>
      <div class="detail-grid">
        <div><span class="label">Hari ini</span><b>${fmtUsd(k.cost_today)}</b></div>
        <div><span class="label">Total</span><b>${fmtUsd(k.cost)}</b></div>
        <div><span class="label">Cache</span><b>${k.cache_rate == null ? '–' : Math.round(k.cache_rate * 100) + '%'}</b></div>
        <div><span class="label">Request</span><b>${fmtNum(k.requests)}</b></div>
        <div><span class="label">Error</span><b>${fmtNum(k.errors)}</b></div>
        <div><span class="label">Dipakai</span><b style="font-size:15px">${fmtAgo(k.last_used_at)}</b></div>
      </div>
      ${k.cooldowns?.length ? `<div class="label" style="margin-bottom:6px">Rate limit per model (model lain tetap jalan)</div><dl class="kv" style="margin-bottom:16px">${k.cooldowns.map((c) => `<dt class="mono">${esc(c.model)}</dt><dd>sampai ${new Date(c.until).toLocaleTimeString('id-ID')}</dd>`).join('')}</dl>` : ''}
      <dl class="kv" style="margin-bottom:16px"><dt>Key</dt><dd class="mono">${esc(k.hint)}</dd><dt>Urutan</dt><dd>${p.keys.indexOf(k) + 1} dari ${p.keys.length}</dd></dl>
      ${k.last_error ? `<div class="label" style="margin-bottom:6px">Error terakhir · ${fmtAgo(k.last_error_at)}</div><pre class="err-text" style="margin-bottom:16px">${esc(k.last_error)}</pre>` : ''}
      <label class="field"><span>Nama</span><input class="input" name="name" value="${esc(k.name)}" /></label>
      <label class="check-row"><span class="t">Aktif</span><span class="switch"><input type="checkbox" name="enabled" ${k.enabled ? 'checked' : ''} /><span></span></span></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
        ${p.auth_type === 'apikey' ? `<button type="button" class="btn" id="kd-test">${icon('plug-zap', 'i-sm')}Tes key</button>` : ''}
        ${['exhausted', 'invalid'].includes(k.state) || k.cooldowns?.length ? `<button type="button" class="btn" id="kd-reset">${icon('rotate-ccw', 'i-sm')}Aktifkan lagi</button>` : ''}
        <button type="button" class="btn btn-danger" id="kd-del">${icon('trash-2', 'i-sm')}Hapus</button>
      </div>`,
    submitLabel: 'Simpan',
    onSubmit: async (form) => {
      const d = formData(form);
      await api('/provider-keys/' + k.id, { method: 'PUT', body: { name: d.name, enabled: !!d.enabled } });
      toast('Key disimpan');
      route();
    },
    onOpen: ({ el }) => {
      const testBtn = $('#kd-test', el);
      if (testBtn)
        testBtn.onclick = async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try {
            const r = await api(`/provider-keys/${k.id}/test`, { method: 'POST' });
            toast(`Key jalan, ${r.models.length} model, ${fmtMs(r.latency_ms)}`);
            route();
          } catch (err) {
            toast(err.message, 'err');
          } finally {
            b.disabled = false;
          }
        };
      $('#kd-reset', el)?.addEventListener('click', async () => {
        await api('/provider-keys/' + k.id, { method: 'PUT', body: { reset: true } });
        toast('Key diaktifkan lagi');
        route();
        $('[data-close]', el)?.click();
      });
      $('#kd-del', el).onclick = async () => {
        if (!(await confirmSheet({ title: `Hapus ${k.name}?`, message: 'Key ini tidak dipakai lagi. Riwayat biayanya tetap ada di log.' }))) return;
        await api('/provider-keys/' + k.id, { method: 'DELETE' });
        toast('Key dihapus');
        route();
      };
    },
  });
}

function providerForm(p) {
  const edit = !!p;
  openSheet({
    title: edit ? `Ubah ${p.name}` : 'Tambah provider',
    submitLabel: edit ? 'Simpan provider' : 'Tambah provider',
    secondary: edit ? `<button type="button" class="btn btn-danger" id="del-prov" style="margin-right:auto">${icon('trash-2', 'i-sm')}Hapus</button>` : '',
    body: `
      <div class="fields-2">
        <label class="field"><span>Slug (awalan model ID)</span><input class="input" name="slug" required value="${esc(p?.slug)}" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="meta" /></label>
        <label class="field"><span>Nama</span><input class="input" name="name" value="${esc(p?.name)}" placeholder="Meta Model API" /></label>
      </div>
      <label class="field"><span>Base URL</span><input class="input" name="base_url" type="url" required value="${esc(p?.base_url)}" autocapitalize="none" spellcheck="false" placeholder="https://api.provider.com/v1" />
        <span class="hint">Gateway memanggil {base_url}/chat/completions dan {base_url}/responses.</span></label>
      ${edit ? '' : '<label class="field"><span>API key pertama</span><input class="input" name="api_key" type="password" autocomplete="off" /><span class="hint">Key lain bisa ditambah setelah provider dibuat.</span></label>'}
      <label class="check-row"><span><span class="t">Minta usage saat streaming</span><span class="hint">Menambahkan stream_options.include_usage supaya token tercatat tepat.</span></span>
        <span class="switch"><input type="checkbox" name="stream_usage" ${p?.stream_usage === false ? '' : 'checked'} /><span></span></span></label>
      <label class="check-row"><span><span class="t">Passthrough</span><span class="hint">slug/model-apa-saja boleh dipanggil tanpa didaftarkan. Biaya tercatat $0.</span></span>
        <span class="switch"><input type="checkbox" name="allow_passthrough" ${p?.allow_passthrough ? 'checked' : ''} /><span></span></span></label>
      <label class="check-row"><span class="t">Aktif</span>
        <span class="switch"><input type="checkbox" name="enabled" ${p?.enabled === false ? '' : 'checked'} /><span></span></span></label>`,
    onOpen: ({ el }) => {
      $('#del-prov', el)?.addEventListener('click', async () => {
        if (!(await confirmSheet({ title: `Hapus ${p.name}?`, message: 'Semua model dari provider ini ikut terhapus. Log lama tetap tersimpan.' }))) return;
        await api('/providers/' + p.id, { method: 'DELETE' });
        toast('Provider dihapus');
        route();
      });
    },
    onSubmit: async (form) => {
      const d = formData(form);
      const body = {
        slug: d.slug.trim(),
        name: d.name.trim() || d.slug.trim(),
        base_url: d.base_url.trim(),
        stream_usage: !!d.stream_usage,
        allow_passthrough: !!d.allow_passthrough,
        enabled: !!d.enabled,
      };
      if (d.api_key) body.api_key = d.api_key;
      await api(edit ? '/providers/' + p.id : '/providers', { method: edit ? 'PUT' : 'POST', body });
      toast('Provider disimpan');
      route();
    },
  });
}

// ==========================================================
// API key
// ==========================================================
async function keys() {
  const list = await api('/keys');
  page.innerHTML = `
    ${head('API key', 'Key untuk memanggil gateway. Buat satu per aplikasi supaya biayanya terpisah dan gampang dicabut.', `
      <button type="button" class="btn btn-primary" id="add-key">${icon('plus', 'i-sm')}Buat key</button>`)}
    ${
      list.length
        ? `<div class="card list">${list
            .map(
              (k) => `<div class="row" style="grid-template-columns:minmax(0,1fr) auto auto">
          <div class="row-text"><div class="row-title">${esc(k.name)} ${k.enabled ? '' : '<span class="badge">dicabut</span>'}</div>
            <div class="row-sub"><span class="mono">${esc(k.key_hint)}</span> · dipakai ${fmtAgo(k.last_used_at)}</div></div>
          <div class="cols"><div>${fmtUsd(k.total_cost)}</div><div class="muted">${fmtNum(k.total_requests)} req</div></div>
          <div class="row-end">
            <label class="switch" aria-label="Aktifkan ${esc(k.name)}"><input type="checkbox" data-toggle-key="${k.id}" ${k.enabled ? 'checked' : ''} /><span></span></label>
            <button type="button" class="btn btn-quiet btn-icon btn-sm" data-del-key="${k.id}" aria-label="Hapus ${esc(k.name)}">${icon('trash-2', 'i-sm')}</button>
          </div></div>`
            )
            .join('')}</div>`
        : `<div class="card empty">${icon('key-round')}<p>Belum ada key. Buat satu untuk aplikasi pertamamu.</p></div>`
    }`;

  $('#add-key').onclick = () =>
    openSheet({
      title: 'Buat API key',
      submitLabel: 'Buat key',
      body: `<label class="field"><span>Nama</span><input class="input" name="name" required placeholder="bot-wa, laptop, n8n" enterkeyhint="done" /></label>`,
      onSubmit: async (form) => {
        const name = formData(form).name.trim();
        if (!name) throw new Error('Isi nama key dulu.');
        const { key } = await api('/keys', { method: 'POST', body: { name } });
        route();
        openSheet({
          title: 'Key siap dipakai',
          body: `<p class="note">Simpan sekarang. Key ini hanya ditampilkan sekali.</p>
            <div class="key-reveal">${esc(key)}</div>
            <div style="margin-top:12px"><button type="button" class="btn btn-primary btn-block" data-copy="${esc(key)}">${icon('copy', 'i-sm')}Salin key</button></div>`,
        });
        return true;
      },
    });

  page.onchange = async (e) => {
    const sw = e.target.closest('[data-toggle-key]');
    if (!sw) return;
    try {
      await api('/keys/' + sw.dataset.toggleKey, { method: 'PUT', body: { enabled: sw.checked } });
      toast(sw.checked ? 'Key aktif lagi' : 'Key dicabut');
      route();
    } catch (err) {
      sw.checked = !sw.checked;
      toast(err.message, 'err');
    }
  };
  page.onclick = async (e) => {
    const b = e.target.closest('[data-del-key]');
    if (!b) return;
    const k = list.find((x) => x.id === Number(b.dataset.delKey));
    if (!(await confirmSheet({ title: `Hapus ${k.name}?`, message: 'Aplikasi yang memakai key ini langsung ditolak. Riwayat biayanya tetap ada di log.' }))) return;
    await api('/keys/' + k.id, { method: 'DELETE' });
    toast('Key dihapus');
    route();
  };
}

// ==========================================================
// Log
// ==========================================================
const logState = { offset: 0, status: '', model: '' };

async function logs() {
  const limit = 50;
  const q = new URLSearchParams({ limit, offset: logState.offset });
  if (logState.status) q.set('status', logState.status);
  if (logState.model) q.set('model', logState.model);
  const [{ rows, total }, modelList] = await Promise.all([api('/logs?' + q), api('/models')]);

  page.innerHTML = `
    ${head('Log', `${fmtNum(total)} request tercatat.`, `
      <a class="btn" href="/api/admin/logs/export.csv" download>${icon('download', 'i-sm')}Export CSV</a>`)}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      <div class="seg" role="group" aria-label="Status" id="f-status">
        ${[['', 'Semua'], ['ok', 'Sukses'], ['error', 'Error']].map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${logState.status === v}">${l}</button>`).join('')}
      </div>
      <select class="input" id="f-model" aria-label="Filter model" style="width:auto;max-width:100%;height:36px">
        <option value="">Semua model</option>
        ${modelList.map((m) => `<option value="${esc(m.id)}" ${m.id === logState.model ? 'selected' : ''}>${esc(m.id)}</option>`).join('')}
      </select>
    </div>
    ${
      rows.length
        ? `<div class="card list">${rows
            .map(
              (r, i) => `<div class="row log-row row-link" data-log="${i}" tabindex="0" role="button" aria-label="Detail request ${esc(r.model)}">
          <span class="dot ${r.status >= 400 ? 'err' : ''}" aria-hidden="true"></span>
          <div class="row-text">
            <div class="row-title mono" style="font-size:14px">${esc(r.model)}</div>
            <div class="row-sub">${fmtTime(r.ts)} · ${esc(r.key_name || '–')}${r.stream ? ' · stream' : ''}${r.fallback_from ? ' · fallback' : ''}${r.status >= 400 ? ` · <span style="color:var(--err)">${r.status}</span>` : ''}</div>
          </div>
          <div class="cols"><div>${fmtUsd(r.cost)}${r.estimated ? '<span class="muted">*</span>' : ''}</div>
            <div class="muted">${usageUnits(r)}<span class="lat"> · ${fmtMs(r.latency_ms)}</span></div></div>
        </div>`
            )
            .join('')}</div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px">
            <span class="label">${logState.offset + 1}–${Math.min(logState.offset + limit, total)} dari ${fmtNum(total)}${rows.some((r) => r.estimated) ? ' · * token diperkirakan' : ''}</span>
            <div style="display:flex;gap:8px">
              <button type="button" class="btn btn-sm btn-icon" id="prev" aria-label="Sebelumnya" ${logState.offset ? '' : 'disabled'}>${icon('chevron-left', 'i-sm')}</button>
              <button type="button" class="btn btn-sm btn-icon" id="next" aria-label="Berikutnya" ${logState.offset + limit < total ? '' : 'disabled'}>${icon('chevron-right', 'i-sm')}</button>
            </div>
          </div>`
        : `<div class="card empty">${icon('scroll-text')}<p>Belum ada request${logState.status || logState.model ? ' untuk filter ini' : ''}.</p></div>`
    }`;

  $('#f-status').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    logState.status = b.dataset.v;
    logState.offset = 0;
    route();
  };
  $('#f-model').onchange = (e) => { logState.model = e.target.value; logState.offset = 0; route(); };
  $('#prev')?.addEventListener('click', () => { logState.offset = Math.max(0, logState.offset - limit); route(); });
  $('#next')?.addEventListener('click', () => { logState.offset += limit; route(); });

  const openLog = (r) =>
    openSheet({
      title: r.model,
      leading: `<span class="dot ${r.status >= 400 ? 'err' : ''}" aria-hidden="true"></span>`,
      wide: true,
      body: `
        <div class="detail-grid">
          <div><span class="label">Status</span><b>${r.status}</b></div>
          <div><span class="label">Biaya</span><b>${fmtUsd(r.cost)}</b></div>
          <div><span class="label">Latency</span><b>${fmtMs(r.latency_ms)}</b></div>
          <div><span class="label">Input</span><b>${fmtNum(r.prompt_tokens)}</b></div>
          <div><span class="label">Cached</span><b>${fmtNum(r.cached_tokens)}</b></div>
          <div><span class="label">Output</span><b>${fmtNum(r.completion_tokens)}</b></div>
          <div><span class="label">Reasoning</span><b>${fmtNum(r.reasoning_tokens)}</b></div>
          ${r.images ? `<div><span class="label">Gambar</span><b>${fmtNum(r.images)}</b></div>` : ''}
          ${r.frames ? `<div><span class="label">Frame video</span><b>${fmtNum(r.frames)}</b></div>` : ''}
          ${r.audio_ms ? `<div><span class="label">Audio</span><b>${(r.audio_ms / 1000).toFixed(1)} dtk</b></div>` : ''}
          ${r.searches ? `<div><span class="label">Web search</span><b>${fmtNum(r.searches)}</b></div>` : ''}
          <div><span class="label">TTFT</span><b>${fmtMs(r.ttft_ms)}</b></div>
          <div><span class="label">Mode</span><b>${r.stream ? 'stream' : 'biasa'}</b></div>
        </div>
        <dl class="kv" style="margin-bottom:16px">
          <dt>Waktu</dt><dd>${new Date(r.ts).toLocaleString('id-ID')}</dd>
          <dt>Provider</dt><dd>${esc(r.provider_slug || '–')}</dd>
          <dt>Model asli</dt><dd class="mono">${esc(r.upstream_model || '–')}</dd>
          <dt>Endpoint</dt><dd class="mono">${esc(r.endpoint)}</dd>
          <dt>Key gateway</dt><dd>${esc(r.key_name || '–')}</dd>
          <dt>Key provider</dt><dd>${esc(r.provider_key_name || '–')}</dd>
          ${r.fallback_from ? `<dt>Fallback dari</dt><dd class="mono">${esc(r.fallback_from)}</dd>` : ''}
        </dl>
        ${r.estimated ? '<p class="note">Provider tidak mengirim data usage, jadi token diperkirakan dari panjang teks.</p>' : ''}
        ${r.error ? `<pre class="err-text">${esc(r.error)}</pre>` : ''}`,
    });
  page.onclick = (e) => {
    const row = e.target.closest('[data-log]');
    if (row) openLog(rows[Number(row.dataset.log)]);
  };
  page.onkeydown = (e) => {
    const row = e.target.closest('[data-log]');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openLog(rows[Number(row.dataset.log)]); }
  };
}

// ==========================================================
// Pengaturan
// ==========================================================
async function settings() {
  const s = await api('/settings');
  page.innerHTML = `
    ${head('Pengaturan', 'Batas biaya dan penyimpanan log.')}
    <form class="card card-pad" id="sf" style="max-width:640px" novalidate>
      <fieldset><legend>Budget (USD, 0 = tanpa batas)</legend>
        <div class="fields-2">
          <label class="field"><span>Per hari</span><input class="input" name="daily_budget_usd" inputmode="decimal" value="${s.daily_budget_usd}" /></label>
          <label class="field"><span>Per bulan</span><input class="input" name="monthly_budget_usd" inputmode="decimal" value="${s.monthly_budget_usd}" /></label>
        </div>
        <span class="hint">Kalau budget habis, gateway menolak request dengan status 429 sampai hari atau bulan berganti.</span>
      </fieldset>
      <fieldset><legend>Sistem</legend>
        <div class="fields-2">
          <label class="field"><span>Simpan log (hari, 0 = selamanya)</span><input class="input" name="log_retention_days" inputmode="numeric" value="${s.log_retention_days}" /></label>
          <label class="field"><span>Timeout upstream (detik)</span><input class="input" name="upstream_timeout_sec" inputmode="numeric" value="${s.upstream_timeout_sec}" /></label>
        </div>
      </fieldset>
      <p class="form-error" id="sf-err" role="alert"></p>
      <button class="btn btn-primary" type="submit">Simpan pengaturan</button>
    </form>
    <section class="section card card-pad" style="max-width:640px">
      <h2 style="margin-bottom:8px">Endpoint gateway</h2>
      ${copyChip(GATEWAY)}
      <p class="muted" style="margin:12px 0 0;font-size:15px">Tersedia: /chat/completions, /responses, /completions, /embeddings, /images/generations, /images/edits, /asr/transcribe, /asr/realtime (WebSocket), /models.</p>
    </section>`;
  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    $('#sf-err').textContent = '';
    try {
      await api('/settings', { method: 'PUT', body: formData(e.target) });
      toast('Pengaturan disimpan');
    } catch (err) {
      $('#sf-err').textContent = err.message;
    }
  };
}

start();
