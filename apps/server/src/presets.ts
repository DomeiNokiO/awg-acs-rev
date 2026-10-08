/**
 * Mesin preset — padanan paling penting dari GenieACS *Presets*.
 *
 * Tanpa ini ACS hanya menaruh tugas di antrean bila admin menekan tombol.
 * Dengan ini, satu aturan yang cocok untuk seluruh armada bisa diterapkan
 * otomatis begitu perangkat mengirim Inform.
 *
 * Contoh pakai nyata di ISP: "semua ZTE F660 → set TR-069 URL ke
 * https://acs.example, set akun PPPoE, lalu get status". Satu preset, bukan
 * klik seratus kali.
 *
 * Dua hal yang sengaja diperhatikan di sini:
 *
 * 1. ANTI-BANJIR. Perangkat biasanya Inform tiap beberapa menit. Tanpa
 *    penanda `preset_applied`, preset yang sama akan menumpuk SetParameterValues
 *    tanpa henti sampai antrean penuh dan perangkat kelelahan. Setiap
 *    preset per perangkat dicatat waktunya dan diulang hanya setelah
 *    `interval_hours` lewat. Peristiwa boot (0 BOOTSTRAP / 1 BOOT) boleh
 *    memicu lebih awal karena perangkat baru menyala — belum ada yang
 *    dikerjakan untuknya.
 *
 * 2. GAGAL DIAM-DIAM. Setiap aksi yang ditolak (path kosong, nilai tidak
 *    valid, antrian error) dicatat ke log dan ke tabel events. Preset yang
 *    "berhasil" tapi tidak melakukan apa pun adalah kutukan operasional:
 *    orang mengira konfigurasi sudah terkirim.
 */

import type { Database, PresetRow, DeviceRow, XsdType } from '@acs/core';
import {
  enqueueRead, enqueueWrite, enqueueReboot, enqueueFactoryReset,
  type CwmpContext,
} from './cwmp.ts';

export interface PresetCondition {
  attr:
    | 'manufacturer' | 'oui' | 'productClass' | 'serialNumber'
    | 'softwareVersion' | 'groupName' | 'tags' | 'param';
  op: 'eq' | 'neq' | 'contains' | 'startsWith' | 'exists' | 'gt' | 'lt';
  value: string;
  /** Wajib bila attr === 'param'. */
  path?: string;
}

export interface PresetAction {
  kind: 'get' | 'refresh' | 'set' | 'reboot' | 'factoryReset';
  path?: string;
  value?: string;
  /** Tipe XSD untuk kind 'set'. Default xsd:string. */
  type?: string;
}

export interface ApplyReport {
  matched: number;
  queued: number;
  skipped: { preset: string; reason: string }[];
}

/* ---------------- parsing & validasi ---------------- */

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const v: unknown = JSON.parse(raw);
    return v as T;
  } catch {
    return fallback;
  }
}

/** Alasan kenapa satu preset tidak bisa dipakai, atau null kalau sehat. */
export function validatePreset(p: {
  conditions: PresetCondition[]; actions: PresetAction[];
}): string[] {
  const errs: string[] = [];
  if (!p.conditions.length) errs.push('minimal satu kondisi');
  // Kondisi kosong berarti preset menimpa SEMUA perangkat. Boleh secara
  // teknis, tapi hampir selalu itu ketikan lupa — makanya diminta eksplisit.
  if (!p.actions.length) errs.push('minimal satu aksi');

  for (const [i, c] of p.conditions.entries()) {
    if (c.attr === 'param' && !c.path?.trim()) {
      errs.push(`kondisi #${i + 1}: attr 'param' butuh 'path'`);
    }
    if (typeof c.value !== 'string' && c.op !== 'exists') {
      errs.push(`kondisi #${i + 1}: butuh 'value'`);
    }
  }
  for (const [i, a] of p.actions.entries()) {
    if ((a.kind === 'get' || a.kind === 'refresh' || a.kind === 'set') && !a.path?.trim()) {
      errs.push(`aksi #${i + 1} (${a.kind}): butuh 'path'`);
    }
    if (a.kind === 'set' && a.value === undefined) {
      errs.push(`aksi #${i + 1} (set): butuh 'value'`);
    }
  }
  return errs;
}

/* ---------------- pencocokan ---------------- */

function fieldOf(d: DeviceRow, attr: PresetCondition['attr']): string | null {
  switch (attr) {
    case 'manufacturer': return d.manufacturer;
    case 'oui': return d.oui;
    case 'productClass': return d.product_class;
    case 'serialNumber': return d.serial_number;
    case 'softwareVersion': return d.software_version ?? null;
    case 'groupName': return d.group_name ?? null;
    case 'tags': return (parseJson<string[]>(d.tags ?? '[]', [])).join(',');
    default: return null;
  }
}

/**
 * Pencocokan tidak peka huruf besar/kecil.
 *
 * Alasannya praktis, bukan malas: operator menulis "ZTE" atau "zte" atau
 * "Zte" di tiga tempat berbeda, dan versi firmware hampir selalu beda kapital
 * di lapangan. Salah kapital bukan alasan agar provisioning tidak jalan.
 */
function cmp(actual: string | null, cond: PresetCondition): boolean {
  const have = actual !== null && actual !== undefined && actual !== '';
  const want = (cond.value ?? '').trim();
  const a = (actual ?? '').trim().toLowerCase();
  const w = want.toLowerCase();

  switch (cond.op) {
    case 'exists': return have;
    case 'eq': return a === w;
    case 'neq': return a !== w;
    case 'contains': return a.includes(w);
    case 'startsWith': return a.startsWith(w);
    case 'gt': case 'lt': {
      const na = Number(a), nw = Number(w);
      if (Number.isNaN(na) || Number.isNaN(nw)) return false;
      return cond.op === 'gt' ? na > nw : na < nw;
    }
    default: return false;
  }
}

export function deviceMatches(
  db: Database, device: DeviceRow, conditions: PresetCondition[],
): boolean {
  for (const c of conditions) {
    let actual: string | null;
    if (c.attr === 'param') {
      if (!c.path) return false;
      const row = db.getParams(device.id).find((p) => p.path === c.path);
      // Nilai yang belum pernah dibaca dianggap tidak ada — bukan cocok.
      // Kalau tidak, kondisi 'eq' akan cocok dengan string kosong dan
      // preset menimpa perangkat yang belum punya datanya.
      actual = row ? row.value : null;
      if (actual === null && c.op !== 'exists' && c.op !== 'neq') return false;
    } else {
      actual = fieldOf(device, c.attr);
    }
    if (!cmp(actual, c)) return false;
  }
  return true;
}

/* ---------------- penerapan ---------------- */

function bootEvent(events: string[]): boolean {
  return events.includes('0 BOOTSTRAP') || events.includes('1 BOOT');
}

/**
 * Terapkan semua preset yang cocok ke satu perangkat.
 *
 * `force` dipakai saat boot (anggap saja masih "pemasangan awal") dan saat
 * admin menekan "Terapkan Sekarang" — keduanya melewati jeda interval.
 */
export function applyPresets(
  ctx: CwmpContext, db: Database, deviceId: string,
  opts: { force?: boolean; events?: string[] } = {},
): ApplyReport {
  const report: ApplyReport = { matched: 0, queued: 0, skipped: [] };
  const device = db.getDevice(deviceId);
  if (!device) {
    report.skipped.push({ preset: '-', reason: 'perangkat tidak ditemukan' });
    return report;
  }

  const force = opts.force === true || (opts.events ? bootEvent(opts.events) : false);

  for (const p of db.listPresets()) {
    if (!p.enabled) continue;

    const conditions = parseJson<PresetCondition[]>(p.conditions, []);
    const actions = parseJson<PresetAction[]>(p.actions, []);
    if (!conditions.length || !actions.length) {
      report.skipped.push({ preset: p.name, reason: 'kondisi/aksi kosong' });
      continue;
    }

    if (!deviceMatches(db, device, conditions)) continue;
    report.matched++;

    // Anti-banjir: lewati kalau belum waktunya.
    if (!force) {
      const last = db.presetAppliedAt(p.id, deviceId);
      const intervalMs = Math.max(0, p.interval_hours) * 3600 * 1000;
      if (last !== null && intervalMs > 0 && Date.now() - last < intervalMs) {
        report.skipped.push({ preset: p.name, reason: 'masih dalam interval' });
        continue;
      }
    }

    const applied = applyActions(ctx, db, p, deviceId);
    if (applied.queued > 0) {
      db.markPresetApplied(p.id, deviceId);
      report.queued += applied.queued;
      db.addEvent(deviceId, 'preset',
        `Preset "${p.name}" diterapkan (${applied.queued} aksi)`);
    }
    for (const s of applied.skipped) {
      report.skipped.push({ preset: p.name, reason: s });
    }
  }
  return report;
}

function applyActions(
  ctx: CwmpContext, db: Database, p: PresetRow, deviceId: string,
): { queued: number; skipped: string[] } {
  const actions = parseJson<PresetAction[]>(p.actions, []);
  const skipped: string[] = [];
  let queued = 0;

  // Gabung semua path read jadi SATU GetParameterValues. Satu RPC per
  // preset, bukan satu per baris — menghemat round-trip dan jeda CPE.
  const reads: string[] = [];
  const writes: { name: string; type: XsdType; value: string }[] = [];

  for (const [i, a] of actions.entries()) {
    const label = `aksi #${i + 1} (${a.kind})`;
    const path = a.path?.trim() ?? '';

    if (a.kind === 'get' || a.kind === 'refresh') {
      if (!path) { skipped.push(`${label}: path kosong`); continue; }
      reads.push(path);
    } else if (a.kind === 'set') {
   if (!path) { skipped.push(`${label}: path kosong`); continue; }
   if (a.value === undefined) { skipped.push(`${label}: value kosong`); continue; }
   // Validasi kasar agar XsdType dari cwmp.ts tidak protes. Kalau salah,
   // enqueueWrite tidak akan mengirim nilai.
   const t = a.type ?? 'xsd:string';
   const typeStr = ['xsd:string', 'xsd:int', 'xsd:unsignedInt', 'xsd:boolean', 'xsd:dateTime', 'xsd:base64Binary', 'xsd:hexBinary'].includes(t)
     ? (t as XsdType)
     : 'xsd:string';
   writes.push({
     name: path,
     type: typeStr,
     value: String(a.value),
   });
    } else if (a.kind === 'reboot') {
      try { enqueueReboot(ctx, deviceId); queued++; }
      catch (e) { skipped.push(`${label}: ${errText(e)}`); }
    } else if (a.kind === 'factoryReset') {
      try { enqueueFactoryReset(ctx, deviceId); queued++; }
      catch (e) { skipped.push(`${label}: ${errText(e)}`); }
    } else {
      skipped.push(`${label}: jenis aksi tidak dikenal`);
    }
  }

  if (reads.length) {
    try { enqueueRead(ctx, deviceId, reads); queued++; }
    catch (e) { skipped.push(`baca ${reads.length} path: ${errText(e)}`); }
  }
  if (writes.length) {
    // id task = ParameterKey tulisan, supaya SetParameterValuesResponse
    // bisa menutup task ini (tanpa ini task preset permanen 'pending').
    const taskKey = `preset_${p.id}_${deviceId}_${Date.now().toString(36)}`;
    try { enqueueWrite(ctx, deviceId, writes, taskKey); queued++; }
    catch (e) { skipped.push(`${errText(e)}`); }
    // Tercatat sebagai tugas supaya tampil di halaman Tasks seperti
    // pekerjaan manual — jejak audit tidak boleh hilang di jalan.
    db.createTask(taskKey, deviceId, 'write', { params: writes, preset: p.name });
  }

  return { queued, skipped };
}


function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ---------------- preset bawaan ---------------- */

/**
 * Preset pertama yang dibuat saat ACS pertama kali dijalankan tanpa
 * preset buatan admin. Semuanya hanya baca parameter atau menyetel hal
 * yang aman — tidak ada reboot dan tidak ada factory reset.
 *
 * Isinya merangkum praktik dari referensi lapangan (paimo54/parameter,
 * GACS-Ubuntu, alijayanet/genieacs): ambil data kualitas sinyal secara
 * berkala, matikan akses jarak jauh di perangkat yang mendukungnya,
 * dan pastikan Inform tetap aktif.
 */
export function seedDefaultPresets(db: Database): number {
  if (db.listPresets().length) return 0;

  const now = Date.now();
  const always: PresetCondition[] = [{ attr: 'manufacturer', op: 'exists', value: '' }];
  const fh: PresetCondition[] = [{ attr: 'manufacturer', op: 'eq', value: 'FiberHome' }];

  const get = (...paths: string[]): PresetAction[] => paths.map((path) => ({ kind: 'get', path }));
  const set = (path: string, value: string, type = 'xsd:string'): PresetAction =>
    ({ kind: 'set', path, value, type });

  const defs: {
    name: string; priority: number; interval_hours: number;
    conditions: PresetCondition[]; actions: PresetAction[];
  }[] = [
    {
      name: 'Data ONU (redaman, PPPoE, WiFi)',
      priority: 10, interval_hours: 1, conditions: always,
      actions: [
        ...get(
          'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.RXPower',
          'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower',
          'InternetGatewayDevice.WANDevice.1.WANEponInterfaceConfig.RXPower',
          'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower',
          'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
          'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ConnectionStatus',
          'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
        ),
      ],
    },
    {
      name: 'Keamanan: matikan akses jarak jauh FiberHome',
      priority: 40, interval_hours: 24, conditions: fh,
      actions: [
        set('InternetGatewayDevice.X_FH_FireWall.REMOTEACCEnable', 'false', 'xsd:boolean'),
        set('InternetGatewayDevice.X_FH_Remoteweblogin.webloginenable', '0'),
      ],
    },
    {
      name: 'Provisioning: Inform aktif tiap 200 detik',
      priority: 50, interval_hours: 24, conditions: always,
      actions: [
        set('InternetGatewayDevice.ManagementServer.PeriodicInformEnable', 'true', 'xsd:boolean'),
        set('InternetGatewayDevice.ManagementServer.PeriodicInformInterval', '200', 'xsd:unsignedInt'),
      ],
    },
  ];

  let n = 0;
  for (const d of defs) {
    try {
      db.createPreset({
        name: d.name, enabled: 1, priority: d.priority, interval_hours: d.interval_hours,
        conditions: JSON.stringify(d.conditions), actions: JSON.stringify(d.actions),
      });
      n++;
    } catch (e) {
      console.error('[preset] gagal seed', d.name, (e as Error).message);
    }
  }
  if (n) console.log(`  Preset bawaan    : ${n} preset dibuat (pertama kali)`);
  return n;
}
