# Provisioning & Konfigurasi ONU — AWG-ACS

Dokumen ini menjelaskan **bagaimana ACS membaca redaman, PPPoE, VLAN, dan
WiFi dari ONU semua vendor**, dan **bagaimana ONU dikonfigurasi dari UI/API**
(ganti SSID/sandi, PPPoE, VLAN, buat & hapus WAN).

Riwayat perubahan rinci: [CHANGELOG.md](../CHANGELOG.md).

---

## 1. Prinsip

1. **RPC harus persis spesifikasi TR-069.** Firmware ONU (terutama Huawei dan
   ZTE) menolak elemen yang tidak dikenal dengan Fault 9003. Karena itu:
   - `GetParameterNames` memakai `<ParameterPath>` + `<NextLevel>`.
   - `GetParameterValues` hanya berisi `<ParameterNames soap-enc:arrayType=…>`
     — **tanpa** `<CommandKey>`.
   - `SetParameterValues`/`AddObject`/`DeleteObject` membawa `<ParameterKey>`
     berisi id task.
2. **Jangan mematok nomor instans.** PPPoE di ZTE/Huawei/FiberHome umumnya ada
   di `WANConnectionDevice.2` atau `.3` (WCD.1 untuk TR069/VoIP). ACS memakai
   nomor instans milik perangkat itu sendiri hasil discovery.
3. **Nama parameter vendor dipilih dari bukti**, bukan asumsi: path yang pernah
   terbaca dari perangkat ∪ hasil `GetParameterNames` model yang sama. Tebakan
   hanya dipakai bila belum ada bukti, dan dilaporkan ke operator.
4. **SPV bersifat atomik** — satu nama salah menggagalkan semuanya. Parameter
   standar (username/password, SSID) dan parameter vendor (VLAN, ServiceList)
   dikirim di SPV terpisah.

---

### Aturan sesi (kompatibilitas firmware ketat)

- Sesi dikenali lewat cookie `acs_session` → koneksi TCP yang sama → IP
  (hanya bila tepat satu sesi aktif di IP itu). ONU yang tidak menyimpan
  cookie (FiberHome HG6543C dll.) tetap mendapat RPC; peristiwa
  "CPE tidak mengirim cookie sesi" dicatat.
- Akhir sesi = respons HTTP kosong **204**, bukan amplop SOAP kosong.
- Namespace `cwmp-1-x` di balasan mengikuti versi Inform ONU.
- Body CWMP diterima dengan Content-Type apa pun.
- Diagnosis: `ACS_CWMP_TRACE=1` di `.env` → `journalctl -u acs -f` menampilkan
  `[cwmp] <device> sesi=… via=cookie|koneksi|ip ← Inform [1 BOOT] ns=1-2 → InformResponse`.

## 2. Alur pembacaan

```
Inform ──► simpan nilai ParameterList Inform (IP WAN, CR URL, versi SW)
   │
   ├─ perangkat baru / profil versi lama ─► DISCOVERY
   │      GPN(root, NextLevel=false) per root data model
   │        ├─ catat nama ke katalog model (discovered_params)
   │        ├─ profil perangkat ← leaf "menarik" (ganti subtree lama)
   │        ├─ hapus params basi di bawah root (WAN yang sudah dihapus)
   │        ├─ kandidat redaman yang tidak ada di subtree → invalid_param
   │        └─ GPV leaf baru di sesi yang sama
   │      root habis ─► GPV path esensial (redaman di luar WANDevice dsb.)
   │
   └─ sudah dipetakan ─►
          BOOT/BOOTSTRAP/VALUE CHANGE, atau profil penuh > ACS_FULL_COLLECT_HOURS
              → GPV PENUH (esensial ∪ profil), batch 24, split-on-fault
          jatuh tempo (ACS_COLLECT_INTERVAL_MIN) atau CONNECTION REQUEST (maks. 1×/menit)
              → GPV PANAS: redaman, ConnectionStatus, ExternalIPAddress,
                LastConnectionError, UpTime, TotalAssociations, HostNumberOfEntries
          selain itu → 0 RPC (sesi langsung diakhiri 204)
```

Setiap balasan GPV/Inform memperbarui **kolom ringkasan** perangkat
(`rx_power`, `tx_power`, `optical_temp`, `pppoe_user`, `pppoe_status`,
`wan_ip`, `ssid`, `data_model`) lewat `insight.ts`. Daftar perangkat membaca
kolom ini — tidak perlu memindai tabel `params`.

### Root discovery

| Data model | Root (`NextLevel=false`, seluruh subtree) |
|------------|-------------------------------------------|
| TR-098 (`InternetGatewayDevice.`) | `WANDevice.`, `LANDevice.1.WLANConfiguration.`, `DeviceInfo.` |
| TR-181 (`Device.`) | `PPP.Interface.`, `IP.Interface.`, `Ethernet.VLANTermination.`, `Optical.Interface.`, `WiFi.`, `DeviceInfo.` |

- Root yang ditolak (Fault apa pun) → `discovery_root_failed`, lanjut ke root berikutnya.
- Root yang tidak dijawab 3× (perangkat memutus sesi) → dilewati.
- Root yang ditolak dengan `NextLevel=false` dicoba ulang **sekali** dengan
  `NextLevel=true`. Bila berhasil, perangkat ditandai mode bertingkat dan
  subtree berikutnya ditelusuri per tingkat (maks. 150 subtree antre).
- **Firmware dangkal**: bila balasan `NextLevel=false` hanya berisi anak
  langsung (tak satu pun nama lebih dalam dari satu tingkat), ACS beralih ke
  **mode BFS** — objek anak ditelusuri satu per satu, kecuali tabel besar
  (`PortMapping`, `Stats`, `Hosts`, `AssociatedDevice`, `WPS`, …), dan
  penghapusan parameter basi dimatikan karena datanya tidak lengkap.

### Leaf yang masuk profil (`isInterestingLeaf`)

- `DeviceInfo` dasar (model, SW/HW, uptime).
- `WANDevice.N.WANConnectionDevice.N.WANPPPConnection|WANIPConnection.N.*`:
  `Enable, Name, Username, ConnectionStatus, ConnectionType, AddressingType,
  ExternalIPAddress, SubnetMask, DefaultGateway, DNSServers, MACAddress,
  Uptime, LastConnectionError, NATEnabled, VLANID` dan ekstensi
  `X_*_{VLANID,VLANIDMark,VLAN,VLANEnable,VLANMode,ServiceList,SERVICELIST,ServiceType,…}`.
- Link config: `WANConnectionDevice.N.X_*LinkConfig.{Enable,Mode,VLANIDMark,VLANID,802-1pMark}`.
- Optik di bawah `WANDevice.N.X_*`/`WANEponInterfaceConfig`: `RXPower, TXPower,
  TransceiverTemperature, SupplyVoltage, BiasCurrent, Status`.
- WiFi: `WLANConfiguration.N.{SSID, Enable, Status, BeaconType, Channel,
  Standard, TotalAssociations, KeyPassphrase, PreSharedKey.1.KeyPassphrase, …}`.
- Padanan TR-181 untuk Optical, PPP, IP, VLANTermination, WiFi SSID/Radio/AccessPoint.

Maksimum 800 path per perangkat.

### Path esensial (`modelpaths.ts`)

Selalu ikut dibaca — terutama untuk redaman yang berada **di luar** root discovery:

| Vendor | Path RX (TX/suhu menyertai) |
|--------|-----------------------------|
| FiberHome | `WANDevice.1.X_FH_GponInterfaceConfig.RXPower` |
| ZTE (F670L, F609 baru) | `WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower` |
| ZTE F660/F609 lama | `InternetGatewayDevice.X_CT-COM_GponInterfaceConfig.Stats.RxPower` |
| Huawei HG8245/HG8546M | `WANDevice.1.X_GponInterafceConfig.RXPower` (typo bawaan firmware) |
| Huawei EG8145V5 dkk. | `InternetGatewayDevice.X_HW_DEBUG.AdminTR069.RxPower` |
| Huawei HG/EG baru | `WANDevice.1.X_HW_GponInterfaceConfig.RXPower` / `TXPower` |
| China Unicom / generik | `WANDevice.1.X_CU_GponInterfaceConfig.RXPower`, `WANDevice.1.WANPONInterfaceConfig.RXPower` |
| Suhu perangkat (fallback) | `DeviceInfo.TemperatureStatus.TemperatureSensor.1.Value` |
| Nokia / Alcatel-Lucent | `InternetGatewayDevice.X_ALU_OntOpticalParam.RXPower` |
| CT-COM / CMCC / CU | `WANDevice.1.X_CT-COM_*`, `X_CMCC_*`, `X_CU_WANEPONInterfaceConfig.OpticalTransceiver.RXPower` |
| EPON standar | `WANDevice.1.WANEponInterfaceConfig.RXPower` |
| China Mobile (GM220-S dll.) | `WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower` (+ `TXPower`, `TransceiverTemperature`, `SupplyVottage`, `BiasCurrent`), `X_CMCC_EponInterfaceConfig.RXPower` |
| ZTE lama EPON | `InternetGatewayDevice.X_CT-COM_EponInterfaceConfig.Stats.RxPower` |
| ONU berbasis Realtek (EPON) | `InternetGatewayDevice.X_Realtek_EponInterfaceConfig.Stats.RxPower` |
| Nokia (varian) | `WANDevice.1.X_ALU-COM_GponInterfaceConfig.RXPower` |
| TR-181 | `Device.Optical.Interface.1.OpticalSignalLevel` / `TransmitOpticalLevel` |
| TR-181 (varian) | `Device.Optical.Interface.1.Stats.RxPower` / `TxPower` |

Kandidat dipilih **per keluarga vendor** (FiberHome, ZTE, Huawei, Nokia,
CMCC/operator China) berdasarkan Manufacturer/OUI/ProductClass; bila semua
kandidat keluarganya ditolak perangkat, seluruh varian dicoba.

Varian yang tidak ada di perangkat ditandai `invalid_param` (langsung dari
hasil discovery, atau lewat split-on-fault) dan tidak dikirim lagi.

### Split-on-fault

Satu path tidak valid membatalkan seluruh GPV (Fault 9005). Isi tiap batch
disimpan di `read_batch` dengan kunci = `Rpc.key`; sesi mengingat kunci RPC
terakhir (`lastSentKey`) sehingga Fault bisa dicocokkan **tanpa** elemen
tambahan di XML. Batch dibelah dua sampai tersisa satu path → path itu
dicatat di `invalid_param`. Setelah kedalaman 8, sisa path dikirim satu per satu.

### Normalisasi redaman (`insight.ts`)

| Nilai mentah | Tafsiran | Contoh |
|--------------|----------|--------|
| negatif wajar (≥ -60) | dBm | `-21.34` → -21.34 |
| negatif besar | 0.1 / 0.01 / 0.001 dBm | `-21000` → -21.00 (TR-181) |
| RX positif | 0.1 µW (standar CT-COM) | `100` → -20.00 dBm |
| TX positif ≤ 10 | dBm | `2.31` → 2.31 |
| TX positif > 10 | 0.1 µW | `20000` → 3.01 dBm |
| RX `0` atau ≤ -40 dBm | **LOS** | |

Suhu > 200 dibagi 256 (1/256 °C); tegangan > 10000 = 100 µV, > 100 = mV;
bias > 1000 = satuan 2 µA. Path optik hanya diterima bila berada dalam
konteks `PON/Gpon/Epon/Optical/Transceiver/AdminTR069` agar RSSI WiFi tidak
terbaca sebagai redaman.

Penilaian di UI (`apps/web/lib/optical.ts`): > -8 terlalu kuat · -8…-25 baik ·
-25…-27 perhatian · < -27 buruk · LOS.

---

## 3. Konfigurasi ONU

```
POST /api/devices/:id/config     (cookie sesi + header x-csrf)
```

`target` = path objek koneksi dari `insight.wan[].base`, mis.
`InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.`
Tanpa `target`, dipakai koneksi PPPoE utama (punya username, utamakan yang Connected).

| `type` | Field | Yang dikirim ke perangkat |
|--------|-------|---------------------------|
| `wifi` | `wlanIndex`, `ssid?`, `passphrase?`, `wifiEnable?` | SPV `SSID`/`Enable` + sandi ke semua lokasi sandi yang ada |
| `pppoe` | `target?`, `username?`, `password?`, `vlanId?`, `serviceName?` | Ubah cepat: SPV kredensial; SPV VLAN; SPV ServiceList |
| `vlan` | `target?`, `vlanId` | SPV VLAN (+ pendamping vendor) |
| `wan-add` | `placement`, `target?`/`wcd?`, `username`, `password`, `vlanId?`, `name?`, `bridge?`, `connectionType?`, `serviceName?`, `bindLan?`, `bindSsid?`, `sequential?`, `extra?` | WAN internet **PPPoE** di lokasi pilihan (lihat bawah) |
| `wan-ip-add` | sama, plus `staticIp?`, `netmask?`, `gateway?`, `dns?` | WAN internet **IPoE** (DHCP bila tanpa `staticIp`, atau bridge) |
| `wan-delete` | `target` | DeleteObject WCD (bila koneksi satu-satunya) atau koneksinya |
| `wan-enable` | `target`, `enable` | SPV `Enable` koneksi |
| `inform-interval` | `informInterval` (60–86400) | SPV `ManagementServer.PeriodicInformEnable/Interval` |

Perintah perangkat (endpoint terpisah): `POST /reboot`, `POST /factory-reset`
(admin + `{"confirm":"<serial number>"}`), `POST /connect`, `POST /refresh`.

Respons: `{queued, plan[], skipped[], guessed[], tasks[], writes[]}`. Bila
tidak ada yang diantrekan → HTTP 400 dengan `error` berisi alasannya.

### WiFi

- Lokasi sandi: `PreSharedKey.1.KeyPassphrase` (ZTE/FiberHome), `KeyPassphrase`
  (Huawei), `X_*_KeyPassphrase` — semua yang ada ditulis. Bila hanya
  `PreSharedKey.1.PreSharedKey` dan vendor Huawei, itu yang dipakai.
- `BeaconType` **hanya** diubah bila jaringan terbuka (`None`/`Basic`), ke
  `11i` (+ `IEEE11iAuthenticationMode=PSKAuthentication`,
  `IEEE11iEncryptionModes=AESEncryption` bila ada). Nilai `WPA2PSK` versi
  lama tidak sah di TR-098 dan membuat seluruh SPV ditolak.
- TR-181: `WiFi.SSID.N.SSID`, `WiFi.AccessPoint.N.Security.KeyPassphrase`.

### Pengetahuan vendor WAN (`vendorwan.ts`)

| Keluarga | VLAN level koneksi | VLAN level link (WCD) | ServiceList | Binding port |
|----------|--------------------|-----------------------|-------------|--------------|
| Huawei | `X_HW_VLAN` | – | `X_HW_SERVICELIST` | `X_HW_LANBIND.Lan{1-4}Enable`, `SSID{1-8}Enable` |
| ZTE | `X_ZTE-COM_VLANEnable=true` + `X_ZTE-COM_VLANID` | `X_ZTE-COM_WANPONLinkConfig.VLANID` | `X_ZTE-COM_ServiceList` | `X_ZTE-COM_LanInterface` |
| FiberHome | `X_FH_VLANID` | `X_FH_WANGponLinkConfig.Mode=2` + `VLANID` | `X_FH_ServiceList` | – |
| CMCC | `X_CMCC_VLANMode=2` + `X_CMCC_VLANIDMark` | `X_CMCC_WANGponLinkConfig.Enable/Mode=2/VLANIDMark` | `X_CMCC_ServiceList` | `X_CMCC_LanInterface` |
| CT-COM | `X_CT-COM_VLANMode=2` + `X_CT-COM_VLANIDMark` | `X_CT-COM_WANGponLinkConfig.Enable/Mode=2/VLANIDMark` | `X_CT-COM_ServiceList` | `X_CT-COM_LanInterface` |
| CU | – | `X_CU_WANGponLinkConfig.Enable/Mode=2/VLANIDMark` | `X_CU_ServiceList` | `X_CU_LanInterface` |
| Nokia | (belum diketahui — pakai "Parameter tambahan") | – | – | – |

Urutan pemilihan nama: **bukti** di perangkat (hasil baca/discovery, instans
mana pun, PPP maupun IP) → **tebakan keluarga** (dilaporkan di `guessed`).
Keluarga ditentukan dari bukti path lalu Manufacturer/OUI; ODM China tanpa
nama operator diperlakukan sebagai CT-COM. `LanInterface` berisi daftar objek
`InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.N` /
`WLANConfiguration.N` dipisah koma.

Parameter standar TR-098 yang ditulis: `Name`, `ConnectionType`, `Username`,
`Password`, `NATEnabled`; `TransportType=PPPoE`,
`PPPAuthenticationProtocol=AUTO`, `ConnectionTrigger=AlwaysOn` hanya bila
terbukti ada (forum GenieACS 7384/7385). IPoE: `AddressingType`
DHCP/Static (+ `ExternalIPAddress`, `SubnetMask`, `DefaultGateway`, `DNSServers`).

### WAN internet: lokasi (`placement`)

| `placement` | Kapan dipakai | Yang terjadi |
|-------------|---------------|--------------|
| `existing` + `target` | Slot yang sudah ada — mis. FiberHome **`WCD 2 · #1 · PPPoE_Routed`** yang disiapkan OLT lewat OMCI, atau WAN yang mau diganti | `Enable=false` (bila aktif) → SPV standar → SPV vendor satu per satu → `Enable=true`. `ConnectionType` slot dipertahankan kecuali dipilih/mode route↔bridge berubah |
| `wcd` + `wcd` | WCD kosong yang sudah ada (mis. dibuat OLT) | `AddObject …WANConnectionDevice.N.WANPPPConnection.` → isi; VLAN level link ditulis ke WCD N |
| `new` | Tidak ada slot — pola umum ZTE/Huawei/FiberHome (satu WAN = satu WCD) | `AddObject WANConnectionDevice.` → `AddObject WANPPPConnection.` di dalamnya → isi |

UI (tab **Konfigurasi → WAN Internet**) mendaftar semua pilihan:
"WANConnectionDevice baru", setiap koneksi yang ada ("Isi (kosong)/(timpa):
PPPoE · WCD 2 · #1 · PPPoE_Routed · …"), dan setiap WCD. **Default** = slot
kosong pertama di luar WCD 1 (TR069) bila ada, selain itu WCD baru. Tombol
⚙ di tabel Koneksi WAN (Ringkasan) langsung membuka formulir untuk slot itu.

**ConnectionType** otomatis mengikuti nilai yang sudah dipakai perangkat
(mis. `PPPoE_Routed` di sebagian FiberHome), selain itu standar TR-098
(`IP_Routed`, `PPPoE_Bridged`, `IP_Bridged`). Bisa dipilih manual.

**Pengiriman bertahap** (`sequential`): setiap parameter dikirim sebagai SPV
tersendiri. Otomatis aktif untuk keluarga CMCC (forum 7385: ONU CMDC hanya
konsisten bila diisi berurutan); bisa dipaksa untuk ONU lain.

```
new (PPPoE, FiberHome):
AddObject InternetGatewayDevice.WANDevice.1.WANConnectionDevice.            → N
AddObject …WANConnectionDevice.N.WANPPPConnection.                           → M
SPV …N.WANPPPConnection.M.{Name, ConnectionType=PPPoE_Routed, TransportType,
     Username, Password, ConnectionTrigger, NATEnabled}
SPV …M.X_FH_VLANID          SPV …M.X_FH_ServiceList
SPV …N.X_FH_WANGponLinkConfig.Mode=2   SPV …N.X_FH_WANGponLinkConfig.VLANID
SPV …M.Enable=true
GPN WANDevice.  → WAN baru muncul di UI
```

- **Parameter tambahan** (`extra`): satu baris `Path = nilai`, relatif ke
  koneksi (`X_HW_PRI = 0`) atau absolut. Tipe ditebak kecuali perangkat sudah
  melaporkan tipenya.
- TR-181: hanya `existing` untuk `PPP.Interface` (username/password/VLAN);
  WAN baru belum didukung.

### Connection Request (tombol Hubungi)

- GET ke `ConnectionRequestURL` tanpa kredensial → bila 401, ulang dengan
  **Digest** (bila ditawarkan) atau Basic. 2xx/500/503 = diterima.
- Kredensial: yang diisi operator di "Akses ACS → CPE", atau kredensial ACS yang
  dipasang otomatis (`ACS_CR_AUTO`, `ACS_CR_USER`, `ACS_CR_PASS` / `data/cr.secret`)
  pada ONU yang password CR-nya tidak diketahui — password CR tidak bisa dibaca
  lewat TR-069.
- URL mengikuti laporan ONU terbaru kecuali diisi manual.
- ONU di balik NAT / VLAN manajemen yang tak terjangkau server ACS tidak bisa
  dipanggil; perintah tetap terkirim saat Inform periodik berikutnya.

### Perintah perangkat & beban ONU

- **Reboot**, **reset pabrik** (admin; ketik serial number), **interval
  Inform**, **aktif/nonaktif WAN**, **Hubungi** — di tab Konfigurasi →
  Perangkat dan di tabel Koneksi WAN.
- **Prioritas antrean**: SetParameterValues/AddObject/DeleteObject/Reboot/
  FactoryReset/Download didahulukan dari bacaan; FIFO di antara sesamanya.
- **Batas RPC per sesi** `ACS_MAX_RPC_PER_SESSION` (default 40; 0 = tanpa
  batas). Setelah batas tercapai sesi diakhiri (204) dan sisanya dilanjutkan
  pada Inform berikutnya — pemetaan ONU baru (±40–100 RPC) terbagi ke 2–3 sesi.
- Pembacaan rutin hanya saat jatuh tempo (`ACS_COLLECT_INTERVAL_MIN`, default
  30) atau event BOOT/VALUE CHANGE/CONNECTION REQUEST; batch 24 path.

### Task & status

- Id task = `ParameterKey` = kunci RPC. Balasan SPV/AddObject/DeleteObject
  menutup task (`done`); Fault menutupnya sebagai `failed` beserta kode & pesan.
- Status SPV `1` (diterima, berlaku setelah apply) dihitung sukses.
- Setelah SPV sukses, nilai yang ditulis dibaca balik (kecuali sandi).
- Antrean tulis TTL 24 jam, baca 6 jam — keduanya menunggu Inform berikutnya.
  Tombol **Hubungi**/**Segarkan** mengirim Connection Request agar segera.

---

## 4. Menguji tanpa perangkat nyata

```bash
npm test                         # engine + insight/profiler
npx tsc -p tsconfig.server.json

# simulator bawaan (gaya AVM, hanya menjawab anak langsung → menguji mode BFS)
node scripts/sim-ont.mjs --url http://127.0.0.1:7547 --id TEST-1 --count 8
node scripts/sim-ont.mjs --url http://127.0.0.1:7547 --id HARD-1 --partial --strict-gpv --count 12
```

Simulator menolak `Reboot`, `FactoryReset`, `Download` (Fault 9000) agar
perintah merusak yang tak disengaja langsung terlihat.

Yang harus terlihat saat uji lulus:

- daftar perangkat menampilkan `rx_power` dan `pppoe_user` terisi;
- tidak ada Fault 9003 di Peristiwa;
- fault 9005 GPV berhenti setelah sesi pertama (penolakan diingat);
- task konfigurasi berakhir `done`, termasuk rantai AddObject + pengisiannya.

---

## 5. Batas yang jujur

- **Belum diuji ke ONU fisik** pada revisi ini — hanya simulator strict.
  Uji 1–2 ONU per vendor sebelum dipakai massal.
- **Redaman bergantung firmware.** Nama di luar pola/daftar belum terbaca;
  tambah varian di `modelpaths.ts` (root vendor) atau pola di `insight.ts`.
- **Tebakan nama vendor** bisa ditolak perangkat; UI memberi peringatan dan
  Fault terlihat di tab Antrean/Peristiwa. Setelah perangkat dipetakan,
  nama yang benar diambil dari bukti.
- **Antrean RPC di memori** — tulisan yang belum terkirim hilang bila ACS restart.
- **Tidak ada auto-reboot / FactoryReset.** Semua tulisan atas perintah operator.
