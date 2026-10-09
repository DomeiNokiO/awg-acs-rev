/**
 * Profiler parameter: mengubah hasil GetParameterNames menjadi daftar path
 * KONKRET milik satu perangkat yang layak dibaca ulang.
 *
 * Alur:
 *  1. Discovery: GetParameterNames(root, NextLevel=false) untuk tiap root
 *     di `discoveryRoots(model)`. NextLevel=false = perangkat mengembalikan
 *     SELURUH subtree dalam satu balasan, jadi tidak perlu menelusuri anak
 *     satu per satu (cara lama memakan puluhan sesi Inform).
 *  2. Dari balasan itu hanya leaf "menarik" yang disimpan ke profil
 *     perangkat (`isInterestingLeaf`): redaman, koneksi WAN beserta
 *     VLAN/ServiceList vendor, WiFi, info dasar. Nomor instans dipakai apa
 *     adanya — milik perangkat itu sendiri — sehingga PPPoE di
 *     WANConnectionDevice.2/.3 ikut terbaca.
 *
 * Profil disimpan per perangkat (tabel collection), bukan per model:
 * dua ONU bermodel sama bisa punya susunan WAN berbeda.
 *
 * Batas yang dijaga: modul ini tidak menulis apa pun ke perangkat.
 */
import type { DataModel } from './insight.ts';

/** Jumlah maksimum path profil per perangkat (jaga ukuran batch GPV). */
export const MAX_PROFILE_PATHS = 800;

const DISCOVERY_ROOTS_098 = [
  'InternetGatewayDevice.WANDevice.',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.',
  'InternetGatewayDevice.DeviceInfo.',
];

const DISCOVERY_ROOTS_181 = [
  'Device.PPP.Interface.',
  'Device.IP.Interface.',
  'Device.Ethernet.VLANTermination.',
  'Device.Optical.Interface.',
  'Device.WiFi.',
  'Device.DeviceInfo.',
];

export function discoveryRoots(model: DataModel | null): string[] {
  return model === 'TR-181' ? [...DISCOVERY_ROOTS_181] : [...DISCOVERY_ROOTS_098];
}

/** Root yang mencakup objek WAN — ditelusuri ulang setelah WAN dibuat/diubah. */
export function wanRoots(model: DataModel | null): string[] {
  return model === 'TR-181'
    ? ['Device.PPP.Interface.', 'Device.IP.Interface.', 'Device.Ethernet.VLANTermination.']
    : ['InternetGatewayDevice.WANDevice.'];
}

const IGD = 'InternetGatewayDevice\\.';
const OPT_LEAF = '(?:RXPower|RxPower|TXPower|TxPower|RXOpticalPower|RxOpticalPower|TxOpticalPower|TransceiverTemperature|Temperature|SupplyVoltage|Voltage|BiasCurrent|Status)';
const CONN_LEAF =
  '(?:Enable|Name|Alias|Username|UserName|ConnectionStatus|ConnectionType|AddressingType|ExternalIPAddress|' +
  'SubnetMask|DefaultGateway|RemoteIPAddress|DNSServers|MACAddress|Uptime|LastConnectionError|NATEnabled|' +
  'TransportType|ConnectionTrigger|PPPAuthenticationProtocol|PPPoEServiceName|' +
  'X_[A-Za-z0-9-]+_(?:VLANID|VLANIDMark|VLAN|VLANEnable|VLANMode|8021p|802-1pMark|PRI|' +
  'ServiceList|SERVICELIST|ServiceType|ConnectionMode|LanInterface|IPMode|IPForwardList)|' +
  'X_HW_LANBIND\\.(?:Lan|SSID)\\d+Enable|Stats\\.Ethernet(?:Bytes|Packets)(?:Sent|Received)|VLANID)';
const WLAN_LEAF =
  '(?:Enable|Status|SSID|BeaconType|Channel|AutoChannelEnable|Standard|TotalAssociations|SSIDAdvertisementEnabled|' +
  'KeyPassphrase|PreSharedKey\\.1\\.KeyPassphrase|OperatingFrequencyBand|' +
  'X_[A-Za-z0-9-]+_(?:Band|FrequencyBand|RFBand|KeyPassphrase|WPAKey))';

/**
 * Leaf CPU/RAM vendor di bawah DeviceInfo (boleh satu objek vendor di
 * antaranya). Nama yang jelas bukan beban (tipe, model, frekuensi, jumlah
 * inti) dikecualikan di insight.ts.
 */
export const SYSTEM_LEAF = /^(?:InternetGatewayDevice|Device)\.DeviceInfo\.(?:X_[^.]+\.)?(?:X_[A-Za-z0-9-]+_)?[A-Za-z]*(?:Cpu|CPU|cpu|Mem|MEM|mem|Memory|RAM|Ram)[A-Za-z]*$/;

const INTEREST: RegExp[] = [
  // ---- TR-098 ----
  new RegExp(`^${IGD}DeviceInfo\\.(?:Manufacturer|ModelName|SerialNumber|SoftwareVersion|HardwareVersion|UpTime|ProvisioningCode|TemperatureStatus\\.TemperatureSensor\\.\\d+\\.Value)$`),
  new RegExp(`^${IGD}WANDevice\\.\\d+\\.WANConnectionDevice\\.\\d+\\.WAN(?:PPP|IP)Connection\\.\\d+\\.${CONN_LEAF}$`),
  new RegExp(`^${IGD}WANDevice\\.\\d+\\.WANConnectionDevice\\.\\d+\\.X_[^.]*(?:Link|LINK)Config\\.(?:Enable|Mode|VLANIDMark|VLANID|VLANId|802-1pMark)$`),
  new RegExp(`^${IGD}WANDevice\\.\\d+\\.WANConnectionDevice\\.\\d+\\.X_FH_VLANConfig\\.\\d+\\.VLANID$`),
  // WCD kosong (dibuat OLT lewat OMCI) — supaya tetap terlihat sebagai lokasi WAN.
  new RegExp(`^${IGD}WANDevice\\.\\d+\\.WANConnectionDevice\\.\\d+\\.WAN(?:PPP|IP)ConnectionNumberOfEntries$`),
  new RegExp(`^${IGD}WANDevice\\.\\d+\\.(?:X_[^.]+|WANEponInterfaceConfig|WANGponInterfaceConfig)(?:\\.[^.]+)*\\.${OPT_LEAF}$`),
  new RegExp(`^${IGD}WANDevice\\.\\d+\\.WANCommonInterfaceConfig\\.(?:WANAccessType|PhysicalLinkStatus|TotalBytesSent|TotalBytesReceived)$`),
  new RegExp(`^${IGD}LANDevice\\.\\d+\\.WLANConfiguration\\.\\d+\\.${WLAN_LEAF}$`),
  // CPU/RAM: standar (ProcessStatus.CPUUsage, MemoryStatus.Total/Free) dan
  // leaf vendor di bawah DeviceInfo yang namanya memuat CPU/Mem/RAM
  // (X_HW_CpuUsed, X_ZTE-COM_…, X_CMCC_…, objek X_*.Memory…). Tabel proses
  // (ProcessStatus.Process.N) sengaja tidak ikut — besar dan tak berguna.
  /^(?:InternetGatewayDevice|Device)\.DeviceInfo\.(?:ProcessStatus\.CPUUsage|MemoryStatus\.(?:Total|Free))$/,
  SYSTEM_LEAF,
  // ---- TR-181 ----
  /^Device\.DeviceInfo\.(?:Manufacturer|ModelName|SerialNumber|SoftwareVersion|HardwareVersion|UpTime)$/,
  /^Device\.Optical\.Interface\.\d+\.(?:Status|Name|OpticalSignalLevel|TransmitOpticalLevel|X_[^.]+)$/,
  /^Device\.PPP\.Interface\.\d+\.(?:Enable|Status|ConnectionStatus|Name|Alias|Username|LowerLayers|LastConnectionError|Stats\.Bytes(?:Sent|Received))$/,
  /^Device\.IP\.Interface\.\d+\.(?:Enable|Status|Name|Alias|LowerLayers|IPv4Address\.\d+\.IPAddress|Stats\.Bytes(?:Sent|Received))$/,
  /^Device\.Optical\.Interface\.\d+\.Stats\.Bytes(?:Sent|Received)$/,
  /^Device\.Ethernet\.VLANTermination\.\d+\.(?:Enable|Status|Name|Alias|VLANID|LowerLayers)$/,
  /^Device\.WiFi\.SSID\.\d+\.(?:Enable|Status|SSID|LowerLayers)$/,
  /^Device\.WiFi\.Radio\.\d+\.(?:Enable|OperatingFrequencyBand|Channel)$/,
  /^Device\.WiFi\.AccessPoint\.\d+\.(?:Enable|SSIDReference|AssociatedDeviceNumberOfEntries|Security\.ModeEnabled|Security\.KeyPassphrase)$/,
];

/** Leaf yang layak masuk profil koleksi. */
export function isInterestingLeaf(path: string): boolean {
  if (!path || path.endsWith('.') || path.includes('*')) return false;
  return INTEREST.some((re) => re.test(path));
}

/** Saring balasan GetParameterNames menjadi daftar leaf profil. */
export function profileFromNodes(nodes: string[]): string[] {
  const out = new Set<string>();
  for (const n of nodes) {
    if (isInterestingLeaf(n)) out.add(n);
    if (out.size >= MAX_PROFILE_PATHS) break;
  }
  return [...out].sort();
}
