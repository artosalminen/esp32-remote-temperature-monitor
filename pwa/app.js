// Tempmon PWA page: current reading, chart, alert settings and their status.
(function () {
  'use strict';
  const T = self.Tempmon;
  const $ = (id) => document.getElementById(id);

  // Chart ranges. Long ranges use ThingSpeak's server-side averaging so a download stays < 1000 points.
  const RANGES = {
    '1d': { h: 24, label: '24 h' },
    '3d': { h: 72, label: '3 days', avg: 10 },
    '7d': { h: 168, label: '7 days', avg: 15 },
    '14d': { h: 336, label: '14 days', avg: 30 },
    '30d': { h: 720, label: '30 days', avg: 60 },
    '90d': { h: 2160, label: '90 days', avg: 240 },
  };
  const POLL_MS = 120e3; // the board sends a point every 2 min

  let range = '1d';
  let last = null; // { t, v, rssi }
  let settings = Object.assign({}, T.DEFAULTS);
  const series = {}; // range -> { pts: [[ms, °C]], fetched: ms }

  const f = (x) => (x == null ? '–' : x.toFixed(1) + ' °C');
  const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  function ago(ms) {
    const m = Math.round(ms / 60e3);
    if (m < 1) return 'just now';
    if (m < 90) return m + ' min ago';
    const h = Math.round(m / 60);
    return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago';
  }
  function wifi(rssi) {
    if (rssi == null) return '';
    const q = rssi >= -60 ? 'excellent' : rssi >= -70 ? 'good' : rssi >= -80 ? 'fair' : 'weak';
    return ' · WiFi ' + rssi + ' dBm (' + q + ')';
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
    try {
      const [l] = await Promise.all([T.fetchLast(), loadRange(range)]);
      last = l;
      T.set('last', l).catch(() => {});
    } catch (e) {
      $('upd').textContent = 'Can’t reach ThingSpeak — showing saved data, retrying…';
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
    $('upd').textContent = (stale ? 'No new data since ' : 'Last reading ') + when(last.t) + ' (' + ago(age) + ')' + wifi(last.rssi);
    $('upd').className = stale ? 'mut warn' : 'mut';
  }

  // ---- chart (same look as the board's own page) ------------------------------------------------
  function draw() {
    const R = RANGES[range], s = series[range], now = Date.now();
    const svg = $('c');
    const p = s ? s.pts.filter((q) => q[0] >= now - R.h * 3600e3) : [];
    const vals = p.map((q) => q[1]);
    const st = $('stats');
    $('res').textContent = R.avg
      ? 'Showing ' + R.avg + '-min averages from ThingSpeak.'
      : 'Showing the 2-min averages the sensor sends.';
    if (!vals.length) {
      st.innerHTML = '<span class="mut">' + (s ? 'No data in this range.' : 'Loading…') + '</span>';
      svg.innerHTML = '';
      $('legend').hidden = true;
      return;
    }
    const min = Math.min(...vals), max = Math.max(...vals), avg = vals.reduce((a, b) => a + b) / vals.length;
    st.innerHTML = '<div><span class="mut">Min (' + R.label + ')</span><b>' + f(min) + '</b></div>' +
      '<div><span class="mut">Max (' + R.label + ')</span><b>' + f(max) + '</b></div>' +
      '<div><span class="mut">Average</span><b>' + f(avg) + '</b></div>';

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
      (k === 'low' ? 'Low' : 'High') + ' limit ' + f(v) + (shown.some((q) => q[0] === k) ? '' : ' (off chart)') + '</span>').join('');
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

    const next = {
      enabled: wantOn,
      low: num('low'),
      high: num('high'),
      offlineMin: num('offlineMin'),
      hyst: Math.max(0, num('hyst') ?? T.DEFAULTS.hyst),
      recover: $('recover').checked,
    };
    if (next.offlineMin != null) next.offlineMin = Math.max(10, next.offlineMin);
    if (next.low != null && next.high != null && next.low >= next.high) {
      $('saved').textContent = 'The low limit must be below the high limit.';
      return;
    }
    settings = next;
    await T.set('settings', settings);
    await T.set('alertState', {}); // re-evaluate from scratch so new limits apply right away
    fillForm();
    await backgroundSync(settings.enabled && perm === 'granted');
    $('saved').textContent = !settings.enabled ? 'Saved. Alerts are off.'
      : perm === 'granted' ? 'Saved. Alerts are on.'
      : 'Saved, but notifications are not allowed on this device (see status below).';
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
    if (!('Notification' in self)) n = ios && !standalone ? '<span class="warn">Add this app to the Home Screen first (Share → Add to Home Screen), then open it from there.</span>' : '<span class="warn">Not supported by this browser.</span>';
    else if (Notification.permission === 'granted') n = '<span class="ok">Allowed</span>';
    else if (Notification.permission === 'denied') n = '<span class="warn">Blocked. Allow notifications for this site in the browser or system settings.</span>';
    else n = 'Not asked yet. Turn alerts on and press Save.';
    rows.push(['Notifications', n]);

    let bg = '<span class="warn">Not supported by this browser. Limits are checked only while the app is open.</span>';
    const reg = 'serviceWorker' in navigator && await navigator.serviceWorker.getRegistration();
    if (reg && 'periodicSync' in reg) {
      let state = 'prompt';
      try { state = (await navigator.permissions.query({ name: 'periodic-background-sync' })).state; } catch (e) { /* ignore */ }
      const tags = await reg.periodicSync.getTags().catch(() => []);
      if (!settings.enabled) bg = 'Off (alerts are off).';
      else if (state !== 'granted') bg = '<span class="warn">Not allowed. ' + (standalone ? 'The browser hasn’t allowed background checks for this app.' : 'Install the app (browser menu → Install app / Add to Home screen) to enable them.') + ' Limits are checked only while the app is open.</span>';
      else if (tags.includes('tempmon-check')) bg = '<span class="ok">Active.</span> The browser decides how often it runs, typically every 1–12 h depending on how much you use the app and on battery saving.';
      else bg = '<span class="warn">Not registered. Press Save to try again.</span>';
    }
    rows.push(['Background checks', bg]);

    const fmtCheck = (c) => !c ? 'Never' : when(c.t) + ' (' + ago(Date.now() - c.t) + ')' +
      (c.ok ? (c.alerts ? ', ' + c.alerts + ' alert(s) sent' : ', OK') : '<span class="warn">, failed: ' + c.error + '</span>');
    rows.push(['Last check', fmtCheck(await T.get('lastCheck'))]);
    rows.push(['Last background check', fmtCheck(await T.get('lastBackgroundCheck'))]);
    $('status').innerHTML = rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
  }

  async function test() {
    let perm = 'Notification' in self ? Notification.permission : 'unsupported';
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') { renderStatus(); $('saved').textContent = 'Notifications are not allowed on this device.'; return; }
    await T.notify('test', 'Tempmon test', 'Notifications work on this device. Now ' + f(last && last.v) + '.');
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
  $('save').onclick = () => save().catch((e) => { $('saved').textContent = 'Could not save: ' + e.message; });
  $('test').onclick = () => test().catch((e) => { $('saved').textContent = 'Could not notify: ' + e.message; });

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
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    try {
      settings = await T.getSettings();
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
