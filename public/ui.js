// UI primitives: springs, sheets, toast, copy, formatting.

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export const icon = (name, cls = '') => `<span class="i i-${name} ${cls}" aria-hidden="true"></span>`;

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isPhone = () => matchMedia('(max-width: 860px)').matches;

// ---------- Format ----------
export function fmtUsd(n) {
  n = Number(n) || 0;
  if (n === 0) return '$0';
  const abs = Math.abs(n);
  if (abs < 0.01) return '$' + n.toPrecision(2).replace(/0+$/, '');
  if (abs < 1) return '$' + n.toFixed(3).replace(/0$/, '');
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export const fmtPrice = (n) => (n == null ? '–' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 }));
export const fmtNum = (n) => (Number(n) || 0).toLocaleString('id-ID');
export function fmtShort(n) {
  n = Number(n) || 0;
  const f = (v, s) => (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')) + s;
  if (n >= 1e9) return f(n / 1e9, 'B');
  if (n >= 1e6) return f(n / 1e6, 'M');
  if (n >= 1e3) return f(n / 1e3, 'K');
  return String(Math.round(n));
}
export const fmtMs = (n) => (n == null ? '–' : n >= 1000 ? (n / 1000).toFixed(1) + ' dtk' : Math.round(n) + ' ms');
export const fmtCtx = (n) => (n ? (n >= 1_000_000 ? (n / 1_048_576).toFixed(0) + 'M' : Math.round(n / 1024) + 'K') : '–');
export const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

export function fmtAgo(ts) {
  if (!ts) return 'belum pernah';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' hari lalu';
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}
export const fmtTime = (ts) =>
  new Date(ts).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---------- Spring (Apple-style damping ratio + response) ----------
// response: seconds to reach the target; damping 1 = no overshoot.
export function spring({ from, to, velocity = 0, response = 0.35, damping = 1, precision = 0.5, onUpdate, onDone }) {
  const k = Math.pow((2 * Math.PI) / response, 2);
  const c = (4 * Math.PI * damping) / response;
  let x = from;
  let v = velocity;
  let last = performance.now();
  let raf = 0;
  let stopped = false;
  const step = (now) => {
    if (stopped) return;
    const dt = Math.min((now - last) / 1000, 0.064);
    last = now;
    const n = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -k * (x - to) - c * v;
      v += a * h;
      x += v * h;
    }
    if (Math.abs(x - to) < precision && Math.abs(v) < precision * 10) {
      x = to;
      onUpdate(x);
      onDone?.();
      return;
    }
    onUpdate(x);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return {
    stop() { stopped = true; cancelAnimationFrame(raf); },
    get value() { return x; },
    get velocity() { return v; },
  };
}

// Momentum projection (Designing Fluid Interfaces).
const project = (v, d = 0.998) => ((v / 1000) * d) / (1 - d);
const rubberband = (o, dim, c = 0.55) => (o * dim * c) / (dim + c * Math.abs(o));

// ---------- Toast ----------
let toastTimer;
export function toast(message, kind = 'ok') {
  const t = $('#toast');
  t.innerHTML = (kind === 'ok' ? icon('check') : icon('circle-alert')) + `<span>${esc(message)}</span>`;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ---------- Copy ----------
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // http (non-secure) fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  e.stopPropagation();
  await copyText(btn.dataset.copy);
  btn.classList.add('done');
  const label = btn.getAttribute('aria-label');
  btn.setAttribute('aria-label', 'Tersalin');
  setTimeout(() => {
    btn.classList.remove('done');
    if (label) btn.setAttribute('aria-label', label);
  }, 1400);
  if (!btn.classList.contains('copy')) toast('Tersalin');
});

export const copyChip = (text, show = text) =>
  `<button type="button" class="copy" data-copy="${esc(text)}" aria-label="Salin ${esc(text)}"><span>${esc(show)}</span>${icon('copy')}</button>`;

// ---------- Sheet ----------
let current = null;

/**
 * openSheet({ title, body, submitLabel, danger, wide, onSubmit, onOpen, secondary })
 * onSubmit(form) may throw to show an error; return true to keep the sheet open.
 */
export function openSheet(opts) {
  if (current) current.close({ instant: true });

  const opener = document.activeElement;
  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  const sheet = document.createElement('form');
  sheet.className = 'sheet' + (opts.wide ? ' sheet-wide' : '');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'sheet-title');
  sheet.noValidate = true;
  sheet.tabIndex = -1;
  sheet.innerHTML = `
    <div class="sheet-grip" aria-hidden="true"></div>
    <div class="sheet-head">
      ${opts.leading || ''}
      <h2 id="sheet-title">${esc(opts.title)}</h2>
      <button type="button" class="btn btn-quiet btn-icon btn-sm" data-close aria-label="Tutup">${icon('x')}</button>
    </div>
    <div class="sheet-body">${opts.body || ''}<p class="form-error" role="alert"></p></div>
    ${
      opts.onSubmit
        ? `<div class="sheet-foot">
            ${opts.secondary || ''}
            <button type="button" class="btn" data-close>Batal</button>
            <button type="submit" class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}">${esc(opts.submitLabel || 'Simpan')}</button>
          </div>`
        : ''
    }`;
  document.body.append(scrim, sheet);
  const app = $('#app');
  app?.setAttribute('inert', '');
  document.documentElement.style.overflow = 'hidden';

  const phone = isPhone();
  const calm = reducedMotion();
  let anim = null;
  let closing = false;
  const height = () => sheet.getBoundingClientRect().height || 400;

  // Presentation state
  let y = 0; // phone: px offset down
  let p = 0; // desktop: 0..1 progress
  const render = () => {
    if (phone) {
      sheet.style.transform = `translateY(${y}px)`;
      scrim.style.opacity = String(Math.max(0, Math.min(1, 1 - y / height())));
    } else {
      sheet.style.transform = `translate(-50%, -50%) scale(${0.96 + 0.04 * p})`;
      sheet.style.opacity = String(p);
      scrim.style.opacity = String(p);
    }
  };

  const animateTo = (target, { velocity = 0, damping = 1, response = 0.36, done } = {}) => {
    anim?.stop();
    if (calm) {
      // Reduced motion: cross-fade only.
      sheet.style.transition = scrim.style.transition = 'opacity 160ms ease';
      if (phone) { y = 0; sheet.style.transform = 'translateY(0)'; }
      const visible = phone ? target === 0 : target === 1;
      sheet.style.opacity = scrim.style.opacity = visible ? '1' : '0';
      setTimeout(() => done?.(), 170);
      return;
    }
    anim = spring({
      from: phone ? y : p,
      to: target,
      velocity,
      response,
      damping,
      precision: phone ? 0.5 : 0.002,
      onUpdate: (v) => { if (phone) y = v; else p = v; render(); },
      onDone: done,
    });
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      const f = $$('button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])', sheet)
        .filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey);

  function teardown() {
    document.removeEventListener('keydown', onKey);
    scrim.remove();
    sheet.remove();
    if (current === api) current = null;
    if (!current) {
      app?.removeAttribute('inert');
      document.documentElement.style.overflow = '';
      opener?.focus?.({ preventScroll: true });
    }
    opts.onClose?.();
  }

  function close({ instant = false, velocity = 0 } = {}) {
    if (closing) return;
    closing = true;
    if (instant) { anim?.stop(); teardown(); return; }
    // Exit along the same path it entered.
    animateTo(phone ? height() : 0, { velocity, response: 0.3, done: teardown });
  }

  scrim.addEventListener('click', () => close());
  sheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });

  sheet.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!opts.onSubmit) return;
    const submit = sheet.querySelector('button[type=submit]');
    const err = sheet.querySelector('.form-error');
    err.textContent = '';
    submit.disabled = true;
    try {
      const keep = await opts.onSubmit(sheet);
      if (!keep && current === api) close();
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      submit.disabled = false;
    }
  });

  // Drag to dismiss (phone): 1:1 tracking, rubber-band upward, velocity projection on release.
  if (phone) {
    const handles = [sheet.querySelector('.sheet-grip'), sheet.querySelector('.sheet-head')];
    let drag = null;
    const down = (e) => {
      if (e.button !== 0 || e.target.closest('button, a, input')) return;
      anim?.stop(); // grab from the live position
      drag = { start: e.clientY, from: y, hist: [{ t: e.timeStamp, y: e.clientY }], id: e.pointerId, el: e.currentTarget };
      e.currentTarget.setPointerCapture(e.pointerId);
    };
    const move = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      let next = drag.from + (e.clientY - drag.start);
      if (next < 0) next = rubberband(next, height());
      y = next;
      render();
      drag.hist.push({ t: e.timeStamp, y: e.clientY });
      if (drag.hist.length > 6) drag.hist.shift();
    };
    const up = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const h = drag.hist;
      const a = h[0];
      const b = h[h.length - 1];
      const dt = Math.max(1, b.t - a.t);
      const v = ((b.y - a.y) / dt) * 1000; // px/s
      drag = null;
      const projected = y + project(v);
      if (projected > height() * 0.45) close({ velocity: v });
      else animateTo(0, { velocity: v, damping: 0.8, response: 0.3 });
    };
    for (const hEl of handles) {
      hEl.addEventListener('pointerdown', down);
      hEl.addEventListener('pointermove', move);
      hEl.addEventListener('pointerup', up);
      hEl.addEventListener('pointercancel', up);
    }
  }

  // Enter
  if (phone) { y = height(); } else { p = 0; }
  if (calm) { sheet.style.opacity = scrim.style.opacity = '0'; if (!phone) sheet.style.transform = 'translate(-50%, -50%)'; }
  else render();
  requestAnimationFrame(() => animateTo(phone ? 0 : 1, { response: 0.38 }));

  const api = { el: sheet, close, body: sheet.querySelector('.sheet-body') };
  current = api;

  const firstInput = sheet.querySelector('.sheet-body input:not([type=hidden]):not([readonly]), .sheet-body select, .sheet-body textarea');
  setTimeout(() => (phone || !firstInput ? sheet : firstInput).focus({ preventScroll: true }), 30);
  opts.onOpen?.(api);
  return api;
}

export const formData = (form) => Object.fromEntries(new FormData(form).entries());

export function confirmSheet({ title, message, confirmLabel = 'Hapus', danger = true }) {
  return new Promise((resolve) => {
    let ok = false;
    openSheet({
      title,
      body: `<p class="note">${esc(message)}</p>`,
      submitLabel: confirmLabel,
      danger,
      onSubmit: () => { ok = true; },
      onClose: () => resolve(ok),
    });
  });
}
