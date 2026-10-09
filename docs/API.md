# Integrasi API NBI (Northbound Interface)

NBI adalah REST API ACS TR-069 yang berjalan di **port UI/API** (default
`8080`) — endpoint-nya di bawah `/api/`. Inilah pintu integrasi untuk
sistem lain: OSS/BSS, portal pelanggan, monitoring (Zabbix/Prometheus
push), bot Telegram, script provisioning, dsb.

```
http://<ip-acs>:8080/api     ← NBI (dokumen ini)
http://<ip-acs>:7547/        ← CWMP/TR-069 (untuk perangkat ONT, SOAP)
```

**Catatan penting (port NBI):** ACS ini berjalan dalam **satu proses** untuk CWMP (`:7547`) dan API/UI (`:8080`). Berbeda dengan GenieACS yang memiliki port terpisah 7557 untuk NBI, di ACS ini **semua endpoint REST (Northbound Interface) berada di `http://<acs>:8080/api/`**. Jadi untuk web monitoring yang sebelumnya mengambil data dari `http://<acs>:7557/`, cukup ubah base URL menjadi `http://<acs>:8080/api/`. Fungsionalitasnya setara (read/write devices, tasks, presets, katalog, webhook, dsb.).

## 1. Apakah perlu autentikasi? **YA — wajib**

Hanya dua endpoint yang terbuka tanpa login:

| Endpoint          | Tanpa auth |
|-------------------|------------|
| `GET /api/health` | ya (cek kesehatan) |
| `POST /api/login` | ya (itu memang pintu login) |

**Semua endpoint lain** menjawab `401 {"error":"unauthorized"}` tanpa sesi
yang valid. Setiap request mutasi (`POST`/`PUT`/`DELETE`) juga wajib membawa
header **`x-csrf`**; tanpa itu → `403 {"error":"csrf_token_invalid"}`.

### Alur autentikasi

```
1. POST /api/login        {"username": "...", "password": "..."}
      → Set-Cookie: acs_auth=<token>; HttpOnly; SameSite=Strict; Max-Age=...
      → body: { "username", "role", "csrf": "<token CSRF>" }
2. Simpan cookie, dan kirim "x-csrf: <token CSRF>" pada SEMUA request
   mutasi (POST/PUT/DELETE).
3. Cookie kedaluwarsa setelah ACS_SESSION_TTL (default 8 jam).
   Saat 401 → ulangi langkah 1. Token CSRF segar bisa diambil ulang
   kapan saja via GET /api/me.
```

### Contoh: curl (integrasi server-ke-server)

```bash
ACS=http://172.18.217.222:8080

# 1) login — simpan cookie + ambil csrf
CSRF=$(curl -s -c /tmp/acs.jar -X POST $ACS/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"RAHASIA"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrf"])')

# 2) baca data (GET tidak butuh csrf)
curl -s -b /tmp/acs.jar "$ACS/api/stats"
curl -s -b /tmp/acs.jar "$ACS/api/devices?online=1&limit=20"

# 3) mutasi (POST/PUT/DELETE butuh header x-csrf)
curl -s -b /tmp/acs.jar -X POST "$ACS/api/devices/1234/reboot" \
  -H "x-csrf: $CSRF"
```

### Contoh: Python (requests)

```python
import requests

BASE = "http://172.18.217.222:8080"
s = requests.Session()

r = s.post(f"{BASE}/api/login", json={"username": "admin", "password": "RAHASIA"})
r.raise_for_status()
csrf = r.json()["csrf"]

def post(path, **kw):
    r = s.post(f"{BASE}{path}", headers={"x-csrf": csrf}, **kw)
    if r.status_code == 401:            # sesi habis → login ulang
        csrf = s.post(f"{BASE}/api/login",
                      json={"username": "admin", "password": "RAHASIA"}).json()["csrf"]
        r = s.post(f"{BASE}{path}", headers={"x-csrf": csrf}, **kw)
    r.raise_for_status()
    return r.json()

print(s.get(f"{BASE}/api/stats").json())
```

Catatan: cookie memakai `SameSite=Strict; HttpOnly` — dirancang untuk
browser. Klien server (curl/requests) memperlakukannya sebagai cookie biasa
via cookie-jar, jadi integrasi mesin-ke-mesin tetap jalan.

### Batas laju (rate limit)

| Siapa               | Batas                | Terlampaui |
|---------------------|----------------------|------------|
| Semua `/api/*` per IP | 300 request / menit | `429 {"error":"rate_limited"}` |
| Login per IP        | 10 percobaan / 5 menit | `429` + header `retry-after` (detik) |

Untuk polling monitoring, **≤ 5 request/menit** sudah cukup (mis. ambil
`/api/stats` tiap 60 detik).

### Kode status

| Kode | Arti | Tindakan |
|------|------|----------|
| 200 | sukses | — |
| 400 | body/query tidak valid | periksa payload |
| 401 | tidak login / sesi habis | `POST /api/login` ulang |
| 403 | header `x-csrf` salah | pakai csrf dari login/`/api/me` |
| 413 | payload terlalu besar (batas 10 MB) | kecilkan payload |
| 429 | rate limit | tunggu `retry-after` |

---

## 2. Daftar endpoint

Semua membutuhkan autentikasi kecuali `/api/health` dan `/api/login`.

### Auth & status

| Method | Path | Catatan |
|--------|------|---------|
| POST | `/api/login` | `{username,password}` → cookie + `{username,role,csrf}` |
| POST | `/api/logout` | hapus sesi (butuh `x-csrf`) |
| GET  | `/api/me` | sesi aktif + `csrf` segar |
| GET  | `/api/health` | `{ok:true, uptime}` — **publik** |
| GET  | `/api/stats` | `{devices:{total,online}, queue, sessions, recentEvents[], discoveredClasses[]}` |

### Perangkat

| Method | Path | Query / Body |
|--------|------|--------------|
| GET | `/api/devices` | `?q=` (serial/model/PPPoE/IP/SSID), `?online=1`, `?rxmax=-25` (RX < ambang dBm), `?group=`, `?tag=`, `?limit=` (≤500), `?offset=` → `{items,total}`. Tiap item memuat ringkasan `rx_power`, `tx_power`, `optical_temp`, `pppoe_user`, `pppoe_status`, `wan_ip`, `ssid`, `cpu_usage` (%), `mem_usage` (% RAM terpakai), `data_model` |
| GET | `/api/devices/:id` | detail + parameter terakhir (kredensial CR/CWMP disamarkan → `has_*`) + `insight` `{optical, wan[], wlan[], wcds[], connTypes, system, general, dataModel}` — `system` = `{cpu, cpuSource, memTotalKb, memFreeKb, memUsedPct, memSource}`; `wan[]` memuat `password`, `passwordSource` (`onu`\|`acs`), `passwordAt`; `wlan[]` memuat `passphrase`, `passphraseSource`, `passphraseAt`, `hidden`, `hiddenPath` (lihat [sandi terbuka](#sandi-wifi--pppoe-terbuka)) |
| POST | `/api/devices/:id/refresh` | antrekan baca ulang (path esensial + profil discovery); susulkan `/connect` agar segera Inform |
| POST | `/api/devices/:id/config` | konfigurasi terstruktur, lihat tabel di bawah |
| PUT | `/api/devices/:id` | **admin** — ubah `connection_request_url/user/pass`, `cwmp_user/pass`, `group_name`, `notes` |
| POST | `/api/devices/:id/connect` | kirim Connection Request (ACS → CPE), Digest/Basic. 200 `{ok:true,status,auth}`; ONU gagal dijangkau → **200** `{ok:false,error,reason:'auth'\|'unreachable'\|'http'\|'malformed',url}` (bukan 502, supaya alasannya tidak diganti halaman error proxy; `malformed` = URL/port CR tak valid, mis. FiberHome RP2872 `:1601009200`); 409 belum ada URL; 429 terlalu cepat (≤ 1×/10 dtk) |
| POST | `/api/devices/:id/live` | mulai trafik live `{seconds?: 15–300 (60), intervalSec?: 2–10 (3)}` → status + `cr` (hasil Connection Request) |
| GET | `/api/devices/:id/live` | status `{status: idle\|waiting\|live\|done\|stopped\|error, message, source:{label,rx,tx}, samples:[{t, down, up}] (Mbps), totals}` |
| DELETE | `/api/devices/:id/live` | hentikan trafik live |
| POST | `/api/devices/:id/read` | `{paths:[...]}` — GET Value RPC (partial path berakhiran `.` diizinkan) |
| POST | `/api/devices/:id/write` | `{values:{path: nilai}}` (tipe dari laporan ONU) atau `{params:[{name,type,value}]}` — SET Value RPC |
| POST | `/api/devices/:id/reboot` | antrekan reboot |
| POST | `/api/devices/:id/factory-reset` | **admin**, body `{"confirm":"<serial number>"}` — antrekan reset pabrik |
| POST | `/api/devices/:id/discover` | petakan struktur parameter perangkat |
| POST | `/api/devices/:id/download` | `{url, fileType}` — download firmware/config via ACS |
| POST | `/api/devices/:id/add-object` | `{objectName, parameterKey?}` — AddObject CWMP (antrekan, instanceNumber dikembalikan saat Inform) |
| POST | `/api/devices/:id/delete-object` | `{objectName, parameterKey?}` — DeleteObject CWMP (antrekan) |

#### `POST /api/devices/:id/config`

`target` = path objek koneksi dari `insight.wan[].base` (mis.
`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.`).
Tanpa `target`, dipakai koneksi PPPoE utama. Nama parameter vendor (VLAN,
ServiceList, sandi WiFi) dipilih server dari path yang terbukti ada di
perangkat; tebakan dilaporkan di `guessed`.

| `type` | Field | Aksi |
|--------|-------|------|
| `wifi` | `wlanIndex`, `ssid?`, `passphrase?` (≥8), `wifiEnable?`, `hidden?` | SPV SSID/sandi/aktif pada WLANConfiguration.N (TR-181: WiFi.SSID/AccessPoint). `hidden:true` = sembunyikan SSID (`SSIDAdvertisementEnabled=false`, atau `X_*_SSIDHide=true` bila hanya itu yang dilaporkan ONU); WiFi tetap aktif. Contoh aktif tapi tersembunyi: `{"type":"wifi","wlanIndex":1,"wifiEnable":true,"hidden":true}` |
| `pppoe` | `target?`, `username?`, `password?`, `vlanId?`, `serviceName?` | SPV kredensial; VLAN & ServiceList di SPV terpisah |
| `vlan` | `target?`, `vlanId` | SPV VLAN (level koneksi `X_HW_VLAN`/`X_ZTE-COM_VLANID`/`X_FH_VLANID` atau level link `X_CT-COM_WANGponLinkConfig.VLANIDMark`) |
| `wan-add` | `placement` (`new`/`wcd`/`existing`), `target?` (existing), `wcd?` (wcd), `username`, `password`, `vlanId?`, `name?`, `bridge?`, `connectionType?`, `serviceName?`, `nat?` (default: true untuk INTERNET, false untuk TR069/VOIP), `bindLan?` [1-8], `bindSsid?` [1-8], `sequential?`, `extra?` | WAN internet PPPoE: WCD baru, di dalam WCD yang ada, atau isi slot yang ada (mis. `WCD 2 · #1 · PPPoE_Routed`); SPV standar → SPV vendor satu per satu → `Enable=true`; struktur WAN dipetakan ulang |
| `wan-ip-add` | sama, plus `staticIp?`, `netmask?`, `gateway?`, `dns?` | WAN internet IPoE (DHCP bila tanpa `staticIp`) atau bridge |
| `wan-delete` | `target` | DeleteObject koneksi (atau WCD-nya bila satu-satunya koneksi) |
| `wan-enable` | `target`, `enable` | aktif/nonaktifkan koneksi WAN |
| `wan-bind` | `target`, `bindLan` [1-8], `bindSsid` [1-8] | binding port koneksi yang ada (`X_FH_LanInterface` / `X_*_LanInterface` daftar objek, `X_HW_LANBIND.*Enable`). Daftar kosong = lepas binding |
| `inform-interval` | `informInterval` (60–86400 detik) | `PeriodicInformEnable=true` + `PeriodicInformInterval` |

`GET /api/devices/:id` → `insight.wcds[]` (WCD yang ada, termasuk kosong),
`insight.connTypes` (ConnectionType yang dipakai perangkat), `insight.wan[].binding`
(`{lan[], ssid[]}` atau null) dan `wanCaps`
(`{family, bindingRequired, bindingParam, lanPorts[], ssids[]}`) untuk menyusun
pilihan lokasi WAN dan binding.

**FiberHome:** `wan-add`/`wan-ip-add` tanpa `bindLan`/`bindSsid` untuk layanan
INTERNET otomatis di-binding ke semua LAN + SSID (`X_FH_LanInterface`) —
tanpa binding klien tidak mendapat internet.

Respons: `{queued, plan[], skipped[], guessed[], tasks[], writes[]}`; HTTP 400 + `error` bila tidak ada yang diantrekan.

#### Sandi WiFi & PPPoE terbuka

`insight.wlan[].passphrase` dan `insight.wan[].password` berisi sandi **apa
adanya** (tidak disamarkan) untuk pengguna yang login — admin maupun operator.

| `…Source` | Arti |
|-----------|------|
| `onu` | dibaca langsung dari ONU |
| `acs` | ONU mengembalikan string kosong / `****` saat dibaca (diizinkan TR-069), atau penulisan ACS lebih baru dari pembacaan terakhir → nilai terakhir yang **disetel lewat ACS** dan diterima ONU (`…At` = waktunya) |
| `null` | ONU tidak mengirim sandi dan sandi belum pernah disetel lewat ACS |

Baca ulang sandi dari ONU: `POST /api/devices/:id/read` dengan
`{"paths":[...insight.wan[].passwordPath, ...insight.wlan[].passphrasePaths]}`
lalu `/connect`. Reset pabrik menghapus sandi cadangan ACS.

### Tugas (antrean RPC)

| Method | Path | Catatan |
|--------|------|---------|
| GET | `/api/tasks` | `?status=pending|done|failed&limit=` — antrean pekerjaan |

### Preset / provisioning otomatis

| Method | Path | Body |
|--------|------|------|
| GET | `/api/presets` | — |
| POST | `/api/presets` | `{name, intervalHours, enabled, conditions:[{path,op,value}], actions:[{type, path?, value?, fileType?, url?}]}` |
| PUT | `/api/presets/:id` | sama dengan POST |
| DELETE | `/api/presets/:id` | — |
| POST | `/api/presets/:id/apply` | jalankan manual terhadap perangkat yang cocok |

Aksi preset: `get` (baca), `set` (tulis), `reboot`, `factory-reset`,
`discover`, `download`. Preset dicek di setiap Inform (koneksi perangkat).

## 2a. Dua arah kredensial (penting, sering tertukar)

Ada **dua** pasang user/password yang berbeda, jangan tertukar:

| Arah | Nama di UI | Disimpan di | Dipakai untuk |
|------|-----------|-------------|---------------|
| **ACS → CPE** | "Akses ACS → CPE" (`connection_request_*`) | `devices.connection_request_url/user/pass` | ACS memanggil **Connection Request** ke ONT (GET ke URL CPE, mis. `http://10.0.0.9:7547/`) supaya ONT segera Inform. |
| **CPE → ACS** | "Akses CPE → ACS (port 7547)" (`cwmp_*`) | `devices.cwmp_user/cwmp_pass` | ONT mengirim **Inform** ke ACS; ACS memvalidasi HTTP Basic sebelum menerima. |

**A. Credential ACS → CPE (Connection Request)** — `PUT /api/devices/:id`
```bash
curl -b jar -X PUT "$ACS/api/devices/$ID" -H "x-csrf: $CSRF" \
  -H 'content-type: application/json' \
  -d '{"connection_request_url":"http://10.0.0.9:7547/","connection_request_user":"acs","connection_request_pass":"***"}'
curl -b jar -X POST "$ACS/api/devices/$ID/connect" -H "x-csrf: $CSRF"   # "Hubungi sekarang"
```
URL biasanya diisi otomatis dari Inform pertama (`ConnectionRequestURL`).

**B. Credential CPE → ACS (autentikasi Inform)** — opsional, berlapis:

1. **Per perangkat** (paling spesifik, dari UI): `cwmp_user` + `cwmp_pass`.
2. **Global via file** (`pola|user|pass`, wildcard `*`), set `ACS_CWMP_CREDENTIALS=/etc/acs/cwmp.creds`:
   ```
   # /etc/acs/cwmp.creds   (chmod 600)
   0019FB-F670L-*|acsuser|rahasia
   *|fallback|rahasia2
   ```
3. **Kosong di keduanya** → ACS menerima semua CPE (default, kompatibel ONT lama).

Bila auth aktif dan gagal: ACS balas **401 + `WWW-Authenticate: Basic realm="ACS CWMP"`**;
sebagian ONT baru mengirim kredensial setelah menerima tantangan 401 ini.
Password **tidak pernah** dikembalikan API — hanya penanda `has_cwmp_pass`/`has_connection_request_pass`.

### Katalog parameter

| Method | Path | Catatan |
|--------|------|---------|
| GET | `/api/catalog` | katalog aktif (version, standard TR-098/TR-181, models) |
| GET | `/api/catalog/search?q=` | cari path/label lintas seluruh katalog |
| GET | `/api/catalog/models/:id` | parameter satu model |
| POST | `/api/catalog/import` | `{catalog:{...}}` — **ganti penuh** (validasi ketat, backup `.bak`), semantik `mongorestore --drop` |
| POST | `/api/catalog/compare` | `{a:<katalog>, b:<katalog>}` → `{modelOnlyA, modelOnlyB, same, diff, summary}` (maks 10 MB) |

Contoh bandingkan katalog aktif vs file lain:

```bash
python3 - <<'PY' > /tmp/comp.json
import json
a = json.load(open('/opt/acs/packages/catalog/data/models.json'))  # atau hasil GET /api/catalog
b = json.load(open('/opt/acs/data/models-paimo54.json'))           # katalog pembanding
json.dump({"a": a, "b": b}, open('/tmp/comp.json', 'w'))
PY

CSRF=$(curl -s -b /tmp/acs.jar $ACS/api/me | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrf"])')
curl -s -b /tmp/acs.jar -X POST "$ACS/api/catalog/compare" \
  -H "content-type: application/json" -H "x-csrf: $CSRF" \
  --data-binary @/tmp/comp.json | python3 -m json.tool | head -20
```

### Peristiwa & pengguna

| Method | Path | Catatan |
|--------|------|---------|
| GET | `/api/events` | `?limit=&kind=` — log perangkat & sistem |
| GET | `/api/users` | daftar pengguna (role `admin`) |
| POST | `/api/users` | `{username, password, role}` (role `admin`) |
| DELETE | `/api/users/:username` | hapus pengguna (role `admin`; bukan diri sendiri, bukan admin terakhir) |

### Webhook (push)

| Method | Path | Catatan |
|--------|------|---------|
| GET | `/api/webhooks` | daftar target + statistik antrean (role `admin`) |
| POST | `/api/webhooks` | `{name, url, secret?, events?, enabled?}` — buat target |
| PUT | `/api/webhooks/:id` | ubah target (secret dikosongkan = pertahankan) |
| DELETE | `/api/webhooks/:id` | hapus target |
| POST | `/api/webhooks/:id/test` | kirim uji ke target |
| GET | `/api/webhooks/log` | log pengiriman terakhir (100) |

---

## 2b. Webhook / push — cara kerja & menerimanya

ACS mengirim **POST JSON** ke URL Anda setiap kali terjadi peristiwa yang
dipilih (Inform, fault, reboot, login, preset, dst). Penerima cukup
menyediakan endpoint HTTP — tidak perlu polling.

### Payload yang dikirim

```json
{
  "id": "e69cea72-8396-49bb-9f72-bcf0712f4959",
  "event": "reboot",
  "deviceId": "ZNTS-A001-12345678",
  "message": "Perintah reboot dikirim",
  "data": {},
  "at": 1791337918720
}
```

- `event` — jenis peristiwa. Pilihan di UI: `inform`, `fault`, `reboot`,
  `factory_reset`, `transfer`, `preset`, `task`, `catalog`, `login`,
  `login_failed`, `user`.
- `deviceId` — ID perangkat (null untuk peristiwa sistem).
- `at` — epoch milidetik.

### Header pengiriman

| Header | Isi |
|--------|-----|
| `content-type` | `application/json` |
| `user-agent` | `ACS-TR069-Webhook/1.0` |
| `x-acs-event` | jenis peristiwa (sama dengan `event` di body) |
| `x-acs-delivery` | ID unik pengiriman |
| `x-acs-timestamp` | epoch **detik** |
| `x-acs-signature` | `sha256=<hex>` — **HMAC-SHA256** dari `timestamp + "." + body-mentah`, jika secret diisi |

### Verifikasi signature (wajib jika pakai secret)

Di penerima, verifikasi atas **body mentah** (sebelum JSON.parse):

```js
// Node.js — express/fastify
const crypto = require('crypto');

const ts = req.headers['x-acs-timestamp'];
const sig = req.headers['x-acs-signature'];
const raw = <body mentah sebagai string>;      // penting: SEBELUM parse
const expected = 'sha256=' + crypto
  .createHmac('sha256', process.env.ACS_WEBHOOK_SECRET)
  .update(ts + '.' + raw).digest('hex');

if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
  return res.status(401).end();
}
```

Tanpa verifikasi, siapa pun yang tahu URL Anda bisa mengirim payload palsu
(yang tampak persis dari ACS).

### Perilaku kirim ulang (retry)

- **3 percobaan** per pengiriman, jeda 1 dtk → 5 dtk → 15 dtk.
- 4xx (kecuali 429) dianggap permanen → tidak diulang.
- Timeout per request: 8 dtk.
- Antrean maksimum 500; jika penuh, peristiwa terlama dibuang (dicatat
  sebagai `dropped`).
- Kegagalan dicatat di `GET /api/webhooks/log` dan sebagai peristiwa
  sistem (kind `webhook`) — tapi kind `webhook` **tidak pernah** memicu
  pengiriman (mencegah loop tak berujung saat penerima mati).

### Contoh penerima minimal (Python)

```python
from flask import Flask, request
import hmac, hashlib

app = Flask(__name__)
SECRET = b"rahasia-anda"

@app.post("/acs-webhook")
def hook():
    raw = request.get_data()                     # body MENTAH
    ts = request.headers.get("x-acs-timestamp", "")
    sig = request.headers.get("x-acs-signature", "")
    expected = "sha256=" + hmac.new(SECRET, f"{ts}.{raw}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return "invalid signature", 401
    ev = request.get_json()
    print("peristiwa:", ev["event"], ev.get("deviceId"), ev["message"])
    return {"ok": True}
```

### Contoh integrasi Telegram

Di UI Webhook buat target:

- Nama: `Bot Telegram`
- URL: `https://api.telegram.org/bot<TOKEN>/sendMessage`
- Secret: kosong (Telegram tidak verifikasi HMAC; akses lewat token)
- Peristiwa: pilih `fault`, `reboot`, `factory_reset`, `preset`

Lalu di BotFather aktifkan perintah, atau pasang reverse proxy kecil yang
menerjemahkan payload ACS → `chat_id` + `text` Telegram.

---

## 3. Keamanan integrasi

- **TLS**: aktifkan untuk NBI bila melewati jaringan publik:
  ```bash
  ACS_API_TLS_CERT=/opt/acs/data/tls/api.crt
  ACS_API_TLS_KEY=/opt/acs/data/tls/api.key
  ```
  di `/opt/acs/.env`, lalu `systemctl restart acs`. Lalu gunakan
  `https://` (sertifikat self-signed perlu `--insecure` / CA sendiri).
- **Bind**: `ACS_BIND=0.0.0.0` (default) mendengarkan semua interface.
  Bila NBI hanya untuk jaringan lokal/monitoring, batasi lewat firewall
  (mis. `ufw allow from <subnet> to any port 8080`).
- **Password**: login `admin` — ganti dari UI (Pengguna) atau
  `/opt/acs/.env` (`ACS_ADMIN_PASSWORD`) lalu restart. Jangan simpan
  password di script; gunakan environment/secret manager.
- **HTTPS + reverse proxy**: boleh juga (Caddy/Nginx) untuk TLS +
  rate-limit tambahan; ACS tetap memakai cookie-nya sendiri di belakungnya.

## 4. Keterbatasan yang belum ada (jujur)

- **Belum ada API key/token permanen** — integrasi memakai alur login
  cookie (contoh di atas). Menambah token `Authorization: Bearer` adalah
  rancangan lanjutan.
- **Webhook**: tersedia (lihat bab 2b) — kirim POST per peristiwa, dengan
  HMAC opsional & retry. Yang belum: **webhook digest/batch** (kumpulkan
  peristiwa lalu kirim satu payload periodik) dan **retry persisten** di
  disk (antrean saat ini di memori — hilang bila ACS restart).
- **Belum ada skema OpenAPI** — tabel endpoint di dokumen ini adalah
  referensi resmi.
