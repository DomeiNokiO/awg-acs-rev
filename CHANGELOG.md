# Changelog — AWG-ACS (revisi `awg-acs-rev`)

Revisi ini berangkat dari [DomeiNokiO/awg-acs](https://github.com/DomeiNokiO/awg-acs).
Fokusnya: **redaman dan PPPoE tampil di ONU semua vendor**, **kolom redaman sendiri
di daftar perangkat**, dan **konfigurasi ONU (WAN PPPoE, VLAN, SSID/sandi) yang
benar-benar diterima perangkat**.

Status verifikasi: `npm test` 16/16 lulus, typecheck server & web bersih,
`next build` sukses, dan uji end-to-end dengan simulator ONU strict (ZTE,
Huawei, TR-181, dan firmware yang hanya menjawab satu tingkat
`GetParameterNames`) lulus semua. **Belum diuji ke ONU fisik.**

---

## 0k. FiberHome RP2872: URL Connection Request port tak valid

- **Penyebab:** firmware FiberHome RP2872 melaporkan `ConnectionRequestURL`
  dengan port di luar rentang TCP 16-bit (lapangan: `:1601009200`). Port TCP
  maksimal 65535, jadi ONU ini tidak mungkin dipanggil lewat HTTP — tetapi
  pesannya menyalahkan NAT/VLAN, dan `new URL()` melempar ERR_INVALID_URL.
- **Perbaikan:** `validateCrUrl()` memeriksa port sebelum menghubungi;
  `/connect` & trafik live memberi `reason:'malformed'` dengan pesan jelas
  (menyebut batas 65535) dan menyarankan menurunkan interval Inform. Kartu
  *Akses ACS → CPE* menandai URL port tak valid sejak awal.
- ONU seperti ini hanya bisa dilayani saat Inform: turunkan interval Inform
  (Konfigurasi → Perangkat) agar perintah & trafik live cepat berjalan.

---

## 0j. Pesan "HTTP 502" saat Hubungi/Segarkan

- **Penyebab:** `/connect` membalas HTTP 502 saat ONU tidak bisa dijangkau.
  Proxy/tunnel di depan ACS mengganti isi respons 502 dengan halaman
  errornya sendiri, sehingga alasan (tidak terjangkau / kredensial ditolak)
  hilang dan UI hanya menampilkan "HTTP 502".
- **Perbaikan:** kegagalan Connection Request kini HTTP 200 `{ok:false, error,
  reason, url}`; UI menampilkan alasannya. Pesan *tidak terjangkau* menyebut
  bila IP Inform ONU berbeda dengan host URL Connection Request (ONU di
  balik NAT / IP manajemen tidak dirutekan ke server ACS).

---

## 0i. Binding FiberHome, opsi NAT, Katalog Parameter

- **Binding FiberHome wajib**: `X_FH_LanInterface` (daftar objek LAN/WLAN).
  WAN internet FiberHome tanpa pilihan port otomatis di-binding ke semua LAN
  (`LANEthernetInterfaceNumberOfEntries`, default 4) + semua SSID. Slot yang
  sudah ber-binding dipertahankan. Tabel WAN menampilkan binding tiap
  koneksi dan menandai WAN FiberHome **"belum di-binding"**; aksi 🔗 / tab
  **Binding** (`wan-bind`) memperbaikinya. Binding Huawei (`X_HW_LANBIND`)
  juga terbaca.
- **NAT**: sakelar di WAN Internet; default aktif untuk INTERNET, mati untuk
  TR069/VOIP/IPTV. Badge NAT / tanpa NAT di tabel WAN. ServiceList dengan
  daftar pilihan (INTERNET, TR069, VOIP, …).
- **Lokasi default WAN**: slot kosong → WCD tanpa koneksi yang disiapkan OLT
  (tambah koneksi PPP di WCD itu lalu isi) → WCD baru.
- **Sandi**: lokasi sandi WiFi vendor diperluas (`X_*Passphrase/Password/WPAKey/PSK`,
  `PreSharedKey.1.X_*_KeyPassphrase`) dengan validasi isi (8–64 karakter,
  bukan flag). Profil v7 (upgrade lokal, tanpa GPN). Laporan
  `param-report.mjs` punya bagian *Sandi (diagnostik)*.
- **Katalog Parameter dirombak**: panel Sumber (Semua / TR-098 / TR-181 /
  per model), tabel dalam kartu dengan path berinduk redup + leaf tebal,
  tipe, akses R/RW, dukungan (standar / N model), filter grup & ekstensi
  vendor, pencarian instan, paginasi 50. Tombol Impor yang sebelumnya tidak
  berfungsi diperbaiki.
- Tes: 43 unit; e2e `wan.mjs` + binding otomatis/manual FiberHome, ZTE tanpa
  binding, WAN TR069 tanpa NAT.

---

## 0h. Sandi terbuka, sembunyikan SSID, firmware berbeda di model sama

- **Sandi WiFi & PPPoE terbuka** di Ringkasan dan Konfigurasi (+ salin), dengan
  asal nilai: *dari ONU* atau *via ACS*. Sandi yang disetel ACS dan diterima
  ONU disimpan (`device_secret`) sebagai cadangan untuk firmware yang membaca
  sandi sebagai string kosong; nilai ONU menang bila dibaca lebih baru.
  Kredensial ManagementServer tidak ikut; reset pabrik menghapusnya.
  Tombol **Ambil sandi dari ONU** (1 GPV path sandi saja).
- **Sembunyikan SSID**: `{"type":"wifi","hidden":true}` →
  `SSIDAdvertisementEnabled=false` (TR-098/TR-181) atau `X_*_SSIDHide` vendor;
  WiFi tetap aktif. Kolom *Siaran SSID* di tabel WiFi.
- Profil v6: leaf `Password`, `SSIDAdvertisementEnabled`, `X_*_SSIDHide`,
  `PreSharedKey.1.PreSharedKey`. Upgrade dari v5 **tanpa GPN** — leaf baru
  diambil dari struktur yang sudah dipetakan (hanya di objek milik ONU itu).
- **Perbaikan:** keluarga vendor dari jumlah ekstensi di area WAN milik ONU
  itu sendiri (F660 ORI `X_ZTE-COM_*` → ZTE, F660 suntikan CMCC → CMCC).
  Bukti discovery dari unit lain bermodel sama dengan ekstensi vendor berbeda
  tidak lagi ikut ditulis (sebelumnya: SPV VLAN unit CMCC memuat
  `X_ZTE-COM_VLANID` → ditolak 9005).
- Tes: 40 unit, 6 suite e2e (baru: `secrets.mjs`; `wan.mjs` + skenario satu
  model dua firmware).

---

## 0g. Data lapangan parameter ONU (19 ONU, 6 kombinasi)

- `docs/PARAMETERS.md`: CPU/RAM, redaman, VLAN, ServiceList, ConnectionType,
  dan lokasi sandi WiFi dari ONU nyata — FiberHome HG6145D2 (RP2939, RP2958,
  RP3478, RP4313), FiberHome HG6543C RP2872, ZTE F660 V9.0.0P1T7.
- **Perbaikan:** keluarga vendor kini ditentukan dari bukti path sebelum nama
  pabrikan (`vendorwan.ts → detectFamily`). ZTE F660 berfirmware China Mobile
  (`X_CMCC_*`) sebelumnya dianggap ZTE → tebakan binding port
  `X_ZTE-COM_LanInterface`; sekarang memakai skema CMCC.
- `scripts/param-report.mjs`: kolom sandi WiFi menampilkan semua lokasi; kolom
  baru counter trafik live.
- Tes unit untuk data lapangan (X_FH_CpuUsed/MemUsed, RX 0.1 µW mentah 58,
  subtree EPON+GPON, detectFamily). `npm test` 37/37, e2e 5 suite lulus.

---

## 0f. Trafik internet live, referensi parameter, keamanan produksi

**Trafik live (Mbps)** — `apps/server/src/live.ts`, `components/TrafficLive.tsx`:
- ACS menahan sesi CWMP dan membaca 2 counter byte WAN tiap 3 detik selama
  durasi pilihan (30 dtk – 5 mnt); berhenti sendiri / tombol Hentikan.
- Counter: `WANPPPConnection.{i}.Stats.EthernetBytes*` koneksi utama →
  `WANCommonInterfaceConfig.TotalBytes*` → `WANEthernetInterfaceConfig.Stats.*`
  (TR-181: `PPP/IP.Interface.{i}.Stats.Bytes*`, `Optical.Interface.1.Stats.*`);
  yang ditolak dilewati otomatis; wrap counter 32-bit ditangani.
- UI: nilai terkini, rata-rata, puncak; grafik 2 seri (palet tervalidasi
  untuk buta warna, terang & gelap), legenda + label ujung garis, crosshair
  + tooltip, tabel data.
- API: `POST/GET/DELETE /api/devices/:id/live`. Maks. 25 pemantauan bersamaan;
  poll live dikecualikan dari batas RPC per sesi.
- `CwmpSession.resume()`, `TaskQueue.dequeueWhere()`; profil v5 (upgrade
  ringan: `GetParameterNames WANDevice.` agar counter `Stats.*` dikenal).
- Uji: `scripts/e2e/live.mjs` (wrap 32-bit, fallback counter, ONU tanpa
  counter, berhenti manual) — terukur 50,0/10,0 Mbps pada laju simulasi 50/10.

**Referensi parameter** — `docs/PARAMETERS.md` (baru): redaman, CPU/RAM, WAN,
WiFi, counter trafik per vendor dengan status bukti (standar / lapangan /
komunitas / pola). **`scripts/param-report.mjs`** (baru): laporan path yang
benar-benar dipakai ONU per vendor/model/firmware dari database (read-only,
tanpa data pelanggan) untuk melengkapi dokumen tersebut.

**Produksi**: diverifikasi bahwa docs, tes, simulator, source, `.env`, DB, dan
`.git` tidak bisa diakses lewat HTTP (404, termasuk path traversal). Link
**API Docs** di sidebar sebelumnya 404 — kini menyajikan `docs/API.md` di `/API.md`.

## 0e. CPU & RAM ONU (semua vendor dan tipe) + uji e2e di repo

**Sumber data** (urutan prioritas):
1. Standar BBF — `InternetGatewayDevice.DeviceInfo.ProcessStatus.CPUUsage` (%),
   `DeviceInfo.MemoryStatus.Total` / `Free` (KiB); padanan TR-181 di `Device.DeviceInfo.`
   (didefinisikan TR-098 sejak InternetGatewayDevice:1.9 dan TR-181).
2. Leaf vendor di bawah `DeviceInfo` (langsung atau satu objek vendor) yang
   namanya memuat CPU/Mem/RAM — mis. `X_HW_CpuUsed`, `X_HW_MemUsed`,
   `X_ZTE-COM_…`, `X_CMCC_SysInfo.CPUUsage`, `…MemoryTotal/Free`. Nama vendor
   tidak terdokumentasi publik, jadi dikenali dari hasil discovery (nama
   non-beban seperti `CPUType`, `CPUFrequency`, `CoreNum` diabaikan).

**Normalisasi**: persen boleh berakhiran `%`; memori vendor: < 8192 = MB,
> 8 juta = byte, selain itu KiB. "…Used" bersama total = jumlah terpakai,
"…Usage/Rate/Percent" = persen. ONU yang tidak melaporkan apa pun tampil "—"
(tidak ditebak).

**Beban**: CPU/RAM termasuk leaf panas → ikut GPV rutin yang sama (0 RPC
tambahan). Path standar yang tidak ada ditandai dari hasil discovery
`DeviceInfo.` tanpa GPV gagal. ONU yang sudah terdaftar di-upgrade ringan
(PROFILE_VERSION 4): hanya `GetParameterNames DeviceInfo.` — terukur 2 RPC.

**UI**: kolom **CPU / RAM** di daftar perangkat (hijau < 70%, kuning 70–90%,
merah > 90%); baris CPU/RAM di kartu Informasi; tile Vendor, Model,
Tipe (ProductClass), Hardware, CPU & RAM (bar + "x MB terpakai dari y MB").

**API**: `GET /api/devices` → `cpu_usage`, `mem_usage`;
`GET /api/devices/:id` → `insight.system` `{cpu, cpuSource, memTotalKb, memFreeKb, memUsedPct, memSource}`.

**Uji e2e kini di repo** — `scripts/e2e/` (`npm run test:e2e`): simulator ONU
ketat (`sim.mjs`) + suite `vendors`, `wan`, `api`, `system`.

## 0d. Tombol aksi "Bad Request", Connection Request Digest, koleksi dua tingkat

**"Bad Request" di tombol aksi** (Hubungi, Pelajari struktur, Segarkan, Reboot,
terapkan/hapus Preset, test/hapus Webhook, hapus pengguna):
- Akar masalah: UI selalu mengirim `Content-Type: application/json` walau
  tanpa body → Fastify menolak (`FST_ERR_CTP_EMPTY_JSON_BODY`). Diperbaiki di
  UI (header hanya bila ada body) **dan** server (body JSON kosong = `{}`).
- Error kini membawa alasan nyata (bukan "Bad Request"); JSON rusak → "Body JSON tidak valid".
- **Tulis Parameter** (tab Perintah) selalu 400: UI mengirim `{values}`, server
  hanya menerima `{params}` — kini keduanya; tipe diambil dari laporan ONU.
- **Hapus pengguna** selalu 404: route `DELETE /api/users/:username` belum
  ada — ditambahkan (admin, bukan diri sendiri, bukan admin terakhir).
- Task tulis manual / AddObject / DeleteObject kini ditutup oleh jawaban ONU.
- Audit otomatis: 38 pemanggilan API di UI dicocokkan dengan route server — semua ada.

**Notifikasi**: hijau = berhasil, kuning = sebagian (mis. data diantrekan
tetapi ONU tak terjangkau), merah = gagal; bisa ditutup. Uji webhook gagal → merah.

**Connection Request (tombol Hubungi)** — `apps/server/src/connreq.ts` (baru):
- HTTP **Digest** (RFC 2617, MD5/MD5-sess, qop=auth) — sebelumnya hanya Basic,
  padahal ZTE/Huawei/FiberHome mewajibkan Digest → selalu 401. Diuji dengan
  contoh resmi RFC 2617.
- `node:http(s)` menggantikan `fetch` (fetch menolak sebagian port: "bad port").
- Satu CR per 10 detik per ONU (429 + sisa waktu).
- Pesan penyebab: kredensial ditolak vs ONU tak terjangkau (NAT/VLAN) vs HTTP lain.
- **Kredensial CR otomatis** (`ACS_CR_AUTO`, default aktif): ONU yang password
  CR-nya tidak diketahui ACS dipasangi `ConnectionRequestUsername/Password`
  milik ACS (satu SPV, sekali; ulang paling cepat 7 hari bila ditolak);
  tersimpan saat ONU menerima. Tidak dilakukan bila operator mengisi sendiri.
- URL CR mengikuti laporan ONU terbaru (sebelumnya hanya diisi sekali dan
  basi saat IP manajemen berubah), kecuali diisi manual.

**PPPoE `ERROR_NO_ANSWER`**: `LastConnectionError` adalah riwayat; kini hanya
ditampilkan bila koneksi tidak Connected, dengan arti dalam bahasa Indonesia.

**Koleksi dua tingkat (beban ONU)**: siklus rutin hanya membaca leaf panas
(redaman, status, IP, uptime, jumlah klien — umumnya 1 GPV); profil penuh tiap
`ACS_FULL_COLLECT_HOURS` (6), saat BOOT/BOOTSTRAP/VALUE CHANGE, atau Segarkan.
Bacaan akibat Connection Request maks. sekali per menit. Terukur: Inform
periodik 0 RPC, rutin 1 GPV.

## 0c. `deploy/update.sh` — update aman di CT

- Update ke commit terbaru tanpa install ulang: `npm ci` dan build UI hanya
  bila file terkait berubah (update dokumen/server ±1 menit, bukan 5–10).
- Backup database sebelum restart (5 terakhir di `data/backup/`).
- Health check; gagal → **rollback otomatis** ke commit lama.
- `--check` (lihat perubahan), `--rollback` (kembali ke versi sebelumnya),
  `--force` (build ulang penuh). Aman dijalankan lewat `curl | bash` dan
  walau file script sendiri ikut diperbarui oleh `git reset`.
- Installer kini menyebut `update.sh` di ringkasan akhir.

## 0b. WAN internet multi-vendor, perintah perangkat, beban ONU

Diuji end-to-end dengan simulator ONU FiberHome (slot OLT `WCD · #1 ·
PPPoE_Routed`), ZTE (WCD kosong), Huawei (binding port), CMCC (bertahap):
semua lulus; tes unit 23/23.

**WAN internet PPPoE / IPoE — pilihan lokasi**
- `placement: existing` — isi/timpa slot yang ada, mis. FiberHome
  `WCD 2 · #1 · PPPoE_Routed` yang disiapkan OLT: `Enable=false` → standar →
  vendor → `Enable=true`; ConnectionType slot dipertahankan.
- `placement: wcd` — koneksi baru di dalam WCD yang sudah ada (WCD kosong
  buatan OLT kini terdeteksi lewat `WAN*ConnectionNumberOfEntries`).
- `placement: new` — WCD baru → koneksi (seperti sebelumnya).
- UI: daftar lokasi lengkap; default = slot kosong pertama di luar WCD 1;
  tombol ⚙ per koneksi di Ringkasan membuka formulir untuk slot itu.

**Pengetahuan vendor terpusat — `apps/server/src/vendorwan.ts`** (baru)
- VLAN level koneksi & link: Huawei `X_HW_VLAN`; ZTE `X_ZTE-COM_VLANEnable` +
  `X_ZTE-COM_VLANID` / `X_ZTE-COM_WANPONLinkConfig.VLANID`; FiberHome
  `X_FH_VLANID` + `X_FH_WANGponLinkConfig.Mode=2/VLANID`; CMCC
  `X_CMCC_VLANMode=2` + `X_CMCC_VLANIDMark` / `X_CMCC_WANGponLinkConfig`;
  CT-COM / CU link config (GPON & EPON).
- ServiceList per vendor; **binding port** Huawei `X_HW_LANBIND.LanN/SSIDN`
  dan operator China/ZTE `X_*_LanInterface`.
- Parameter standar opsional (`TransportType=PPPoE`, `ConnectionTrigger=AlwaysOn`,
  `PPPAuthenticationProtocol=AUTO`) hanya ditulis bila ada di perangkat.
- **ConnectionType** mengikuti nilai yang dipakai ONU (mis. `PPPoE_Routed`),
  bisa dipilih manual.
- Bukti vendor dari koneksi PPP berlaku untuk IP dan sebaliknya.
- **Pengiriman bertahap** (satu parameter per SPV) — otomatis untuk CMCC
  (forum 7385), opsional untuk lainnya. `Enable=true` selalu terakhir.

**Perintah perangkat**
- Tab Konfigurasi → Perangkat: Hubungi, Reboot, interval Inform, reset pabrik.
- Reset pabrik: hanya admin + wajib mengetik serial number (API menolak tanpa
  `confirm` yang cocok).
- Aktif/nonaktif WAN (`wan-enable`) dari tabel Koneksi WAN.
- Task reboot/reset kini ditutup saat ONU menjawab.

**Beban ONU**
- `PROFILE_VERSION` 3: ONU yang sudah terdaftar dipetakan ulang sekali agar leaf baru (WCD kosong, TransportType, binding) terbaca.
- `ACS_MAX_RPC_PER_SESSION` (default 40): sesi diakhiri rapi setelah N RPC,
  sisanya dilanjutkan pada Inform berikutnya. Pemetaan ONU berat terbagi ke
  2–3 sesi (terukur: 40+40+25 RPC untuk FiberHome "sulit").
- Prioritas antrean: tulis/AddObject/DeleteObject/Reboot/FactoryReset/Download
  didahulukan dari pembacaan rutin.

**Varian parameter tambahan**: `WANDevice.1.X_HW_GponInterfaceConfig.*`,
`X_CU_GponInterfaceConfig.RXPower`, `WANDevice.1.WANPONInterfaceConfig.*`,
suhu `DeviceInfo.TemperatureStatus.TemperatureSensor.1.Value` (sumber:
genieacs-panel `deviceParameterFallbacks.js`).

## 0a. Sesi CWMP — ONU yang "terdaftar tapi semua detail kosong"

Gejala di lapangan: FiberHome HG6543C (firmware RP2872) dan sebagian ONU
CMCC tercatat Inform, tetapi tidak satu pun parameter terbaca. Diuji ulang
dengan simulator ONU yang meniru perilaku firmware ketat: **kode sebelumnya
mengirim 0 RPC** ke ONU tersebut; kode ini membaca redaman, PPPoE, WAN, dan
WiFi-nya lengkap.

| Masalah | Penyebab | Perbaikan |
|---------|----------|-----------|
| Tidak ada RPC sama sekali | Sesi hanya dikenali lewat cookie `acs_session`. ONU yang tidak menyimpan cookie (atau gagal memparse atribut `SameSite`/`HttpOnly`/`Max-Age`) memulai sesi baru di setiap POST, sehingga antrean baca tidak pernah terkirim | Sesi dikenali lewat cookie → koneksi TCP yang sama → IP (hanya bila satu sesi aktif di IP itu, < 2 menit). Cookie disederhanakan menjadi `acs_session=<id>; Path=/`. Peristiwa "CPE tidak mengirim cookie sesi" dicatat sekali per sesi |
| Sesi diakhiri dengan cara yang salah | ACS membalas amplop SOAP berisi `<Body/>` kosong (HTTP 200) | TR-069: respons HTTP **kosong 204** mengakhiri sesi |
| RPC ditolak firmware yang memakai CWMP 1.2+ | Balasan selalu `urn:dslforum-org:cwmp-1-0` | Namespace mengikuti versi di Inform ONU (`cwmp-1-0` … `cwmp-1-4`) |
| 415 dari Fastify | Parser body hanya menerima `text/xml`/`application/xml` | Port CWMP menerima Content-Type apa pun |
| Struktur ONU tak terpetakan | Sebagian firmware menolak `GetParameterNames` dengan `NextLevel=false` | Root yang ditolak dicoba ulang dengan `NextLevel=true` dan ditelusuri bertingkat (maks. 150 subtree); perangkat diingat "mode bertingkat" |
| Sesi menumpuk di memori | Sesi yang ditinggal CPE tidak pernah dibuang | Sesi idle > 10 menit dibersihkan |
| Sulit didiagnosis | Tidak ada log alur RPC | `ACS_CWMP_TRACE=1` (alur RPC per ONU) / `=2` (+ isi SOAP) |

Varian redaman baru dan pemilihan per keluarga vendor (`modelpaths.ts`):

- **CMCC / China Mobile (GM220-S dll.)**: `WANDevice.1.X_CMCC_GponInterfaceConfig.{RXPower,TXPower,TransceiverTemperature,SupplyVottage,BiasCurrent}`, `X_CMCC_EponInterfaceConfig.*` — satuan 0.1 µW / 1/256 °C dinormalisasi otomatis. VLAN di `WANConnectionDevice.N.X_CMCC_WANGponLinkConfig.VLANIDMark` (+ `Mode=2`), ServiceList `X_CMCC_ServiceList`.
- **FiberHome**: `X_FH_GponInterfaceConfig.*`, plus `X_CT-COM_`/`X_CMCC_GponInterfaceConfig` untuk firmware operator; VLAN `X_FH_VLANID`, ServiceList `X_FH_ServiceList`.
- **ZTE lama / EPON**: `InternetGatewayDevice.X_CT-COM_EponInterfaceConfig.Stats.*`; **Realtek EPON**: `InternetGatewayDevice.X_Realtek_EponInterfaceConfig.Stats.*`; **Nokia**: `WANDevice.1.X_ALU-COM_GponInterfaceConfig.RXPower`; **TR-181**: `Device.Optical.Interface.1.Stats.{RxPower,TxPower}`.
- Keluarga vendor ditebak dari Manufacturer/OUI/ProductClass (firmware operator sering melapor "CMCC" sebagai pabrikan). Kandidat keluarga itu dicoba lebih dulu — lebih sedikit RPC split-on-fault pada ONU yang menolak discovery — dan bila semuanya ditolak, otomatis melebar ke seluruh varian.
- Modul konfigurasi mengenali keluarga `cmcc`/`cu` untuk tebakan VLAN/ServiceList.

Lain-lain: UI tidak tersaji bila folder instalasi mengandung spasi
(`URL.pathname` → `%20`) — diganti `fileURLToPath`.

## 0. Installer (`deploy/install.sh`) — CT Proxmox Ubuntu/Debian

Diuji di container dengan batas RAM **1 GB**: Ubuntu 22.04, Ubuntu 24.04,
Debian 12, Debian 13 — instal baru, instal ulang/update, mode interaktif via
terminal, dan jalur systemd (unit aktif + enabled, berjalan sebagai user `acs`).

| Masalah | Penyebab | Perbaikan |
|---------|----------|-----------|
| Berhenti di `tr: write error: Broken pipe` (baris 108) | `tr </dev/urandom \| head -c 12` + `set -o pipefail`: `tr` mati SIGPIPE (exit 141) → `set -e` menghentikan installer | Pembuat string acak tanpa SIGPIPE (`head -c 256 /dev/urandom \| tr -dc …`) |
| Build UI `Killed` (exit 137) di CT 1 GB | Next.js 16 Turbopack memakai > 1 GB | RAM efektif dideteksi (MemTotal + batas cgroup di sepanjang hierarki); < 3 GB → build webpack hemat memori (`ACS_BUILD_LOWMEM=1`, satu worker, heap 512 MB) — terukur lolos di 768 MB & 1 GB; mesin besar otomatis turun ke mode hemat bila build biasa gagal |
| Update gagal `detected dubious ownership` | Repo dimiliki user `acs`, git dijalankan root (git ≥ 2.35.2) | `git -c safe.directory=$APP_DIR`; update = `fetch --depth 1` + `reset --hard FETCH_HEAD` |
| Layanan gagal `226/NAMESPACE` di CT unprivileged | `PrivateTmp`/`ProtectSystem` butuh mount namespace | Opsi sandbox hanya dipasang di VM/bare metal (`systemd-detect-virt -c`) |
| Node.js gagal/terlalu lama | Hanya NodeSource `setup_22.x`; bentrok paket `libnode` Ubuntu | Node 24 LTS via repo NodeSource (keyring), paket `nodejs/libnode` distro dibersihkan; cadangan biner resmi nodejs.org; Node ≥ 22.18 yang ada dipakai |
| Instal ulang menimpa konfigurasi | `.env` ditulis ulang dari default | `.env` lama jadi default (tanpa menimpa env yang di-export); DB & TLS dipertahankan; ringkasan menyatakan password admin lama tidak berubah |
| Sisa script "termakan" pada `curl \| bash` | Perintah anak bisa membaca stdin | Seluruh script dalam satu blok `{ … }` + `exec </dev/null` |
| Error sulit dilacak | Output dipotong `tail -3` | Semua output ke `/var/log/acs-install.log`; langkah gagal mencetak 30 baris terakhir; health check 30 detik + 30 baris journal bila gagal |
| `$ID` kosong / distro turunan | `case "$ID"` tanpa `ID_LIKE`, `set -u` | Deteksi `ID`/`ID_LIKE`; arsitektur x86_64/aarch64; Debian 11 diberi peringatan EOL |
| Tanpa systemd (Docker) installer gagal | `systemctl` wajib | Fallback menjalankan ACS di latar belakang via `setpriv` sebagai user `acs` |
| Validasi input | Port/password tidak divalidasi | Port 1–65535 dan tidak boleh sama; password 8–64 karakter aman untuk `.env`; port < 1024 → `CAP_NET_BIND_SERVICE` |
| `apt` 404 sesaat | Mirror sedang sinkron | `apt-get install` dicoba ulang setelah `apt-get update` |

`ACS_ENABLE_FS` dihapus (tidak ada listener FS terpisah). Variabel baru:
`ACS_NONINTERACTIVE`, `REPO_BRANCH`, `NODE_MAJOR`.

## 1. Ringkasan akar masalah

| # | Gejala | Akar masalah | Perbaikan |
|---|--------|--------------|-----------|
| 1 | Nilai redaman muncul di kolom "Terakhir Inform" | `<thead>` tabel Perangkat 8 kolom, setiap baris berisi 11 `<td>` | Tabel ditulis ulang; kolom **Redaman RX** sendiri + TX, PPPoE, IP WAN |
| 2 | Banyak ONU tidak pernah terbaca | `GetParameterNames` mengirim `<ParameterName>` (TR-069: **`<ParameterPath>`**) → path dianggap kosong = seluruh pohon, atau Fault 9003. `GetParameterValues` menyisipkan `<CommandKey>` yang **bukan argumen GPV** → firmware ketat (Huawei, sebagian ZTE) membalas Fault 9003 | RPC disesuaikan spesifikasi; pencocokan batch ↔ fault memakai kunci RPC di sesi |
| 3 | Redaman kosong di banyak merek | Varian path redaman kurang (ZTE F660 `X_CT-COM_GponInterfaceConfig.Stats`, Huawei `X_HW_DEBUG.AdminTR069` & `X_GponInterafceConfig`, Nokia `X_ALU_OntOpticalParam`, TR-181 `Optical.Interface`). Satuan 0.1 µW / 0.001 dBm tidak dikonversi. Setelah discovery, path redaman katalog **dibuang dari profil** | Path redaman jadi *esensial* (selalu dibaca); normalisasi satuan ke dBm; deteksi berbasis pola di subtree vendor mana pun |
| 4 | PPPoE tidak tampil | Path dipatok `WANConnectionDevice.1`; ZTE/Huawei/FiberHome memakai WCD.1 untuk TR069 dan menaruh PPPoE di WCD.2/.3. Profil discovery dipotong 400 node pertama dan path wildcard dibuang | Discovery per perangkat dengan nomor instans asli; insight mencari semua `WANPPPConnection`/`WANIPConnection` |
| 5 | Ganti sandi WiFi gagal total | Selalu menulis `BeaconType=WPA2PSK` (bukan enum TR-098). SPV atomik → SSID & sandi ikut ditolak | BeaconType hanya diubah bila jaringan terbuka, ke nilai sah `11i`. Sandi ditulis ke lokasi yang terbukti ada |
| 6 | Tambah WAN tidak jalan / bentrok | `AddObject` `WANPPPConnection` di WCD.1 milik TR069; VLAN hanya satu nama vendor; satu nama vendor salah menggagalkan username/password | Rantai `AddObject` WCD baru → koneksi; parameter standar & vendor dikirim di SPV terpisah; VLAN level koneksi **dan** level link |
| 7 | Event Inform selalu kosong | Parser membaca `node.string`, padahal struktur CWMP `<EventStruct><EventCode>` | Parser event diperbaiki → preset berbasis `1 BOOT` dan pembacaan saat `6 CONNECTION REQUEST` berjalan |
| 8 | "Pelajari struktur" error 500 pada klik kedua | Task dibuat dengan id = `deviceId` → bentrok PRIMARY KEY | Tidak lagi membuat task ber-id tetap |
| 9 | Task konfigurasi menggantung `pending` saat ditolak | Fault SPV/AddObject tidak dipetakan ke task; status `error` tidak dirender UI | Kunci RPC = id task; fault menutup task sebagai `failed` |

---

## 2. Engine CWMP (`packages/acs-core`)

### `rpc.ts`
- `buildGetParameterNames` memakai `<ParameterPath>` sesuai TR-069.
- `buildGetParameterValues` tidak lagi mengirim `<CommandKey>`.
- `handleGetParameterValuesResponse` juga mengembalikan `types` (xsi:type per
  parameter) supaya penulisan berikutnya memakai tipe yang dilaporkan perangkat.

### `session.ts`
- Field baru `lastSentKey` (= `Rpc.key` RPC terakhir). Dipakai untuk
  mencocokkan balasan GPV dan Fault ke batch asal (split-on-fault) tanpa
  elemen non-standar di XML.
- `InformInfo.parameterValues`: nilai `ParameterList` Inform (IP WAN,
  ConnectionRequestURL, versi SW) kini diparse dan disimpan — sebelumnya selalu kosong.
- Parser `Event` membaca `EventStruct/EventCode`.
- `readParameterName` menerima `ParameterPath`.
- `DeleteObjectResponse` membawa `commandKey` (dari `<ParameterKey>`) agar task bisa ditutup.

### `db.ts`
- Kolom ringkasan baru di `devices` (migrasi otomatis `ALTER TABLE`):
  `data_model`, `rx_power`, `tx_power`, `optical_temp`, `pppoe_user`,
  `pppoe_status`, `wan_ip`, `ssid`, `summary_at`.
- Kolom `collection.profile_version` — profil versi lama dipetakan ulang otomatis.
- Method baru: `recordDiscoveryMany` (satu transaksi), `writablePaths`,
  `pruneParams`, `bumpDiscoveryTry`, `unmarkInvalidParams`,
  `clearInvalidParams`, `resetDiscovery`, `purgeStaleReadBatches`.
- `listDevices`: pencarian juga di PPPoE/IP WAN/IP/SSID; filter `rxMax`.

---

## 3. Server (`apps/server`)

### `insight.ts` (baru)
Modul murni (tanpa I/O) yang mengubah parameter mentah menjadi informasi operasional:

- **`extractOptical`** — RX/TX/suhu/tegangan/bias dari subtree optik vendor
  mana pun (dibatasi konteks `PON/Gpon/Epon/Optical/Transceiver/AdminTR069`
  agar RSSI WiFi tidak salah tangkap).
- **`normalizePower`** — dBm apa adanya; negatif besar dibagi 10/100/1000
  (TR-181 `OpticalSignalLevel` = 0.001 dBm); RX positif = 0.1 µW →
  `10·log10(v/10000)`; RX 0 atau ≤ -40 dBm = **LOS**. Suhu 1/256 °C,
  tegangan 100 µV/mV, bias 2 µA dinormalisasi.
- **`extractWan`** — semua koneksi `WANPPPConnection`/`WANIPConnection` di
  WCD mana pun (TR-098) atau `PPP.Interface` (TR-181), lengkap dengan
  username, status, IP, VLAN (`X_HW_VLAN`, `X_ZTE-COM_VLANID`, `X_FH_VLANID`,
  `X_CMCC_VLANIDMark`, `VLANID`, atau level link `X_*_WANGponLinkConfig.VLANIDMark`)
  dan ServiceList vendor.
- **`extractWlan`** — semua SSID (WLANConfiguration.N / WiFi.SSID.N), band
  2.4/5 GHz, keamanan, klien, dan lokasi sandi yang ada di perangkat.
- **`summaryFields`** — kolom ringkasan untuk tabel `devices`.

### `profiler.ts` (ditulis ulang)
- Discovery = `GetParameterNames(root, NextLevel=false)` → seluruh subtree
  dalam **satu** balasan. Root per data model:
  - TR-098: `WANDevice.`, `LANDevice.1.WLANConfiguration.`, `DeviceInfo.`
  - TR-181: `PPP.Interface.`, `IP.Interface.`, `Ethernet.VLANTermination.`,
    `Optical.Interface.`, `WiFi.`, `DeviceInfo.`
- `isInterestingLeaf` memilih leaf yang layak dibaca ulang (redaman, koneksi
  WAN + VLAN/ServiceList vendor, link config, WiFi, info dasar); tabel besar
  (PortMapping, Stats, Hosts, AssociatedDevice) dibuang. Batas 800 path/perangkat.

### `modelpaths.ts` (ditulis ulang)
- `essentialPaths(model)` — info dasar + **24 varian redaman TR-098** (termasuk
  yang berada di luar `WANDevice.`) / 3 path optik TR-181. Selalu ikut dibaca.
- Tidak ada lagi path WAN/WiFi dengan nomor instans tetap.

### `cwmp.ts` (ditulis ulang sebagian besar)
- `applyValues` dipakai bersama oleh Inform dan GPV: simpan nilai + tipe,
  versi SW/HW, data model, Connection Request, lalu `refreshSummary`.
- **Discovery baru**: profil = leaf menarik milik perangkat itu; subtree yang
  baru dipetakan **mengganti** isi lama (WAN terhapus tidak dibaca lagi);
  parameter basi di bawah root dihapus (`pruneParams`); leaf baru langsung
  dibaca di sesi yang sama; kandidat redaman esensial yang tidak ada di
  subtree ditandai invalid tanpa harus dibuktikan lewat puluhan GPV.
- **Mode BFS** untuk firmware yang hanya menjawab anak langsung pada
  `NextLevel=false` — terdeteksi otomatis, objek anak ditelusuri satu per
  satu, dan pembersihan parameter dimatikan.
- GPN yang tidak dijawab 3× dilewati (tidak macet selamanya).
- `handleAddObject` mendukung **rantai** (`then`): WCD baru → koneksi di
  dalamnya; parameter standar satu SPV, parameter vendor **satu SPV per
  parameter** (tebakan yang salah hanya menggagalkan dirinya).
- Setelah SPV berhasil: nilai yang ditulis dibaca balik (kecuali sandi);
  bila `rediscover`, subtree WAN dipetakan ulang. DeleteObject juga memicu
  pemetaan ulang WAN.
- Status SPV/AddObject `1` (diterima, berlaku setelah apply) dianggap sukses.
- Kunci RPC `enqueueWrite/AddObject/DeleteObject` = id task.
- `PROFILE_VERSION = 2`; fungsi baru `collectPaths`, `deviceModel`,
  `refreshSummary`, `continueDiscovery`, `rediscoverWan`.

### `configure.ts` (ditulis ulang)
- Target koneksi berupa path objek nyata (`target`), bukan `slot` di WCD.1.
- Pengetahuan perangkat = `params` ∪ `discovered_params` model itu; tipe
  diambil dari tipe yang dilaporkan perangkat (path sama atau bentuk sama).
- Keluarga vendor dari bukti path dulu, lalu nama pabrikan/OUI
  (Huawei, ZTE, FiberHome, CT-COM, CMCC, CU).
- **WiFi**: pilih SSID (`wlanIndex`), aktif/nonaktif, sandi ke semua lokasi
  yang ada (`KeyPassphrase`, `PreSharedKey.1.KeyPassphrase`, `X_*_KeyPassphrase`;
  `PreSharedKey.1.PreSharedKey` khusus Huawei bila hanya itu); TR-181 via
  `AccessPoint.N.Security.KeyPassphrase`.
- **PPPoE**: username/password di SPV sendiri; VLAN dan ServiceList di SPV terpisah.
- **VLAN**: urutan pilihan path — yang terbaca untuk koneksi itu → path vendor
  yang terbukti ada → tebakan keluarga vendor; ikut menyalakan
  `X_ZTE-COM_VLANEnable` dan `X_*_LinkConfig.Mode=2` bila ada. TR-181 lewat
  `Ethernet.VLANTermination`.
- **Buat WAN** (`wan-add`, `wan-ip-add`): mode Route/Bridge, DHCP/Static
  (IP, mask, gateway, DNS), ServiceList, dan **parameter tambahan** bebas
  (`Path = nilai`, relatif ke koneksi baru atau absolut).
- **Hapus WAN** (`wan-delete`): hapus WCD bila koneksi itu satu-satunya,
  selain itu hapus koneksinya saja.
- Laporan memuat `guessed` (nama vendor yang belum terbukti) dan `tasks`.

### `api.ts`
- `GET /api/devices`: kolom ringkasan langsung dari tabel `devices` (tidak lagi
  membaca seluruh `params` per baris); filter `?rxmax=`.
- `GET /api/devices/:id`: menyertakan `insight`.
- **Baru** `POST /api/devices/:id/refresh` — antrekan baca esensial + profil.
- `POST /api/devices/:id/read`: partial path (berakhiran `.`) diizinkan.
- `POST /api/devices/:id/config`: tipe dari `CONFIG_TYPES` (+ `wan-delete`);
  bila tidak ada yang diantrekan, HTTP 400 dengan `error` berisi alasan nyata.
- `POST /api/devices/:id/discover`: tidak lagi crash pada panggilan kedua.

### `index.ts`
- Inform: perangkat baru / profil versi lama → discovery penuh (pembacaan
  dilakukan discovery itu sendiri). Selain itu pembacaan dilakukan bila
  **jatuh tempo** atau event `0 BOOTSTRAP`, `1 BOOT`, `4 VALUE CHANGE`,
  `6 CONNECTION REQUEST` — tidak lagi membaca ulang semuanya di setiap Inform.
- Sweep periodik hanya membersihkan `read_batch` basi (RPC hanya bisa dikirim
  saat perangkat membuka sesi; sweep lama menumpuk bacaan ganda).

---

## 4. UI (`apps/web`)

- **Halaman Perangkat**: kolom Status · Serial/ID · Model (vendor + firmware) ·
  PPPoE (username + status) · IP WAN · **Redaman RX** (badge warna) · TX ·
  Terakhir Inform · Antre. Filter "Perhatian (< -25 dBm)" / "Buruk (< -27 dBm)",
  pencarian PPPoE/IP/SSID, tombol muat ulang.
- **Detail Perangkat**:
  - Tombol **Segarkan** (`/refresh` + Connection Request) dan **Pelajari struktur**.
  - Kartu Informasi: redaman, vendor, data model, uptime.
  - Tab **Ringkasan**: tile redaman (RX/TX/suhu/tegangan/bias + sumber path),
    tabel **semua koneksi WAN** (tipe, WCD, username, status, IP, VLAN, service,
    tombol Ubah/Hapus), tabel **semua SSID** (band, status, keamanan, kanal,
    klien, tombol Ubah), info perangkat.
  - Tab **Konfigurasi** (baru): WiFi, PPPoE, VLAN, Buat WAN — target dipilih
    dari koneksi yang terdeteksi, nilai saat ini terisi otomatis, peringatan
    untuk nama parameter hasil tebakan.
  - Tab Antrean menampilkan task `failed` beserta alasannya.
- `lib/optical.ts`: ambang redaman — > -8 terlalu kuat, -8…-25 baik,
  -25…-27 perhatian, < -27 buruk, LOS.

---

## 5. Lain-lain

- `apps/server/test/insight.test.ts` (7 tes baru) — normalisasi satuan,
  redaman Huawei/ZTE/Nokia/TR-181, PPPoE di WCD.2, VLAN level link, WiFi,
  filter profiler. `npm test` kini menjalankan tes engine + server.
- `scripts/sim-ont.mjs` menerima `<ParameterPath>`.
- `docs/API.md`, `docs/PROVISIONING.md`, `README.md` diperbarui.
- `deploy/install.sh` default `REPO_URL` → repo ini.

## 6. Catatan upgrade

1. Migrasi DB otomatis saat start (kolom baru). Tidak perlu langkah manual.
2. Pada Inform pertama setelah upgrade, setiap perangkat **dipetakan ulang
   sekali** (`profile_version` < 2). Sesi pertama per ONU lebih panjang
   (±45–50 RPC, termasuk pembuktian varian redaman di luar subtree discovery).
3. Preset bawaan lama **"Data ONU (redaman, PPPoE, WiFi)"** memakai path WCD.1
   tetap dan kini redundan — disarankan dinonaktifkan di menu Preset.
4. Buat WAN otomatis untuk perangkat **TR-181** belum didukung (gunakan tab
   Perintah → AddObject). Baca data, WiFi, PPPoE, dan VLAN TR-181 sudah didukung.
