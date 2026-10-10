# Referensi Parameter ONU — AWG-ACS

Daftar path TR-069 yang dipakai AWG-ACS per fungsi dan per vendor, beserta
**status bukti** masing-masing. Dokumen ini diperbarui dari laporan lapangan
(lihat [Membuat laporan dari server Anda](#membuat-laporan-dari-server-anda)).

Status bukti:

| Tanda | Arti |
|-------|------|
| **Standar** | Didefinisikan spesifikasi BBF (TR-098 / TR-181) |
| **Lapangan** | Terbaca dari ONU nyata pengguna AWG-ACS |
| **Komunitas** | Dari forum/repo GenieACS (sumber di bawah tabel) |
| **Pola** | Dikenali otomatis dari nama parameter hasil discovery; nama persis bergantung firmware |

`IGD.` = `InternetGatewayDevice.` · `{i}` = nomor instans (berbeda per ONU; AWG-ACS
memakai nomor milik perangkat itu sendiri).

---

## 1. CPU & RAM

| Vendor / tipe | CPU | RAM | Satuan | Bukti |
|---------------|-----|-----|--------|-------|
| Semua (TR-098) | `IGD.DeviceInfo.ProcessStatus.CPUUsage` | `IGD.DeviceInfo.MemoryStatus.Total` / `.Free` | %, KiB | Standar |
| Semua (TR-181) | `Device.DeviceInfo.ProcessStatus.CPUUsage` | `Device.DeviceInfo.MemoryStatus.Total` / `.Free` | %, KiB | Standar |
| FiberHome HG6145D2 (RP2939, RP2958, RP3478, RP4313) | `IGD.DeviceInfo.ProcessStatus.CPUUsage` | `IGD.DeviceInfo.MemoryStatus.Total` / `.Free` | %, KiB (512 MB) | **Lapangan** |
| FiberHome HG6543C (RP2872) | `IGD.DeviceInfo.X_FH_CpuUsed` | `IGD.DeviceInfo.X_FH_MemUsed` | % (tanpa total) | **Lapangan** |
| ZTE F660 (V9.0.0P1T7, firmware CMCC) | `IGD.DeviceInfo.ProcessStatus.CPUUsage` | `IGD.DeviceInfo.MemoryStatus.Total` / `.Free` | %, KiB (224 MB) | **Lapangan** |
| Huawei (gaya `X_HW_`) | `IGD.DeviceInfo.X_HW_CpuUsed` | `IGD.DeviceInfo.X_HW_MemUsed` | % | Pola |
| Vendor/operator lain | `IGD.DeviceInfo[.X_<vendor>_<Objek>].…CPU…` | `…Mem…Total/Free/Used/Usage` | %, KiB/MB/byte | Pola |

Aturan pola (`insight.ts → extractSystem`): leaf di bawah `DeviceInfo` (langsung
atau lewat satu objek) yang namanya memuat `CPU`/`Mem`/`RAM`; nama non-beban
(`Type`, `Model`, `Freq`, `Num`, `Core`, `Version`, `Threshold`…) diabaikan.
Memori vendor: `< 8192` → MB, `> 8 juta` → byte, selain itu KiB; "…Used"
bersama total = jumlah, "…Usage/Rate/Percent/Util" = persen. ONU yang tidak
melaporkan apa pun tampil "—" (tidak ditebak).

> **Catatan lapangan (2026-10):** dua gaya terlihat bahkan di satu merek.
> FiberHome generasi HG6145D2 dan ZTE F660 mengikuti standar TR-098
> (`ProcessStatus` / `MemoryStatus`, RAM dalam KiB → ditampilkan persen +
> total MB), sedangkan FiberHome HG6543C RP2872 hanya punya `X_FH_CpuUsed` /
> `X_FH_MemUsed` (persen langsung, total RAM tidak dilaporkan). Keduanya
> ditangani aturan di atas tanpa konfigurasi per model.

## 2. Redaman optik

| Vendor / tipe | RX (TX menyertai) | Satuan mentah | Bukti |
|---------------|-------------------|---------------|-------|
| FiberHome GPON | `IGD.WANDevice.1.X_FH_GponInterfaceConfig.RXPower` | dBm | **Lapangan** (HG6543C RP2872; HG6145D2 RP2939/RP2958/RP3478/RP4313) |
| FiberHome EPON | `IGD.WANDevice.1.X_FH_EponInterfaceConfig.RXPower` | dBm | **Lapangan** (HG6145D2 RP3478 — firmware ini punya subtree EPON dan GPON) |
| ZTE F670L, F609 baru | `IGD.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower` | dBm | Komunitas¹ |
| ZTE F660/F609 lama | `IGD.X_CT-COM_GponInterfaceConfig.Stats.RxPower` | 0.1 µW | Komunitas² |
| ZTE EPON lama | `IGD.X_CT-COM_EponInterfaceConfig.Stats.RxPower` | 0.1 µW | Komunitas² |
| Huawei HG8245/HG8546M | `IGD.WANDevice.1.X_GponInterafceConfig.RXPower` (typo bawaan firmware) | dBm | Komunitas¹ |
| Huawei EG8145V5 dkk. | `IGD.X_HW_DEBUG.AdminTR069.RxPower` | dBm | Komunitas² |
| Huawei baru | `IGD.WANDevice.1.X_HW_GponInterfaceConfig.RXPower` | dBm | Komunitas³ |
| Nokia / Alcatel-Lucent | `IGD.X_ALU_OntOpticalParam.RXPower`, `IGD.WANDevice.1.X_ALU-COM_GponInterfaceConfig.RXPower` | dBm | Komunitas¹ ³ |
| ZTE F660 firmware CMCC (V9.0.0P1T7) | `IGD.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower` | 0.1 µW (mentah `58` = -22.37 dBm) | **Lapangan** |
| China Mobile (GM220-S dll.) | `IGD.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower` (+ `TXPower`, `TransceiverTemperature`, `SupplyVottage`, `BiasCurrent`) | 0.1 µW, 1/256 °C | Komunitas³ |
| CT-COM / CU / ODM China | `IGD.WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower`, `X_CU_GponInterfaceConfig.RXPower`, `X_CU_WANEPONInterfaceConfig.OpticalTransceiver.RXPower` | 0.1 µW | Komunitas¹ ³ |
| ONU Realtek (EPON) | `IGD.X_Realtek_EponInterfaceConfig.Stats.RxPower` | dBm | Komunitas² |
| Generik | `IGD.WANDevice.1.WANPONInterfaceConfig.RXPower`, `IGD.WANDevice.1.WANEponInterfaceConfig.RXPower` | dBm | Komunitas³ |
| TR-181 | `Device.Optical.Interface.1.OpticalSignalLevel` / `TransmitOpticalLevel` | 0.001 dBm | Standar |

Konversi: negatif wajar → dBm; negatif besar → ÷10/100/1000; RX positif →
`10·log10(v/10000)` (0.1 µW); RX 0 atau ≤ -40 dBm → LOS. Bila ONU mengisi beberapa subtree (mis. EPON +
GPON), yang dipakai adalah nilai pertama yang masuk akal — subtree yang
kosong/0 dilewati.

## 3. WAN (PPPoE / IPoE)

| Vendor | VLAN koneksi | VLAN link (WCD) | ServiceList | Binding port | ConnectionType | Bukti |
|--------|--------------|-----------------|-------------|--------------|----------------|-------|
| FiberHome HG6145D2 | `VLANID` (standar) | – | `X_FH_ServiceList` | `X_FH_LanInterface` **wajib** | `PPPoE_Routed` | **Lapangan** |
| FiberHome HG6543C RP2872 | `VLANID` (standar) | – | `X_FH_ServiceList` | `X_FH_LanInterface` **wajib** | `IP_Routed` | **Lapangan** |
| FiberHome (lainnya) | `X_FH_VLANID` | `X_FH_WANGponLinkConfig.Mode=2` + `VLANID` | `X_FH_ServiceList` | `X_FH_LanInterface` | – | Komunitas⁴ + pengguna |
| ZTE F660 firmware suntikan CMCC (V9.0.0P1T7) | `X_CMCC_VLANIDMark` | – | `X_CMCC_ServiceList` | `X_CMCC_LanInterface` (bila ada) | `PPPoE_Routed` | **Lapangan** — diperlakukan sebagai keluarga CMCC |
| ZTE (termasuk F660 ORI) | `X_ZTE-COM_VLANEnable` + `X_ZTE-COM_VLANID` | `X_ZTE-COM_WANPONLinkConfig.VLANID` | `X_ZTE-COM_ServiceList` | `X_ZTE-COM_LanInterface` | `IP_Routed` | Komunitas⁵ |
| Huawei | `X_HW_VLAN` (+ `X_HW_PRI`) | – | `X_HW_SERVICELIST` | `X_HW_LANBIND.Lan{1-4}Enable`, `SSID{1-8}Enable` | `IP_Routed` | Komunitas³ ⁶ |
| CMCC | `X_CMCC_VLANMode=2` + `X_CMCC_VLANIDMark` | `X_CMCC_WANGponLinkConfig.Enable/Mode=2/VLANIDMark` | `X_CMCC_ServiceList` | `X_CMCC_LanInterface` | `IP_Routed` | Komunitas⁷ |
| CT-COM | `X_CT-COM_VLANMode=2` + `X_CT-COM_VLANIDMark` | `X_CT-COM_WANGponLinkConfig.Enable/Mode=2/VLANIDMark` | `X_CT-COM_ServiceList` | `X_CT-COM_LanInterface` | `IP_Routed` | Komunitas (halny HL-4GMV) |

**Binding FiberHome (pengguna, 2026-10):** WAN internet FiberHome tanpa
`X_FH_LanInterface` = tidak ada internet di klien. Nilai yang dipakai di
GenieACS dan kini default AWG-ACS (semua LAN + semua SSID, dipisah koma,
tanpa titik akhir):

```
InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1,InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.2,
InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.3,InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.4,
InternetGatewayDevice.LANDevice.1.WLANConfiguration.1,InternetGatewayDevice.LANDevice.1.WLANConfiguration.2,
InternetGatewayDevice.LANDevice.1.WLANConfiguration.3,InternetGatewayDevice.LANDevice.1.WLANConfiguration.4
```

**NAT:** `NATEnabled=true` untuk WAN INTERNET, `false` untuk WAN TR069/VOIP.

`ConnectionType` WAN baru mengikuti nilai yang sudah dipakai koneksi sejenis
di ONU itu sendiri (lihat HG6145D2 `PPPoE_Routed` vs HG6543C `IP_Routed` —
satu merek, beda firmware), jadi tidak perlu disetel per model.

Keluarga vendor **tidak** ditentukan dari merek, tetapi dari ekstensi yang
dipakai ONU itu sendiri di area WAN (`vendorwan.ts → detectFamily`). Merek
yang sama bisa membawa firmware berbeda:

| ONU | Pabrikan dilaporkan | Ekstensi WAN | Keluarga |
|-----|---------------------|--------------|----------|
| ZTE F660 ORI | ZTE | `X_ZTE-COM_*` | ZTE |
| ZTE F660 firmware suntikan China Mobile | ZTE | `X_CMCC_*` | CMCC (VLAN, ServiceList, binding, penulisan berurutan) |
| Firmware campuran | – | beberapa | ekstensi terbanyak; seri → merek |
| ONU baru (belum dipetakan) | – | – | nama pabrikan / OUI |

Struktur hasil discovery dikumpulkan per ProductClass, jadi unit ORI dan unit
CMCC bermodel sama berbagi data. Saat menyusun penulisan, path discovery
dengan ekstensi vendor yang **tidak** dipakai ONU tersebut dibuang — tanpa ini
unit CMCC ikut dikirimi `X_ZTE-COM_VLANID` milik unit ORI dan seluruh SPV
ditolak (9005).

PPP standar yang hanya ditulis bila ada: `TransportType=PPPoE`,
`ConnectionTrigger=AlwaysOn`, `PPPAuthenticationProtocol=AUTO`.
Rincian alur pembuatan: [PROVISIONING.md](PROVISIONING.md#wan-internet-lokasi-placement).

## 4. Counter trafik (trafik live)

| Urutan | Path (rx = download, tx = upload) | Bukti |
|--------|-----------------------------------|-------|
| 1 | `…WANConnectionDevice.{i}.WANPPPConnection.{i}.Stats.EthernetBytesReceived` / `…Sent` (koneksi PPPoE utama) | Standar TR-098 |
| 2 | `IGD.WANDevice.1.WANCommonInterfaceConfig.TotalBytesReceived` / `TotalBytesSent` | Standar TR-098 |
| 3 | `IGD.WANDevice.1.WANEthernetInterfaceConfig.Stats.BytesReceived` / `BytesSent` | Standar TR-098 |
| TR-181 | `Device.PPP.Interface.{i}.Stats.BytesReceived/Sent`, `Device.IP.Interface.{i}.Stats.…`, `Device.Optical.Interface.1.Stats.…` | Standar |

Counter TR-098 bertipe unsignedInt 32-bit (berputar di 4 GiB); wrap ditangani.
Pasangan yang ditolak ONU dilewati otomatis ke pasangan berikutnya.

## 5. WiFi

| Lokasi sandi | Vendor | Bukti |
|--------------|--------|-------|
| `…WLANConfiguration.{i}.PreSharedKey.1.KeyPassphrase` | ZTE, FiberHome, CMCC | Standar |
| `…WLANConfiguration.{i}.KeyPassphrase` | FiberHome HG6145D2/HG6543C, ZTE F660 (CMCC) | **Lapangan** |
| `…WLANConfiguration.{i}.KeyPassphrase` | Huawei | Komunitas¹ |
| `…WLANConfiguration.{i}.PreSharedKey.1.PreSharedKey` | Huawei (bila hanya ini) | Komunitas |
| `Device.WiFi.AccessPoint.{i}.Security.KeyPassphrase` | TR-181 | Standar |

Saat ganti sandi, ACS menulis ke **semua** lokasi di atas yang ada di ONU
tersebut (sebagian firmware punya keduanya).

Lokasi sandi vendor (`X_<vendor>_…Passphrase/Password/WPAKey/PSK`,
`PreSharedKey.1.X_<vendor>_KeyPassphrase`) juga dibaca; nilainya hanya
dianggap sandi bila 8–64 karakter dan bukan `true/false` — leaf vendor
bernama mirip bisa berisi mode/flag. Bagian *Sandi (diagnostik)* di
`scripts/param-report.mjs` menunjukkan per firmware lokasi sandi mana yang
terisi / kosong / bintang (nilainya tidak dicetak) dan kandidat lokasi lain
di struktur ONU.

**Sandi terbuka.** UI menampilkan sandi WiFi & PPPoE apa adanya. TR-098
mengizinkan ONU mengembalikan string kosong saat sandi dibaca (Huawei
umumnya begitu; ZTE/FiberHome umumnya mengirim nilai asli). Nilai kosong atau
`****` bukan sandi; saat itu yang tampil adalah sandi terakhir yang **disetel
lewat ACS** dan diterima ONU (label "via ACS"). PSK hex 64 karakter
(`PreSharedKey.1.PreSharedKey`) bukan sandi ketikan dan tidak ditampilkan.
PPPoE: `WANPPPConnection.{i}.Password` (TR-181 `PPP.Interface.{i}.Password`).

### Sembunyikan SSID (siaran)

| Parameter | Nilai "tersembunyi" | Bukti |
|-----------|---------------------|-------|
| `…WLANConfiguration.{i}.SSIDAdvertisementEnabled` | `false` | Standar TR-098 |
| `Device.WiFi.AccessPoint.{i}.SSIDAdvertisementEnabled` | `false` | Standar TR-181 |
| `…WLANConfiguration.{i}.X_<vendor>_SSIDHide` / `HideSSID` | `true` | Pola — dipakai hanya bila ONU tidak punya parameter standar |

`Enable` (WiFi aktif) dan siaran SSID terpisah: WiFi bisa aktif tetapi
tersembunyi.

---

## 6. Remote management (akses WAN ke ONU)

Membuka manajemen ONU (web GUI / Telnet / SSH) dari sisi WAN. ONU GPON
umumnya **tidak** mengenal `UserInterface.RemoteAccess` standar (balas Fault
9003), jadi dipakai parameter per keluarga vendor yang terbukti di lapangan.
Sumber: provision GenieACS komunitas ISP (safrinnetwork, beryindo, alijayanet).

| Vendor | Parameter | Tipe | Nilai aktif |
|--------|-----------|------|-------------|
| Huawei | `X_HW_Security.AclServices.HTTPWanEnable` | bool | `true` (web GUI) |
| Huawei | `…AclServices.{HTTPS,TELNET,SSH}WanEnable` | bool | `true` per protokol |
| Huawei | `X_HW_Security.X_HW_FirewallLevel` | string | `Custom` (wajib; tanpa ini WAN tetap diblokir) |
| Huawei | `X_HW_Security.Dosfilter.IcmpEchoReplyEn` | string | `1` = balas ping |
| FiberHome | `X_FH_FireWall.REMOTEACCEnable` | bool | `true` (master remote) |
| FiberHome | `X_FH_Remoteweblogin.webloginenable` | string | `1` (web GUI) |
| FiberHome | `X_FH_ACL.Enable` | unsignedInt | `1` |
| ZTE | `Firewall.X_ZTE-COM_ServiceControl.IPV4ServiceControl.1.Enable` | bool | `true` |
| ZTE | `…IPV4ServiceControl.1.Ingress` | string | `WAN_ALL` |
| ZTE | `…IPV4ServiceControl.1.ServiceType` | string | `HTTP` |
| Standar | `…UserInterface.RemoteAccess.Enable/Port/Protocol` | — | hanya bila terbukti ada |

Keluarga vendor ditentukan dari bukti path WAN (`detectFamily`): ONU satu merek
tidak pernah dikirim parameter merek lain. Path terbukti diantre sekaligus;
sisanya satu per SPV (9005 pada satu nama tidak menggagalkan yang lain). ZTE
butuh `IPV4ServiceControl.1` sudah ada (kalau belum, buat via AddObject).

---

## Laporan lapangan

### 2026-10-09 — 19 ONU, 6 kombinasi

| Vendor | Model | Firmware | ONU | CPU | RAM | Redaman RX | Contoh |
|--------|-------|----------|----:|-----|-----|------------|--------|
| FiberHome | HG6145D2 | RP3478 | 4 | `ProcessStatus.CPUUsage` | `MemoryStatus.Total` | `X_FH_EponInterfaceConfig.RXPower`, `X_FH_GponInterfaceConfig.RXPower` | CPU 4 %, RAM 26,8 % / 512 MB, RX -23,10 dBm |
| FiberHome | HG6145D2 | RP4313 | 8 | `ProcessStatus.CPUUsage` | `MemoryStatus.Total` | `X_FH_GponInterfaceConfig.RXPower` | CPU 5 %, RAM 28,4 % / 512 MB, RX -10,73 dBm |
| FiberHome | HG6145D2 | RP2958 | 3 | `ProcessStatus.CPUUsage` | `MemoryStatus.Total` | `X_FH_GponInterfaceConfig.RXPower` | CPU 11 %, RAM 32,4 % / 512 MB, RX -23,67 dBm |
| FiberHome | HG6145D2 | RP2939 | 1 | `ProcessStatus.CPUUsage` | `MemoryStatus.Total` | `X_FH_GponInterfaceConfig.RXPower` | CPU 6 %, RAM 32,6 % / 512 MB, RX -8,43 dBm |
| FiberHome | HG6543C | RP2872 | 2 | `X_FH_CpuUsed` | `X_FH_MemUsed` | `X_FH_GponInterfaceConfig.RXPower` | CPU 6 %, RAM 48 %, RX -10,30 dBm |
| ZTE | F660 | V9.0.0P1T7 | 1 | `ProcessStatus.CPUUsage` | `MemoryStatus.Total` | `X_CMCC_GponInterfaceConfig.RXPower` | CPU 0 %, RAM 36,5 % / 224 MB, RX -22,37 dBm (mentah 58) |

| Vendor | Model | Firmware | VLAN PPPoE | ServiceList | ConnectionType | Sandi WiFi |
|--------|-------|----------|------------|-------------|----------------|------------|
| FiberHome | HG6145D2 | RP2939/RP2958/RP3478/RP4313 | `WANPPPConnection.{i}.VLANID` | `X_FH_ServiceList` | `PPPoE_Routed` | `WLANConfiguration.{i}.KeyPassphrase` |
| FiberHome | HG6543C | RP2872 | `WANPPPConnection.{i}.VLANID` | `X_FH_ServiceList` | `IP_Routed` | `WLANConfiguration.{i}.KeyPassphrase` |
| ZTE | F660 | V9.0.0P1T7 | `WANPPPConnection.{i}.X_CMCC_VLANIDMark` | `X_CMCC_ServiceList` | `PPPoE_Routed` | `WLANConfiguration.{i}.KeyPassphrase` |

Path CPU/RAM relatif ke `IGD.DeviceInfo.`, redaman ke `IGD.WANDevice.1.`,
WAN ke `IGD.WANDevice.1.WANConnectionDevice.{i}.`, WiFi ke `IGD.LANDevice.1.`.
"Contoh" = satu ONU per kombinasi.

Temuan & tindak lanjut:
- **ZTE F660 V9.0.0P1T7 berfirmware China Mobile**: pabrikan "ZTE", tetapi
  seluruh ekstensinya `X_CMCC_*`. Sebelumnya keluarga vendor ditentukan dari
  nama pabrikan → tebakan binding port memakai `X_ZTE-COM_LanInterface`.
  Sekarang bukti path menang (`detectFamily`), jadi ONU ini memakai skema CMCC.
- **FiberHome HG6145D2 vs HG6543C**: `ConnectionType` PPPoE berbeda
  (`PPPoE_Routed` vs `IP_Routed`), CPU/RAM berbeda gaya. Sudah ditangani
  otomatis (nilai yang teramati per ONU dipakai).
- **HG6145D2 RP3478** memiliki subtree EPON dan GPON sekaligus; redaman
  diambil dari subtree yang berisi nilai valid.

## Membuat laporan dari server Anda

`scripts/param-report.mjs` membaca database ACS (read-only) dan mencetak tabel
Markdown: path CPU, RAM, redaman, VLAN, ServiceList, ConnectionType, lokasi
sandi WiFi (semua), dan counter trafik live yang **benar-benar dipakai** tiap kombinasi vendor / model / firmware,
plus contoh nilai. Tidak memuat serial, IP, username, atau sandi.

```bash
node /opt/acs/scripts/param-report.mjs > /tmp/laporan-parameter.md
node /opt/acs/scripts/param-report.mjs --json
```

Tempel hasilnya ke bagian yang sesuai di dokumen ini (ubah bukti menjadi
**Lapangan**), atau kirim ke pengembang agar pola dan default vendor bisa
disesuaikan.

## Sumber

1. [GenieACS forum — Ont Pon Rx Power](https://forum.genieacs.com/t/ont-pon-rx-power/3447)
2. [genieacs-relay `optical.go`](https://github.com/Cepat-Kilat-Teknologi/genieacs-relay/blob/main/optical.go)
3. [genieacs-panel `deviceParameterFallbacks.js` / `deviceService.js`](https://github.com/tavaresbr/genieacs-panel)
4. [GenieACS forum 7384 — FiberHome HG6143D PPPoE](https://forum.genieacs.com/t/the-issue-is-with-the-pppoe-provisioning-on-the-fiberhome-hg6143d-device/7384)
5. [GenieACS forum 5925 — ZTE F670L / Huawei EG8145V5](https://forum.genieacs.com/t/different-parameter-in-single-label/5925)
6. [GenieACS forum 7365 — Huawei HG8546M WAN](https://forum.genieacs.com/t/creating-wan-on-bootstrap-sometimes-works-sometimes-not/7365)
7. [GenieACS forum 7385 — CMDC/CMCC PPPoE berurutan](https://forum.genieacs.com/t/cmdc-onu-pppoe-provisioning-works-only-with-sequential-parameter-configuration/7385)
8. [BBF TR-098 data model](https://cwmp-data-models.broadband-forum.org/tr-098-1-8-0.html)
