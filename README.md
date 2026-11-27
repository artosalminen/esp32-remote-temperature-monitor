# esp32-remote-temperature-monitor

A temperature monitor for a remote site (cabin, garage, shared space…) built on an
ESP32 and a DS18x20 1-Wire sensor, running [ESPHome](https://esphome.io).

- **Anyone on the site's WiFi** opens `http://tempmon.local/` and sees the current
  temperature plus a 24 h / 3 d / 7 d / 14 d chart. No app, no login.
- **You** get the full long-term history in a [ThingSpeak](https://thingspeak.mathworks.com)
  channel, and from there in Home Assistant (or anything else that can read an HTTP API).
- **Anyone, anywhere** can install the phone app at <https://slmnn.fi/tempmon>, a PWA that
  reads the public ThingSpeak channel and sends alerts based on limits set on each phone.
- **No inbound access needed** at the site: no port forwarding, DDNS, VPN or local server.
  The board only makes outgoing HTTPS requests.

![The board's own page: current temperature, min/max/average and a chart](docs/images/local-page.png)

Write-up with background and design notes:
[How to build a remote temperature monitor with ESP32](https://slmnn.fi/posts/how-to-build-a-remote-temperature-monitor-with-esp32/)

## How it works

![Data flow: the sensor feeds the ESP32 at the site, which serves a read-only page to phones on the site WiFi and sends HTTPS uploads to ThingSpeak. Home Assistant at home polls ThingSpeak and sends Telegram alerts. Nothing connects into the site](docs/images/architecture.svg)

- The sensor is read every 30 s; four readings are averaged into one point every 2 minutes.
- Each point goes into a 10 080-slot ring buffer in RAM (14 days, 20 KB) that the local web
  page charts, and is sent to ThingSpeak (field 1 = °C, field 2 = WiFi RSSI in dBm).
- After a power loss or reboot, the local history is loaded back from ThingSpeak, which keeps
  everything.
- The chart zooms to the data it has, so a freshly restarted board doesn't show a nearly empty
  24-hour chart.

### Time and outages

![Upload queue: points measured while the internet is down are queued in RAM and sent in bulk with their original timestamps when the connection returns, so ThingSpeak has no gap](docs/images/upload-queue.svg)

- The board syncs its clock over SNTP (`pool.ntp.org`). Every point is stamped with its
  **measurement time** in UTC; the web page shows it in the viewer's local time.
- Uploads use ThingSpeak's
  [bulk-update API](https://www.mathworks.com/help/thingspeak/bulkwritejsondata.html) with
  `created_at`, so ThingSpeak and Home Assistant get the time it was measured, not the time it arrived.
- If the internet or ThingSpeak is down, points stay queued in RAM. When the connection is back
  they go out in batches of 100 every 20 s, still with their original timestamps. Up to the full
  14 days can be caught up, as long as the board isn't rebooted in between.
- Before the first time sync, points are kept but not uploaded. They are dated and sent once
  the clock is set.

### Restoring history after a reboot

A reboot or power cut empties the RAM buffer, so the board loads its older history back
from ThingSpeak:

- It starts once the clock is synced and the first new point exists.
- It fetches `fields/1.csv` in **6-hour windows, newest first**, one request every 10 s
  (~6 KB each), until the 14-day buffer is covered. That takes about 9 minutes.
- Restored points only go into empty slots and never overwrite what the board measured
  itself. The minutes the board was actually off stay as a gap.
- It never blocks anything. The page, measurements and uploads work normally meanwhile, and
  the chart fills in as windows arrive.
- Only one request is in flight at a time. ESPHome's `http_request` is asynchronous, so a
  timer could otherwise queue the same window twice. A window is accepted only if its whole
  body arrived. A failed window is retried with backoff (20 s up to 5 min) and skipped only
  after 12 failures in a row.
- For a **private** channel, set `ts_read_key` in `tempmon.yaml`'s `substitutions`. A public
  channel needs no key.

### Security model

| Thing | Protection |
|---|---|
| Temperature page `/` and `/history.json` | Public on the site LAN, read-only. There are no settings reachable over the network. |
| WiFi settings | Only via the fallback hotspot *Tempmon Setup*, which is WPA2-protected (`tempmon_ap_password`). |
| Firmware updates (OTA) | Password-protected (`tempmon_ota_password`), and only from the same LAN. |
| Long-term data | ThingSpeak channel: **public** (anyone with the channel ID can read it) or **private** (readers need the *Read API Key*). Writing always needs the *Write API Key*. |

## Hardware

- ESP32 dev board with ESP32-WROOM-32 (NodeMCU-32S, DevKitC or similar)
- DS18S20 or DS18B20 temperature sensor (TO-92 or waterproof probe)
- 4.7 kΩ resistor
- USB power supply

### Wiring

![Wiring: 3V3 to VDD, GND to GND, GPIO13 to DQ, and a 4.7 kΩ pull-up between DQ and VDD. GPIO12 is marked as a strapping pin to avoid](docs/images/wiring.svg)

| DS18x20 | ESP32 |
|---|---|
| GND | GND |
| VDD | 3V3 |
| DATA | **GPIO13** |
| 4.7 kΩ resistor | between DATA and 3V3 |

> **Don't use GPIO12** (labelled D12, next to GND on many boards), even though it's
> conveniently placed. It's a strapping pin: the 1-Wire pull-up holds it HIGH at reset, which
> switches the flash to 1.8 V and the board won't boot. GPIO13 is right next to it on the
> same GND pin. Other safe choices: GPIO4, 16, 17, 25, 26, 27, 32.

## Setup

### 1. ThingSpeak channel

1. Create a free MathWorks account at <https://thingspeak.mathworks.com>.
2. *Channels → New Channel*. Name it, set **Field 1 = `Temperature`** and **Field 2 = `RSSI`**, then save.
   New channels are private by default. To share the data (charts on ThingSpeak, keyless API
   reads), go to *Sharing → Share channel view with everyone*.
3. On the *API Keys* tab, note the **Write API Key** (used by the board) and the
   **Read API Key** (for Home Assistant, only if the channel stays private), plus the **Channel ID**.

The free tier allows 3 million messages a year (~8 200/day). This sends 720 a day.

### 2. Install ESPHome

Any ESPHome install works (Home Assistant add-on, Docker Device Builder, or CLI). For the CLI:

```sh
python -m venv .venv
# Windows: .venv\Scripts\activate    Linux/macOS: source .venv/bin/activate
pip install esphome
```

### 3. Configure

```sh
git clone https://github.com/artosalminen/esp32-remote-temperature-monitor
cd esp32-remote-temperature-monitor
cp secrets.example.yaml secrets.yaml
```

Fill in `secrets.yaml`:

| Key | What |
|---|---|
| `remote_wifi_ssid` / `remote_wifi_password` | WiFi at the site where the monitor will live |
| `wifi_ssid` / `wifi_password` | A second network, e.g. home, for testing and updates before you deploy |
| `tempmon_ap_password` | Password of the fallback setup hotspot (≥ 8 characters) |
| `tempmon_ota_password` | Password for over-the-air updates |
| `thingspeak_write_key` | ThingSpeak *Write API Key* |
| `thingspeak_channel_id` | ThingSpeak channel ID (the number in the channel URL) |

`secrets.yaml` is git-ignored. Never commit it.

### 4. Flash

First flash over USB:

```sh
esphome run tempmon.yaml --device COM6        # or /dev/ttyUSB0 on Linux
```

If it fails with *"Wrong boot mode detected"* (common on NodeMCU boards whose auto-reset
circuit doesn't work), **hold the BOOT button** while the tool says `Connecting....`, and
release it once writing starts.

After that, updates go over WiFi from a computer on the same network:

```sh
esphome run tempmon.yaml --device tempmon.local   # or the board's IP
```

### 5. Test at home

Watch the log (`esphome logs tempmon.yaml`) for:

- `'Temperature': Got Temperature=23.3°C`: the sensor works
- `IP Address: 192.168.x.y`: WiFi works
- `ThingSpeak: uploaded 1 point(s)` every 2 min: data is arriving (check the channel's *Private View*)

Then open `http://tempmon.local/` (or the IP). The chart fills in as 2-minute points arrive.

### 6. Deploy

Plug the board in at the site. It joins whichever of the two configured networks it can see.
If neither is available (new site, changed password), after 1 minute it opens a hotspot:

1. On a phone, join WiFi **`Tempmon Setup`** with `tempmon_ap_password`.
2. The setup page opens automatically (or browse to `http://192.168.4.1`).
3. Pick the local network and enter its password. The board reboots onto it.

The hotspot reappears whenever the WiFi is lost for more than a minute.

**Tip:** `tempmon.local` (mDNS) works on most phones and computers but not every Android or
router. Reserve a fixed IP for the board in the site router's DHCP settings and put a QR code
with `http://<that-ip>/` on the enclosure.

## Phone app (PWA)

`pwa/` is a static Progressive Web App that shows the ThingSpeak data the same way as the board's
own page and lets each user set their own alert limits. It is published by
`.github/workflows/pages.yml` to <https://slmnn.fi/esp32-remote-temperature-monitor/>, and
<https://slmnn.fi/tempmon> redirects there.

<img src="docs/images/pwa.png" alt="The PWA: current temperature, chart with the user's limit lines, and the alert settings with their status" width="320">

- **Data:** current value, min/max/average and a 24 h / 3 d / 7 d / 14 d / 30 d / 90 d chart.
  24 h uses the raw 2-min points. Longer ranges use ThingSpeak's server-side `average`
  (10–240 min), so a download stays under 1 000 points. Also shows the WiFi RSSI.
- **Alerts:** a low limit, a high limit, sensor offline after N minutes, and optionally a
  notification when the value is back to normal (with hysteresis). Every check looks at all
  points measured since the previous check, so a short dip between two checks is still caught.
- **Settings stay on the phone** (IndexedDB). There is no server and no account.
- **Free tier:** reads from a public channel don't count toward ThingSpeak's message limit.
  An open app makes about three small requests every 2 minutes, and only fetches new points.
  Background checks add one request each.

### Background checks: what works where

There is no push server, so checks while the app is closed rely on
[Periodic Background Sync](https://developer.mozilla.org/docs/Web/API/Web_Periodic_Background_Synchronization_API):

| Platform | While the app is open | While the app is closed |
|---|---|---|
| Android, Chrome / Edge, **installed** app | Every 2 min | Yes, when the browser decides: typically every 1–12 h depending on how much the app is used and on battery saving |
| Android, not installed / Firefox | Every 2 min | No |
| iPhone / iPad (Home Screen app, iOS 16.4+) | Every 2 min | No (Safari has no background sync without a push server) |
| Desktop Chrome / Edge, installed | Every 2 min | Yes, while the browser is running |

The settings view shows on each device whether notifications are allowed, whether background
checks are active, and when the last (background) check ran. For reliable, prompt alerts use
the Home Assistant route below, or add a Web Push server later.

To change the channel, edit `CHANNEL` in `pwa/core.js`. After changing app files, bump `VERSION`
in `pwa/sw.js` so installed apps pick up the new version.

## Home Assistant

Home Assistant can't reach the board directly, so it reads from ThingSpeak instead. The
**Scrape** integration does this entirely in the UI, with no YAML.

**1. Add the integration:** *Settings → Devices & services → Add integration → Scrape*.
For the resource, use:

```
https://api.thingspeak.com/channels/<CHANNEL_ID>/feeds.xml?results=1
```

- **Public channel:** no API key is needed.
- **Private channel:** append `&api_key=<READ_API_KEY>`.

Scrape reads XML/HTML, not JSON, so use `feeds.xml`, not `feeds.json`.

**2. Add one sensor per value:** use the integration's *Add entity* button:

| Name | Select | Device class | State class | Unit |
|---|---|---|---|---|
| Tempmon temperature | `feed field1` | Temperature | Measurement | °C |
| Tempmon WiFi signal | `feed field2` | Signal strength | Measurement | dBm |
| Tempmon last measurement | `feed created-at` | Timestamp | – | – |

**3. Refresh rate:** Scrape polls every 10 minutes by default. HA stores the newest point at
each poll; it can't import the 2-minute points in between. Requesting more `results` doesn't
help, since only one value per sensor is used. The full-resolution data stays in ThingSpeak and
on the board's own page.

**4. Charts:** add a *History graph*, *Statistics graph* or tile *trend graph* card.
`Tempmon last measurement` is useful for an alert when the board stops reporting.

**Alternative with YAML access:** a `rest` sensor on `.../fields/1/last.json`.

## Local endpoints

| Path | Returns |
|---|---|
| `/` | The HTML page (works offline, no external scripts) |
| `/history.json` | `{"now":22.75,"t":1795456465,"age":42,"step":120,"unsent":0,"restore":2,"restored":512,"heap":169104,"v":[2288,2280,null,…]}`. `v` holds 2-min averages in °C × 100, oldest first, `null` = no reading. `t` is the UTC epoch of the newest point (`0` before the first time sync). `age` is seconds since that point. `unsent` is the number of points waiting for upload. `restore` is `0` waiting, `1` loading history from ThingSpeak or `2` done; `restored` is how many points were loaded back. `heap` is free memory in bytes (diagnostics). |

## Customising

- **Resolution / length of local history:** `STEP_S` and `HIST_N` in `tempmon_web.h`, and
  the matching `interval:` in `tempmon.yaml`. Each point costs 2 bytes. Around 40 000 points
  (80 KB) is a sensible maximum on an ESP32 that also runs WiFi and HTTPS.
- **Read interval:** `update_interval` of the `dallas_temp` sensor.
- **Different pin:** `one_wire → pin`.
- **Several sensors:** add more `dallas_temp` entries with `address:` (shown in the boot log).

## Files

| File | Purpose |
|---|---|
| `tempmon.yaml` | ESPHome device configuration |
| `tempmon_web.h` | Ring buffer, public web page and JSON endpoint (C++ include) |
| `secrets.example.yaml` | Template for `secrets.yaml` |
| `pwa/` | Phone app (PWA): page, service worker, manifest, icons |
| `.github/workflows/pages.yml` | Publishes `pwa/` to GitHub Pages |
| `docs/images/` | Diagrams and screenshot used in this README |

## License

MIT, see [LICENSE](LICENSE).
