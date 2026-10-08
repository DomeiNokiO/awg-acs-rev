/**
 * Konfigurasi terstruktur perangkat — WiFi (SSID/sandi), PPPoE, VLAN,
 * buat WAN PPPoE/IP, dan hapus WAN.
 *
 * Semua aksi menulis lewat SetParameterValues / AddObject / DeleteObject.
 * Tidak ada Reboot / FactoryReset otomatis.
 *
 * PRINSIP PEMILIHAN PATH (berlaku untuk semua vendor):
 *  1. Target koneksi WAN diambil dari koneksi NYATA milik perangkat
 *     (insight.extractWan) — PPPoE di WANConnectionDevice.2/.3 ikut
 *     tertangani, tidak lagi dipatok ke `.1`.
 *  2. Nama parameter vendor (VLAN, ServiceList, sandi WiFi) dipilih dari
 *     path yang TERBUKTI ada di perangkat: hasil baca (params) ∪ hasil
 *     GetParameterNames model ini (discovered_params).
 *  3. Bila belum ada bukti, dipakai tebakan per keluarga vendor (Huawei
 *     X_HW_*, ZTE X_ZTE-COM_*, FiberHome X_FH_*, CT-COM/CMCC link config)
 *     dan laporan menandainya sebagai "tebakan".
 *  4. SetParameterValues bersifat ATOMIK: satu nama salah menggagalkan
 *     semuanya. Karena itu parameter standar (username/password, SSID)
 *     dikirim terpisah dari parameter vendor (VLAN, ServiceList).
 */

import type { Database } from '@acs/core';
import {
  enqueueWrite, enqueueAddObject, enqueueDeleteObject, deviceModel, WRITE_TTL_MS,
  type CwmpContext,
} from './cwmp.ts';
import { extractWan, extractWlan, type WanConn, type DataModel } from './insight.ts';

export type XsdType =
  | 'xsd:string' | 'xsd:int' | 'xsd:unsignedInt' | 'xsd:boolean'
  | 'xsd:dateTime' | 'xsd:base64Binary' | 'xsd:hexBinary';

export interface ParamValue { name: string; type: XsdType; value: string }

export type ConfigType =
  | 'wifi'        // ganti SSID / sandi / aktif-nonaktif
  | 'pppoe'       // kredensial PPPoE pada koneksi yang ada
  | 'vlan'        // set VLAN pada koneksi yang ada
  | 'wan-add'     // buat WAN PPPoE baru
  | 'wan-ip-add'  // buat WAN IP (DHCP/Static/Bridge) baru
  | 'wan-delete'; // hapus koneksi WAN

export const CONFIG_TYPES: ConfigType[] = ['wifi', 'pppoe', 'vlan', 'wan-add', 'wan-ip-add', 'wan-delete'];

export interface ConfigRequest {
  type: ConfigType;
  // wifi
  wlanIndex?: number;
  ssid?: string;
  passphrase?: string;
  wifiEnable?: boolean;
  // pppoe / vlan / wan-delete: path objek koneksi (dari insight.wan[].base)
  target?: string;
  username?: string;
  password?: string;
  vlanId?: number | string;
  serviceName?: string;
  // wan-add / wan-ip-add
  name?: string;
  bridge?: boolean;
  staticIp?: string;
  netmask?: string;
  gateway?: string;
  dns?: string;
  /** Baris tambahan "Path = nilai" (relatif ke koneksi baru, atau absolut). */
  extra?: string;
}

export interface ConfigReport {
  queued: number;
  writes: ParamValue[];
  plan: string[];
  skipped: string[];
  /** Nama parameter vendor yang dipakai tanpa bukti (tebakan). */
  guessed: string[];
  tasks: string[];
}

type Family = 'huawei' | 'zte' | 'fiberhome' | 'ct' | 'cmcc' | 'cu';

/* ------------------------------------------------------------------ *
 * Validasi input
 * ------------------------------------------------------------------ */

function str(v: unknown, max: number): string {
  return String(v ?? '').slice(0, max);
}
function vlan(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 4094) return null;
  return n;
}
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const TARGET_RE = /^(InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+\.WAN(?:PPP|IP)Connection\.\d+\.|Device\.PPP\.Interface\.\d+\.|Device\.IP\.Interface\.\d+\.)$/;
const NAME_RE = /^[\w.\-:]{1,256}$/;

/* ------------------------------------------------------------------ *
 * Pengetahuan tentang perangkat
 * ------------------------------------------------------------------ */

interface Knowledge {
  model: DataModel | null;
  /** Path yang terbukti ada: params ∪ discovered_params (model ini). */
  known: Set<string>;
  /** path → tipe xsd yang dilaporkan perangkat. */
  types: Map<string, string>;
  values: Map<string, string>;
  invalid: Set<string>;
  wan: WanConn[];
  manufacturer: string;
  oui: string;
}

function knowledge(ctx: CwmpContext, db: Database, deviceId: string): Knowledge {
  const row = db.getDevice(deviceId);
  const params = db.getParams(deviceId);
  const known = new Set(params.map((p) => p.path));
  for (const d of db.getDiscovered(row?.product_class ?? '')) {
    if (!d.path.endsWith('.')) known.add(d.path);
  }
  const model = deviceModel(ctx, deviceId);
  return {
    model,
    known,
    types: new Map(params.filter((p) => p.type && p.type !== 'xsd:string').map((p) => [p.path, p.type])),
    values: new Map(params.map((p) => [p.path, p.value])),
    invalid: new Set(db.invalidParams(deviceId)),
    wan: extractWan(params, model),
    manufacturer: row?.manufacturer ?? '',
    oui: (row?.oui ?? '').toUpperCase(),
  };
}

/** Bentuk path tanpa nomor instans, untuk mencocokkan antar instans. */
const shape = (p: string): string => p.replace(/\.\d+\./g, '.*.');

/** Tipe yang dilaporkan perangkat untuk path ini atau path berbentuk sama. */
function typeFor(k: Knowledge, path: string, fallback: XsdType): XsdType {
  const exact = k.types.get(path);
  if (exact) return exact as XsdType;
  const sh = shape(path);
  for (const [p, t] of k.types) if (shape(p) === sh) return t as XsdType;
  return fallback;
}

/** Ada di perangkat (path persis, atau bentuk yang sama di instans lain). */
function existsLike(k: Knowledge, path: string): boolean {
  if (k.known.has(path)) return true;
  const sh = shape(path);
  for (const p of k.known) if (shape(p) === sh) return true;
  return false;
}

/** Keluarga vendor: dari bukti path dulu, lalu nama pabrikan/OUI. */
function familyOf(k: Knowledge): Family {
  const has = (re: RegExp): boolean => { for (const p of k.known) if (re.test(p)) return true; return false; };
  if (has(/\.X_HW_VLAN$/)) return 'huawei';
  if (has(/\.X_ZTE-COM_VLANID$/)) return 'zte';
  if (has(/\.X_FH_VLANID$/)) return 'fiberhome';
  if (has(/\.X_CMCC_WANGponLinkConfig\./)) return 'cmcc';
  if (has(/\.X_CU_WANGponLinkConfig\./)) return 'cu';
  if (has(/\.X_CT-COM_WANGponLinkConfig\./)) return 'ct';
  const m = k.manufacturer.toLowerCase();
  if (/huawei/.test(m) || ['00E0FC', '4C1FCC', '00259E', '001882', 'E0247F'].includes(k.oui)) return 'huawei';
  if (/zte/.test(m) || ['001141', '00D0D0', 'D0608C', '344B50'].includes(k.oui)) return 'zte';
  if (/fiberhome|fiber home/.test(m) || ['0019E0', '241815'].includes(k.oui)) return 'fiberhome';
  // Firmware China Mobile (GM220-S dll.) melaporkan operator sebagai pabrikan.
  if (/cmcc|china ?mobile|chinamobile/.test(m)) return 'cmcc';
  if (/unicom|cucc/.test(m)) return 'cu';
  return 'ct';
}

/* ------------------------------------------------------------------ *
 * Perencanaan tulisan VLAN / ServiceList
 * ------------------------------------------------------------------ */

const LINK_VLAN: Record<Family, string | null> = {
  huawei: null,
  zte: null,
  fiberhome: null,
  ct: 'X_CT-COM_WANGponLinkConfig',
  cmcc: 'X_CMCC_WANGponLinkConfig',
  cu: 'X_CU_WANGponLinkConfig',
};
const CONN_VLAN: Record<Family, string | null> = {
  huawei: 'X_HW_VLAN', zte: 'X_ZTE-COM_VLANID', fiberhome: 'X_FH_VLANID', ct: null, cmcc: null, cu: null,
};
const CONN_SERVICE: Record<Family, string> = {
  huawei: 'X_HW_SERVICELIST', zte: 'X_ZTE-COM_ServiceList', fiberhome: 'X_FH_ServiceList',
  ct: 'X_CT-COM_ServiceList', cmcc: 'X_CMCC_ServiceList', cu: 'X_CU_ServiceList',
};

interface Planned { params: ParamValue[]; guessed: string[]; note?: string }

function linkBase(connBase: string): string | null {
  const m = /^(InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+\.)/.exec(connBase);
  return m ? m[1]! : null;
}

/**
 * Tulisan VLAN untuk koneksi yang SUDAH ADA. Mengembalikan beberapa
 * ParamValue bila vendor butuh penanda aktif (mis. X_ZTE-COM_VLANEnable,
 * Mode=2 tagged pada link config CT-COM).
 */
function planVlan(k: Knowledge, conn: WanConn, v: number): Planned {
  const out: ParamValue[] = [];
  const guessed: string[] = [];
  const val = String(v);

  if (k.model === 'TR-181') {
    if (!conn.vlanPath) return { params: [], guessed, note: 'VLANTermination untuk koneksi ini tidak ditemukan' };
    out.push({ name: conn.vlanPath, type: typeFor(k, conn.vlanPath, 'xsd:unsignedInt'), value: val });
    return { params: out, guessed };
  }

  const lb = linkBase(conn.base);
  // 1) path VLAN yang benar-benar terbaca untuk koneksi ini
  let path = conn.vlanPath;
  // 2) path VLAN lain yang diketahui ada (instans ini atau bentuk sama)
  if (!path) {
    const cands = [
      ...['X_HW_VLAN', 'X_ZTE-COM_VLANID', 'X_FH_VLANID', 'X_CMCC_VLANIDMark', 'X_CT-COM_VLANIDMark', 'VLANID']
        .map((n) => `${conn.base}${n}`),
      ...(lb ? ['X_CT-COM_WANGponLinkConfig', 'X_CMCC_WANGponLinkConfig', 'X_CU_WANGponLinkConfig',
        'X_CT-COM_WANEponLinkConfig', 'X_CMCC_WANEponLinkConfig']
        .map((n) => `${lb}${n}.VLANIDMark`) : []),
      ...(lb ? [`${lb}X_ZTE-COM_WANPONLinkConfig.VLANID`] : []),
    ];
    path = cands.find((c) => existsLike(k, c) && !k.invalid.has(c)) ?? null;
  }
  // 3) tebakan per keluarga vendor
  if (!path) {
    const fam = familyOf(k);
    const cv = CONN_VLAN[fam];
    const lv = LINK_VLAN[fam];
    path = cv ? `${conn.base}${cv}` : lb && lv ? `${lb}${lv}.VLANIDMark` : null;
    if (path) guessed.push(path);
  }
  if (!path) return { params: [], guessed, note: 'Nama parameter VLAN tidak diketahui untuk perangkat ini' };

  out.push({ name: path, type: typeFor(k, path, 'xsd:unsignedInt'), value: val });

  // Penanda aktif yang menyertai VLAN pada sebagian vendor.
  const enable = path.replace(/X_ZTE-COM_VLANID$/, 'X_ZTE-COM_VLANEnable');
  if (enable !== path && existsLike(k, enable)) {
    out.push({ name: enable, type: 'xsd:boolean', value: 'true' });
  }
  const link = /^(.*\.X_[^.]*LinkConfig\.)VLANIDMark$/.exec(path);
  if (link) {
    const mode = `${link[1]}Mode`;
    if (existsLike(k, mode)) out.push({ name: mode, type: typeFor(k, mode, 'xsd:unsignedInt'), value: '2' });
  }
  return { params: out, guessed };
}

function planService(k: Knowledge, conn: WanConn, service: string): Planned {
  if (conn.serviceListPath) {
    return { params: [{ name: conn.serviceListPath, type: 'xsd:string', value: service }], guessed: [] };
  }
  const cands = Object.values(CONN_SERVICE).map((n) => `${conn.base}${n}`);
  const found = cands.find((c) => existsLike(k, c) && !k.invalid.has(c));
  if (found) return { params: [{ name: found, type: 'xsd:string', value: service }], guessed: [] };
  const g = `${conn.base}${CONN_SERVICE[familyOf(k)]}`;
  return { params: [{ name: g, type: 'xsd:string', value: service }], guessed: [g] };
}

/* ------------------------------------------------------------------ *
 * Antrean
 * ------------------------------------------------------------------ */

function queueWrite(
  ctx: CwmpContext, db: Database, deviceId: string, rep: ConfigReport,
  params: ParamValue[], label: string, prefix: string,
): void {
  if (!params.length) return;
  const key = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  // id task = ParameterKey yang ikut dikirim ke perangkat, sehingga
  // SetParameterValuesResponse/Fault bisa langsung menutup task ini.
  db.createTask(key, deviceId, 'write', { params, label }, WRITE_TTL_MS);
  enqueueWrite(ctx, deviceId, params, key);
  rep.queued++;
  rep.tasks.push(key);
  rep.writes.push(...params);
  rep.plan.push(`${label}: SetParameterValues ${params.map((p) => p.name.split('.').slice(-2).join('.')).join(', ')}`);
}

/** Koneksi target: dari `target`, atau koneksi utama berjenis sesuai. */
function resolveConn(k: Knowledge, target: unknown, kind?: 'ppp' | 'ip'): WanConn | null {
  if (typeof target === 'string' && TARGET_RE.test(target)) {
    const found = k.wan.find((c) => c.base === target);
    if (found) return found;
  }
  const pool = kind ? k.wan.filter((c) => c.kind === kind) : k.wan;
  return pool.find((c) => c.username) ?? pool[0] ?? null;
}

/** Parse baris "Path = nilai" dari kolom parameter tambahan. */
function parseExtra(
  k: Knowledge, raw: string | undefined, relBase: string, rep: ConfigReport,
): { rel: { name: string; type: XsdType; value: string }[]; abs: { name: string; type: XsdType; value: string }[] } {
  const rel: { name: string; type: XsdType; value: string }[] = [];
  const abs: { name: string; type: XsdType; value: string }[] = [];
  for (const line of String(raw ?? '').split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('=');
    const name = i > 0 ? l.slice(0, i).trim() : '';
    const value = i > 0 ? l.slice(i + 1).trim() : '';
    if (!NAME_RE.test(name) || name.endsWith('.')) { rep.skipped.push(`baris tambahan diabaikan: ${l.slice(0, 80)}`); continue; }
    const isAbs = name.startsWith('InternetGatewayDevice.') || name.startsWith('Device.');
    const guess: XsdType = /^(true|false)$/i.test(value) ? 'xsd:boolean'
      : /^\d+$/.test(value) ? 'xsd:unsignedInt' : 'xsd:string';
    const type = typeFor(k, isAbs ? name : `${relBase}1.${name}`, guess);
    (isAbs ? abs : rel).push({ name, type, value });
  }
  return { rel, abs };
}

/* ------------------------------------------------------------------ *
 * Aksi
 * ------------------------------------------------------------------ */

function applyWifi(ctx: CwmpContext, db: Database, deviceId: string, k: Knowledge, req: ConfigRequest, rep: ConfigReport): void {
  const idx = Number.isInteger(Number(req.wlanIndex)) && Number(req.wlanIndex) >= 1 ? Number(req.wlanIndex) : 1;
  const wlans = extractWlan(db.getParams(deviceId), k.model);
  const w = wlans.find((x) => x.index === idx);
  const is181 = k.model === 'TR-181';
  const base = w?.base ?? (is181 ? `Device.WiFi.SSID.${idx}.` : `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.`);

  const std: ParamValue[] = [];
  if (req.ssid !== undefined && req.ssid !== '') {
    const s = str(req.ssid, 32);
    std.push({ name: `${base}SSID`, type: 'xsd:string', value: s });
  }
  if (typeof req.wifiEnable === 'boolean') {
    std.push({ name: `${base}Enable`, type: 'xsd:boolean', value: req.wifiEnable ? 'true' : 'false' });
  }
  if (req.passphrase !== undefined && req.passphrase !== '') {
    const pw = str(req.passphrase, 63);
    if (pw.length < 8) {
      rep.skipped.push('Sandi WiFi minimal 8 karakter');
    } else if (is181) {
      const p = w?.passphrasePaths[0] ?? `Device.WiFi.AccessPoint.${idx}.Security.KeyPassphrase`;
      std.push({ name: p, type: 'xsd:string', value: pw });
    } else {
      // Tulis ke semua lokasi sandi yang memang ada di perangkat. Huawei
      // memakai WLANConfiguration.N.KeyPassphrase, ZTE/FiberHome
      // PreSharedKey.1.KeyPassphrase; sebagian firmware punya keduanya.
      const cands = [`${base}PreSharedKey.1.KeyPassphrase`, `${base}KeyPassphrase`];
      let paths = [...new Set([...(w?.passphrasePaths ?? []).filter((p) => !/PreSharedKey\.1\.PreSharedKey$/.test(p)),
        ...cands.filter((c) => existsLike(k, c))])].filter((p) => !k.invalid.has(p));
      if (!paths.length && familyOf(k) === 'huawei' && existsLike(k, `${base}PreSharedKey.1.PreSharedKey`)) {
        paths = [`${base}PreSharedKey.1.PreSharedKey`];
      }
      if (!paths.length) {
        paths = [cands[0]!];
        rep.guessed.push(cands[0]!);
      }
      for (const p of paths) std.push({ name: p, type: 'xsd:string', value: pw });

      // Jaringan terbuka (BeaconType None/Basic) harus dijadikan WPA2 agar
      // sandi berlaku. Nilai enum TR-098 yang sah adalah '11i' — BUKAN
      // 'WPA2PSK' (nilai itu ditolak 9007 dan menggagalkan seluruh SPV).
      const beacon = k.values.get(`${base}BeaconType`);
      if (beacon && /^(None|Basic)$/i.test(beacon)) {
        std.push({ name: `${base}BeaconType`, type: 'xsd:string', value: '11i' });
        if (existsLike(k, `${base}IEEE11iAuthenticationMode`)) {
          std.push({ name: `${base}IEEE11iAuthenticationMode`, type: 'xsd:string', value: 'PSKAuthentication' });
        }
        if (existsLike(k, `${base}IEEE11iEncryptionModes`)) {
          std.push({ name: `${base}IEEE11iEncryptionModes`, type: 'xsd:string', value: 'AESEncryption' });
        }
      }
    }
  }
  if (!std.length) { rep.skipped.push('tidak ada perubahan WiFi yang valid'); return; }
  queueWrite(ctx, db, deviceId, rep, std, `WiFi SSID ${idx}`, 'cfg_wifi');
}

function applyPppoe(ctx: CwmpContext, db: Database, deviceId: string, k: Knowledge, req: ConfigRequest, rep: ConfigReport): void {
  const conn = resolveConn(k, req.target, 'ppp');
  if (!conn) {
    rep.skipped.push('Tidak ada koneksi PPPoE terdeteksi. Gunakan "Buat WAN" atau "Pelajari struktur" dulu.');
    return;
  }
  const std: ParamValue[] = [];
  if (req.username !== undefined && req.username !== '') {
    std.push({ name: `${conn.base}Username`, type: 'xsd:string', value: str(req.username, 128) });
  }
  if (req.password !== undefined && req.password !== '') {
    std.push({ name: `${conn.base}Password`, type: 'xsd:string', value: str(req.password, 128) });
  }
  queueWrite(ctx, db, deviceId, rep, std, `PPPoE ${conn.name ?? conn.base}`, 'cfg_pppoe');

  const v = vlan(req.vlanId);
  if (req.vlanId !== undefined && req.vlanId !== '' && v === null) rep.skipped.push('VLAN harus 1..4094');
  if (v !== null) {
    const pv = planVlan(k, conn, v);
    if (pv.note) rep.skipped.push(pv.note);
    rep.guessed.push(...pv.guessed);
    queueWrite(ctx, db, deviceId, rep, pv.params, `VLAN ${v}`, 'cfg_vlan');
  }
  if (req.serviceName) {
    const ps = planService(k, conn, str(req.serviceName, 64));
    rep.guessed.push(...ps.guessed);
    queueWrite(ctx, db, deviceId, rep, ps.params, 'Service list', 'cfg_svc');
  }
  if (!rep.queued) rep.skipped.push('tidak ada perubahan PPPoE yang valid');
}

function applyVlan(ctx: CwmpContext, db: Database, deviceId: string, k: Knowledge, req: ConfigRequest, rep: ConfigReport): void {
  const v = vlan(req.vlanId);
  if (v === null) { rep.skipped.push('VLAN harus 1..4094'); return; }
  const conn = resolveConn(k, req.target);
  if (!conn) { rep.skipped.push('Tidak ada koneksi WAN terdeteksi'); return; }
  const pv = planVlan(k, conn, v);
  if (pv.note) rep.skipped.push(pv.note);
  rep.guessed.push(...pv.guessed);
  queueWrite(ctx, db, deviceId, rep, pv.params, `VLAN ${v} ${conn.name ?? conn.base}`, 'cfg_vlan');
}

function applyWanAdd(ctx: CwmpContext, db: Database, deviceId: string, k: Knowledge, req: ConfigRequest, rep: ConfigReport): void {
  if (k.model === 'TR-181') {
    rep.skipped.push('Buat WAN otomatis belum didukung untuk perangkat TR-181 (butuh PPP.Interface + IP.Interface + VLANTermination). Gunakan tab Perintah → AddObject.');
    return;
  }
  const isPppoe = req.type === 'wan-add';
  const v = vlan(req.vlanId);
  if (req.vlanId !== undefined && req.vlanId !== '' && v === null) { rep.skipped.push('VLAN harus 1..4094'); return; }
  if (isPppoe && (!req.username || !req.password)) { rep.skipped.push('Username dan password PPPoE wajib diisi'); return; }
  if (!isPppoe && req.staticIp && !IPV4.test(req.staticIp)) { rep.skipped.push('IP statis tidak valid'); return; }

  // WANDevice tempat koneksi dibuat: yang sudah dipakai koneksi lain (GPON = 1).
  const wd = /^InternetGatewayDevice\.WANDevice\.(\d+)\./.exec(k.wan[0]?.base ?? '')?.[1] ?? '1';
  const wcdObj = `InternetGatewayDevice.WANDevice.${wd}.WANConnectionDevice.`;
  const connObj = isPppoe ? 'WANPPPConnection.' : 'WANIPConnection.';
  const fam = familyOf(k);
  const bridge = req.bridge === true;

  // Parameter standar TR-098 — satu SPV.
  const fills: { name: string; type: XsdType; value: string }[] = [
    { name: 'Name', type: 'xsd:string', value: str(req.name || (isPppoe ? 'INTERNET' : 'WAN_IP'), 32) },
  ];
  if (isPppoe) {
    fills.push(
      { name: 'ConnectionType', type: 'xsd:string', value: bridge ? 'PPPoE_Bridged' : 'IP_Routed' },
      { name: 'Username', type: 'xsd:string', value: str(req.username, 128) },
      { name: 'Password', type: 'xsd:string', value: str(req.password, 128) },
    );
    if (!bridge) fills.push({ name: 'NATEnabled', type: 'xsd:boolean', value: 'true' });
  } else {
    fills.push({ name: 'ConnectionType', type: 'xsd:string', value: bridge ? 'IP_Bridged' : 'IP_Routed' });
    if (!bridge) {
      fills.push(
        { name: 'AddressingType', type: 'xsd:string', value: req.staticIp ? 'Static' : 'DHCP' },
        { name: 'NATEnabled', type: 'xsd:boolean', value: 'true' },
      );
      if (req.staticIp) {
        const mask = req.netmask && IPV4.test(req.netmask) ? req.netmask : '255.255.255.0';
        fills.push(
          { name: 'ExternalIPAddress', type: 'xsd:string', value: req.staticIp },
          { name: 'SubnetMask', type: 'xsd:string', value: mask },
        );
        if (req.gateway && IPV4.test(req.gateway)) fills.push({ name: 'DefaultGateway', type: 'xsd:string', value: req.gateway });
        if (req.dns) fills.push({ name: 'DNSServers', type: 'xsd:string', value: str(req.dns, 64).replace(/\s+/g, '') });
      }
    }
  }
  fills.push({ name: 'Enable', type: 'xsd:boolean', value: 'true' });

  // Parameter vendor — VLAN & ServiceList. Pakai nama yang terbukti ada
  // pada koneksi lain di perangkat ini; kalau belum ada, tebakan keluarga.
  const vendorFills: { name: string; type: XsdType; value: string }[] = [];
  const parentFills: { name: string; type: XsdType; value: string }[] = [];
  const sample = `${wcdObj}1.${connObj}1.`;
  if (v !== null) {
    const connNames = ['X_HW_VLAN', 'X_ZTE-COM_VLANID', 'X_FH_VLANID', 'X_CMCC_VLANIDMark', 'X_CT-COM_VLANIDMark'];
    const linkNames = ['X_CT-COM_WANGponLinkConfig', 'X_CMCC_WANGponLinkConfig', 'X_CU_WANGponLinkConfig', 'X_ZTE-COM_WANPONLinkConfig'];
    const connHit = connNames.find((n) => existsLike(k, `${sample}${n}`));
    const linkHit = linkNames.find((n) => existsLike(k, `${wcdObj}1.${n}.VLANIDMark`) || existsLike(k, `${wcdObj}1.${n}.VLANID`));
    if (connHit) {
      vendorFills.push({ name: connHit, type: typeFor(k, `${sample}${connHit}`, 'xsd:unsignedInt'), value: String(v) });
      if (connHit === 'X_ZTE-COM_VLANID' && existsLike(k, `${sample}X_ZTE-COM_VLANEnable`)) {
        vendorFills.unshift({ name: 'X_ZTE-COM_VLANEnable', type: 'xsd:boolean', value: 'true' });
      }
    } else if (linkHit) {
      const leaf = existsLike(k, `${wcdObj}1.${linkHit}.VLANIDMark`) ? 'VLANIDMark' : 'VLANID';
      parentFills.push({ name: `${linkHit}.${leaf}`, type: typeFor(k, `${wcdObj}1.${linkHit}.${leaf}`, 'xsd:unsignedInt'), value: String(v) });
      if (existsLike(k, `${wcdObj}1.${linkHit}.Mode`)) parentFills.unshift({ name: `${linkHit}.Mode`, type: 'xsd:unsignedInt', value: '2' });
      if (existsLike(k, `${wcdObj}1.${linkHit}.Enable`)) parentFills.unshift({ name: `${linkHit}.Enable`, type: 'xsd:boolean', value: 'true' });
    } else if (CONN_VLAN[fam]) {
      vendorFills.push({ name: CONN_VLAN[fam]!, type: 'xsd:unsignedInt', value: String(v) });
      rep.guessed.push(`${connObj}N.${CONN_VLAN[fam]}`);
    } else {
      const lv = LINK_VLAN[fam]!;
      parentFills.push(
        { name: `${lv}.Enable`, type: 'xsd:boolean', value: 'true' },
        { name: `${lv}.Mode`, type: 'xsd:unsignedInt', value: '2' },
        { name: `${lv}.VLANIDMark`, type: 'xsd:unsignedInt', value: String(v) },
      );
      rep.guessed.push(`WANConnectionDevice.N.${lv}.VLANIDMark`);
    }
  }
  if (!bridge || req.serviceName) {
    const svc = str(req.serviceName || 'INTERNET', 64);
    const svcHit = Object.values(CONN_SERVICE).find((n) => existsLike(k, `${sample}${n}`));
    const svcName = svcHit ?? CONN_SERVICE[fam];
    if (!svcHit) rep.guessed.push(`${connObj}N.${svcName}`);
    vendorFills.push({ name: svcName, type: 'xsd:string', value: svc });
  }

  const extra = parseExtra(k, req.extra, `${wcdObj}1.${connObj}`, rep);
  vendorFills.push(...extra.rel);

  // Rantai AddObject: WANConnectionDevice baru → koneksi di dalamnya.
  // Pola ini yang dipakai ZTE/Huawei/FiberHome (satu WAN = satu WCD);
  // menambah WANPPPConnection ke WCD.1 milik TR069 sering ditolak/bentrok.
  const key = `cfg_wan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const label = `Buat ${isPppoe ? 'WAN PPPoE' : bridge ? 'WAN Bridge' : 'WAN IP'}${v !== null ? ` VLAN ${v}` : ''}`;
  db.createTask(key, deviceId, 'add_object', {
    objectName: wcdObj,
    label,
    absFills: extra.abs,
    then: { objectName: connObj, fills, vendorFills, parentFills },
  }, WRITE_TTL_MS);
  enqueueAddObject(ctx, deviceId, wcdObj, key);
  rep.queued = 1;
  rep.tasks.push(key);
  rep.plan.push(
    `AddObject ${wcdObj} → AddObject ${connObj} di instans baru`,
    `SetParameterValues standar: ${fills.map((f) => f.name).join(', ')}`,
    ...(vendorFills.length || parentFills.length
      ? [`SetParameterValues vendor (terpisah): ${[...parentFills, ...vendorFills].map((f) => f.name).join(', ')}`]
      : []),
    'Struktur WAN dipetakan ulang otomatis setelah selesai',
  );
}

function applyWanDelete(ctx: CwmpContext, db: Database, deviceId: string, k: Knowledge, req: ConfigRequest, rep: ConfigReport): void {
  if (typeof req.target !== 'string' || !TARGET_RE.test(req.target)) {
    rep.skipped.push('Target koneksi tidak valid'); return;
  }
  const conn = k.wan.find((c) => c.base === req.target);
  if (!conn) { rep.skipped.push('Koneksi tidak ditemukan di perangkat'); return; }
  // Koneksi tunggal di WCD-nya → hapus WCD sekalian (link VLAN ikut bersih).
  const lb = linkBase(conn.base);
  const siblings = lb ? k.wan.filter((c) => c.base.startsWith(lb)).length : 0;
  const obj = lb && siblings <= 1 ? lb : conn.base;
  const key = `cfg_del_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  db.createTask(key, deviceId, 'delete_object', { objectName: obj, label: `Hapus WAN ${conn.name ?? conn.base}` }, WRITE_TTL_MS);
  enqueueDeleteObject(ctx, deviceId, obj, key);
  rep.queued = 1;
  rep.tasks.push(key);
  rep.plan.push(`DeleteObject ${obj}`);
}

export function applyConfig(
  ctx: CwmpContext,
  db: Database,
  deviceId: string,
  req: ConfigRequest,
): ConfigReport {
  const rep: ConfigReport = { queued: 0, writes: [], plan: [], skipped: [], guessed: [], tasks: [] };
  const k = knowledge(ctx, db, deviceId);
  switch (req.type) {
    case 'wifi': applyWifi(ctx, db, deviceId, k, req, rep); break;
    case 'pppoe': applyPppoe(ctx, db, deviceId, k, req, rep); break;
    case 'vlan': applyVlan(ctx, db, deviceId, k, req, rep); break;
    case 'wan-add':
    case 'wan-ip-add': applyWanAdd(ctx, db, deviceId, k, req, rep); break;
    case 'wan-delete': applyWanDelete(ctx, db, deviceId, k, req, rep); break;
    default: rep.skipped.push(`jenis konfigurasi tidak dikenal: ${String(req.type)}`);
  }
  if (rep.guessed.length) {
    rep.plan.push(`Catatan: ${rep.guessed.length} nama parameter vendor berupa tebakan — cek tab Antrean Tugas/Peristiwa bila ditolak perangkat`);
  }
  return rep;
}
