# esp32-remote-temperature-monitor

A temperature monitor for a remote site (cabin, club house, shared space…) built on an
ESP32 and a DS18x20 1-Wire sensor, running [ESPHome](https://esphome.io).

- **Anyone on the site's WiFi** opens `http://tempmon.local/` and sees the current
  temperature plus a 24 h / 3 d / 7 d / 14 d chart. No app, no login.
- **You** get the full long-term history in a private [ThingSpeak](https://thingspeak.mathworks.com)
  channel, and from there in Home Assistant (or anything else that can read an HTTP API).
- **No inbound access needed** at the site: no port forwarding, DDNS, VPN or local server.
  The board only makes outgoing HTTPS requests.

## How it works

```
                remote site                                 internet / home
┌──────────────────────────────────────┐
│ DS18S20 ─1-Wire─ ESP32 (ESPHome)     │  HTTPS, every 2 min    ┌────────────────┐
│                   │  14 days of      │ ─────────────────────▶ │  ThingSpeak    │
│                   │  2-min averages  │                        │  private chan. │
│                   │  in RAM          │                        └───────┬────────┘
│                   ▼                  │                                │ read API key
│  phones/laptops ◀── http://tempmon.local/                     ┌───────▼────────┐
│  (read-only page + chart)            │                        │ Home Assistant │
└──────────────────────────────────────┘                        └────────────────┘
```

- The sensor is read every 30 s; four readings are averaged into one point every 2 minutes.
- Each point goes into a 10 080-slot ring buffer in RAM (14 days, 20 KB) that the local web
  page charts, and is sent to ThingSpeak (field 1 = °C, field 2 = WiFi RSSI in dBm).
- The local history is lost on power loss/reboot; ThingSpeak keeps everything.

### Security model

| Thing | Protection |
|---|---|
| Temperature page `/` and `/history.json` | Public on the site LAN, read-only. There are no settings reachable over the network. |
| WiFi settings | Only via the fallback hotspot *Tempmon Setup*, which is WPA2-protected (`tempmon_ap_password`). |
| Firmware updates (OTA) | Password-protected (`tempmon_ota_password`), and only from the same LAN. |
| Long-term data | Private ThingSpeak channel; readers need the channel's *Read API Key*. |

## Hardware

- ESP32 dev board with ESP32-WROOM-32 (NodeMCU-32S, DevKitC or similar)
- DS18S20 or DS18B20 temperature sensor (TO-92 or waterproof probe)
- 4.7 kΩ resistor
- USB power supply

### Wiring

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
   New channels are private by default.
3. On the *API Keys* tab, note the **Write API Key** (used by the board) and the
   **Read API Key** (used by Home Assistant), plus the **Channel ID**.

The free tier allows ~8 200 messages/day; this sends 720.

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
- `ThingSpeak: HTTP 200` every 2 min: data is arriving (check the channel's *Private View*)

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

## Home Assistant

Home Assistant can't reach the board directly, so it reads from ThingSpeak instead. With the
**Scrape** integration (UI only, no YAML):

1. *Settings → Devices & services → Add integration → Scrape*
2. Resource: `https://api.thingspeak.com/channels/<CHANNEL_ID>/fields/1/last.xml?api_key=<READ_API_KEY>`
3. Sensor: select `field1`, unit `°C`, device class *Temperature*, state class *Measurement*
4. Set the scan interval to 120 s.

Other options:
- A REST sensor on `.../fields/1/last.json`
- The plain-text endpoint `.../fields/1/last.txt`

Then use a *History graph* or *Statistics graph* card for charts.

## Local endpoints

| Path | Returns |
|---|---|
| `/` | The HTML page (works offline, no external scripts) |
| `/history.json` | `{"now":23.06,"age":42,"step":120,"heap":170908,"v":[2306,2304,null,…]}`. `v` holds 2-min averages in °C × 100, oldest first, `null` = no reading. `age` is seconds since the last point. `heap` is free memory in bytes (diagnostics). |

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

## License

MIT, see [LICENSE](LICENSE).
