// Tempmon public read-only web page + 14-day in-RAM history (2-min averages).
//   GET /              -> HTML page (current temperature + chart)
//   GET /history.json  -> {"now":21.37,"t":1795000000,"age":42,"step":120,"unsent":0,"heap":N,"v":[...]}
//                         (v = °C*100, oldest first, null = gap; t = UTC epoch of newest point,
//                          0 if the clock isn't synced yet; unsent = points waiting for upload;
//                          restore = 0 waiting / 1 loading older history from ThingSpeak / 2 done,
//                          restored = points loaded back)
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

// ---------------------------------------------------------------------------------------------
// Restore after reboot: refill older history from ThingSpeak, newest first, in 6-hour windows.
// Runs in the background once the clock is synced and the first point exists. A failed window is
// retried up to RESTORE_TRIES times and then skipped; nothing else waits for it.
// ---------------------------------------------------------------------------------------------
static constexpr uint32_t RESTORE_WINDOW_S = 6 * 3600;  // ~180 rows, ~6 KB of CSV
static constexpr int RESTORE_TRIES = 3;

enum RestoreState : uint8_t { RESTORE_WAITING = 0, RESTORE_RUNNING = 1, RESTORE_DONE = 2 };
struct Restore {
  RestoreState state{RESTORE_WAITING};
  uint32_t cursor{0};  // UTC end of the next window to fetch (moves back in time)
  uint32_t stop{0};    // oldest time that still fits in the ring buffer
  int fails{0};
  int restored{0};     // points filled in so far
};
inline Restore rst;

// Days since 1970-01-01 for a civil date (UTC), so we don't depend on the TZ setting.
inline int64_t days_from_civil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned) (y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (int64_t) doe - 719468;
}

// Put one restored reading into the slot for its time. Only fills empty slots or extends the
// history backwards; never overwrites a point the board measured itself.
inline void restore_point(uint32_t t, float value) {
  if (hist.last_epoch == 0 || t > hist.last_epoch) return;
  long k = lroundf((float) (hist.last_epoch - t) / STEP_S);  // age in steps from the newest point
  if (k < 0 || k >= HIST_N) return;
  int16_t v = (int16_t) lroundf(value * 100.0f);
  auto slot = [](long age) { return (hist.head - 1 - age + 2 * HIST_N) % HIST_N; };
  if (k < hist.count) {
    if (hist.v[slot(k)] == GAP) { hist.v[slot(k)] = v; rst.restored++; }
    return;
  }
  for (long j = hist.count; j < k; j++) hist.v[slot(j)] = GAP;  // unknown in between
  hist.v[slot(k)] = v;
  hist.count = k + 1;
  rst.restored++;
}

// True when a restore request should be made now. Starts the restore on first call.
inline bool restore_due() {
  if (rst.state == RESTORE_DONE) return false;
  if (rst.state == RESTORE_WAITING) {
    if (hist.count == 0 || hist.last_epoch == 0) return false;  // need a point and a clock
    rst.cursor = hist.last_epoch - (uint32_t) (hist.count - 1) * STEP_S;  // oldest point we have
    rst.stop = hist.last_epoch - (uint32_t) (HIST_N - 1) * STEP_S;
    rst.state = RESTORE_RUNNING;
  }
  if (rst.cursor <= rst.stop) { rst.state = RESTORE_DONE; return false; }
  return true;
}

inline std::string restore_url(const char *channel, const char *read_key) {
  uint32_t start = std::max(rst.stop, rst.cursor > RESTORE_WINDOW_S ? rst.cursor - RESTORE_WINDOW_S : 0u);
  char a[24], b[24];
  time_t ts = start, te = rst.cursor;
  struct tm tm;
  gmtime_r(&ts, &tm);
  strftime(a, sizeof(a), "%Y-%m-%d%%20%H:%M:%S", &tm);
  gmtime_r(&te, &tm);
  strftime(b, sizeof(b), "%Y-%m-%d%%20%H:%M:%S", &tm);
  std::string url = "https://api.thingspeak.com/channels/";
  url += channel;
  url += "/fields/1.csv?start=";
  url += a;
  url += "&end=";
  url += b;
  if (read_key && *read_key) {
    url += "&api_key=";
    url += read_key;
  }
  return url;
}

inline void restore_advance() {
  rst.cursor = rst.cursor > RESTORE_WINDOW_S ? rst.cursor - RESTORE_WINDOW_S : 0;
  rst.fails = 0;
  if (rst.cursor <= rst.stop) rst.state = RESTORE_DONE;
}

// Parse a ThingSpeak CSV window ("created_at,entry_id,field1" rows) and move to the next window.
inline void restore_ok(const std::string &body) {
  size_t pos = 0;
  while (pos < body.size()) {
    size_t eol = body.find('\n', pos);
    if (eol == std::string::npos) break;  // ignore a truncated last line
    std::string line = body.substr(pos, eol - pos);
    pos = eol + 1;
    int y, mo, d, h, mi, s;
    float val;
    if (sscanf(line.c_str(), "%d-%d-%d %d:%d:%d UTC,%*d,%f", &y, &mo, &d, &h, &mi, &s, &val) != 7) continue;
    uint32_t t = (uint32_t) (days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s);
    restore_point(t, val);
  }
  restore_advance();
}

// Request failed: retry the same window a few times, then skip it.
inline void restore_fail() {
  if (++rst.fails >= RESTORE_TRIES) restore_advance();
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
<div class="mut" style="margin-top:8px">2-min averages kept on the device for 14 days; after a power cut, older history is reloaded from the cloud.</div>
</main><script>
let D=null,H=24;
const f=x=>x==null?'–':x.toFixed(1)+' °C';
function draw(){if(!D)return;const now=Date.now(),end=D.t?D.t*1000:now-D.age*1000,n=D.v.length,
pts=D.v.map((v,i)=>[end-(n-1-i)*D.step*1000,v==null?null:v/100]),
p=pts.filter(q=>q[0]>=now-H*3600e3),vals=p.filter(q=>q[1]!=null).map(q=>q[1]);
const s=document.getElementById('stats');
s.innerHTML=vals.length?`<div><span class="mut">Min (${H} h)</span><b>${f(Math.min(...vals))}</b></div><div><span class="mut">Max (${H} h)</span><b>${f(Math.max(...vals))}</b></div><div><span class="mut">Average</span><b>${f(vals.reduce((a,b)=>a+b)/vals.length)}</b></div>`:'<span class="mut">No history yet — first point after 2 min.</span>';
const svg=document.getElementById('c'),W=700,Ht=260,L=40,R=8,T=10,B=24;
if(!vals.length){svg.innerHTML='';return}
// Zoom to the data when the history is shorter than the selected range (e.g. after a power cut).
const from=Math.min(Math.max(now-H*3600e3,p[0][0]),now-600e3);
let lo=Math.floor(Math.min(...vals)-0.5),hi=Math.ceil(Math.max(...vals)+0.5);
const x=t=>L+(t-from)/(now-from)*(W-L-R),y=v=>T+(hi-v)/(hi-lo)*(Ht-T-B);
let g='',st=Math.max(1,Math.ceil((hi-lo)/5));
for(let v=lo;v<=hi;v+=st)g+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L-6}" y="${y(v)+4}" text-anchor="end">${v}°</text>`;
// Time grid: the smallest step (10 min … 2 days) that gives at most 6 lines, aligned to local time.
const DT=[6e5,18e5,36e5,108e5,216e5,432e5,864e5,1728e5],dt=DT.find(d=>(now-from)/d<=6)||DT[7],o=new Date().getTimezoneOffset()*6e4;
for(let t=Math.ceil((from-o)/dt)*dt+o;t<now;t+=dt){const d=new Date(t),lab=dt<864e5?d.getHours()+':'+String(d.getMinutes()).padStart(2,'0'):d.getDate()+'.'+(d.getMonth()+1)+'.';
g+=`<line x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${Ht-B}" stroke="var(--line)"/><text x="${x(t)}" y="${Ht-6}" text-anchor="middle">${lab}</text>`}
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
    len += snprintf(buf + len, sizeof(buf) - len,
                    ",\"t\":%u,\"age\":%u,\"step\":%d,\"unsent\":%d,\"restore\":%d,\"restored\":%d,\"heap\":%u,\"v\":[",
                    (unsigned) hist.last_epoch, (unsigned) age, STEP_S, hist.unsent, (int) rst.state, rst.restored,
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
