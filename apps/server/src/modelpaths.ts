/**
 * Path ESENSIAL yang selalu ikut dibaca di setiap siklus koleksi, di luar
 * profil hasil discovery.
 *
 * ATURAN MAIN — semua path di sini KONKRET (tanpa `*`, tanpa titik akhir).
 * GetParameterValues tidak mendukung wildcard; path yang tidak ada di
 * perangkat memicu Fault 9005, lalu split-on-fault (cwmp.ts) memecah batch
 * sampai ketemu path itu dan mencatatnya di `invalid_param` — siklus
 * berikutnya hanya varian yang DIDUKUNG perangkat yang dikirim.
 *
 * Kenapa optik ada di sini (bukan hanya dari discovery): sebagian vendor
 * menaruh redaman di luar `WANDevice.` — mis. Huawei `X_HW_DEBUG.AdminTR069`,
 * ZTE F660 `X_CT-COM_GponInterfaceConfig.Stats`, Nokia `X_ALU_OntOpticalParam`
 * — subtree yang tidak ikut ditelusuri discovery.
 *
 * Koneksi WAN/PPPoE dan WiFi TIDAK ditulis dengan nomor instans di sini:
 * nomornya berbeda per perangkat (PPPoE sering di WANConnectionDevice.2/.3)
 * dan diambil dari discovery (lihat profiler.ts).
 *
 * Sumber varian: packages/catalog/data/models.json (genieacs-relay
 * optical.go, forum GenieACS 3447/5925/7365/7384), TR-098, TR-181.
 */
import type { DataModel } from './insight.ts';

const P = 'InternetGatewayDevice.';
const W1 = `${P}WANDevice.1.`;

export const PATH_INFO_098: string[] = [
  `${P}DeviceInfo.Manufacturer`,
  `${P}DeviceInfo.ModelName`,
  `${P}DeviceInfo.SerialNumber`,
  `${P}DeviceInfo.SoftwareVersion`,
  `${P}DeviceInfo.HardwareVersion`,
  `${P}DeviceInfo.UpTime`,
  `${P}ManagementServer.ConnectionRequestURL`,
  `${P}ManagementServer.ConnectionRequestUsername`,
  `${P}ManagementServer.PeriodicInformInterval`,
  `${P}LANDevice.1.LANHostConfigManagement.IPInterface.1.IPInterfaceIPAddress`,
  `${P}LANDevice.1.Hosts.HostNumberOfEntries`,
  // Jumlah port LAN — dipakai menyusun binding WAN (FiberHome X_FH_LanInterface).
  `${P}LANDevice.1.LANEthernetInterfaceNumberOfEntries`,
  // Suhu perangkat standar TR-098 (dipakai bila ONU tak punya suhu optik)
  `${P}DeviceInfo.TemperatureStatus.TemperatureSensor.1.Value`,
  // Beban CPU (%) & RAM (KiB) standar TR-098 (InternetGatewayDevice:1.9+).
  // Leaf CPU/RAM milik vendor di bawah DeviceInfo ditemukan lewat discovery.
  `${P}DeviceInfo.ProcessStatus.CPUUsage`,
  `${P}DeviceInfo.MemoryStatus.Total`,
  `${P}DeviceInfo.MemoryStatus.Free`,
];

/** Keluarga vendor untuk memilih kandidat redaman yang dicoba lebih dulu. */
export type OpticalFamily = 'fiberhome' | 'zte' | 'huawei' | 'nokia' | 'cmcc' | 'unknown';

/**
 * Kandidat redaman TR-098 per keluarga. Satu path boleh muncul di beberapa
 * keluarga: firmware operator China (CT-COM/CMCC) dipakai lintas merek.
 */
const OPT: Record<Exclude<OpticalFamily, 'unknown'>, string[]> = {
  fiberhome: [
    `${W1}X_FH_GponInterfaceConfig.RXPower`,
    `${W1}X_FH_GponInterfaceConfig.TXPower`,
    `${W1}X_FH_GponInterfaceConfig.TransceiverTemperature`,
    // FiberHome firmware operator (CT/CMCC) memakai subtree standar China.
    `${W1}X_CT-COM_GponInterfaceConfig.RXPower`,
    `${W1}X_CT-COM_GponInterfaceConfig.TXPower`,
    `${W1}X_CMCC_GponInterfaceConfig.RXPower`,
    `${W1}X_CMCC_GponInterfaceConfig.TXPower`,
  ],
  zte: [
    `${W1}X_ZTE-COM_WANPONInterfaceConfig.RXPower`,
    `${W1}X_ZTE-COM_WANPONInterfaceConfig.TXPower`,
    `${W1}X_ZTE-COM_WANPONInterfaceConfig.TransceiverTemperature`,
    // ZTE F660/F609 lama: subtree CT-COM di root (genieacs-relay optical.go)
    `${P}X_CT-COM_GponInterfaceConfig.Stats.RxPower`,
    `${P}X_CT-COM_GponInterfaceConfig.Stats.TxPower`,
    `${P}X_CT-COM_EponInterfaceConfig.Stats.RxPower`,
    `${P}X_CT-COM_EponInterfaceConfig.Stats.TxPower`,
    `${W1}X_CMCC_GponInterfaceConfig.RXPower`,
  ],
  huawei: [
    // HG8245/HG8546M (typo "Interafce" memang dari firmware)
    `${W1}X_GponInterafceConfig.RXPower`,
    `${W1}X_GponInterafceConfig.TXPower`,
    `${W1}X_GponInterafceConfig.TransceiverTemperature`,
    // EG8145V5 dkk.
    `${P}X_HW_DEBUG.AdminTR069.RxPower`,
    `${P}X_HW_DEBUG.AdminTR069.TxPower`,
    // HG/EG generasi baru (genieacs-panel deviceParameterFallbacks.js)
    `${W1}X_HW_GponInterfaceConfig.RXPower`,
    `${W1}X_HW_GponInterfaceConfig.TXPower`,
  ],
  nokia: [
    `${P}X_ALU_OntOpticalParam.RXPower`,
    `${P}X_ALU_OntOpticalParam.TXPower`,
    `${W1}X_ALU-COM_GponInterfaceConfig.RXPower`,
  ],
  // China Mobile (GM220-S dll.), CDATA, Hioso, Youhua, ONU berbasis Realtek:
  // spesifikasi gateway operator China — X_CMCC_/X_CT-COM_/X_CU_.
  cmcc: [
    `${W1}X_CMCC_GponInterfaceConfig.RXPower`,
    `${W1}X_CMCC_GponInterfaceConfig.TXPower`,
    `${W1}X_CMCC_GponInterfaceConfig.TransceiverTemperature`,
    `${W1}X_CMCC_GponInterfaceConfig.SupplyVottage`,
    `${W1}X_CMCC_GponInterfaceConfig.BiasCurrent`,
    `${W1}X_CMCC_EponInterfaceConfig.RXPower`,
    `${W1}X_CMCC_EponInterfaceConfig.TXPower`,
    `${W1}X_CT-COM_GponInterfaceConfig.RXPower`,
    `${W1}X_CT-COM_GponInterfaceConfig.TXPower`,
    `${W1}X_CT-COM_EponInterfaceConfig.RXPower`,
    `${W1}X_CU_WANEPONInterfaceConfig.OpticalTransceiver.RXPower`,
    `${W1}X_CU_GponInterfaceConfig.RXPower`,
    `${W1}WANPONInterfaceConfig.RXPower`,
    `${W1}WANPONInterfaceConfig.TXPower`,
    `${P}X_CT-COM_GponInterfaceConfig.Stats.RxPower`,
    `${P}X_CT-COM_EponInterfaceConfig.Stats.RxPower`,
    `${P}X_Realtek_EponInterfaceConfig.Stats.RxPower`,
    `${P}X_Realtek_EponInterfaceConfig.Stats.TxPower`,
    `${W1}WANEponInterfaceConfig.RXPower`,
    `${W1}WANEponInterfaceConfig.TXPower`,
  ],
};

/** Semua varian redaman yang diketahui (TR-098), tanpa duplikat. */
export const PATH_OPTICAL_098: string[] = [...new Set(Object.values(OPT).flat())];

/**
 * Tebak keluarga vendor dari Manufacturer / OUI / ProductClass Inform.
 * Firmware operator sering melaporkan nama operator, bukan pabrikan.
 */
export function opticalFamily(manufacturer: string, oui: string, productClass: string): OpticalFamily {
  const m = `${manufacturer} ${productClass}`.toLowerCase();
  const o = oui.toUpperCase();
  if (/fiberhome|fiber home/.test(m) || /^(HG6|AN55|HG62|HG61)/i.test(productClass) || ['0019E0', '241815', '0C4F5A', '5C6A80'].includes(o)) return 'fiberhome';
  if (/huawei/.test(m) || /^(HG8|EG8|HS8)/i.test(productClass) || ['00E0FC', '4C1FCC', '00259E', '001882', 'E0247F', '486276'].includes(o)) return 'huawei';
  if (/\bzte\b|zxhn/.test(m) || /^F[0-9]{3}/i.test(productClass) || ['001141', '00D0D0', 'D0608C', '344B50'].includes(o)) return 'zte';
  if (/nokia|alcatel|\balu\b/.test(m) || /^G-[0-9]/i.test(productClass)) return 'nokia';
  if (/cmcc|china ?mobile|chinamobile|ctcc|china ?telecom|cucc|unicom|cdata|hioso|youhua|realtek|vsol|gm2[0-9]{2}/.test(m)) return 'cmcc';
  return 'unknown';
}

/**
 * Kandidat redaman untuk satu perangkat: milik keluarganya dulu. Bila
 * semuanya sudah terbukti ditolak (`invalid`), kembali ke seluruh varian —
 * jadi perangkat yang salah ditebak tetap akhirnya terbaca.
 */
export function opticalCandidates(family: OpticalFamily, invalid: Set<string>): string[] {
  if (family === 'unknown') return PATH_OPTICAL_098;
  const own = OPT[family];
  return own.every((p) => invalid.has(p)) ? PATH_OPTICAL_098 : own;
}

export const PATH_INFO_181: string[] = [
  'Device.DeviceInfo.Manufacturer',
  'Device.DeviceInfo.ModelName',
  'Device.DeviceInfo.SerialNumber',
  'Device.DeviceInfo.SoftwareVersion',
  'Device.DeviceInfo.HardwareVersion',
  'Device.DeviceInfo.UpTime',
  'Device.ManagementServer.ConnectionRequestURL',
  'Device.ManagementServer.ConnectionRequestUsername',
  'Device.ManagementServer.PeriodicInformInterval',
  'Device.Hosts.HostNumberOfEntries',
  'Device.DeviceInfo.ProcessStatus.CPUUsage',
  'Device.DeviceInfo.MemoryStatus.Total',
  'Device.DeviceInfo.MemoryStatus.Free',
  'Device.DeviceInfo.TemperatureStatus.TemperatureSensor.1.Value',
];

export const PATH_OPTICAL_181: string[] = [
  'Device.Optical.Interface.1.Status',
  'Device.Optical.Interface.1.OpticalSignalLevel',
  'Device.Optical.Interface.1.TransmitOpticalLevel',
  // Sebagian firmware (genieacs-relay optical.go) melapor di Stats.
  'Device.Optical.Interface.1.Stats.RxPower',
  'Device.Optical.Interface.1.Stats.TxPower',
];

/**
 * Path esensial sesuai data model; null = belum diketahui → TR-098.
 * `optical` = kandidat redaman TR-098 terpilih (lihat opticalCandidates);
 * tanpa argumen dipakai seluruh varian.
 */
export function essentialPaths(model: DataModel | null, optical: string[] = PATH_OPTICAL_098): string[] {
  return model === 'TR-181'
    ? [...PATH_INFO_181, ...PATH_OPTICAL_181]
    : [...PATH_INFO_098, ...optical];
}
