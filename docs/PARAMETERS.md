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
| ZTE (F-series, firmware yang dipakai di lapangan) | muncul — lihat laporan | muncul — lihat laporan | | **Lapangan** (path persis: jalankan laporan) |
| FiberHome (HG6543C dll.) | muncul — lihat laporan | muncul — lihat laporan | | **Lapangan** (path persis: jalankan laporan) |
| Huawei (gaya `X_HW_`) | `IGD.DeviceInfo.X_HW_CpuUsed` | `IGD.DeviceInfo.X_HW_MemUsed` | % | Pola |
| Vendor/operator lain | `IGD.DeviceInfo[.X_<vendor>_<Objek>].…CPU…` | `…Mem…Total/Free/Used/Usage` | %, KiB/MB/byte | Pola |

Aturan pola (`insight.ts → extractSystem`): leaf di bawah `DeviceInfo` (langsung
atau lewat satu objek) yang namanya memuat `CPU`/`Mem`/`RAM`; nama non-beban
(`Type`, `Model`, `Freq`, `Num`, `Core`, `Version`, `Threshold`…) diabaikan.
Memori vendor: `< 8192` → MB, `> 8 juta` → byte, selain itu KiB; "…Used"
bersama total = jumlah, "…Usage/Rate/Percent/Util" = persen. ONU yang tidak
melaporkan apa pun tampil "—" (tidak ditebak).

> **Catatan lapangan (2026-10):** ZTE dan FiberHome di jaringan pengguna sudah
> menampilkan CPU & RAM lewat aturan di atas. Path persisnya belum dicatat di
> sini — jalankan `scripts/param-report.mjs` dan tempel kolom CPU/RAM-nya ke
> baris ZTE/FiberHome tabel ini.

## 2. Redaman optik

| Vendor / tipe | RX (TX menyertai) | Satuan mentah | Bukti |
|---------------|-------------------|---------------|-------|
| FiberHome | `IGD.WANDevice.1.X_FH_GponInterfaceConfig.RXPower` | dBm | Lapangan (HG6543C RP2872) |
| ZTE F670L, F609 baru | `IGD.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower` | dBm | Komunitas¹ |
| ZTE F660/F609 lama | `IGD.X_CT-COM_GponInterfaceConfig.Stats.RxPower` | 0.1 µW | Komunitas² |
| ZTE EPON lama | `IGD.X_CT-COM_EponInterfaceConfig.Stats.RxPower` | 0.1 µW | Komunitas² |
| Huawei HG8245/HG8546M | `IGD.WANDevice.1.X_GponInterafceConfig.RXPower` (typo bawaan firmware) | dBm | Komunitas¹ |
| Huawei EG8145V5 dkk. | `IGD.X_HW_DEBUG.AdminTR069.RxPower` | dBm | Komunitas² |
| Huawei baru | `IGD.WANDevice.1.X_HW_GponInterfaceConfig.RXPower` | dBm | Komunitas³ |
| Nokia / Alcatel-Lucent | `IGD.X_ALU_OntOpticalParam.RXPower`, `IGD.WANDevice.1.X_ALU-COM_GponInterfaceConfig.RXPower` | dBm | Komunitas¹ ³ |
| China Mobile (GM220-S dll.) | `IGD.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower` (+ `TXPower`, `TransceiverTemperature`, `SupplyVottage`, `BiasCurrent`) | 0.1 µW, 1/256 °C | Komunitas³ |
| CT-COM / CU / ODM China | `IGD.WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower`, `X_CU_GponInterfaceConfig.RXPower`, `X_CU_WANEPONInterfaceConfig.OpticalTransceiver.RXPower` | 0.1 µW | Komunitas¹ ³ |
| ONU Realtek (EPON) | `IGD.X_Realtek_EponInterfaceConfig.Stats.RxPower` | dBm | Komunitas² |
| Generik | `IGD.WANDevice.1.WANPONInterfaceConfig.RXPower`, `IGD.WANDevice.1.WANEponInterfaceConfig.RXPower` | dBm | Komunitas³ |
| TR-181 | `Device.Optical.Interface.1.OpticalSignalLevel` / `TransmitOpticalLevel` | 0.001 dBm | Standar |

Konversi: negatif wajar → dBm; negatif besar → ÷10/100/1000; RX positif →
`10·log10(v/10000)` (0.1 µW); RX 0 atau ≤ -40 dBm → LOS.

## 3. WAN (PPPoE / IPoE)

| Vendor | VLAN koneksi | VLAN link (WCD) | ServiceList | Binding port | ConnectionType | Bukti |
|--------|--------------|-----------------|-------------|--------------|----------------|-------|
| FiberHome | `X_FH_VLANID` | `X_FH_WANGponLinkConfig.Mode=2` + `VLANID` | `X_FH_ServiceList` | – | `PPPoE_Routed` (HG6543C), `IP_Routed` | Lapangan + Komunitas⁴ |
| ZTE | `X_ZTE-COM_VLANEnable` + `X_ZTE-COM_VLANID` | `X_ZTE-COM_WANPONLinkConfig.VLANID` | `X_ZTE-COM_ServiceList` | `X_ZTE-COM_LanInterface` | `IP_Routed` | Komunitas⁵ |
| Huawei | `X_HW_VLAN` (+ `X_HW_PRI`) | – | `X_HW_SERVICELIST` | `X_HW_LANBIND.Lan{1-4}Enable`, `SSID{1-8}Enable` | `IP_Routed` | Komunitas³ ⁶ |
| CMCC | `X_CMCC_VLANMode=2` + `X_CMCC_VLANIDMark` | `X_CMCC_WANGponLinkConfig.Enable/Mode=2/VLANIDMark` | `X_CMCC_ServiceList` | `X_CMCC_LanInterface` | `IP_Routed` | Komunitas⁷ |
| CT-COM | `X_CT-COM_VLANMode=2` + `X_CT-COM_VLANIDMark` | `X_CT-COM_WANGponLinkConfig.Enable/Mode=2/VLANIDMark` | `X_CT-COM_ServiceList` | `X_CT-COM_LanInterface` | `IP_Routed` | Komunitas (halny HL-4GMV) |

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
| `…WLANConfiguration.{i}.PreSharedKey.1.KeyPassphrase` | ZTE, FiberHome, CMCC | Standar / Lapangan |
| `…WLANConfiguration.{i}.KeyPassphrase` | Huawei | Komunitas¹ |
| `…WLANConfiguration.{i}.PreSharedKey.1.PreSharedKey` | Huawei (bila hanya ini) | Komunitas |
| `Device.WiFi.AccessPoint.{i}.Security.KeyPassphrase` | TR-181 | Standar |

---

## Membuat laporan dari server Anda

`scripts/param-report.mjs` membaca database ACS (read-only) dan mencetak tabel
Markdown: path CPU, RAM, redaman, VLAN, ServiceList, ConnectionType, dan lokasi
sandi WiFi yang **benar-benar dipakai** tiap kombinasi vendor / model / firmware,
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
