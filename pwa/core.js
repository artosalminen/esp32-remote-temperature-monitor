// Shared by the page (app.js) and the service worker (sw.js): ThingSpeak access, the settings
// store (IndexedDB, so the service worker can read it too) and the alert check.
// Classic script (not a module) so it also loads with importScripts() in every browser.
(function (g) {
  'use strict';

  // The deploy workflow replaces the placeholder with the THINGSPEAK_CHANNEL_ID repository
  // variable. Unreplaced (running from a checkout), the ID comes from ?channel=<id> in the URL.
  const BUILT_CHANNEL = '__THINGSPEAK_CHANNEL_ID__';
  const CHANNEL = /^\d+$/.test(BUILT_CHANNEL) ? BUILT_CHANNEL
    : (new URLSearchParams(g.location.search).get('channel') || '').replace(/\D/g, '') || null;
  const API = 'https://api.thingspeak.com/channels/' + CHANNEL;
  const STEP_MS = 120e3; // the board sends one 2-min average per entry

  const DEFAULTS = {
    enabled: false,   // alerts on this device
    low: null,        // °C, null = off
    high: null,       // °C, null = off
    offlineMin: 60,   // minutes without new data, null = off
    hyst: 0.5,        // °C the value must come back inside a limit before it counts as normal
    recover: true,    // also notify when back to normal
  };

  // ---- tiny IndexedDB key-value store ------------------------------------------------------
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open('tempmon', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return dbp;
  }
  async function get(key) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const r = d.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function set(key, value) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getSettings() {
    return Object.assign({}, DEFAULTS, await get('settings'));
  }

  // ---- ThingSpeak ---------------------------------------------------------------------------
  // ThingSpeak wants "YYYY-MM-DD HH:MM:SS" in UTC for start/end.
  const tsTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('ThingSpeak HTTP ' + r.status);
    const j = await r.json();
    if (j === -1) throw new Error('ThingSpeak refused the request');
    return j;
  }

  // Newest entry: { t: ms, v: °C | null, rssi: dBm | null }.
  async function fetchLast() {
    const j = await getJSON(API + '/feeds/last.json');
    let rssi = j.field2 != null ? +j.field2 : null;
    if (rssi == null) {
      try { const f2 = await getJSON(API + '/fields/2/last.json'); if (f2.field2 != null) rssi = +f2.field2; } catch (e) { /* optional */ }
    }
    return { t: Date.parse(j.created_at), v: j.field1 != null ? +j.field1 : null, rssi };
  }

  // Temperature points as [[ms, °C], …], oldest first.
  //   opts.days + opts.average (minutes) for long ranges, or opts.start (ms) for raw points since then.
  async function fetchSeries(opts) {
    const q = new URLSearchParams();
    if (opts.start != null) q.set('start', tsTime(opts.start));
    if (opts.days != null) q.set('days', opts.days);
    if (opts.average) q.set('average', opts.average);
    q.set('results', 8000);
    const j = await getJSON(API + '/fields/1.json?' + q);
    return (j.feeds || [])
      .map((f) => [Date.parse(f.created_at), f.field1 == null ? null : +f.field1])
      .filter((p) => p[1] != null && !isNaN(p[1]) && isFinite(p[0]));
  }

  // ---- alerts ------------------------------------------------------------------------------
  const fmt = (v) => (v == null ? '–' : v.toFixed(1) + ' °C');
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function ago(ms) {
    const m = Math.round(ms / 60e3);
    if (m < 90) return m + ' min';
    const h = Math.round(m / 60);
    return h < 48 ? h + ' h' : Math.round(h / 24) + ' days';
  }

  function registration() {
    if (g.registration) return Promise.resolve(g.registration); // inside the service worker
    return navigator.serviceWorker.ready;
  }

  async function notify(type, title, body) {
    const reg = await registration();
    await reg.showNotification(title, {
      body,
      tag: 'tempmon-' + type, // a newer alert of the same kind replaces the old one
      renotify: true,
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png',
      data: { url: './' },
    });
  }

  // Evaluate the limits against everything measured since the previous check, so a short dip
  // between two (possibly hours apart) background checks is still caught.
  // source: 'app' | 'background'. Returns the check record that is also stored as 'lastCheck'.
  async function check(source) {
    const s = await getSettings();
    const now = Date.now();
    const rec = { t: now, source, ok: false };
    try {
      const st = (await get('alertState')) || {};
      // Raw points since the previous check (at most 3 days back; the first check looks back 2 h).
      const start = st.seen ? Math.max(st.seen + 1000, now - 3 * 86400e3) : now - 2 * 3600e3;
      const pts = (await fetchSeries({ start })).filter((p) => p[0] > (st.seen || 0));
      if (pts.length) {
        const last = pts[pts.length - 1];
        st.seen = last[0];
        st.lastV = last[1];
      } else if (!st.seen) {
        const l = await fetchLast();
        st.seen = l.t;
        st.lastV = l.v;
      }
      const notes = [];

      if (s.enabled && s.low != null && pts.length) {
        let min = pts[0];
        for (const p of pts) if (p[1] < min[1]) min = p;
        if (st.low !== 'alert' && min[1] < s.low) {
          const back = st.lastV >= s.low + s.hyst;
          notes.push(['low', 'Low temperature: ' + fmt(min[1]),
            'Below your ' + fmt(s.low) + ' limit at ' + clock(min[0]) + (back ? ', now ' + fmt(st.lastV) : '') + '.']);
          st.low = back ? 'ok' : 'alert';
        } else if (st.low === 'alert' && st.lastV >= s.low + s.hyst) {
          st.low = 'ok';
          if (s.recover) notes.push(['low', 'Temperature back to normal', 'Now ' + fmt(st.lastV) + ' (low limit ' + fmt(s.low) + ').']);
        }
      }
      if (s.low == null) st.low = 'ok';

      if (s.enabled && s.high != null && pts.length) {
        let max = pts[0];
        for (const p of pts) if (p[1] > max[1]) max = p;
        if (st.high !== 'alert' && max[1] > s.high) {
          const back = st.lastV <= s.high - s.hyst;
          notes.push(['high', 'High temperature: ' + fmt(max[1]),
            'Above your ' + fmt(s.high) + ' limit at ' + clock(max[0]) + (back ? ', now ' + fmt(st.lastV) : '') + '.']);
          st.high = back ? 'ok' : 'alert';
        } else if (st.high === 'alert' && st.lastV <= s.high - s.hyst) {
          st.high = 'ok';
          if (s.recover) notes.push(['high', 'Temperature back to normal', 'Now ' + fmt(st.lastV) + ' (high limit ' + fmt(s.high) + ').']);
        }
      }
      if (s.high == null) st.high = 'ok';

      const age = now - (st.seen || now);
      if (s.enabled && s.offlineMin != null) {
        if (st.off !== 'alert' && age > s.offlineMin * 60e3) {
          st.off = 'alert';
          notes.push(['offline', 'Sensor offline', 'No new data for ' + ago(age) + '. Last reading ' + fmt(st.lastV) + '.']);
        } else if (st.off === 'alert' && age <= s.offlineMin * 60e3) {
          st.off = 'ok';
          if (s.recover) notes.push(['offline', 'Sensor back online', 'Now ' + fmt(st.lastV) + '.']);
        }
      } else {
        st.off = 'ok';
      }

      await set('alertState', st);
      for (const n of notes) {
        try { await notify(n[0], n[1], n[2]); } catch (e) { /* permission revoked */ }
      }
      rec.ok = true;
      rec.alerts = notes.length;
    } catch (e) {
      rec.error = String(e && e.message || e);
    }
    await set('lastCheck', rec);
    if (source === 'background') await set('lastBackgroundCheck', rec);
    return rec;
  }

  g.Tempmon = { CHANNEL, STEP_MS, DEFAULTS, get, set, getSettings, fetchLast, fetchSeries, check, notify };
})(self);
