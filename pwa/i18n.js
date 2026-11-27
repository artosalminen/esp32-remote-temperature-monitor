// UI and notification texts in English and Finnish. Loaded by the page and the service worker.
// The language setting is 'auto' (follow the device), 'en' or 'fi'.
(function (g) {
  'use strict';

  const STRINGS = {
    en: {
      current: 'Current temperature',
      loading: 'Loading…',
      settings: 'Settings',
      r1d: '24 h', r3d: '3 days', r7d: '7 days', r14d: '14 days', r30d: '30 days', r90d: '90 days',
      lastReading: 'Last reading {time} ({ago})',
      noDataSince: 'No new data since {time} ({ago})',
      wifi: ' · WiFi {rssi} dBm ({q})',
      wifiQ: ['excellent', 'good', 'fair', 'weak'],
      justNow: 'just now', minAgo: '{n} min ago', hAgo: '{n} h ago', dAgo: '{n} days ago',
      unreachable: 'Can’t reach ThingSpeak — showing saved data, retrying…',
      noChannel: 'No ThingSpeak channel configured. Set the THINGSPEAK_CHANNEL_ID variable for the deploy workflow, or open this page with ?channel=<id> when testing locally.',
      resAvg: 'Showing {n}-min averages from ThingSpeak.',
      resRaw: 'Showing the 2-min averages the sensor sends.',
      noRange: 'No data in this range.',
      min: 'Min ({r})', max: 'Max ({r})', avg: 'Average',
      lowLine: 'Low limit {v}', highLine: 'High limit {v}', offChart: ' (off chart)',

      settingsNote: 'Stored only on this device.',
      language: 'Language',
      langAuto: 'Automatic ({name})',
      alerts: 'Alerts',
      enabled: 'Alerts enabled',
      enabledHelp: 'Notifications on this device when the temperature goes outside your limits.',
      low: 'Low limit (°C)', lowHelp: 'Alert when the temperature drops below this. Leave empty for no limit.',
      high: 'High limit (°C)', highHelp: 'Alert when the temperature rises above this. Leave empty for no limit.',
      offline: 'Sensor offline after (min)', offlineHelp: 'Alert when no new data arrives for this long. Leave empty for no alert.',
      hyst: 'Hysteresis (°C)', hystHelp: 'How far back inside the limit the temperature must come to count as normal again.',
      recover: 'Notify when back to normal',
      off: 'off',
      save: 'Save', test: 'Send test notification', close: 'Close',
      savedOff: 'Saved. Alerts are off.',
      savedOn: 'Saved. Alerts are on.',
      savedNoPerm: 'Saved, but notifications are not allowed on this device (see status below).',
      lowHigh: 'The low limit must be below the high limit.',
      saveFailed: 'Could not save: {e}',
      notifyFailed: 'Could not notify: {e}',
      notAllowed: 'Notifications are not allowed on this device.',

      stNotif: 'Notifications',
      stIosHome: 'Add this app to the Home Screen first (Share → Add to Home Screen), then open it from there.',
      stUnsupported: 'Not supported by this browser.',
      stAllowed: 'Allowed',
      stBlocked: 'Blocked. Allow notifications for this site in the browser or system settings.',
      stNotAsked: 'Not asked yet. Turn alerts on and press Save.',
      stBg: 'Background checks',
      bgUnsupported: 'Not supported by this browser. Limits are checked only while the app is open.',
      bgOff: 'Off (alerts are off).',
      bgNotAllowed: 'Not allowed.',
      bgNoGrant: 'The browser hasn’t allowed background checks for this app.',
      bgInstall: 'Install the app (browser menu → Install app / Add to Home screen) to enable them.',
      bgOnlyOpen: 'Limits are checked only while the app is open.',
      bgActive: 'Active.',
      bgActiveHelp: 'The browser decides how often it runs, typically every 1–12 h depending on how much you use the app and on battery saving.',
      bgNotRegistered: 'Not registered. Press Save to try again.',
      stLast: 'Last check', stLastBg: 'Last background check',
      never: 'Never', checkOk: 'OK',
      checkAlerts: (n) => (n === 1 ? '1 alert sent' : n + ' alerts sent'),
      checkFailed: 'failed: {e}',

      nLowTitle: 'Low temperature: {v}',
      nLowBody: 'Below your {limit} limit at {time}{now}.',
      nHighTitle: 'High temperature: {v}',
      nHighBody: 'Above your {limit} limit at {time}{now}.',
      nNow: ', now {v}',
      nBackTitle: 'Temperature back to normal',
      nBackLow: 'Now {v} (low limit {limit}).',
      nBackHigh: 'Now {v} (high limit {limit}).',
      nOffTitle: 'Sensor offline',
      nOffBody: 'No new data. Last reading {ago}: {v}.',
      nOnTitle: 'Sensor back online',
      nOnBody: 'Now {v}.',
      nTestTitle: 'Tempmon test',
      nTestBody: 'Notifications work on this device. Now {v}.',
    },
    fi: {
      current: 'Lämpötila nyt',
      loading: 'Ladataan…',
      settings: 'Asetukset',
      r1d: '24 h', r3d: '3 vrk', r7d: '7 vrk', r14d: '14 vrk', r30d: '30 vrk', r90d: '90 vrk',
      lastReading: 'Viimeisin lukema {time} ({ago})',
      noDataSince: 'Ei uusia lukemia {time} jälkeen ({ago})',
      wifi: ' · WiFi {rssi} dBm ({q})',
      wifiQ: ['erinomainen', 'hyvä', 'kohtalainen', 'heikko'],
      justNow: 'juuri nyt', minAgo: '{n} min sitten', hAgo: '{n} h sitten', dAgo: '{n} vrk sitten',
      unreachable: 'ThingSpeakiin ei saada yhteyttä – näytetään tallennetut tiedot, yritetään uudelleen…',
      noChannel: 'ThingSpeak-kanavaa ei ole määritetty. Aseta julkaisutyönkululle THINGSPEAK_CHANNEL_ID-muuttuja tai avaa sivu paikallisesti osoitteella ?channel=<id>.',
      resAvg: 'Näytetään ThingSpeakin {n} minuutin keskiarvot.',
      resRaw: 'Näytetään anturin lähettämät 2 minuutin keskiarvot.',
      noRange: 'Ei lukemia tältä aikaväliltä.',
      min: 'Alin ({r})', max: 'Ylin ({r})', avg: 'Keskiarvo',
      lowLine: 'Alaraja {v}', highLine: 'Yläraja {v}', offChart: ' (kaavion ulkopuolella)',

      settingsNote: 'Tallennetaan vain tähän laitteeseen.',
      language: 'Kieli',
      langAuto: 'Automaattinen ({name})',
      alerts: 'Hälytykset',
      enabled: 'Hälytykset käytössä',
      enabledHelp: 'Ilmoitus tähän laitteeseen, kun lämpötila menee asettamiesi rajojen ulkopuolelle.',
      low: 'Alaraja (°C)', lowHelp: 'Hälytys, kun lämpötila laskee tämän alle. Jätä tyhjäksi, jos et halua rajaa.',
      high: 'Yläraja (°C)', highHelp: 'Hälytys, kun lämpötila nousee tämän yli. Jätä tyhjäksi, jos et halua rajaa.',
      offline: 'Anturi ei vastaa (min)', offlineHelp: 'Hälytys, kun uusia lukemia ei ole tullut näin pitkään aikaan. Jätä tyhjäksi, jos et halua hälytystä.',
      hyst: 'Hystereesi (°C)', hystHelp: 'Kuinka paljon rajan sisäpuolelle lämpötilan pitää palata, jotta tilanne on taas normaali.',
      recover: 'Ilmoita, kun tilanne palaa normaaliksi',
      off: 'ei rajaa',
      save: 'Tallenna', test: 'Lähetä testi-ilmoitus', close: 'Sulje',
      savedOff: 'Tallennettu. Hälytykset eivät ole käytössä.',
      savedOn: 'Tallennettu. Hälytykset ovat käytössä.',
      savedNoPerm: 'Tallennettu, mutta ilmoitukset eivät ole sallittuja tässä laitteessa (katso tila alta).',
      lowHigh: 'Alarajan pitää olla pienempi kuin yläraja.',
      saveFailed: 'Tallennus epäonnistui: {e}',
      notifyFailed: 'Ilmoitus epäonnistui: {e}',
      notAllowed: 'Ilmoitukset eivät ole sallittuja tässä laitteessa.',

      stNotif: 'Ilmoitukset',
      stIosHome: 'Lisää sovellus ensin Koti-valikkoon (Jaa → Lisää Koti-valikkoon) ja avaa se sieltä.',
      stUnsupported: 'Tämä selain ei tue niitä.',
      stAllowed: 'Sallittu',
      stBlocked: 'Estetty. Salli tämän sivuston ilmoitukset selaimen tai järjestelmän asetuksista.',
      stNotAsked: 'Lupaa ei ole vielä kysytty. Ota hälytykset käyttöön ja paina Tallenna.',
      stBg: 'Taustatarkistukset',
      bgUnsupported: 'Tämä selain ei tue niitä. Rajat tarkistetaan vain, kun sovellus on auki.',
      bgOff: 'Pois päältä (hälytykset eivät ole käytössä).',
      bgNotAllowed: 'Ei sallittu.',
      bgNoGrant: 'Selain ei ole sallinut taustatarkistuksia tälle sovellukselle.',
      bgInstall: 'Asenna sovellus (selaimen valikko → Asenna sovellus / Lisää aloitusnäytölle), niin ne voidaan ottaa käyttöön.',
      bgOnlyOpen: 'Rajat tarkistetaan vain, kun sovellus on auki.',
      bgActive: 'Käytössä.',
      bgActiveHelp: 'Selain päättää, kuinka usein tarkistus tehdään, yleensä 1–12 tunnin välein. Se riippuu siitä, kuinka paljon käytät sovellusta, ja virransäästöstä.',
      bgNotRegistered: 'Ei rekisteröity. Yritä uudelleen painamalla Tallenna.',
      stLast: 'Viimeisin tarkistus', stLastBg: 'Viimeisin taustatarkistus',
      never: 'Ei koskaan', checkOk: 'OK',
      checkAlerts: (n) => (n === 1 ? '1 hälytys lähetetty' : n + ' hälytystä lähetetty'),
      checkFailed: 'epäonnistui: {e}',

      nLowTitle: 'Matala lämpötila: {v}',
      nLowBody: 'Alitti rajasi {limit} klo {time}{now}.',
      nHighTitle: 'Korkea lämpötila: {v}',
      nHighBody: 'Ylitti rajasi {limit} klo {time}{now}.',
      nNow: ', nyt {v}',
      nBackTitle: 'Lämpötila palasi normaaliksi',
      nBackLow: 'Nyt {v} (alaraja {limit}).',
      nBackHigh: 'Nyt {v} (yläraja {limit}).',
      nOffTitle: 'Anturi ei vastaa',
      nOffBody: 'Ei uusia lukemia. Viimeisin lukema {ago}: {v}.',
      nOnTitle: 'Anturi vastaa taas',
      nOnBody: 'Nyt {v}.',
      nTestTitle: 'Tempmon-testi',
      nTestBody: 'Ilmoitukset toimivat tässä laitteessa. Nyt {v}.',
    },
  };
  const NAMES = { en: 'English', fi: 'Suomi' };

  // The device's language: the first of its preferred languages that we have, else English.
  function deviceLang() {
    const prefs = (g.navigator && (g.navigator.languages || [g.navigator.language])) || [];
    for (const l of prefs) {
      const p = String(l || '').toLowerCase().slice(0, 2);
      if (STRINGS[p]) return p;
    }
    return 'en';
  }
  const resolve = (setting) => (STRINGS[setting] ? setting : deviceLang());

  // Locale for dates and numbers: Finnish formats in Finnish; in English, the device's own
  // English variant (12/24 h etc.), or British English when the device is in another language.
  function locale(lang) {
    if (lang === 'fi') return 'fi-FI';
    const dev = (g.navigator && g.navigator.language) || '';
    return /^en\b/i.test(dev) ? dev : 'en-GB';
  }

  function t(lang, key, vars) {
    let s = (STRINGS[lang] || STRINGS.en)[key];
    if (s == null) s = STRINGS.en[key];
    if (typeof s === 'function') return s(vars);
    if (vars && typeof s === 'string') s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
    return s;
  }

  const temp = (lang, v) => (v == null || isNaN(v) ? '–'
    : new Intl.NumberFormat(locale(lang), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v) + ' °C');

  function ago(lang, ms) {
    const m = Math.round(ms / 60e3);
    if (m < 1) return t(lang, 'justNow');
    if (m < 90) return t(lang, 'minAgo', { n: m });
    const h = Math.round(m / 60);
    return h < 48 ? t(lang, 'hAgo', { n: h }) : t(lang, 'dAgo', { n: Math.round(h / 24) });
  }

  const dateTime = (lang, ms) => new Date(ms).toLocaleString(locale(lang), { dateStyle: 'short', timeStyle: 'short' });
  const clock = (lang, ms) => new Date(ms).toLocaleTimeString(locale(lang), { hour: '2-digit', minute: '2-digit' });

  g.TempmonI18n = { LANGS: Object.keys(STRINGS), NAMES, deviceLang, resolve, locale, t, temp, ago, dateTime, clock };
})(self);
