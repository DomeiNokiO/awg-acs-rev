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
