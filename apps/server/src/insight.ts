/**
 * Insight perangkat: mengubah parameter mentah (path → nilai) menjadi
 * informasi operasional — redaman optik, daftar koneksi WAN (PPPoE/IP),
 * daftar SSID — TANPA bergantung pada nomor instans atau merek tertentu.
 *
 * Kenapa berbasis pola, bukan path tetap:
 *  - ZTE/Huawei/FiberHome menaruh WAN PPPoE di `WANConnectionDevice.2`,
 *    `.3`, dst. (WCD.1 sering dipakai TR069/VoIP). Path tetap `.1.` membuat
 *    PPPoE "tidak tampil" walau datanya sudah terbaca.
 *  - Redaman tersebar di banyak subtree vendor (X_ZTE-COM_WANPONInterfaceConfig,
 *    X_GponInterafceConfig, X_HW_DEBUG.AdminTR069, X_CT-COM_GponInterfaceConfig,
 *    X_ALU_OntOpticalParam, Device.Optical.Interface, …) dan dengan satuan
 *    berbeda (dBm, 0.1 µW, 0.001 dBm). Semua dinormalisasi ke dBm di sini.
 *
 * Modul ini murni (tanpa I/O) supaya mudah diuji dan dipakai di mana saja.
 */

export type DataModel = 'TR-098' | 'TR-181';

export interface ParamLike { path: string; value: string; type?: string }

const IGD = 'InternetGatewayDevice.';

/** Tentukan data model dari daftar path yang pernah dilihat. */
export function detectDataModel(paths: Iterable<string>): DataModel | null {
  let igd = false;
  let dev = false;
  for (const p of paths) {
    if (p.startsWith(IGD)) igd = true;
    else if (p.startsWith('Device.')) dev = true;
  }
  if (igd) return 'TR-098';
  if (dev) return 'TR-181';
  return null;
}

function num(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(String(raw));
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ *
 * Optik / redaman
 * ------------------------------------------------------------------ */

export interface OpticalInfo {
  /** Daya terima (dBm). null = tidak terbaca. */
  rx: number | null;
  /** Daya kirim (dBm). */
  tx: number | null;
  temperature: number | null; // °C
  voltage: number | null;     // V
  bias: number | null;        // mA
  /** true bila perangkat melaporkan tidak ada cahaya (LOS). */
  los: boolean;
  /** Path sumber nilai RX — untuk audit di UI. */
  source: string | null;
  raw: { rx: string | null; tx: string | null };
}

/** Konteks path optik: menghindari salah tangkap sinyal WiFi (Rssi dsb). */
const OPTICAL_CTX = /(?:G?E?PON|Gpon|Epon|Pon|Optical|OntOptical|Transceiver|AdminTR069|X_HW_DEBUG)/;

const RX_LEAF = /\.(RXPower|RxPower|RXOpticalPower|RxOpticalPower|OpticalSignalLevel|RxOpticalLevel|ReceivePower|RecvPower)$/;
const TX_LEAF = /\.(TXPower|TxPower|TXOpticalPower|TxOpticalPower|TransmitOpticalLevel|TxOpticalLevel|SendPower)$/;
const TEMP_LEAF = /\.(TransceiverTemperature|Temperature|OpticalTemperature)$/;
const VOLT_LEAF = /\.(SupplyVoltage|SupplyVottage|Voltage|Vcc)$/;
const BIAS_LEAF = /\.(BiasCurrent|TxBiasCurrent|Bias|LaserBiasCurrent)$/;

/**
 * Normalisasi daya optik ke dBm.
 *
 *  - Nilai negatif wajar (-8 … -30) dianggap sudah dBm.
 *  - Negatif besar (-2134, -21340) = skala 0.01 / 0.001 dBm (TR-181
 *    OpticalSignalLevel bersatuan 0.001 dBm) → dibagi sampai masuk rentang.
 *  - RX positif = satuan 0.1 µW (standar CT-COM/CMCC, dipakai ZTE/FiberHome
 *    firmware China) → 10·log10(v / 10000).
 *  - TX positif kecil (≤ 10) sudah dBm; lebih besar = 0.1 µW.
 */
export function normalizePower(raw: string | null | undefined, kind: 'rx' | 'tx'): { dbm: number | null; los: boolean } {
  const v = num(raw);
  if (v === null) return { dbm: null, los: false };
  if (kind === 'rx' && v === 0) return { dbm: null, los: true };
  let dbm: number;
  if (v < 0) {
    dbm = v;
    for (const div of [10, 100, 1000]) {
      if (dbm >= -60) break;
      dbm = v / div;
    }
    if (dbm < -60) return { dbm: null, los: false };
  } else if (kind === 'tx' && v <= 10) {
    dbm = v;
  } else {
    dbm = 10 * Math.log10(v / 10000);
  }
  // ≤ -40 dBm praktis = tidak ada cahaya.
  if (kind === 'rx' && dbm <= -40) return { dbm: round2(dbm), los: true };
  return { dbm: round2(dbm), los: false };
}

function normalizeTemp(raw: string | null): number | null {
  const v = num(raw);
  if (v === null) return null;
  // Standar CT-COM: satuan 1/256 °C.
  return round2(Math.abs(v) > 200 ? v / 256 : v);
}
function normalizeVoltage(raw: string | null): number | null {
  const v = num(raw);
  if (v === null) return null;
  if (v > 10000) return round2(v / 10000); // 100 µV (CT-COM)
  if (v > 100) return round2(v / 1000);    // mV
  return round2(v);
}
function normalizeBias(raw: string | null): number | null {
  const v = num(raw);
  if (v === null) return null;
  return round2(v > 1000 ? v * 0.002 : v); // 2 µA (CT-COM) atau mA
}

/** Urutkan kandidat: instans `.1.` dulu, lalu path terpendek. */
function rank(a: ParamLike, b: ParamLike): number {
  const a1 = /\.1\./.test(a.path) ? 0 : 1;
  const b1 = /\.1\./.test(b.path) ? 0 : 1;
  return a1 - b1 || a.path.length - b.path.length;
}

function firstOptical(params: ParamLike[], leaf: RegExp): ParamLike | null {
  const c = params
    .filter((p) => leaf.test(p.path) && OPTICAL_CTX.test(p.path) && p.value !== '')
    .sort(rank);
  return c[0] ?? null;
}

export function extractOptical(params: ParamLike[]): OpticalInfo {
  // Banyak firmware mengisi beberapa subtree sekaligus; ambil RX yang
  // menghasilkan angka masuk akal lebih dulu.
  const rxCands = params
    .filter((p) => RX_LEAF.test(p.path) && OPTICAL_CTX.test(p.path) && p.value !== '')
    .sort(rank);
  let rx: { dbm: number | null; los: boolean } = { dbm: null, los: false };
  let rxSrc: ParamLike | null = null;
  for (const c of rxCands) {
    const n = normalizePower(c.value, 'rx');
    if (n.dbm !== null || n.los) { rx = n; rxSrc = c; if (!n.los) break; }
  }
  const txP = firstOptical(params, TX_LEAF);
  const tempP = firstOptical(params, TEMP_LEAF);
  const voltP = firstOptical(params, VOLT_LEAF);
  const biasP = firstOptical(params, BIAS_LEAF);
  return {
    rx: rx.dbm,
    tx: txP ? normalizePower(txP.value, 'tx').dbm : null,
    temperature: tempP ? normalizeTemp(tempP.value) : null,
    voltage: voltP ? normalizeVoltage(voltP.value) : null,
    bias: biasP ? normalizeBias(biasP.value) : null,
    los: rx.los,
    source: rxSrc?.path ?? null,
    raw: { rx: rxSrc?.value ?? null, tx: txP?.value ?? null },
  };
}

/* ------------------------------------------------------------------ *
 * Koneksi WAN
 * ------------------------------------------------------------------ */

export interface WanConn {
  /** Path objek koneksi, berakhiran titik. */
  base: string;
  kind: 'ppp' | 'ip';
  /** Nomor WANConnectionDevice (TR-098) — null untuk TR-181. */
  wcd: number | null;
  instance: number;
  name: string | null;
  enable: string | null;
  status: string | null;
  username: string | null;
  externalIp: string | null;
  gateway: string | null;
  dns: string | null;
  connectionType: string | null;
  addressingType: string | null;
  vlan: string | null;
  /** Path parameter VLAN yang terbaca (untuk penulisan ulang). */
  vlanPath: string | null;
  serviceList: string | null;
  serviceListPath: string | null;
  mac: string | null;
  uptime: string | null;
  lastError: string | null;
  nat: string | null;
}

const WAN98 = /^(InternetGatewayDevice\.WANDevice\.(\d+)\.WANConnectionDevice\.(\d+)\.(WANPPPConnection|WANIPConnection)\.(\d+)\.)([^.]+)$/;
const LINK98 = /^InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.(\d+)\.(X_[^.]*(?:Link|LINK)Config|X_FH_VLANConfig\.\d+)\.(VLANIDMark|VLANID|VLANId|VLAN)$/;
/** Nama parameter VLAN di level koneksi (vendor & standar). */
const VLAN_LEAF = /^(?:X_[A-Za-z0-9-]+_)?(?:VLANID|VLANIDMark|VLANId|VLAN|VlanId|VLANIDTag)$/;
const SERVICE_LEAF = /^X_[A-Za-z0-9-]+_(?:ServiceList|SERVICELIST|ServiceType)$/;

function emptyConn(base: string, kind: 'ppp' | 'ip', wcd: number | null, instance: number): WanConn {
  return {
    base, kind, wcd, instance,
    name: null, enable: null, status: null, username: null, externalIp: null,
    gateway: null, dns: null, connectionType: null, addressingType: null,
    vlan: null, vlanPath: null, serviceList: null, serviceListPath: null,
    mac: null, uptime: null, lastError: null, nat: null,
  };
}

function fillCommon(c: WanConn, leaf: string, value: string, path: string): void {
  switch (leaf) {
    case 'Name': case 'Alias': c.name ??= value; break;
    case 'Enable': c.enable = value; break;
    case 'ConnectionStatus': c.status = value; break;
    case 'Status': c.status ??= value; break;
    case 'Username': case 'UserName': c.username = value; break;
    case 'ExternalIPAddress': c.externalIp = value; break;
    case 'DefaultGateway': case 'RemoteIPAddress': c.gateway ??= value; break;
    case 'DNSServers': c.dns = value; break;
    case 'ConnectionType': c.connectionType = value; break;
    case 'AddressingType': c.addressingType = value; break;
    case 'MACAddress': c.mac = value; break;
    case 'Uptime': c.uptime = value; break;
    case 'LastConnectionError': c.lastError = value; break;
    case 'NATEnabled': c.nat = value; break;
    default:
      if (VLAN_LEAF.test(leaf) && c.vlanPath === null) { c.vlan = value; c.vlanPath = path; }
      else if (SERVICE_LEAF.test(leaf) && /ServiceList|SERVICELIST/.test(leaf)) {
        c.serviceList = value; c.serviceListPath = path;
      }
  }
}

function wan098(params: ParamLike[]): WanConn[] {
  const map = new Map<string, WanConn>();
  const linkVlan = new Map<number, { value: string; path: string }>();
  for (const p of params) {
    const m = WAN98.exec(p.path);
    if (m) {
      const base = m[1]!;
      let c = map.get(base);
      if (!c) {
        c = emptyConn(base, m[4] === 'WANPPPConnection' ? 'ppp' : 'ip', Number(m[3]), Number(m[5]));
        map.set(base, c);
      }
      fillCommon(c, m[6]!, p.value, p.path);
      continue;
    }
    const l = LINK98.exec(p.path);
    if (l && p.value !== '') linkVlan.set(Number(l[1]), { value: p.value, path: p.path });
  }
  // VLAN level link (X_CT-COM_WANGponLinkConfig, X_ZTE-COM_WANPONLinkConfig…)
  // berlaku untuk semua koneksi di WANConnectionDevice yang sama.
  for (const c of map.values()) {
    if (c.vlanPath === null && c.wcd !== null) {
      const lv = linkVlan.get(c.wcd);
      if (lv) { c.vlan = lv.value; c.vlanPath = lv.path; }
    }
  }
  return [...map.values()].sort((a, b) => (a.wcd ?? 0) - (b.wcd ?? 0) || a.instance - b.instance);
}

function wan181(params: ParamLike[]): WanConn[] {
  const byPath = new Map(params.map((p) => [p.path, p.value]));
  const out: WanConn[] = [];
  const pppRe = /^(Device\.PPP\.Interface\.(\d+)\.)([^.]+)$/;
  const conns = new Map<string, WanConn>();
  for (const p of params) {
    const m = pppRe.exec(p.path);
    if (!m) continue;
    let c = conns.get(m[1]!);
    if (!c) { c = emptyConn(m[1]!, 'ppp', null, Number(m[2])); conns.set(m[1]!, c); }
    fillCommon(c, m[3]!, p.value, p.path);
  }
  for (const c of conns.values()) {
    const ref = c.base.slice(0, -1); // Device.PPP.Interface.N
    // IP publik: IP.Interface yang LowerLayers-nya menunjuk PPP ini.
    for (const p of params) {
      const m = /^(Device\.IP\.Interface\.\d+\.)LowerLayers$/.exec(p.path);
      if (m && p.value.split(',').map((s) => s.trim().replace(/\.$/, '')).includes(ref)) {
        c.externalIp = byPath.get(`${m[1]}IPv4Address.1.IPAddress`) ?? c.externalIp;
      }
    }
    // VLAN: PPP.LowerLayers → Ethernet.VLANTermination.K
    const lower = byPath.get(`${c.base}LowerLayers`) ?? '';
    const vt = /Device\.Ethernet\.VLANTermination\.(\d+)/.exec(lower);
    if (vt) {
      const vp = `Device.Ethernet.VLANTermination.${vt[1]}.VLANID`;
      if (byPath.has(vp)) { c.vlan = byPath.get(vp) ?? null; c.vlanPath = vp; }
    }
    if (c.status === null) c.status = byPath.get(`${c.base}ConnectionStatus`) ?? null;
    out.push(c);
  }
  return out.sort((a, b) => a.instance - b.instance);
}

export function extractWan(params: ParamLike[], model?: DataModel | null): WanConn[] {
  const m = model ?? detectDataModel(params.map((p) => p.path));
  return m === 'TR-181' ? wan181(params) : wan098(params);
}

/** Koneksi PPPoE utama: yang punya username, utamakan yang Connected. */
export function primaryPppoe(conns: WanConn[]): WanConn | null {
  const ppp = conns.filter((c) => c.kind === 'ppp' && c.username);
  return ppp.find((c) => /connected|up/i.test(c.status ?? '') && !/dis/i.test(c.status ?? ''))
    ?? ppp[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * WiFi
 * ------------------------------------------------------------------ */

export interface WlanInfo {
  /** Indeks instans (WLANConfiguration.i atau WiFi.SSID.i). */
  index: number;
  base: string;
  ssid: string | null;
  enable: string | null;
  status: string | null;
  band: '2.4GHz' | '5GHz' | null;
  channel: string | null;
  security: string | null;
  clients: string | null;
  /** Path sandi yang terbaca di perangkat (urutan prioritas tulis). */
  passphrasePaths: string[];
  hasPassphrase: boolean;
}

function bandOf(std: string | null, channel: string | null, band: string | null): WlanInfo['band'] {
  if (band) return /5/.test(band) ? '5GHz' : '2.4GHz';
  const ch = num(channel);
  if (ch !== null && ch > 14) return '5GHz';
  if (std && /\bac\b|ax|^a$|^n,?ac|a\/n/i.test(std)) return '5GHz';
  if (std || ch !== null) return '2.4GHz';
  return null;
}

function wlan098(params: ParamLike[]): WlanInfo[] {
  const re = /^(InternetGatewayDevice\.LANDevice\.\d+\.WLANConfiguration\.(\d+)\.)(.+)$/;
  const map = new Map<string, WlanInfo & { _std: string | null; _band: string | null }>();
  for (const p of params) {
    const m = re.exec(p.path);
    if (!m) continue;
    const base = m[1]!;
    let w = map.get(base);
    if (!w) {
      w = {
        index: Number(m[2]), base, ssid: null, enable: null, status: null, band: null,
        channel: null, security: null, clients: null, passphrasePaths: [], hasPassphrase: false,
        _std: null, _band: null,
      };
      map.set(base, w);
    }
    const leaf = m[3]!;
    if (leaf === 'SSID') w.ssid = p.value;
    else if (leaf === 'Enable') w.enable = p.value;
    else if (leaf === 'Status') w.status = p.value;
    else if (leaf === 'Channel') w.channel = p.value;
    else if (leaf === 'BeaconType') w.security = p.value;
    else if (leaf === 'TotalAssociations') w.clients = p.value;
    else if (leaf === 'Standard') w._std = p.value;
    else if (/^(OperatingFrequencyBand|X_[^.]+_(?:Band|FrequencyBand|RFBand))$/.test(leaf)) w._band = p.value;
    else if (/^(PreSharedKey\.1\.KeyPassphrase|KeyPassphrase|PreSharedKey\.1\.PreSharedKey|X_[^.]+_KeyPassphrase|X_[^.]+_WPAKey)$/.test(leaf)) {
      w.passphrasePaths.push(p.path);
      if (p.value) w.hasPassphrase = true;
    }
  }
  return [...map.values()]
    .map(({ _std, _band, ...w }) => ({ ...w, band: bandOf(_std, w.channel, _band) }))
    .sort((a, b) => a.index - b.index);
}

function wlan181(params: ParamLike[]): WlanInfo[] {
  const byPath = new Map(params.map((p) => [p.path, p.value]));
  const out: WlanInfo[] = [];
  const re = /^(Device\.WiFi\.SSID\.(\d+)\.)SSID$/;
  for (const p of params) {
    const m = re.exec(p.path);
    if (!m) continue;
    const base = m[1]!;
    const ref = base.slice(0, -1);
    const radio = /Device\.WiFi\.Radio\.(\d+)/.exec(byPath.get(`${base}LowerLayers`) ?? '');
    const radioBase = radio ? `Device.WiFi.Radio.${radio[1]}.` : null;
    // AccessPoint yang SSIDReference-nya menunjuk SSID ini.
    let ap: string | null = null;
    for (const q of params) {
      const am = /^(Device\.WiFi\.AccessPoint\.\d+\.)SSIDReference$/.exec(q.path);
      if (am && q.value.replace(/\.$/, '') === ref) { ap = am[1]!; break; }
    }
    const passPaths = ap ? [`${ap}Security.KeyPassphrase`].filter((x) => byPath.has(x)) : [];
    out.push({
      index: Number(m[2]), base, ssid: p.value,
      enable: byPath.get(`${base}Enable`) ?? null,
      status: byPath.get(`${base}Status`) ?? null,
      band: bandOf(null, radioBase ? byPath.get(`${radioBase}Channel`) ?? null : null,
        radioBase ? byPath.get(`${radioBase}OperatingFrequencyBand`) ?? null : null),
      channel: radioBase ? byPath.get(`${radioBase}Channel`) ?? null : null,
      security: ap ? byPath.get(`${ap}Security.ModeEnabled`) ?? null : null,
      clients: ap ? byPath.get(`${ap}AssociatedDeviceNumberOfEntries`) ?? null : null,
      passphrasePaths: passPaths,
      hasPassphrase: passPaths.some((x) => !!byPath.get(x)),
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

export function extractWlan(params: ParamLike[], model?: DataModel | null): WlanInfo[] {
  const m = model ?? detectDataModel(params.map((p) => p.path));
  return m === 'TR-181' ? wlan181(params) : wlan098(params);
}

/* ------------------------------------------------------------------ *
 * Info umum + ringkasan
 * ------------------------------------------------------------------ */

export interface GeneralInfo {
  model: string | null;
  uptime: number | null;     // detik
  softwareVersion: string | null;
  hardwareVersion: string | null;
  lanIp: string | null;
  hosts: string | null;
  ponStatus: string | null;
}

export function extractGeneral(params: ParamLike[]): GeneralInfo {
  const get = (...re: RegExp[]): string | null => {
    for (const r of re) {
      const p = params.find((x) => r.test(x.path) && x.value !== '');
      if (p) return p.value;
    }
    return null;
  };
  const up = get(/^(InternetGatewayDevice|Device)\.DeviceInfo\.UpTime$/);
  return {
    model: get(/^(InternetGatewayDevice|Device)\.DeviceInfo\.ModelName$/),
    uptime: up !== null ? num(up) : null,
    softwareVersion: get(/^(InternetGatewayDevice|Device)\.DeviceInfo\.SoftwareVersion$/),
    hardwareVersion: get(/^(InternetGatewayDevice|Device)\.DeviceInfo\.HardwareVersion$/),
    lanIp: get(
      /^InternetGatewayDevice\.LANDevice\.1\.LANHostConfigManagement\.IPInterface\.1\.IPInterfaceIPAddress$/,
      /^Device\.IP\.Interface\.1\.IPv4Address\.1\.IPAddress$/,
    ),
    hosts: get(/^(InternetGatewayDevice\.LANDevice\.1|Device)\.Hosts\.HostNumberOfEntries$/),
    ponStatus: get(
      /^InternetGatewayDevice\.WANDevice\.1\.X_[^.]*(?:PON|Pon|Gpon|GPON|Epon|EPON|Interafce)[^.]*\.Status$/,
      /^Device\.Optical\.Interface\.1\.Status$/,
    ),
  };
}

export interface DeviceInsight {
  dataModel: DataModel | null;
  optical: OpticalInfo;
  wan: WanConn[];
  wlan: WlanInfo[];
  general: GeneralInfo;
}

export function buildInsight(params: ParamLike[], model?: DataModel | null): DeviceInsight {
  const dm = model ?? detectDataModel(params.map((p) => p.path));
  return {
    dataModel: dm,
    optical: extractOptical(params),
    wan: extractWan(params, dm),
    wlan: extractWlan(params, dm),
    general: extractGeneral(params),
  };
}

/** Kolom ringkasan untuk tabel devices (lihat Database.setDeviceFields). */
export function summaryFields(ins: DeviceInsight): Record<string, string | number | null> {
  const ppp = primaryPppoe(ins.wan);
  const anyIp = ins.wan.find((c) => c.externalIp && c.externalIp !== '0.0.0.0');
  return {
    data_model: ins.dataModel,
    rx_power: ins.optical.rx,
    tx_power: ins.optical.tx,
    optical_temp: ins.optical.temperature,
    pppoe_user: ppp?.username ?? null,
    pppoe_status: ppp?.status ?? null,
    wan_ip: (ppp?.externalIp && ppp.externalIp !== '0.0.0.0' ? ppp.externalIp : null) ?? anyIp?.externalIp ?? null,
    ssid: ins.wlan.find((w) => w.ssid)?.ssid ?? null,
    summary_at: Date.now(),
  };
}
