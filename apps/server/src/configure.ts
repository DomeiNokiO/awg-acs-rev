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
import { extractWan, extractWlan, extractWcds, observedConnTypes, isPassphraseValue, type WanConn, type DataModel } from './insight.ts';
import {
  planVlan as vendorVlan, planService as vendorService, planBinding, planStandard, bindingRequired, natDefault,
  chooseConnectionType, detectFamily, planRemoteAccess, type Evidence, type Family, type Fill, type RemoteProtocols,
} from './vendorwan.ts';

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
  | 'wan-delete'  // hapus koneksi WAN
  | 'wan-enable'  // aktif/nonaktifkan koneksi WAN
  | 'wan-bind'    // binding port LAN/SSID ke koneksi WAN yang ada
  | 'inform-interval' // interval Inform periodik ONU
  | 'remote-mgmt'; // remote management (akses manajemen ONU dari WAN)

export const CONFIG_TYPES: ConfigType[] = [
  'wifi', 'pppoe', 'vlan', 'wan-add', 'wan-ip-add', 'wan-delete', 'wan-enable', 'wan-bind', 'inform-interval', 'remote-mgmt',
];

/**
 * Lokasi WAN baru:
 *  - `new`      : WANConnectionDevice baru → koneksi di dalamnya (pola umum);
 *  - `wcd`      : koneksi baru di dalam WCD yang SUDAH ada (`wcd` = nomornya,
 *                 mis. WCD kosong yang dibuat OLT lewat OMCI);
 *  - `existing` : isi/timpa koneksi yang sudah ada (`target`), mis.
 *                 "WCD 2 · #1 · PPPoE_Routed" yang disiapkan OLT FiberHome.
 */
export type WanPlacement = 'new' | 'wcd' | 'existing';

export interface ConfigRequest {
  type: ConfigType;
  // wifi
  wlanIndex?: number;
  ssid?: string;
  passphrase?: string;
  wifiEnable?: boolean;
  /** true = sembunyikan SSID (siaran mati), false = tampilkan. WiFi tetap aktif. */
  hidden?: boolean;
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
  placement?: WanPlacement;
  wcd?: number;
  /** Nilai ConnectionType eksplisit (mis. "PPPoE_Routed"); kosong = otomatis. */
  connectionType?: string;
  /** Kirim satu parameter per SetParameterValues (ONU yang tidak konsisten). */
  sequential?: boolean;
  /** Binding port: nomor LAN (1-4) dan SSID (1-4) yang dipakai WAN ini. */
  /** NAT untuk mode route; default: ya untuk INTERNET, tidak untuk TR069/VOIP. */
  nat?: boolean;
  bindLan?: number[];
  bindSsid?: number[];
  // wan-enable
  enable?: boolean;
  // inform-interval (detik)
  informInterval?: number;
  // remote-mgmt: enable (pakai field `enable` di atas), protokol, port WAN
  /** Protokol WAN yang dibuka: subset dari http/https/telnet/ssh/ping. */
  protocols?: string[];
  /** Port web GUI di WAN (opsional). */
  port?: number;
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
  /** Path yang dilaporkan ONU ini sendiri (tabel params). */
  own: Set<string>;
  /** Path yang terbukti ada: params ∪ discovered_params (model ini, ekstensi vendor yang sama). */
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
  const own = new Set(params.map((p) => p.path));
  const known = new Set(own);
  // Struktur hasil discovery dikumpulkan per ProductClass — padahal satu
  // model bisa membawa firmware berbeda (mis. F660 ORI `X_ZTE-COM_*` vs
  // F660 suntikan CMCC `X_CMCC_*`). Path discovery dengan ekstensi vendor
  // yang TIDAK dipakai ONU ini dibuang, supaya bukti firmware lain tidak
  // ikut ditulis (SPV atomik → seluruh batch ditolak 9005).
  const ownTokens = vendorTokens(own);
  for (const d of db.getDiscovered(row?.product_class ?? '')) {
    if (d.path.endsWith('.')) continue;
    if (ownTokens.size && [...vendorTokens([d.path])].some((t) => !ownTokens.has(t))) continue;
    known.add(d.path);
  }
  const model = deviceModel(ctx, deviceId);
  return {
    model,
    own,
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

/** Keluarga vendor: dari bukti path dulu, lalu nama pabrikan/OUI (vendorwan.ts). */
function familyOf(k: Knowledge): Family {
  // Bukti milik ONU ini dulu; data discovery model hanya bila ONU belum
  // melaporkan ekstensi WAN apa pun.
  const ownWan = [...k.own].some((p) => /\.WANConnectionDevice\.\d+\..*\.X_/.test(p));
  return detectFamily(ownWan ? k.own : k.known, k.manufacturer, k.oui);
}

/** Token ekstensi vendor (`X_<token>_…`) yang muncul di path. */
function vendorTokens(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of paths) for (const m of p.matchAll(/\.X_([A-Za-z0-9-]+?)_/g)) out.add(m[1]!);
  return out;
}

/* ------------------------------------------------------------------ *
 * Jembatan ke vendorwan.ts
 * ------------------------------------------------------------------ */

/**
 * Bukti untuk vendorwan.ts. Nama ekstensi vendor sama untuk koneksi PPP
 * dan IP (X_HW_VLAN, X_ZTE-COM_VLANID, …), jadi bukti di WANPPPConnection
 * berlaku juga untuk WANIPConnection baru — dan sebaliknya.
 */
function evidence(k: Knowledge): Evidence {
  const sibling = (p: string): string => p.includes('.WANIPConnection.')
    ? p.replace('.WANIPConnection.', '.WANPPPConnection.')
    : p.replace('.WANPPPConnection.', '.WANIPConnection.');
  const has = (p: string): boolean => existsLike(k, p) && !k.invalid.has(p);
  const vendorLeaf = (p: string): boolean => /\.X_[^.]+(\.[^.]+)?$/.test(p);
  return {
    exists: (p) => has(p) || (vendorLeaf(p) && has(sibling(p))),
    typeFor: (p, fb) => {
      const t = typeFor(k, p, fb);
      return t !== fb ? t : typeFor(k, sibling(p), fb);
    },
    family: familyOf(k),
  };
}

function linkBase(connBase: string): string | null {
  const m = /^(InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+\.)/.exec(connBase);
  return m ? m[1]! : null;
}

const prefixed = (base: string, fills: Fill[]): ParamValue[] =>
  fills.map((f) => ({ name: `${base}${f.name}`, type: f.type, value: f.value }));

/** VLAN untuk koneksi yang sudah ada: path terbaca → bukti → tebakan keluarga. */
function vlanWrites(k: Knowledge, conn: WanConn, v: number, rep: ConfigReport): ParamValue[] {
  if (k.model === 'TR-181') {
    if (!conn.vlanPath) { rep.skipped.push('VLANTermination untuk koneksi ini tidak ditemukan'); return []; }
    return [{ name: conn.vlanPath, type: typeFor(k, conn.vlanPath, 'xsd:unsignedInt'), value: String(v) }];
  }
  const lb = linkBase(conn.base) ?? conn.base;
  const plan = vendorVlan(evidence(k), conn.base, lb, v);
  if (plan.note) rep.skipped.push(plan.note);
  rep.guessed.push(...plan.guessed);
  const out = [...prefixed(conn.base, plan.conn), ...prefixed(lb, plan.link)];
  // Path VLAN yang terbaca tapi tidak tercakup skema mana pun tetap ditulis.
  if (conn.vlanPath && !out.some((p) => p.name === conn.vlanPath)) {
    out.push({ name: conn.vlanPath, type: typeFor(k, conn.vlanPath, 'xsd:unsignedInt'), value: String(v) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Antrean
 * ------------------------------------------------------------------ */

function queueWrite(
  ctx: CwmpContext, db: Database, deviceId: string, rep: ConfigReport,
  params: ParamValue[], label: string, prefix: string, rediscover = false,
): void {
  if (!params.length) return;
  const key = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  // id task = ParameterKey yang ikut dikirim ke perangkat, sehingga
  // SetParameterValuesResponse/Fault bisa langsung menutup task ini.
  db.createTask(key, deviceId, 'write', { params, label, rediscover }, WRITE_TTL_MS);
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
  if (typeof req.hidden === 'boolean') {
    // Standar: SSIDAdvertisementEnabled (TR-098 di WLANConfiguration, TR-181
    // di AccessPoint) — kebalikan dari "hidden". Vendor X_*_SSIDHide (bila
    // hanya itu yang dilaporkan ONU) bernilai true = tersembunyi. Ditulis
    // setelah Enable di SPV yang sama → WiFi bisa aktif tapi tersembunyi.
    const stdPath = is181 ? (w?.apBase ? `${w.apBase}SSIDAdvertisementEnabled` : null) : `${base}SSIDAdvertisementEnabled`;
    const hp = w?.hiddenPath ?? stdPath;
    if (!hp) {
      rep.skipped.push('AccessPoint untuk SSID ini belum diketahui — jalankan "Pelajari struktur" dulu');
    } else {
      const v = /SSIDAdvertisementEnabled$/.test(hp) ? !req.hidden : req.hidden;
      if (!w?.hiddenPath && !existsLike(k, hp)) rep.guessed.push(hp);
      std.push({ name: hp, type: typeFor(k, hp, 'xsd:boolean'), value: v ? 'true' : 'false' });
    }
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
      // Leaf vendor (X_*Password/_PSK…) hanya ditulis bila isinya memang
      // sandi — namanya bisa mirip leaf mode/flag.
      const vals = new Map(db.getParams(deviceId, base).map((p) => [p.path, p.value]));
      let paths = [...new Set([...(w?.passphrasePaths ?? []).filter((p) => !/PreSharedKey\.1\.PreSharedKey$/.test(p)
        && (!/\.X_[^.]+$/.test(p) || isPassphraseValue(vals.get(p)))),
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
  if (v !== null) queueWrite(ctx, db, deviceId, rep, vlanWrites(k, conn, v, rep), `VLAN ${v}`, 'cfg_vlan');
  if (req.serviceName && k.model !== 'TR-181') {
    const sv = conn.serviceListPath
      ? { fill: { name: conn.serviceListPath.slice(conn.base.length), type: 'xsd:string' as XsdType, value: '' }, guessed: false }
      : vendorService(evidence(k), conn.base, '');
    if (sv.fill) {
      if (sv.guessed) rep.guessed.push(sv.fill.name);
      queueWrite(ctx, db, deviceId, rep,
        [{ name: `${conn.base}${sv.fill.name}`, type: 'xsd:string', value: str(req.serviceName, 64) }],
        'Service list', 'cfg_svc');
    }
  }
  if (!rep.queued) rep.skipped.push('tidak ada perubahan PPPoE yang valid');
}

function applyVlan(ctx: CwmpContext, db: Database, deviceId: string, k: Knowledge, req: ConfigRequest, rep: ConfigReport): void {
  const v = vlan(req.vlanId);
  if (v === null) { rep.skipped.push('VLAN harus 1..4094'); return; }
  const conn = resolveConn(k, req.target);
  if (!conn) { rep.skipped.push('Tidak ada koneksi WAN terdeteksi'); return; }
  queueWrite(ctx, db, deviceId, rep, vlanWrites(k, conn, v, rep), `VLAN ${v} ${conn.name ?? conn.base}`, 'cfg_vlan');
}

function ports(v: unknown, max: number): number[] {
  return Array.isArray(v)
    ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= max))].sort()
    : [];
}

/**
 * Buat atau isi WAN internet (PPPoE / IPoE) di lokasi pilihan operator.
 *
 * Urutan tulisan mengikuti pola yang terbukti stabil di lapangan
 * (forum GenieACS 7385): parameter standar → parameter vendor (satu per
 * SPV, supaya tebakan yang salah tidak menggagalkan yang lain) → Enable
 * terakhir. Mode `sequential` memecah parameter standar juga satu per SPV.
 */
function applyWanAdd(ctx: CwmpContext, db: Database, deviceId: string, k: Knowledge, req: ConfigRequest, rep: ConfigReport): void {
  const placement: WanPlacement = req.placement === 'wcd' || req.placement === 'existing' ? req.placement : 'new';
  const existing = placement === 'existing' ? k.wan.find((c) => c.base === req.target) ?? null : null;
  if (placement === 'existing' && !existing) { rep.skipped.push('Koneksi tujuan tidak ditemukan di perangkat'); return; }
  const kind: 'ppp' | 'ip' = existing ? existing.kind : req.type === 'wan-add' ? 'ppp' : 'ip';

  if (k.model === 'TR-181') {
    if (existing && kind === 'ppp') { applyPppoe(ctx, db, deviceId, k, { ...req, target: existing.base }, rep); return; }
    rep.skipped.push('Buat WAN baru belum didukung untuk perangkat TR-181 (butuh PPP.Interface + IP.Interface + VLANTermination). Pilih koneksi yang ada, atau gunakan tab Perintah → AddObject.');
    return;
  }
  const v = vlan(req.vlanId);
  if (req.vlanId !== undefined && req.vlanId !== '' && v === null) { rep.skipped.push('VLAN harus 1..4094'); return; }
  const bridge = req.bridge === true;
  if (kind === 'ppp' && !existing && (!req.username || !req.password)) { rep.skipped.push('Username dan password PPPoE wajib diisi'); return; }
  if (kind === 'ppp' && existing && !existing.username && (!req.username || !req.password)) {
    rep.skipped.push('Slot PPPoE ini masih kosong — username dan password wajib diisi'); return;
  }
  if (kind === 'ip' && req.staticIp && !IPV4.test(req.staticIp)) { rep.skipped.push('IP statis tidak valid'); return; }

  const wd = /^InternetGatewayDevice\.WANDevice\.(\d+)\./.exec(k.wan[0]?.base ?? '')?.[1] ?? '1';
  const wcdObj = `InternetGatewayDevice.WANDevice.${wd}.WANConnectionDevice.`;
  const connObj = kind === 'ppp' ? 'WANPPPConnection.' : 'WANIPConnection.';
  let wcdBase: string;
  if (existing) wcdBase = linkBase(existing.base)!;
  else if (placement === 'wcd') {
    const n = Number(req.wcd);
    const known = extractWcds(db.getParams(deviceId)).find((w) => w.index === n);
    if (!known) { rep.skipped.push(`WANConnectionDevice ${String(req.wcd)} tidak ditemukan di perangkat`); return; }
    wcdBase = known.base;
  } else wcdBase = `${wcdObj}1.`; // contoh bentuk untuk pencocokan bukti
  const connBase = existing ? existing.base : `${wcdBase}${connObj}1.`;

  const e = evidence(k);
  const observed = observedConnTypes(k.wan)[kind];
  // Slot yang sudah ada: ConnectionType dipertahankan kecuali operator
  // memilihnya, mengubah mode route/bridge, atau slot belum dikonfigurasi.
  let connectionType: string | null = chooseConnectionType(kind, bridge, observed, req.connectionType);
  if (existing && !req.connectionType && existing.connectionType && existing.connectionType !== 'Unconfigured'
    && /Bridged/i.test(existing.connectionType) === bridge) connectionType = null;

  const service = str(req.serviceName || existing?.serviceList || 'INTERNET', 64);
  const nat = typeof req.nat === 'boolean' ? req.nat : natDefault(service);
  const std = planStandard(e, connBase, {
    kind, connectionType, bridge, nat,
    name: req.name ? str(req.name, 32) : existing ? undefined : (kind === 'ppp' ? 'INTERNET' : 'WAN_IP'),
    username: req.username !== undefined ? str(req.username, 128) : undefined,
    password: req.password !== undefined ? str(req.password, 128) : undefined,
    staticIp: req.staticIp,
    netmask: req.netmask && IPV4.test(req.netmask) ? req.netmask : undefined,
    gateway: req.gateway && IPV4.test(req.gateway) ? req.gateway : undefined,
    dns: req.dns ? str(req.dns, 64).replace(/\s+/g, '') : undefined,
  });

  const connVendor: Fill[] = [];
  const linkVendor: Fill[] = [];
  if (v !== null) {
    const pv = vendorVlan(e, connBase, wcdBase, v);
    if (pv.note) rep.skipped.push(pv.note);
    rep.guessed.push(...pv.guessed);
    connVendor.push(...pv.conn);
    linkVendor.push(...pv.link);
  }
  if (!bridge || req.serviceName) {
    const sv = vendorService(e, connBase, service);
    if (sv.fill) { connVendor.push(sv.fill); if (sv.guessed) rep.guessed.push(sv.fill.name); }
  }
  // Binding: pilihan operator; bila tidak ada pilihan dan vendor wajib
  // binding (FiberHome), WAN internet di-binding ke semua LAN + SSID —
  // tanpa itu klien tidak dapat internet walau PPPoE Connected.
  const caps = wanCapabilities(ctx, db, deviceId, k);
  let bindLan = ports(req.bindLan, 8);
  let bindSsid = ports(req.bindSsid, 8);
  const chosen = Array.isArray(req.bindLan) || Array.isArray(req.bindSsid);
  const hasBinding = !!existing?.binding && (existing.binding.lan.length + existing.binding.ssid.length) > 0;
  if (!chosen && caps.bindingRequired && !hasBinding && /INTERNET/i.test(service)) {
    bindLan = caps.lanPorts; bindSsid = caps.ssids.map((s) => s.index);
    rep.plan.push(`Binding otomatis (${caps.family} wajib binding): LAN ${bindLan.join(',')} · SSID ${bindSsid.join(',')}`);
  }
  const bind = planBinding(e, connBase, bindLan, bindSsid);
  if (bind.note) rep.skipped.push(bind.note);
  if (bind.guessed && bind.fills.length) rep.guessed.push(bind.fills[0]!.name.replace(/\d+Enable$/, 'NEnable'));
  connVendor.push(...bind.fills);
  const extra = parseExtra(k, req.extra, `${wcdBase}${connObj}`, rep);
  connVendor.push(...extra.rel);

  const fam = familyOf(k);
  const sequential = req.sequential ?? fam === 'cmcc';
  const enableFill: Fill = { name: 'Enable', type: 'xsd:boolean', value: 'true' };
  const what = kind === 'ppp' ? (bridge ? 'WAN PPPoE bridge' : 'WAN PPPoE') : (bridge ? 'WAN IPoE bridge' : 'WAN IPoE');
  const label = `${existing ? 'Isi' : 'Buat'} ${what}${v !== null ? ` VLAN ${v}` : ''}`;

  if (existing) {
    // Isi slot yang ada: nonaktifkan dulu bila aktif, tulis, aktifkan lagi.
    const base = existing.base;
    if (/^(1|true)$/i.test(existing.enable ?? '')) {
      queueWrite(ctx, db, deviceId, rep, [{ name: `${base}Enable`, type: 'xsd:boolean', value: 'false' }], `${label}: nonaktifkan sementara`, 'cfg_wan');
    }
    const stdP = prefixed(base, std);
    if (sequential) stdP.forEach((p) => queueWrite(ctx, db, deviceId, rep, [p], `${label}: ${p.name.split('.').pop()}`, 'cfg_wan'));
    else queueWrite(ctx, db, deviceId, rep, stdP, `${label}: parameter standar`, 'cfg_wan');
    for (const p of [...prefixed(base, connVendor), ...prefixed(wcdBase, linkVendor), ...prefixed('', extra.abs)]) {
      queueWrite(ctx, db, deviceId, rep, [p], `${label}: ${p.name.split('.').slice(-2).join('.')}`, 'cfg_wan');
    }
    queueWrite(ctx, db, deviceId, rep, prefixed(base, [enableFill]), `${label}: aktifkan`, 'cfg_wan', true);
    rep.plan.unshift(`Lokasi: koneksi yang ada ${base} (WCD ${existing.wcd ?? '?'} · #${existing.instance}${existing.connectionType ? ` · ${existing.connectionType}` : ''})`);
    return;
  }

  const key = `cfg_wan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const common = { fills: std, vendorFills: connVendor, finalFills: [enableFill], sequential, label };
  if (placement === 'wcd') {
    // Koneksi baru di dalam WCD yang sudah ada; VLAN level link ditulis ke WCD itu.
    const objectName = `${wcdBase}${connObj}`;
    db.createTask(key, deviceId, 'add_object', {
      objectName, ...common, absFills: [...extra.abs, ...prefixed(wcdBase, linkVendor)],
    }, WRITE_TTL_MS);
    enqueueAddObject(ctx, deviceId, objectName, key);
    rep.plan.push(`Lokasi: WANConnectionDevice ${wcdBase.match(/\.(\d+)\.$/)?.[1]} yang ada → AddObject ${connObj}`);
  } else {
    // WCD baru → koneksi di dalamnya (satu WAN = satu WCD: pola ZTE/Huawei/FiberHome).
    db.createTask(key, deviceId, 'add_object', {
      objectName: wcdObj, label, absFills: extra.abs,
      then: { objectName: connObj, ...common, parentFills: linkVendor },
    }, WRITE_TTL_MS);
    enqueueAddObject(ctx, deviceId, wcdObj, key);
    rep.plan.push(`Lokasi: WANConnectionDevice baru → AddObject ${wcdObj} lalu ${connObj}`);
  }
  rep.queued = 1;
  rep.tasks.push(key);
  rep.plan.push(
    `ConnectionType: ${connectionType}`,
    `SetParameterValues standar${sequential ? ' (bertahap)' : ''}: ${std.map((f) => f.name).join(', ')}`,
    ...(connVendor.length || linkVendor.length
      ? [`SetParameterValues vendor (satu per SPV): ${[...linkVendor, ...connVendor].map((f) => f.name).join(', ')}`]
      : []),
    'Enable=true terakhir, lalu struktur WAN dipetakan ulang otomatis',
  );
}

function applyWanBind(ctx: CwmpContext, db: Database, deviceId: string, k: Knowledge, req: ConfigRequest, rep: ConfigReport): void {
  const conn = typeof req.target === 'string' ? k.wan.find((c) => c.base === req.target) : undefined;
  if (!conn) { rep.skipped.push('Koneksi tidak ditemukan di perangkat'); return; }
  const lan = ports(req.bindLan, 8);
  const ssid = ports(req.bindSsid, 8);
  const bind = planBinding(evidence(k), conn.base, lan, ssid);
  if (bind.note) { rep.skipped.push(bind.note); return; }
  if (!bind.fills.length) {
    // Kosongkan binding (daftar objek "") — hanya untuk vendor berbasis daftar.
    if (conn.bindingPath && /LanInterface$/.test(conn.bindingPath)) {
      queueWrite(ctx, db, deviceId, rep, [{ name: conn.bindingPath, type: 'xsd:string', value: '' }], `Lepas binding ${conn.name ?? conn.base}`, 'cfg_bind');
    } else rep.skipped.push('Pilih minimal satu port LAN/SSID');
    return;
  }
  if (bind.guessed) rep.guessed.push(bind.fills[0]!.name.replace(/\d+Enable$/, 'NEnable'));
  queueWrite(ctx, db, deviceId, rep, prefixed(conn.base, bind.fills),
    `Binding ${conn.name ?? conn.base}: LAN ${lan.join(',') || '-'} · SSID ${ssid.join(',') || '-'}`, 'cfg_bind');
}

/** Kemampuan WAN perangkat untuk UI: keluarga, binding wajib, port LAN, SSID. */
export interface WanCapabilities {
  family: Family;
  bindingRequired: boolean;
  /** Nama parameter binding yang dipakai (mis. X_FH_LanInterface, X_HW_LANBIND). */
  bindingParam: string | null;
  lanPorts: number[];
  ssids: { index: number; band: string | null; ssid: string | null }[];
}

export function wanCapabilities(ctx: CwmpContext, db: Database, deviceId: string, kIn?: Knowledge): WanCapabilities {
  const k = kIn ?? knowledge(ctx, db, deviceId);
  const family = familyOf(k);
  const nLan = Number(k.values.get('InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceNumberOfEntries'));
  const lanPorts = Array.from({ length: Number.isInteger(nLan) && nLan >= 1 && nLan <= 8 ? nLan : 4 }, (_, i) => i + 1);
  const wl = extractWlan(db.getParams(deviceId), k.model).filter((w) => w.index <= 8);
  const ssids = wl.length
    ? wl.map((w) => ({ index: w.index, band: w.band, ssid: w.ssid }))
    : [1, 2, 3, 4].map((index) => ({ index, band: null, ssid: null }));
  const sample = k.wan.find((c) => c.bindingPath)?.bindingPath ?? null;
  const bindingParam = sample ? (sample.endsWith('X_HW_LANBIND.') ? 'X_HW_LANBIND' : sample.split('.').pop()!)
    : family === 'huawei' ? 'X_HW_LANBIND' : ({ zte: 'X_ZTE-COM_LanInterface', fiberhome: 'X_FH_LanInterface', cmcc: 'X_CMCC_LanInterface', ct: 'X_CT-COM_LanInterface', cu: 'X_CU_LanInterface', nokia: null } as Record<string, string | null>)[family] ?? null;
  return { family, bindingRequired: bindingRequired(family), bindingParam, lanPorts, ssids };
}

function applyWanEnable(ctx: CwmpContext, db: Database, deviceId: string, k: Knowledge, req: ConfigRequest, rep: ConfigReport): void {
  const conn = typeof req.target === 'string' ? k.wan.find((c) => c.base === req.target) : undefined;
  if (!conn) { rep.skipped.push('Koneksi tidak ditemukan di perangkat'); return; }
  if (typeof req.enable !== 'boolean') { rep.skipped.push('Nilai enable wajib true/false'); return; }
  queueWrite(ctx, db, deviceId, rep, [{ name: `${conn.base}Enable`, type: 'xsd:boolean', value: String(req.enable) }],
    `${req.enable ? 'Aktifkan' : 'Nonaktifkan'} WAN ${conn.name ?? conn.base}`, 'cfg_wanen', true);
}

function applyInformInterval(ctx: CwmpContext, db: Database, deviceId: string, k: Knowledge, req: ConfigRequest, rep: ConfigReport): void {
  const n = Number(req.informInterval);
  if (!Number.isInteger(n) || n < 60 || n > 86400) { rep.skipped.push('Interval Inform harus 60..86400 detik'); return; }
  const root = k.model === 'TR-181' ? 'Device.' : 'InternetGatewayDevice.';
  queueWrite(ctx, db, deviceId, rep, [
    { name: `${root}ManagementServer.PeriodicInformEnable`, type: 'xsd:boolean', value: 'true' },
    { name: `${root}ManagementServer.PeriodicInformInterval`, type: typeFor(k, `${root}ManagementServer.PeriodicInformInterval`, 'xsd:unsignedInt'), value: String(n) },
  ], `Interval Inform ${n} detik`, 'cfg_inform');
}

/**
 * Remote management: buka/tutup akses manajemen ONU dari sisi WAN untuk
 * SEMUA vendor. Jalur universal = standar TR-069 `UserInterface.RemoteAccess`;
 * Huawei ditambah ACL per protokol (`X_HW_Security.AclServices`). Path yang
 * terbukti ada diantre sekaligus (pasti berlaku); path tebakan diantre satu
 * per SPV supaya nama yang salah tidak menggagalkan yang lain.
 */
function applyRemoteMgmt(ctx: CwmpContext, db: Database, deviceId: string, k: Knowledge, req: ConfigRequest, rep: ConfigReport): void {
  if (typeof req.enable !== 'boolean') { rep.skipped.push('Nilai enable wajib true/false'); return; }
  const sel = new Set((Array.isArray(req.protocols) ? req.protocols : []).map((p) => String(p).toLowerCase()));
  // Saat mengaktifkan tanpa memilih protokol, buka web GUI (HTTP+HTTPS) —
  // kebutuhan teknisi paling umum. Saat menonaktifkan, protokol tak dipakai.
  const protocols: RemoteProtocols = req.enable && sel.size === 0
    ? { http: true, https: true, telnet: false, ssh: false, ping: false }
    : { http: sel.has('http'), https: sel.has('https'), telnet: sel.has('telnet'), ssh: sel.has('ssh'), ping: sel.has('ping') };
  const port = Number.isInteger(Number(req.port)) && Number(req.port) >= 1 && Number(req.port) <= 65535 ? Number(req.port) : undefined;
  if (req.port !== undefined && req.port !== null && String(req.port) !== '' && port === undefined) {
    rep.skipped.push('Port harus 1..65535'); return;
  }

  const root = k.model === 'TR-181' ? 'Device.' : 'InternetGatewayDevice.';
  const plan = planRemoteAccess(evidence(k), root, { enable: req.enable, protocols, port });
  rep.guessed.push(...plan.guessed);

  const label = req.enable ? 'Remote management: aktifkan' : 'Remote management: nonaktifkan';
  const proven = plan.fills.filter((f) => f.proven).map(({ name, type, value }) => ({ name, type, value }));
  if (proven.length) queueWrite(ctx, db, deviceId, rep, proven, `${label} (terbukti)`, 'cfg_remote');
  // Belum terbukti: satu per SPV — 9005 pada satu nama tidak membatalkan sisanya.
  for (const f of plan.fills.filter((f) => !f.proven)) {
    queueWrite(ctx, db, deviceId, rep, [{ name: f.name, type: f.type, value: f.value }], `${label}: ${f.name.split('.').slice(-2).join('.')}`, 'cfg_remote');
  }
  // ZTE tanpa instance ServiceControl: buat objek dulu, lalu isi + Enable.
  if (plan.addObject) {
    const a = plan.addObject;
    const key = `cfg_remote_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    db.createTask(key, deviceId, 'add_object', { objectName: a.objectName, fills: a.fills, finalFills: a.finalFills, label: a.label }, WRITE_TTL_MS);
    enqueueAddObject(ctx, deviceId, a.objectName, key);
    rep.queued++;
    rep.tasks.push(key);
    rep.plan.push(`${a.label}: AddObject ${a.objectName} → isi ServiceType/Ingress, lalu Enable=true`);
  }
  // Catatan informatif saat ada yang diantre; jadi alasan gagal bila tidak.
  if (plan.note) (rep.queued ? rep.plan : rep.skipped).push(plan.note);
  if (!rep.queued && !plan.note) rep.skipped.push('Tidak ada parameter remote management yang bisa ditulis');
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
    case 'wan-enable': applyWanEnable(ctx, db, deviceId, k, req, rep); break;
    case 'wan-bind': applyWanBind(ctx, db, deviceId, k, req, rep); break;
    case 'inform-interval': applyInformInterval(ctx, db, deviceId, k, req, rep); break;
    case 'remote-mgmt': applyRemoteMgmt(ctx, db, deviceId, k, req, rep); break;
    default: rep.skipped.push(`jenis konfigurasi tidak dikenal: ${String(req.type)}`);
  }
  if (rep.guessed.length) {
    rep.plan.push(`Catatan: ${rep.guessed.length} nama parameter vendor berupa tebakan — cek tab Antrean Tugas/Peristiwa bila ditolak perangkat`);
  }
  return rep;
}
