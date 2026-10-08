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
];

/** Semua varian redaman yang diketahui (TR-098). */
export const PATH_OPTICAL_098: string[] = [
  // FiberHome
  `${W1}X_FH_GponInterfaceConfig.RXPower`,
  `${W1}X_FH_GponInterfaceConfig.TXPower`,
  `${W1}X_FH_GponInterfaceConfig.TransceiverTemperature`,
  // ZTE (F670L, F609 v5+, F477…)
  `${W1}X_ZTE-COM_WANPONInterfaceConfig.RXPower`,
  `${W1}X_ZTE-COM_WANPONInterfaceConfig.TXPower`,
  `${W1}X_ZTE-COM_WANPONInterfaceConfig.TransceiverTemperature`,
  // ZTE F660/F609 lama (subtree CT-COM di root)
  `${P}X_CT-COM_GponInterfaceConfig.Stats.RxPower`,
  `${P}X_CT-COM_GponInterfaceConfig.Stats.TxPower`,
  // Huawei HG8245/HG8546M (typo "Interafce" memang dari firmware)
  `${W1}X_GponInterafceConfig.RXPower`,
  `${W1}X_GponInterafceConfig.TXPower`,
  `${W1}X_GponInterafceConfig.TransceiverTemperature`,
  // Huawei EG8145V5 dkk.
  `${P}X_HW_DEBUG.AdminTR069.RxPower`,
  `${P}X_HW_DEBUG.AdminTR069.TxPower`,
  // Nokia / Alcatel-Lucent
  `${P}X_ALU_OntOpticalParam.RXPower`,
  `${P}X_ALU_OntOpticalParam.TXPower`,
  // CT-COM / CMCC / CU (CDATA, Hioso, firmware China)
  `${W1}X_CT-COM_GponInterfaceConfig.RXPower`,
  `${W1}X_CT-COM_GponInterfaceConfig.TXPower`,
  `${W1}X_CT-COM_EponInterfaceConfig.RXPower`,
  `${W1}X_CMCC_GponInterfaceConfig.RXPower`,
  `${W1}X_CMCC_GponInterfaceConfig.TXPower`,
  `${W1}X_CMCC_EponInterfaceConfig.RXPower`,
  `${W1}X_CU_WANEPONInterfaceConfig.OpticalTransceiver.RXPower`,
  // Standar EPON (TR-181 lama / beberapa ONU EPON)
  `${W1}WANEponInterfaceConfig.RXPower`,
  `${W1}WANEponInterfaceConfig.TXPower`,
];

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
];

export const PATH_OPTICAL_181: string[] = [
  'Device.Optical.Interface.1.Status',
  'Device.Optical.Interface.1.OpticalSignalLevel',
  'Device.Optical.Interface.1.TransmitOpticalLevel',
];

/** Path esensial sesuai data model; null = belum diketahui → TR-098. */
export function essentialPaths(model: DataModel | null): string[] {
  return model === 'TR-181'
    ? [...PATH_INFO_181, ...PATH_OPTICAL_181]
    : [...PATH_INFO_098, ...PATH_OPTICAL_098];
}

