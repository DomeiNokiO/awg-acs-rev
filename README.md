# ACS — Server TR-069 Custom (AWG-ACS)

ACS (Auto Configuration Server) TR-069/CWMP ditulis dari nol dalam **TypeScript
satu bahasa** — engine, API, sampai UI. Tidak ada Java, tidak ada Node lain,
tidak ada database server terpisah.

Meniru peran GenieACS (provisioning ONT/modem lewat TR-069) tetapi dengan
tumpukan yang sengaja dibuat kecil dan mudah diaudit.

> **Revisi `awg-acs-rev`** — perbaikan pembacaan redaman & PPPoE lintas vendor,
> kolom **Redaman** di daftar perangkat, dan konfigurasi ONU (buat WAN PPPoE,
> VLAN, SSID/sandi, hapus WAN) yang sesuai spesifikasi TR-069. Rincian lengkap
> di **[CHANGELOG.md](CHANGELOG.md)**; ringkasannya di bagian
> [Apa yang diperbaiki di revisi ini](#apa-yang-diperbaiki-di-revisi-ini).

## Kenapa ACS ini dibuat

| | GenieACS 1.2.16 | AWG-ACS (ini) |
|---|-----------------|---------------|
| Bahasa | Node (JS) + UI terpisah | TypeScript satu bahasa, full-stack |
| Database | MongoDB + RabbitMQ | `node:sqlite` (satu file, tanpa daemon) |
| Port | 7547 / 7557 / 7567 / 3000 | 7547 / 8080 |
| NBI | Terbuka — `GET /devices` balas 200 tanpa auth | Semua `/api/*` di balik sesi + CSRF |
| UI | React bawaan, butuh CDN saat build | UI kustom, seluruh aset lokal (tanpa CDN) |
| Koleksi parameter | Impor lewat `mongorestore` | Impor file JSON lewat UI/API |
| Komponen yang dijalankan | Node + MongoDB + RabbitMQ (3 proses) | Node saja (1 proses) |

Kekuatan yang disengaja: **satu proses, satu basis data, satu perintah
deploy**. Untuk ACS dengan ribuan ONU, yang menentukan bukan jumlah fitur,
melainkan apakah operator masih bisa mendiagnosa masalah dalam 5 menit dari
sebuah `journalctl`.

## Arsitektur

Satu proses, dua port. Pemisahan ini penting dan bukan selera:

| Port | Penyaji | Autentikasi | Siapa yang memakai |
|------|---------|-------------|--------------------|
| **7547** | CWMP (SOAP) | HTTP Basic/Digest level CPE | ONT/ONT di jaringan manajemen |
| **8080** | REST API + UI | Cookie sesi + header CSRF | Operator (browser) |

Alasan dipisah:

- **Firewall bisa diberi aturan berbeda.** 7547 terbuka ke VLAN manajemen ONU,
  8080 cukup ke jaringan internal. GenieACS aslinya memakai pemisahan serupa
  (7547 CWMP, 7557 NBI, 7567 FS, 3000 UI) dan pelajarannya kami bawa ke sini.
- **Menghindari celah yang kami temukan di GenieACS**: NBI-nya membalas
  `GET /devices` dengan **200 tanpa autentikasi**. Di sini semua `/api/*`
  membalas 401 tanpa sesi — sudah diuji.

```
apps/
  server/    Fastify: cwmp.ts (:7547) + api.ts (:8080) + catalog.ts
  web/       Next.js 16, static export, disajikan oleh proses ACS itu sendiri
packages/
  acs-core/  engine murni: soap, rpc, session, db, auth
  catalog/   data/models.json — kumpulan parameter modem
```

## Menjalankan

```bash
cd /root/acs

# Uji (16 tes: sesi CWMP, SOAP, antrean, insight redaman/WAN/WiFi, profiler)
npm test

# Periksa tipe di seluruh paket server
npx tsc -p tsconfig.server.json

# Bangun UI (menghasilkan apps/web/out — satu kali, saat kode UI berubah)
cd apps/web && npx next build && cd ../..

# Jalankan
ACS_ADMIN_PASSWORD='***' ACS_DB=/root/acs/data/acs.db node apps/server/src/index.ts
```

Tanpa `ACS_ADMIN_PASSWORD`, akun admin dibuat dengan password acak yang
**dicetak sekali ke stdout dan tidak disimpan** — salin saat itu juga.

### Instalasi otomatis di Proxmox CT / VPS

Installer `deploy/install.sh` — tanpa Docker, muat di CT unprivileged 1 vCPU /
1 GB RAM. Cara pakai di dalam CT:

```bash
curl -fsSL https://raw.githubusercontent.com/DomeiNokiO/awg-acs-rev/refs/heads/main/deploy/install.sh | bash
```

Apa yang dilakukan:

- Pasang paket sistem + **Node.js 22+**, buat user `acs`, clone repo
- `npm install`, **build UI** (Next.js static export)
- Tulis `.env` (port/bind/TLS/kredensial), buat **sertifikat TLS self-signed**
  opsional, pasang **systemd unit `acs`**, buka firewall (ufw)
- Mulai layanan + lakukan **health check**
- Cetak ringkasan: alamat UI/API/CWMP, login, database, cara log

Variabel lingkungan untuk mode non-interaktif (otomasi):

| Variabel | Default | Fungsi |
|----------|---------|--------|
| `ACS_ADMIN_PASSWORD` | acak | Password admin awal |
| `ACS_BIND` | `0.0.0.0` | Bind address |
| `ACS_CWMP_PORT` | `7547` | Port CWMP |
| `ACS_API_PORT` | `8080` | Port API/UI |
| `ACS_ENABLE_CWMP` | `1` | Aktif/tidak port CWMP |
| `ACS_ENABLE_NBI` | `1` | Aktif/tidak REST API |
| `ACS_ENABLE_FS` | `1` | Aktif/tidak file server |
| `ACS_ENABLE_UI` | `1` | Aktif/tidak UI |
| `ACS_ENABLE_TLS` | `0` | Buat TLS self-signed |

Variabel lingkungan (waktu jalankan server):

| Variabel | Default | Fungsi |
|----------|---------|--------|
| `ACS_CWMP_PORT` | `7547` | Port CWMP |
| `ACS_API_PORT` | `8080` | Port API/UI |
| `ACS_DB` | `/root/acs/data/acs.db` | File SQLite (node:sqlite) |
| `ACS_ADMIN_PASSWORD` | — | Password admin awal |
| `ACS_LOG_LEVEL` | `info` | Log Fastify |
| `ACS_CATALOG` | — | File/direktori kumpulan parameter (lihat bawah) |
| `ACS_CWMP_TLS_CERT` / `ACS_CWMP_TLS_KEY` | — | TLS untuk CWMP (:7547) |
| `ACS_API_TLS_CERT` / `ACS_API_TLS_KEY` | — | TLS untuk API/UI (:8080) |
| `ACS_SESSION_TTL` | `8` (jam) | Masa berlaku sesi login |
| `ACS_BIND` | `0.0.0.0` | Bind address semua listener |

### Menunjuk ONT ke ACS

Di ONT: ACS URL `http://<ip-server>:7547/`. Atau lewat DHCP Option 66/43 di
MikroTik, atau provisioning ZTE via `tr069-mgmt` pada C320 — rinciannya ada di
`/root/genieacs-lab/REFERENSI-GENIEACS.md`.

### Kredensial dua arah (ACS ↔ CPE)

Ada **dua** pasang user/password yang berbeda dan sering tertukar:

- **ACS → CPE** (kartu “Akses ACS → CPE”): URL + user + password yang dipakai ACS
  untuk mengirim **Connection Request** ke ONT. Diisi otomatis dari Inform pertama,
  bisa diedit manual, dan diuji lewat tombol **“Hubungi sekarang”**.
- **CPE → ACS** (kartu “Akses CPE → ACS (port 7547)”): kredensial yang **harus
  dikirim ONT** saat Inform. Opsional — kosong berarti ACS menerima semua ONT
  (perilaku default, kompatibel dengan perangkat lama). Bisa diset per perangkat
  dari UI, atau global lewat file `ACS_CWMP_CREDENTIALS` (`pola|user|pass`,
  wildcard `*`, `chmod 600`). Bila aktif dan gagal → ACS balas `401`
  + `WWW-Authenticate: Basic`.

Detail lengkap (contoh curl, skema DB, urutan prioritas): `docs/API.md` bab 2a.
Password tidak pernah dikembalikan API — hanya penanda `has_*`.

### Preset — provisioning otomatis saat Inform

Preset dijalankan **otomatis setiap perangkat Inform** (event `0 BOOTSTRAP` /
`1 BOOT` memaksa terapkan tanpa menunggu interval) — sama seperti GenieACS.
Kondisi mencocokkan atribut perangkat (`manufacturer`, `oui`, `productClass`,
`serialNumber`, `softwareVersion`, `groupName`, `tags`) atau nilai parameter;
aksi mendukung `get`, `set`, `reboot`, `factory-reset`, `discover`, `download`.
Ada anti-banjir (`intervalHours`) dan `POST /api/presets/:id/apply` untuk manual.

## Integrasi API NBI (untuk sistem lain)

NBI = REST API di port UI/API (`8080`), semua di bawah `/api/`.
**Wajib autentikasi**: hanya `/api/health` dan `/api/login` yang terbuka;
sisanya `401` tanpa sesi, dan setiap `POST/PUT/DELETE` wajib header
`x-csrf` (`403` tanpa itu).

```bash
ACS=http://<ip-acs>:8080

# login → simpan cookie + ambil token CSRF
CSRF=$(curl -s -c /tmp/acs.jar -X POST $ACS/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"RAHASIA"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrf"])')

# baca (GET tidak butuh csrf)
curl -s -b /tmp/acs.jar "$ACS/api/stats"
curl -s -b /tmp/acs.jar "$ACS/api/devices?online=1&limit=20"

# mutasi (butuh x-csrf)
curl -s -b /tmp/acs.jar -X POST "$ACS/api/devices/<id>/reboot" -H "x-csrf: $CSRF"
```

- Sesi kedaluwarsa `ACS_SESSION_TTL` (default 8 jam) → `401`; ulangi login.
- Token CSRF segar kapan saja: `GET /api/me`.
- Batas laju: 300 req/menit/IP, login 10 percobaan/5 menit (`429`).
- **Webhook/push**: ACS mengirim `POST` JSON ke URL Anda tiap peristiwa
  (Inform, fault, reboot, login, preset…). Kelola target di menu UI
  **Webhook**; payload, header HMAC, retry & contoh penerima di
  `docs/API.md` bab 2b.
- Endpoint lengkap (perangkat, tugas, preset, katalog, peristiwa, webhook,
  pengguna), contoh Python, TLS, dan rencana lanjutan: **[docs/API.md](docs/API.md)**.
  Dokumen yang sama disajikan di UI pada **/API.md** (tautan *API Docs* di
  sidebar).

## Perintah ke Perangkat (tab Perintah)

Satu antrean RPC per perangkat, diisi dari UI atau API, dikirim pada POST
berikutnya dari ONT (atau dipicu lebih cepat lewat Connection Request):

| Perintah | Endpoint | XML |
|----------|----------|-----|
| Baca parameter | `POST /api/devices/:id/read` | `GetParameterValues` |
| Tulis parameter | `POST /api/devices/:id/write` | `SetParameterValues` |
| Pelajari struktur | `POST /api/devices/:id/discover` | `GetParameterNames` |
| **Tambah objek** | `POST /api/devices/:id/add-object` | `AddObject` |
| **Hapus objek** | `POST /api/devices/:id/delete-object` | `DeleteObject` |
| Reboot | `POST /api/devices/:id/reboot` | `Reboot` |
| Reset pabrik | `POST /api/devices/:id/factory-reset` | `FactoryReset` |
| Unduh firmware | `POST /api/devices/:id/download` | `Download` |
| Ketuk perangkat | `POST /api/devices/:id/connect` | — (HTTP GET ke ConnectionRequestURL) |

AddObject/DeleteObject menambah/menghapus satu instans objek, misalnya
membuat WAN atau VLAN baru:

```bash
# ObjectName tanpa nomor instans — perangkat yang menentukan nomornya
curl -s -b jar -X POST "$ACS/api/devices/<id>/add-object" -H "x-csrf: $CSRF" \
  -H 'content-type: application/json' \
  -d '{"objectName":"InternetGatewayDevice.WANDevice.1.WANConnectionDevice."}'
```

Nomor instans yang dibuat perangkat dikembalikan di respons `AddObjectResponse`
dan dicatat di log tugas; parameter barulah (mis.
`...WANConnectionDevice.3.X`) aktif setelah Inform berikutnya.

## Apa yang diperbaiki di revisi ini

| Gejala sebelumnya | Akar masalah | Sekarang |
|-------------------|--------------|----------|
| Nilai redaman tampil di kolom "Terakhir Inform" | Header tabel 8 kolom, baris berisi 11 sel | Kolom **Redaman RX** (badge warna) dan TX sendiri, plus PPPoE & IP WAN; filter "redaman buruk" |
| Banyak ONU tidak pernah terbaca | `GetParameterNames` mengirim `<ParameterName>` (seharusnya `<ParameterPath>`); `GetParameterValues` menyisipkan `<CommandKey>` non-standar → Fault 9003 di firmware ketat | RPC persis spesifikasi; batch ↔ fault dicocokkan lewat kunci RPC di sesi |
| Redaman kosong di banyak merek | Varian path kurang (ZTE F660, Huawei `X_HW_DEBUG`/`X_GponInterafceConfig`, Nokia, TR-181), satuan 0.1 µW / 0.001 dBm tak dikonversi, path redaman terbuang dari profil setelah discovery | 24 varian TR-098 + TR-181 selalu dibaca; normalisasi ke dBm; deteksi LOS |
| PPPoE tidak tampil | Path dipatok `WANConnectionDevice.1`, padahal PPPoE ZTE/Huawei/FiberHome di WCD.2/.3 | Discovery per perangkat dengan instans asli; semua koneksi WAN tampil |
| Ganti sandi WiFi gagal | Selalu menulis `BeaconType=WPA2PSK` (bukan enum TR-098) → SPV atomik ditolak | Sandi ke lokasi yang ada; BeaconType hanya diubah bila jaringan terbuka (`11i`) |
| Tambah WAN tidak jalan | AddObject di WCD.1 milik TR069; VLAN satu nama vendor; tebakan vendor menggagalkan username/password | Rantai AddObject WCD → koneksi; SPV standar & vendor terpisah; VLAN level koneksi/link |
| Preset BOOT tak pernah jalan | Parser `Event` Inform selalu kosong | Parser `EventStruct/EventCode` diperbaiki |
| "Pelajari struktur" error pada klik kedua | Task ber-id = deviceId (PRIMARY KEY bentrok) | Diperbaiki |
| Task konfigurasi `pending` selamanya saat ditolak | Fault tidak dipetakan ke task | Task ditutup `failed` + alasan |

Detail per file: [CHANGELOG.md](CHANGELOG.md).

## Provisioning & Konfigurasi ONU

Data ONU (redaman, PPPoE, VLAN, WiFi) **terbaca otomatis** untuk semua vendor
dan ONU **dikonfigurasi dari UI** tanpa reboot. Rincian teknis lengkap:
**[docs/PROVISIONING.md](docs/PROVISIONING.md)**.

### Membaca otomatis

1. **Discovery per perangkat** — `GetParameterNames(root, NextLevel=false)`
   pada root sesuai data model (TR-098: `WANDevice.`,
   `LANDevice.1.WLANConfiguration.`, `DeviceInfo.`; TR-181: `PPP`, `IP`,
   `Ethernet.VLANTermination`, `Optical`, `WiFi`, `DeviceInfo`). Seluruh
   subtree datang dalam satu balasan; leaf penting (redaman, koneksi WAN +
   VLAN/ServiceList vendor, WiFi) disimpan sebagai **profil perangkat itu**
   dengan nomor instans aslinya. Firmware yang hanya menjawab anak langsung
   otomatis ditelusuri bertingkat (BFS).
2. **Path esensial** (`modelpaths.ts`) — info dasar + 24 varian redaman
   (termasuk yang di luar `WANDevice.`) selalu ikut dibaca.
3. **Split-on-fault** — batch GPV yang ditolak 9005 dibelah sampai ketemu
   path yang tidak didukung; path itu dicatat di `invalid_param` dan tidak
   dikirim lagi. Kandidat yang terbukti tidak ada dari hasil discovery
   langsung ditandai tanpa perlu dibuktikan.
4. **Insight** (`insight.ts`) — redaman dinormalisasi ke dBm (0.1 µW,
   0.001 dBm, LOS), semua koneksi WAN dan SSID diekstrak berbasis pola,
   ringkasannya disimpan di kolom `devices` untuk daftar perangkat yang cepat.

Pembacaan terjadi saat jatuh tempo (`ACS_COLLECT_INTERVAL_MIN`, default 30)
atau saat event `BOOT`/`VALUE CHANGE`/`CONNECTION REQUEST`. Tombol
**Segarkan** di Detail Perangkat memaksa baca ulang + Connection Request.

### Konfigurasi ONU dari UI / API

Tab **Ringkasan** menampilkan redaman, tabel semua koneksi WAN (dengan tombol
Ubah/Hapus) dan semua SSID (tombol Ubah). Tab **Konfigurasi**:

| Konfigurasi | Body `POST /api/devices/:id/config` | RPC |
|-------------|-------------------------------------|-----|
| SSID & sandi WiFi | `{"type":"wifi","wlanIndex":1,"ssid":"…","passphrase":"…"}` | `SetParameterValues` |
| Kredensial PPPoE | `{"type":"pppoe","target":"<path koneksi>","username":"…","password":"…","vlanId":100}` | `SetParameterValues` (kredensial & VLAN terpisah) |
| VLAN | `{"type":"vlan","target":"<path koneksi>","vlanId":200}` | `SetParameterValues` |
| Buat WAN PPPoE | `{"type":"wan-add","username":"…","password":"…","vlanId":100,"bridge":false}` | `AddObject` WCD → `AddObject` WANPPPConnection → `SetParameterValues` |
| Buat WAN IP | `{"type":"wan-ip-add","staticIp":"…","netmask":"…","gateway":"…","dns":"…"}` | sama, WANIPConnection |
| Hapus WAN | `{"type":"wan-delete","target":"<path koneksi>"}` | `DeleteObject` |

`target` diambil dari `insight.wan[].base` (`GET /api/devices/:id`). Nama
parameter vendor (`X_HW_VLAN`, `X_ZTE-COM_VLANID`, `X_FH_VLANID`,
`X_CT-COM_WANGponLinkConfig.VLANIDMark`, ServiceList, lokasi sandi WiFi)
dipilih server dari path yang **terbukti ada** di perangkat; bila belum ada
bukti, dipakai tebakan per keluarga vendor dan UI menampilkan peringatan.

Id task = `ParameterKey` = kunci RPC, sehingga balasan perangkat menutup task
(`done`) dan Fault menandainya `failed` beserta alasan.

## Keamanan

Dibangun dari awal, bukan ditempel belakangan:

- **Semua `/api/*` di belakang sesi login** (401 tanpa cookie).
- **CSRF**: setiap request non-GET wajib header `x-csrf` yang diambil dari
  `/api/me`. Token terikat ke cookie sesi.
- **Password**: scrypt bawaan `node:crypto` — tanpa dependensi native.
- **Rate-limit login** — mencegah brute force.
- **XML di-escape** di semua nilai RPC — mencegah SOAP injection.
- **Penyajian file statis**: path dibersihkan sebelum menyentuh filesystem;
  traversal diblokir (diuji: `403`), rute tak dikenal membalikkan `404.html`
  sungguhan, bukan halaman utama diam-diam.
- **Log tidak memuat body SOAP** — berisi kredensial PPPoE pelanggan.

## Menambah / Push Parameter

Di GenieACS, kumpulan parameter diimpor dari repo terpisah lewat MongoDB:

```bash
git clone https://github.com/paimo54/parameter.git
mongorestore --db genieacs --drop parameter
```

Di ACS ini tidak ada MongoDB, jadi penggantinya adalah **file JSON satu
berkas** dengan semantik yang sama (`--drop` = ganti penuh, bukan gabung):

```bash
# arahkan ACS ke repo parameter eksternal
git clone https://github.com/…/parameter.git /opt/parameter
ACS_CATALOG=/opt/parameter node apps/server/src/index.ts
```

`ACS_CATALOG` menerima **path file** (`/opt/parameter/models.json`) atau
**path direktori** (di dalamnya dicari `models.json`).

### Mengimpor dari repo paimo54/parameter (BSON)

Repo https://github.com/paimo54/parameter berisi **dump MongoDB (.bson)**,
bukan JSON. ACS ini tidak perlu mongod — konverter `scripts/bson-to-catalog.mjs`
membaca `devices.bson` langsung dan menghasilkan `models.json`:

```bash
git clone https://github.com/paimo54/parameter.git /opt/parameter
node scripts/bson-to-catalog.mjs /opt/parameter /root/acs/data/models-paimo54.json
# lalu arahkan ACS ke hasilnya:
ACS_CATALOG=/root/acs/data/models-paimo54.json node apps/server/src/index.ts
```

Hasil konversi: 19 model, ribuan parameter (path TR-069, tipe XSD,
akses read/readWrite, sumber tercatat). Installer otomatis memakai cara ini
di bagian akhir.

### Impor/ekspor & bandingkan lewat UI

- Di halaman **Katalog** ada tombol **Impor Katalog** — tempel JSON `models.json`
  langsung, validasi skema, impor atomik, file lama dicadangkan `.bak`.
- Menu **Bandingkan** membandingkan dua katalog: per model dan per path,
  menandai param yang sama / hanya di satu sisi.

**Sifat penting:**

- **Semantik ganti, bukan gabung** — setara `mongorestore --drop`. Yang
  ditunjuk menggantikan katalog bawaan sepenuhnya, sehingga hasil bisa
  diprediksi.
- **Tanpa restart.** Loader memeriksa mtime, jadi ganti/pull file → request
  berikutnya sudah memakai isi baru. (Terbukti dalam pengujian: 95 → 96
  param hanya dengan menyentuh file.)
- **Gagal arah = fallback, bukan katalog kosong.** Bila `ACS_CATALOG`
  menunjuk path yang tidak ada, ACS memakai katalog bawaan dan mencetak
  peringatan. Lebih baik dapat data lama yang salah ketimbang katalog
  mendadak kosong di tengah operasi.
- **File korup = katalog DITOLAK, bukan dikosongkan.** Loader memvalidasi
  skema (`catalog-schema.ts`); struktur rusak membuat file ditolak total
  dan katalog yang sedang berjalan dipertahankan (hanya dicatat error).
  Entri individual yang tidak valid dibuang dan **dicatat ke log**.
- **Sumber tampil di API**: `GET /api/catalog` mengembalikan field `source`
  sehingga operator bisa memastikan yang termuat katalog bawaan atau repo
  luar.

Cara kedua — **tanpa repo eksternal**, cukup timpa file bawaan:

```bash
git -C packages/catalog/data pull        # atau salin models.json manual
# ACS membaca ulang otomatis pada request berikutnya
```

> Catatan format: file harus mengikuti skema `models.json` (lihat
> `packages/catalog/data/models.json`). Loader bersifat defensif — file korup
> membuat katalog **tetap memakai isi terakhir** + peringatan, entri
> individual yang tidak valid dibuang dan **dicatat ke log**, bukan
> diam-diam. Validasi format memakai `catalog-schema.ts` (validasi per-field:
> path wajib, tipe harus XSD resmi, akses read/readWrite, group wajib).

## Katalog Parameter

`packages/catalog/data/models.json` — **240 path unik** dari 291 entri:

- **105** parameter TR-098 (Broadband Forum, samber resmi)
- **91** parameter TR-181 Device:2
- **14 model ONT** (ZTE F660/F670L, Huawei EG8145V5/HG8546M, FiberHome,
  Nokia G-140W, Alcatel-Lucent G-2426G-A, TP-Link XC220-G3v, Mitrastar,
  Sercomm FG824CW, D-Link, HALNy HL-4GMV) dengan **95 param vendor**

UI menggabungkannya jadi satu daftar lalu **dedupe berdasarkan path** (path
sama sering muncul di standard dan di beberapa model). Kolom *Model*
menandai perangkat mana yang mendukung path itu; path standard diberi label
`Standard`.

Loader **defensif**: file korup/hilang tidak mematikan server (UI jalan
dengan katalog kosong + peringatan), dan entri yang ditolak dicatat ke log —
bukan dibuang diam-diam. `productClass: null` didukung (dipasangkan via
vendor/alias) karena umum pada entri vendor pihak ketiga.

## Design System UI

UI **ditulis ulang total** (tidak lagi AdminLTE) dan diadaptasi dari repo
`franchise-management`:

- Sidebar gelap `#0f172a`, aksen biru `#2563eb`, font **Inter** self-hosted,
  kartu radius 14px, topbar sticky + backdrop blur, badge pil.
- **Setiap kartu** berbingkai gradien `linear-gradient(135deg,#818cf8,#60a5fa,#f472b6)`
  (2px, teknik `border-box` + padding-box) dengan glow saat hover.
- Halaman statistik (Dashboard, Katalog, Webhook) memakai kartu metrik
  berwarna — Katalog menampilkan TR-098, TR-181, jumlah model, param vendor.
- **Tanpa CDN sama sekali.** Bootstrap 5.3, Font Awesome, dan Inter semuanya
  dari `node_modules` lalu ikut bundel. CT produksi tidak punya internet
  publik; kegagalan CDN mematikan seluruh tampilan, bukan hanya sebagian.
- **Tanpa JS global.** Toggle sidebar memakai state React murni
  (`.sidebar.open` + `.sidebar-overlay.show`), bukan `adminlte.min.js`.

> Catatan sejarah: markup AdminLTE **3** pernah dipasang di atas CSS
> **AdminLTE 4** (yang memakai CSS Grid) sehingga `.main-sidebar` lebarnya
> 0 px dan navigasi hilang. Setelah UI dirombak total, kelas-kelas tersebut
> tidak lagi dipakai; yang tersisa hanya nama variabel di komentar.

Mobile: hamburger di topbar (`.topbar` z-index 1060 > `.sidebar` 1045 >
overlay 1040) membuka sidebar off-canvas di bawah 992px.

## Skala: menangani ribuan ONU

Yang menentukan skala bukan jumlah fitur, tapi **biaya per ONU** dan **apa
yang terjadi saat banyak perangkat datang bersamaan**.

### Beban per ONU

| Yang disimpan | Ukuran | Keterangan |
|---------------|--------|------------|
| `devices` | 1 baris | Ditulis tiap Inform |
| `params` | 1 baris per path unik | Hanya parameter yang benar-benar dibaca/ditulis; tabel `WITHOUT ROWID` dengan PK `(device_id, path)` |
| `tasks` | 1 baris per perintah | TTL 5 menit saat dibuat |
| `events` | 1 baris per peristiwa | **Tidak dipurge otomatis** — lihat catatan di bawah |
| `sessions` (UI) | 1 baris per sesi login | Dipurge tiap 10 menit (`purgeExpiredSessions`) |

Yang membuat mode ini murah: parameter **tidak ditulis ulang seluruhnya**
setiap Inform. `setParams` memakai `INSERT … ON CONFLICT DO UPDATE` dalam satu
transaksi, jadi hanya baris yang berubah yang tersentuh. Pada mode inform
murni (hanya DeviceId + SoftwareVersion), satu ONU ≈ 2 baris tulis.

### Beban saat banyak perangkat datang bersamaan

Ini yang biasanya meltdown, bukan kondisi stabil. Kondisi yang ada sekarang:

- **Satu proses Node, `DatabaseSync` bersifat sinkron.** Semua operasi DB
  serialize di satu thread. Beban puncak adalah burst penulisan DB, bukan
  bandwidth jaringan.
- **Antrean per perangkat, bukan antrean global.** Ribuan ONU menghasilkan
  ribuan antrean kecil di memori; tidak ada satu antrean harus direbut lock.
- **Tanpa RabbitMQ** — tidak ada broker yang harus serialize antrean saat
  ACS di-restart, dan antrean yang hilang cukup dihitung sebagai tugas gagal.
- **Tanpa scheduler berat.** Yang berjalan periodik hanya purge sesi
  (10 menit). Tidak ada iterasi seluruh tabel secara berkala.

### Angka hasil ukur

Diukur dengan `scripts/loadtest.mjs` — N perangkat melakukan Inform lengkap
(DeviceId + 2 ParameterList) dengan konkurensi tertentu, di satu proses ACS
sungguhan dengan `DatabaseSync`.

Mesin uji: Intel i5-4570 (2 vCPU), 7 GB RAM, Node v26.7.0, ACS lokal.

| Perangkat | Konkurensi | p50 | p95 | p99 | Throughput | Durasi | DB |
|-----------|-----------|-----|-----|-----|------------|--------|-----|
| 300 | 25 | 72 ms | 149 ms | 391 ms | 159/detik | 1,9 s | 0,14 MB |
| 2.000 | 60 | 149 ms | 292 ms | 2.079 ms | 176/detik | 11,4 s | 0,45 MB |
| 5.000 | 100 | 314 ms | 905 ms | 1.532 ms | 101/detik | 49,4 s | 1,02 MB |

Cara membaca angka ini:

- **0 kegagalan di semua ukuran.** Tidak ada perangkat yang hilang, tidak ada
  session yang bocor, tidak ada error SOAP.
- **Ukuran DB linier dan sangat kecil** — 1,02 MB untuk 5.000 perangkat, jadi
  ±205 B per ONU. Ribuan ONU bukan masalah penyimpanan di sini.
- **p95 memburuk seiring jumlah perangkat.** Ini konsekuensi `DatabaseSync`
  yang sinkron — inilah yang akan jadi alasan pertama kalau skalanya nanti
  tumbuh: pada 5.000 perangkat p95 sudah 905 ms.
- **Skala nyata bukan 5.000 sekaligus, tapi ribuan yang tersebar.** Dalam
  operasi ISP normal, Inform tersebar merata dan tidak pernah 5.000
  bersamaan. Throughput yang terukur (100–176/detik) jauh di atas kebutuhan:
  5.000 ONU dengan Inform tiap 30 menit = **2,8 Inform/detik**.

Kesimpulan dari angka, bukan dari dugaan: **5.000 ONU pada mode inform murni
bukan beban yang membuat ACS ini kewalahan.** Yang belum terbukti adalah kombinasi
berat yang lebih realistis — ribuan ONU yang *sekaligus* menjalankan polling
parameter (`read`) dan satu proses menulis beberapa ribu baris `params`.
Itu uji berikutnya yang harus ditulis, bukan angka yang dihafal.

## Keterbatasan yang Belum Ditangani

Daftar ini jujur — bukan daftar fitur. Item yang sudah ada kode/aktif
ditandai ✓.

| Hal | Status | Catatan |
|-----|--------|---------|
| **TLS** | ✓ ada (opsional) | `ACS_CWMP_TLS_CERT/KEY` + `ACS_API_TLS_CERT/KEY` mengaktifkan HTTPS di :7547 dan :8080. Di luar itu HTTP polos (kredensial CPE terlihat) — produksi wajib menyalakannya atau memakai reverse proxy. |
| **AddObject / DeleteObject** | ✓ ada | Builder RPC + parser respons di engine, `enqueueAddObject/DeleteObject` di server, endpoint `POST /api/devices/:id/add-object` & `.../delete-object`, dan UI di tab **Perintah**. `instanceNumber` hasil AddObject dicatat saat perangkat membalas. |
| **Dokumentasi API** | ✓ ada | `docs/API.md` (ratusan baris) + tautan **API Docs** di sidebar, disajikan di `/API.md`. |
| **Impor parameter via HTTP** | ✓ ada | `POST /api/catalog/import` (admin) + tombol di UI Katalog. Menulis atomik + `.bak`. |
| **Validator skema ketat** | ✓ ada | `catalog-schema.ts`: path wajib, tipe harus XSD resmi, akses read/readWrite, group wajib; file rusak ditolak total. |
| **Preset / provisioning otomatis** | ✓ ada | CRUD + aksi, dipicu `onInform`, anti-banjir interval jam, `POST /:id/apply`. |
| **Auto-discovery parameter** | ✓ ada | Discovery per perangkat (`NextLevel=false`, root per data model TR-098/TR-181, fallback BFS untuk firmware dangkal) + path esensial redaman + split-on-fault GPV. Perangkat yang menolak `GetParameterNames` tetap terbaca lewat path esensial. |
| Bind address | ✓ ada | `ACS_BIND` (default `0.0.0.0`). |
| Session TTL | ✓ ada | `ACS_SESSION_TTL` (jam), default 8. |
| File konfigurasi | ✓ ada | `.env` (dibuat installer) + env var; installer menghasilkan systemd unit. |
| **Bandingkan katalog** | sebagian | Per model/path di UI (bandingkan dua katalog), tapi belum ada diff per-nilai. |
| **Impor langsung dari repo paimo54** | ✓ ada | `scripts/bson-to-catalog.mjs` (tanpa mongod). |
| **Ekspor** | belum | Belum ada tombol unduh di UI; bisa ambil JSON penuh via `GET /api/catalog`. |
| **NBI: token API permanen** | belum | Integrasi memakai alur login cookie + `x-csrf` (lihat `docs/API.md`). Token bearer di header `Authorization` masih rancangan. |
| **NBI: webhook/push** | ✓ ada | `POST` JSON per peristiwa (HMAC opsional, retry 1s/5s/15s) ke URL target; kelola di UI **Webhook**. Antrean & log retry masih di memori, jadi hilang saat restart — belum persisten. |
| **NBI: skema OpenAPI** | belum | Referensi resmi = tabel endpoint di `docs/API.md`. |
| **Skala ribuan ONU** | ⚠ perlu diukur | Parameter tiap ONU disimpan di SQLite (WAL aktif, index `(device_id, path)`) dan `DatabaseSync` bersifat sinkron — jadi operasi DB serialize, belum paralel. Praktis untuk ratusan–ribuan ONU dengan Inform jarang, tapi batasnya harus diukur, bukan dikira-kira. |
| **Uji otomatis** | sebagian | 16 tes unit (sesi CWMP, SOAP, antrean, insight, profiler) + simulator ONT (`scripts/sim-ont.mjs`). Revisi ini diverifikasi end-to-end dengan simulator strict ZTE/Huawei/TR-181; **belum diuji ke ONU fisik**. |
| **Konfigurasi ONU dari UI** | ✓ ada | SSID/sandi WiFi (multi-SSID), PPPoE, VLAN, buat WAN PPPoE/IP (route/bridge), hapus WAN. Lihat bagian *Provisioning & Konfigurasi ONU*. |
| **Buat WAN untuk TR-181** | belum | Butuh PPP.Interface + IP.Interface + VLANTermination; sementara lewat tab Perintah → AddObject. Baca data, WiFi, PPPoE, VLAN TR-181 sudah didukung. |
| **Antrean RPC persisten** | belum | Antrean RPC di memori; tulisan yang belum terkirim hilang saat ACS restart. |

## Rencana Pematangan

Yang mendahulukan, urut dari nilai paling tinggi per usaha:

1. **Token API permanen** — satu endpoint `POST /api/tokens` yang menerbitkan
   token bearer bertanda hash (scrypt, seperti password), tanpa kedaluwarsa
   atau dengan masa berlaku. Ini yang paling sering dibutuhkan integrasi
   OSS/BSS supaya tidak menyimpan cookie.
2. **Retry webhook persisten** — pindahkan antrean & log ke SQLite agar
   pengiriman yang gagal saat restart tidak hilang.
3. **Skala** — ukur dulu: arsitektur saat ini serial (DatabaseSync). Kalau
   memang perlu paralel, jalur yang tersedia tanpa mengubah semantik adalah
   `worker_threads` untuk penulisan DB + pemisahan listener CWMP.
4. **Auto-discovery → katalog** — tombol "Simpan ke katalog" untuk
   `discovered_params` per productClass.
5. **Skema OpenAPI** — turunkan dari definisi rute yang sudah ada.
6. **Ekspor katalog** + diff per-nilai di halaman Bandingkan.
7. **Uji beban** — skrip yang menyimulasikan N perangkat Inform bersamaan
   supaya batas skala bukan perkiraan.

## Catatan Implementasi

- **Node 26 native TypeScript** (mode strip-only): tanpa build step untuk
  server, tetapi **parameter properties dilarang** (`constructor(private x)`)
  — tulis field secara eksplisit.
- **InformResponse meng-echo ID CPE** — diverifikasi empiris terhadap
  GenieACS 1.2.16 asli, bukan asumsi dari spesifikasi.
- **Nilai RPC berteks polos**, bukan `<cwmp:string>`: `<Name>`,
  `<ParameterKey>`, `<ParameterPath>` wajib tanpa pembungkus tipe.
- **Argumen RPC persis TR-069**: `GetParameterNames` = `ParameterPath` +
  `NextLevel`; `GetParameterValues` = `ParameterNames` saja (tanpa
  `CommandKey`). Elemen tambahan ditolak firmware ketat dengan Fault 9003.
- Semua rute UI diekspor statis per-URL (`catalog.html`), sehingga proses ACS
  melayani UI tanpa proses Next.js terpisah di produksi.
