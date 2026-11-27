// Tempmon PWA page: current reading, chart, settings (language, alerts) and alert status.
(function () {
  'use strict';
  const T = self.Tempmon;
  const I = self.TempmonI18n;
  const $ = (id) => document.getElementById(id);

  // Chart ranges. Long ranges use ThingSpeak's server-side averaging so a download stays < 1000 points.
  const RANGES = {
    '1d': { h: 24 },
    '3d': { h: 72, avg: 10 },
    '7d': { h: 168, avg: 15 },
    '14d': { h: 336, avg: 30 },
    '30d': { h: 720, avg: 60 },
    '90d': { h: 2160, avg: 240 },
  };
  const POLL_MS = 120e3; // the board sends a point every 2 min

  let range = '1d';
  let last = null; // { t, v, rssi }
  let settings = Object.assign({}, T.DEFAULTS);
  const series = {}; // range -> { pts: [[ms, °C]], fetched: ms }

  // ---- language -------------------------------------------------------------------------------
  // The chosen language is mirrored in localStorage so the first paint is already in it;
  // the real setting lives in IndexedDB with the others, where the service worker reads it.
  let lang = I.resolve(T.DEFAULTS.lang);
  try { lang = I.resolve(localStorage.getItem('tempmon-lang') || 'auto'); } catch (e) { /* storage blocked */ }
  const t = (k, v) => I.t(lang, k, v);
  const f = (x) => I.temp(lang, x);
  const when = (ms) => I.dateTime(lang, ms);
  const ago = (ms) => I.ago(lang, ms);
  function wifi(rssi) {
    if (rssi == null) return '';
    const q = t('wifiQ')[rssi >= -60 ? 0 : rssi >= -70 ? 1 : rssi >= -80 ? 2 : 3];
    return t('wifi', { rssi, q });
  }

  // Put the static texts of the page into the current language.
  function applyLang() {
    document.documentElement.lang = lang;
    T.set('uiLang', lang).catch(() => {}); // for notifications sent by the service worker
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      const [attrs, key] = el.dataset.i18nAttr.split(':');
      for (const a of attrs.split(',')) el.setAttribute(a, t(key));
    });
    $('langAuto').textContent = t('langAuto', { name: I.NAMES[I.deviceLang()] });
  }

  async function setLang(setting) {
    settings.lang = setting;
    lang = I.resolve(setting);
    try { localStorage.setItem('tempmon-lang', setting); } catch (e) { /* storage blocked */ }
    const stored = Object.assign({}, await T.getSettings(), { lang: setting }); // keep unsaved form edits out
    await T.set('settings', stored);
    applyLang();
    showNow();
    draw();
    if (!$('settings').hidden) renderStatus();
  }

  // ---- data -----------------------------------------------------------------------------------
  async function loadRange(r) {
    const R = RANGES[r], now = Date.now(), s = series[r];
    if (!R.avg) {
      // Raw 2-min points for 24 h: fetch only what is new since the last download.
      const from = now - R.h * 3600e3;
      if (s && s.pts.length && now - s.fetched < POLL_MS - 5e3) return;
      const start = s && s.pts.length ? s.pts[s.pts.length - 1][0] + 1000 : from;
      const add = await T.fetchSeries({ start });
      const pts = (s ? s.pts : []).concat(add.filter((p) => !s || !s.pts.length || p[0] > s.pts[s.pts.length - 1][0]))
        .filter((p) => p[0] >= from);
      series[r] = { pts, fetched: now };
      T.set('raw24', series[r]).catch(() => {});
      return;
    }
    if (s && now - s.fetched < Math.max(R.avg, 10) * 60e3) return;
    series[r] = { pts: await T.fetchSeries({ days: R.h / 24, average: R.avg }), fetched: now };
  }

  async function refresh() {
    if (!T.CHANNEL) return;
    try {
      const [l] = await Promise.all([T.fetchLast(), loadRange(range)]);
      last = l;
      T.set('last', l).catch(() => {});
    } catch (e) {
      $('upd').textContent = t('unreachable');
      $('upd').className = 'mut warn';
      draw();
      return;
    }
    showNow();
    draw();
    if (settings.enabled && 'Notification' in self && Notification.permission === 'granted') {
      await T.check('app');
      renderStatus();
    }
  }

  function showNow() {
    if (!last) return;
    $('now').textContent = f(last.v);
    const age = Date.now() - last.t;
    const stale = age > (settings.offlineMin || 30) * 60e3;
    $('upd').textContent = t(stale ? 'noDataSince' : 'lastReading', { time: when(last.t), ago: ago(age) }) + wifi(last.rssi);
    $('upd').className = stale ? 'mut warn' : 'mut';
  }

  // ---- chart (same look as the board's own page) ------------------------------------------------
  function draw() {
    const R = RANGES[range], s = series[range], now = Date.now();
    const svg = $('c');
    const p = s ? s.pts.filter((q) => q[0] >= now - R.h * 3600e3) : [];
    const vals = p.map((q) => q[1]);
    const st = $('stats');
    $('res').textContent = R.avg ? t('resAvg', { n: R.avg }) : t('resRaw');
    if (!vals.length) {
      st.innerHTML = '<span class="mut">' + (s ? t('noRange') : t('loading')) + '</span>';
      svg.innerHTML = '';
      $('legend').hidden = true;
      return;
    }
    const min = Math.min(...vals), max = Math.max(...vals), avg = vals.reduce((a, b) => a + b) / vals.length;
    const label = t('r' + range);
    st.innerHTML = '<div><span class="mut">' + t('min', { r: label }) + '</span><b>' + f(min) + '</b></div>' +
      '<div><span class="mut">' + t('max', { r: label }) + '</span><b>' + f(max) + '</b></div>' +
      '<div><span class="mut">' + t('avg') + '</span><b>' + f(avg) + '</b></div>';

    // Draw in real pixels so the axis labels stay readable on a phone.
    const W = Math.round(svg.clientWidth) || 700, Ht = 260, L = 36, Rm = 8, Tm = 10, B = 24;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + Ht);
    // Zoom to the data when the channel has less history than the selected range.
    const from = Math.min(Math.max(now - R.h * 3600e3, p[0][0]), now - 600e3);
    let lo = Math.floor(min - 0.5), hi = Math.ceil(max + 0.5);
    // Show the user's limits when they are reasonably close to the data.
    const limits = [];
    if (settings.low != null) limits.push(['low', settings.low]);
    if (settings.high != null) limits.push(['high', settings.high]);
    const shown = limits.filter(([, v]) => v >= min - 5 && v <= max + 5);
    for (const [, v] of shown) { lo = Math.min(lo, Math.floor(v - 0.5)); hi = Math.max(hi, Math.ceil(v + 0.5)); }

    const x = (t) => L + (t - from) / (now - from) * (W - L - Rm);
    const y = (v) => Tm + (hi - v) / (hi - lo) * (Ht - Tm - B);
    let g = '';
    const stp = Math.max(1, Math.ceil((hi - lo) / 5));
    for (let v = lo; v <= hi; v += stp) {
      g += '<line x1="' + L + '" x2="' + (W - Rm) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--line)"/>' +
        '<text x="' + (L - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '°</text>';
    }
    // Time grid: the smallest step (10 min … 2 weeks) giving at most 4–6 lines, aligned to local time.
    const DT = [6e5, 18e5, 36e5, 108e5, 216e5, 432e5, 864e5, 1728e5, 3456e5, 6048e5, 12096e5];
    const maxLines = W < 500 ? 4 : 6;
    const dt = DT.find((d) => (now - from) / d <= maxLines) || DT[DT.length - 1];
    const o = new Date().getTimezoneOffset() * 6e4;
    for (let t = Math.ceil((from - o) / dt) * dt + o; t < now; t += dt) {
      const d = new Date(t);
      const lab = dt < 864e5 ? d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') : d.getDate() + '.' + (d.getMonth() + 1) + '.';
      g += '<line x1="' + x(t) + '" x2="' + x(t) + '" y1="' + Tm + '" y2="' + (Ht - B) + '" stroke="var(--line)"/>' +
        '<text x="' + x(t) + '" y="' + (Ht - 6) + '" text-anchor="middle">' + lab + '</text>';
    }
    for (const [k, v] of shown) {
      g += '<line x1="' + L + '" x2="' + (W - Rm) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--' + k +
        ')" stroke-width="1.5" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/>';
    }
    // Break the line where points are missing (sensor or internet outage).
    const gap = (R.avg ? R.avg * 60e3 : T.STEP_MS) * 3;
    let path = '', prev = null;
    for (const [t, v] of p) {
      path += (prev != null && t - prev <= gap ? 'L' : 'M') + x(t).toFixed(1) + ' ' + y(v).toFixed(1);
      prev = t;
    }
    svg.innerHTML = g + '<path d="' + path + '" fill="none" stroke="var(--acc)" stroke-width="2" vector-effect="non-scaling-stroke"/>';

    const lg = $('legend');
    lg.hidden = !limits.length;
    lg.innerHTML = limits.map(([k, v]) => '<span><i style="border-color:var(--' + k + ')"></i>' +
      t(k === 'low' ? 'lowLine' : 'highLine', { v: f(v) }) + (shown.some((q) => q[0] === k) ? '' : t('offChart')) + '</span>').join('');
  }

  // ---- settings -------------------------------------------------------------------------------
  const num = (id) => { const v = $(id).value.trim(); return v === '' || isNaN(+v) ? null : +v; };

  function fillForm() {
    $('enabled').checked = settings.enabled;
    $('low').value = settings.low ?? '';
    $('high').value = settings.high ?? '';
    $('offlineMin').value = settings.offlineMin ?? '';
    $('hyst').value = settings.hyst;
    $('recover').checked = settings.recover;
    $('lang').value = settings.lang || 'auto';
  }

  async function backgroundSync(on) {
    const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
    if (!reg || !('periodicSync' in reg)) return;
    try {
      if (on) await reg.periodicSync.register('tempmon-check', { minInterval: 15 * 60e3 });
      else await reg.periodicSync.unregister('tempmon-check');
    } catch (e) { /* not allowed (e.g. not installed); status shows it */ }
  }

  async function save() {
    // Ask for permission first, while we still have the click (Safari requires it).
    const wantOn = $('enabled').checked;
    let perm = 'Notification' in self ? Notification.permission : 'unsupported';
    if (wantOn && perm === 'default') perm = await Notification.requestPermission();
    // Take the language from the selector itself, in case its change event never ran.
    const chosen = $('lang').value;
    if (chosen !== settings.lang) await setLang(chosen);

    const next = {
      enabled: wantOn,
      low: num('low'),
      high: num('high'),
      offlineMin: num('offlineMin'),
      hyst: Math.max(0, num('hyst') ?? T.DEFAULTS.hyst),
      recover: $('recover').checked,
      lang: chosen,
    };
    if (next.offlineMin != null) next.offlineMin = Math.max(10, next.offlineMin);
    if (next.low != null && next.high != null && next.low >= next.high) {
      $('saved').textContent = t('lowHigh');
      return;
    }
    settings = next;
    await T.set('settings', settings);
    await T.set('alertState', {}); // re-evaluate from scratch so new limits apply right away
    fillForm();
    await backgroundSync(settings.enabled && perm === 'granted');
    $('saved').textContent = t(!settings.enabled ? 'savedOff' : perm === 'granted' ? 'savedOn' : 'savedNoPerm');
    showNow();
    draw();
    if (settings.enabled && perm === 'granted') await T.check('app');
    renderStatus();
  }

  async function renderStatus() {
    const rows = [];
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    let n;
    const warn = (s) => '<span class="warn">' + s + '</span>';
    if (!('Notification' in self)) n = warn(t(ios && !standalone ? 'stIosHome' : 'stUnsupported'));
    else if (Notification.permission === 'granted') n = '<span class="ok">' + t('stAllowed') + '</span>';
    else if (Notification.permission === 'denied') n = warn(t('stBlocked'));
    else n = t('stNotAsked');
    rows.push([t('stNotif'), n]);

    let bg = warn(t('bgUnsupported'));
    const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
    if (reg && 'periodicSync' in reg) {
      let state = 'prompt';
      try { state = (await navigator.permissions.query({ name: 'periodic-background-sync' })).state; } catch (e) { /* ignore */ }
      const tags = await reg.periodicSync.getTags().catch(() => []);
      if (!settings.enabled) bg = t('bgOff');
      else if (state !== 'granted') bg = warn(t('bgNotAllowed') + ' ' + t(standalone ? 'bgNoGrant' : 'bgInstall') + ' ' + t('bgOnlyOpen'));
      else if (tags.includes('tempmon-check')) bg = '<span class="ok">' + t('bgActive') + '</span> ' + t('bgActiveHelp');
      else bg = warn(t('bgNotRegistered'));
    }
    rows.push([t('stBg'), bg]);

    const fmtCheck = (c) => !c ? t('never') : when(c.t) + ' (' + ago(Date.now() - c.t) + ')' +
      (c.ok ? ', ' + (c.alerts ? t('checkAlerts', c.alerts) : t('checkOk')) : warn(', ' + t('checkFailed', { e: c.error })));
    rows.push([t('stLast'), fmtCheck(await T.get('lastCheck'))]);
    rows.push([t('stLastBg'), fmtCheck(await T.get('lastBackgroundCheck'))]);
    $('status').innerHTML = rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
  }

  async function test() {
    let perm = 'Notification' in self ? Notification.permission : 'unsupported';
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') { renderStatus(); $('saved').textContent = t('notAllowed'); return; }
    await T.notify('test', t('nTestTitle'), t('nTestBody', { v: f(last && last.v) }));
    renderStatus();
  }

  function openSettings(show) {
    $('settings').hidden = !show;
    if (show) { fillForm(); $('saved').textContent = ''; renderStatus(); $('settings').scrollIntoView({ behavior: 'smooth' }); }
  }

  // ---- start ----------------------------------------------------------------------------------
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    range = b.dataset.r;
    document.querySelectorAll('#tabs button').forEach((z) => z.classList.toggle('on', z === b));
    draw();
    loadRange(range).then(draw).catch(() => {});
  });
  $('openSettings').onclick = () => openSettings($('settings').hidden);
  $('closeSettings').onclick = () => openSettings(false);
  $('save').onclick = () => save().catch((e) => { $('saved').textContent = t('saveFailed', { e: e.message }); });
  $('test').onclick = () => test().catch((e) => { $('saved').textContent = t('notifyFailed', { e: e.message }); });
  const onLang = () => { if ($('lang').value !== settings.lang) setLang($('lang').value).catch(() => {}); };
  $('lang').addEventListener('change', onLang);
  $('lang').addEventListener('input', onLang);

  let rz = null;
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(draw, 150); });

  let timer = null;
  function schedule() {
    clearInterval(timer);
    if (document.visibilityState === 'visible') timer = setInterval(refresh, POLL_MS);
  }
  document.addEventListener('visibilitychange', () => {
    schedule();
    if (document.visibilityState === 'visible') refresh();
  });

  (async () => {
    applyLang();
    $('upd').textContent = t('loading');
    if (!T.CHANNEL) {
      $('now').textContent = '–';
      $('upd').textContent = t('noChannel');
      $('upd').className = 'mut warn';
      $('stats').innerHTML = '';
      return;
    }
    // Pass ?channel= on to the service worker too (only used when running unbuilt, locally).
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js' + location.search).catch(() => {});
    try {
      settings = await T.getSettings();
      if (I.resolve(settings.lang) !== lang) { lang = I.resolve(settings.lang); applyLang(); }
      try { localStorage.setItem('tempmon-lang', settings.lang); } catch (e) { /* storage blocked */ }
      const raw = await T.get('raw24');
      if (raw) series['1d'] = raw;
      last = await T.get('last');
    } catch (e) { /* private mode without IndexedDB: still works, nothing saved */ }
    showNow();
    draw();
    await refresh();
    schedule();
  })();
})();
