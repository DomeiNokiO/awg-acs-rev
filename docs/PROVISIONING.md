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
   └─ sudah dipetakan ─► bila jatuh tempo atau event 0/1/4/6:
          GPV (esensial ∪ profil), batch 24, split-on-fault
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
| Nokia / Alcatel-Lucent | `InternetGatewayDevice.X_ALU_OntOpticalParam.RXPower` |
| CT-COM / CMCC / CU | `WANDevice.1.X_CT-COM_*`, `X_CMCC_*`, `X_CU_WANEPONInterfaceConfig.OpticalTransceiver.RXPower` |
| EPON standar | `WANDevice.1.WANEponInterfaceConfig.RXPower` |
| TR-181 | `Device.Optical.Interface.1.OpticalSignalLevel` / `TransmitOpticalLevel` |

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
| `pppoe` | `target?`, `username?`, `password?`, `vlanId?`, `serviceName?` | SPV kredensial; SPV VLAN; SPV ServiceList |
| `vlan` | `target?`, `vlanId` | SPV VLAN (+ penanda aktif vendor) |
| `wan-add` | `username`, `password`, `vlanId?`, `name?`, `bridge?`, `serviceName?`, `extra?` | AddObject WCD → AddObject `WANPPPConnection.` → SPV standar → SPV vendor (satu per parameter) → pemetaan ulang WAN |
| `wan-ip-add` | `staticIp?`, `netmask?`, `gateway?`, `dns?`, `vlanId?`, `bridge?`, `name?`, `extra?` | sama, `WANIPConnection.` (DHCP bila tanpa `staticIp`) |
| `wan-delete` | `target` | DeleteObject WCD (bila koneksi satu-satunya) atau koneksinya |

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

### VLAN

Urutan pemilihan path:

1. path VLAN yang **terbaca** untuk koneksi itu (`insight.wan[].vlanPath`);
2. path vendor yang **terbukti ada** di perangkat:
   - level koneksi: `X_HW_VLAN`, `X_ZTE-COM_VLANID`, `X_FH_VLANID`,
     `X_CMCC_VLANIDMark`, `X_CT-COM_VLANIDMark`, `VLANID`;
   - level link: `WANConnectionDevice.N.X_CT-COM|X_CMCC|X_CU_WANGponLinkConfig.VLANIDMark`,
     `X_*_WANEponLinkConfig.VLANIDMark`, `X_ZTE-COM_WANPONLinkConfig.VLANID`;
3. tebakan per keluarga vendor (Huawei `X_HW_VLAN`, ZTE `X_ZTE-COM_VLANID`,
   FiberHome `X_FH_VLANID`, lainnya link config CT-COM) — dilaporkan di `guessed`.

Penanda yang menyertai bila ada: `X_ZTE-COM_VLANEnable=true`,
`X_*_LinkConfig.Mode=2` (tagged). TR-181: `Ethernet.VLANTermination.N.VLANID`
yang dirujuk `PPP.Interface.N.LowerLayers`.

### Buat WAN

```
AddObject InternetGatewayDevice.WANDevice.1.WANConnectionDevice.      → N
AddObject …WANConnectionDevice.N.WANPPPConnection.                     → M
SPV standar …N.WANPPPConnection.M.{Name, ConnectionType, Username,
            Password, NATEnabled, Enable}
SPV vendor  …M.X_HW_VLAN / …M.X_HW_SERVICELIST / …N.X_CT-COM_WANGponLinkConfig.*  (satu per SPV)
GPN WANDevice.  → WAN baru muncul di UI
```

- Satu WAN = satu WCD — pola ZTE/Huawei/FiberHome. Menambah koneksi ke WCD.1
  milik TR069 sering ditolak atau mengganggu manajemen.
- `ConnectionType`: `IP_Routed` / `PPPoE_Bridged` / `IP_Bridged`.
- Nama vendor diambil dari koneksi lain di perangkat yang sama bila ada; bila
  tidak, tebakan keluarga vendor.
- **Parameter tambahan** (`extra`): satu baris `Path = nilai`, relatif ke
  koneksi baru (`X_HW_LANBIND.Lan1Enable = 1`) atau absolut. Tipe ditebak
  (boolean/angka/string) kecuali perangkat sudah melaporkan tipenya.
- TR-181 belum didukung untuk buat WAN otomatis.

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
