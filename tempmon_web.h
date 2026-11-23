// Tempmon public read-only web page + 14-day in-RAM history (2-min averages).
//   GET /              -> HTML page (current temperature + chart)
//   GET /history.json  -> {"now":21.37,"t":1795000000,"age":42,"step":120,"unsent":0,"heap":N,"v":[...]}
//                         (v = °C*100, oldest first, null = gap; t = UTC epoch of newest point,
//                          0 if the clock isn't synced yet; unsent = points waiting for upload)
// Only serves while the board is connected to WiFi as a client, so it never
// shadows the captive portal in fallback-hotspot mode. History is lost on reboot.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstring>
#include <ctime>
#include <string>
#include <esp_http_server.h>
#include <esp_system.h>
#include "esphome/core/hal.h"
#include "esphome/components/wifi/wifi_component.h"
#include "esphome/components/web_server_base/web_server_base.h"

namespace tempmon {

using esphome::web_server_idf::AsyncWebHandler;
using esphome::web_server_idf::AsyncWebServerRequest;

static constexpr int STEP_S = 120;                      // one point per 2 min (must match the YAML interval)
static constexpr int HIST_N = 14 * 24 * 3600 / STEP_S;  // 14 days = 10080 points = 20 KB
static constexpr int16_t GAP = INT16_MIN;

static constexpr int UPLOAD_BATCH = 100;  // points per ThingSpeak bulk update (~7 KB JSON)

struct History {
  int16_t v[HIST_N];
  int head{0};          // next write position
  int count{0};         // stored samples
  uint32_t last_ms{0};  // millis() of newest point
  uint32_t last_epoch{0};  // UTC epoch of newest point (0 = clock never synced)
  int unsent{0};        // newest N points not yet accepted by ThingSpeak
  int inflight{0};      // points in the upload currently being sent
  float sum{0};
  int n{0};
  float current{NAN};
};
inline History hist;

// Feed every sensor reading (e.g. once a minute).
inline void add_reading(float x) {
  hist.current = x;
  if (!std::isnan(x)) {
    hist.sum += x;
    hist.n++;
  }
}

// Close the current 2-min window. epoch = current UTC time from SNTP, or 0 if not synced.
// Points are exactly STEP_S apart, so one timestamp on the newest point dates them all.
inline void commit(uint32_t epoch) {
  float mean = hist.n ? hist.sum / hist.n : NAN;
  hist.sum = 0;
  hist.n = 0;
  if (hist.count == 0 && std::isnan(mean))
    return;  // don't start the history with a gap (interval fires right after boot)
  hist.v[hist.head] = std::isnan(mean) ? GAP : (int16_t) lroundf(mean * 100.0f);
  hist.head = (hist.head + 1) % HIST_N;
  if (hist.count < HIST_N) hist.count++;
  hist.last_ms = esphome::millis();
  if (epoch)
    hist.last_epoch = epoch;
  else if (hist.last_epoch)
    hist.last_epoch += STEP_S;  // clock was synced before; keep counting
  if (hist.unsent < hist.count) hist.unsent++;
}

// Build a ThingSpeak bulk_update body with the oldest pending points (up to UPLOAD_BATCH),
// each stamped with its measurement time. Returns "" if there is nothing to send yet.
// The newest point also carries the current WiFi RSSI as field2.
inline std::string build_upload(const char *write_key, float rssi) {
  hist.inflight = 0;
  if (hist.unsent == 0 || hist.last_epoch == 0)
    return "";  // nothing pending, or no clock yet (timestamps unknown)
  int n = std::min(hist.unsent, UPLOAD_BATCH);
  std::string body = "{\"write_api_key\":\"";
  body += write_key;
  body += "\",\"updates\":[";
  bool any = false;
  char item[96], ts[24];
  for (int k = hist.unsent - 1; k >= hist.unsent - n; k--) {  // k = age in steps, oldest first
    int16_t v = hist.v[(hist.head - 1 - k + HIST_N) % HIST_N];
    if (v == GAP) continue;
    time_t t = hist.last_epoch - (uint32_t) k * STEP_S;
    struct tm tm;
    gmtime_r(&t, &tm);
    strftime(ts, sizeof(ts), "%Y-%m-%dT%H:%M:%SZ", &tm);
    int len = snprintf(item, sizeof(item), "%s{\"created_at\":\"%s\",\"field1\":\"%.2f\"", any ? "," : "", ts,
                       v / 100.0f);
    if (k == 0 && !std::isnan(rssi))
      len += snprintf(item + len, sizeof(item) - len, ",\"field2\":\"%.0f\"", rssi);
    snprintf(item + len, sizeof(item) - len, "}");
    body += item;
    any = true;
  }
  body += "]}";
  if (!any) {  // batch was all gaps: nothing to send, just skip past them
    hist.unsent -= n;
    return "";
  }
  hist.inflight = n;
  return body;
}

// ThingSpeak accepted the last upload.
inline void upload_ack() {
  hist.unsent = std::max(0, hist.unsent - hist.inflight);
  hist.inflight = 0;
}

static const char PAGE_HTML[] = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Temperature</title>
<style>
:root{--bg:#fff;--fg:#1d2330;--mut:#6b7280;--line:#e5e7eb;--acc:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--fg:#e8eaed;--mut:#9aa0a6;--line:#2a2f36;--acc:#60a5fa}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:20px 16px}
.now{font-size:64px;font-weight:600;letter-spacing:-1px}
.mut{color:var(--mut);font-size:14px}
.stats{display:flex;gap:24px;margin:12px 0 20px;flex-wrap:wrap}
.stats b{display:block;font-size:20px}
.tabs button{background:none;border:1px solid var(--line);color:var(--fg);padding:4px 12px;border-radius:6px;margin-right:6px;cursor:pointer}
.tabs button.on{border-color:var(--acc);color:var(--acc)}
svg{width:100%;height:260px;display:block;margin-top:10px}
svg text{fill:var(--mut);font-size:11px}
</style></head><body><main>
<div class="mut">Current temperature</div>
<div class="now" id="now">–</div>
<div class="mut" id="upd"></div>
<div class="stats" id="stats"></div>
<div class="tabs"><button data-h="24" class="on">24 h</button><button data-h="72">3 days</button><button data-h="168">7 days</button><button data-h="336">14 days</button></div>
<svg id="c" viewBox="0 0 700 260" preserveAspectRatio="none"></svg>
<div class="mut" style="margin-top:8px">2-min averages kept on the device for 14 days; history resets if it loses power.</div>
</main><script>
let D=null,H=24;
const f=x=>x==null?'–':x.toFixed(1)+' °C';
function draw(){if(!D)return;const end=D.t?D.t*1000:Date.now()-D.age*1000,n=D.v.length,
pts=D.v.map((v,i)=>[end-(n-1-i)*D.step*1000,v==null?null:v/100]),from=Date.now()-H*3600e3,
p=pts.filter(q=>q[0]>=from),vals=p.filter(q=>q[1]!=null).map(q=>q[1]);
const s=document.getElementById('stats');
s.innerHTML=vals.length?`<div><span class="mut">Min (${H} h)</span><b>${f(Math.min(...vals))}</b></div><div><span class="mut">Max (${H} h)</span><b>${f(Math.max(...vals))}</b></div><div><span class="mut">Average</span><b>${f(vals.reduce((a,b)=>a+b)/vals.length)}</b></div>`:'<span class="mut">No history yet — first point after 2 min.</span>';
const svg=document.getElementById('c'),W=700,Ht=260,L=40,R=8,T=10,B=24;
if(!vals.length){svg.innerHTML='';return}
let lo=Math.floor(Math.min(...vals)-0.5),hi=Math.ceil(Math.max(...vals)+0.5);
const x=t=>L+(t-from)/(Date.now()-from)*(W-L-R),y=v=>T+(hi-v)/(hi-lo)*(Ht-T-B);
let g='',st=Math.max(1,Math.ceil((hi-lo)/5));
for(let v=lo;v<=hi;v+=st)g+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L-6}" y="${y(v)+4}" text-anchor="end">${v}°</text>`;
const dt=H<=24?6*3600e3:24*3600e3;let t0=new Date(from);t0.setMinutes(0,0,0);
if(dt>6*3600e3)t0.setHours(0);else t0.setHours(Math.ceil(t0.getHours()/6)*6);
for(let t=+t0;t<Date.now();t+=dt)if(t>=from){const d=new Date(t);g+=`<line x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${Ht-B}" stroke="var(--line)"/><text x="${x(t)}" y="${Ht-6}" text-anchor="middle">${H<=24?d.getHours()+':00':d.getDate()+'.'+(d.getMonth()+1)+'.'}</text>`}
let path='',pen=false;for(const[t,v]of p){if(v==null){pen=false;continue}path+=(pen?'L':'M')+x(t).toFixed(1)+' '+y(v).toFixed(1);pen=true}
svg.innerHTML=g+`<path d="${path}" fill="none" stroke="var(--acc)" stroke-width="2" vector-effect="non-scaling-stroke"/>`}
async function load(){try{D=await (await fetch('history.json',{cache:'no-store'})).json();
document.getElementById('now').textContent=f(D.now);
const last=D.v.length?(D.t?new Date(D.t*1000):new Date(Date.now()-D.age*1000)):null;
document.getElementById('upd').textContent=last?'Last 2-min average '+last.toLocaleString([], {dateStyle:'short',timeStyle:'short'}):'Waiting for first reading…';draw()}catch(e){document.getElementById('upd').textContent='Connection lost — retrying…'}}
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{H=+b.dataset.h;document.querySelectorAll('.tabs button').forEach(z=>z.classList.toggle('on',z===b));draw()});
load();setInterval(load,60000);
</script></body></html>)HTML";

class PublicPage : public AsyncWebHandler {
 public:
  bool canHandle(AsyncWebServerRequest *request) const override {
    if (request->method() != HTTP_GET || !esphome::wifi::global_wifi_component->is_connected())
      return false;
    char buf[AsyncWebServerRequest::URL_BUF_SIZE];
    auto url = request->url_to(buf);
    return url == "/" || url == "/history.json";
  }

  void handleRequest(AsyncWebServerRequest *request) override {
    char ubuf[AsyncWebServerRequest::URL_BUF_SIZE];
    auto url = request->url_to(ubuf);
    if (url == "/") {
      request->send(200, "text/html; charset=utf-8", PAGE_HTML);
      return;
    }
    // Stream in small chunks: 2 weeks of points is ~50 KB of JSON, too much to build in RAM.
    httpd_req_t *r = *request;
    httpd_resp_set_type(r, "application/json");
    httpd_resp_set_hdr(r, "Cache-Control", "no-store");
    char buf[CHUNK + 16];
    int len;
    uint32_t age = hist.count ? (esphome::millis() - hist.last_ms) / 1000 : 0;
    if (std::isnan(hist.current))
      len = snprintf(buf, sizeof(buf), "{\"now\":null");
    else
      len = snprintf(buf, sizeof(buf), "{\"now\":%.2f", hist.current);
    len += snprintf(buf + len, sizeof(buf) - len, ",\"t\":%u,\"age\":%u,\"step\":%d,\"unsent\":%d,\"heap\":%u,\"v\":[",
                    (unsigned) hist.last_epoch, (unsigned) age, STEP_S, hist.unsent,
                    (unsigned) esp_get_free_heap_size());
    int count = hist.count, start = (hist.head - count + HIST_N) % HIST_N;
    for (int i = 0; i < count; i++) {
      int16_t v = hist.v[(start + i) % HIST_N];
      len += v == GAP ? snprintf(buf + len, sizeof(buf) - len, "%snull", i ? "," : "")
                      : snprintf(buf + len, sizeof(buf) - len, "%s%d", i ? "," : "", v);
      if (len >= CHUNK) {
        if (httpd_resp_send_chunk(r, buf, len) != ESP_OK)
          return;  // client went away
        len = 0;
      }
    }
    len += snprintf(buf + len, sizeof(buf) - len, "]}");
    httpd_resp_send_chunk(r, buf, len);
    httpd_resp_send_chunk(r, nullptr, 0);
  }

 protected:
  static constexpr int CHUNK = 1024;
};

inline void start_web() {
  auto *base = esphome::web_server_base::global_web_server_base;
  base->add_handler_without_auth(new PublicPage());  // public, read-only
  base->init();
}

}  // namespace tempmon
