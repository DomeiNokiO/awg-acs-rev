/**
 * Endpoint CWMP (port 7547) — pintu masuk perangkat TR-069.
 *
 * Satu CPE = satu sesi HTTP panjang berisi bolak-balik POST. Kita kunci
 * sesinya lewat cookie (seperti GenieACS) supaya dua perangkat di belakang
 * NAT yang IP-nya sama tidak saling mencuri sesi.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CwmpSession, TaskQueue, buildGetParameterValues, buildSetParameterValues,
  buildReboot, buildFactoryReset, buildDownload, buildGetParameterNames,
  buildAddObject, buildDeleteObject,
  type DeviceIdentity, type RpcResult, type Rpc, type ParamValue,
} from '@acs/core';
import type { Database } from '@acs/core';
import { checkCwmpAuth, type CwmpCredential } from './cwmp-auth.ts';
import { discoveryRoots, wanRoots, profileFromNodes, MAX_PROFILE_PATHS } from './profiler.ts';
import { essentialPaths } from './modelpaths.ts';
import { buildInsight, detectDataModel, summaryFields, type DataModel } from './insight.ts';

/** Ukuran maksimum body SOAP — 1 MB. Lebih dari itu kemungkinan bukan CPE. */
const MAX_BODY = 1024 * 1024;

/**
 * Versi format profil koleksi. Perangkat dengan profil versi lebih lama
 * dipetakan ulang otomatis saat Inform berikutnya — profil lama (sebelum
 * perbaikan discovery) tidak memuat redaman/PPPoE di WANConnectionDevice.N.
 */
export const PROFILE_VERSION = 2;

/**
 * Subtree yang tidak ditelusuri pada mode BFS (firmware yang hanya
 * menjawab anak langsung): tabel besar tanpa data operasional.
 */
const SKIP_SUBTREE = /\.(?:PortMapping|Stats|Hosts|AssociatedDevice|WPS|WEPKey|DHCPOption|DHCPStaticAddress|IPv6[^.]*|X_[^.]*(?:Statistics|Stats|Log|Diagnostic)[^.]*)\.$/;

/** GPN yang tidak pernah dijawab sebanyak ini dianggap gagal dan dilewati. */
const MAX_DISCOVERY_TRIES = 3;

interface SessionEntry {
  session: CwmpSession;
  identity: DeviceIdentity | null;
  createdAt: number;
}

export interface CwmpContext {
  db: Database;
  queue: TaskQueue;
  sessions: Map<string, SessionEntry>;
  onInform?: (deviceId: string, info: { identity: DeviceIdentity; events: string[]; ip: string }) => void;
  onResult?: (deviceId: string, result: RpcResult) => void;
  /** Credential CPE→ACS (lihat cwmp-auth.ts). Kosong = terima semua. */
  credentials?: CwmpCredential[];
  /** Dipanggil setelah profil perangkat berhasil dipetakan. */
  onDiscovery?: (deviceId: string, nodes: number, done: boolean) => void;
  /** Dipanggil setelah parameter berhasil dikoleksi. */
  onCollected?: (deviceId: string, params: number) => void;
  /** Interval (menit) pengumpulan ulang; default 30. */
  collectIntervalMin?: number;
}

function deviceIdOf(identity: DeviceIdentity): string {
  return `${identity.oui}-${identity.productClass}-${identity.serialNumber}`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function registerCwmpRoutes(app: FastifyInstance, ctx: CwmpContext): void {
  // Body SOAP dibaca manual: Fastify tidak lagi memakai content-type parser
  // bawaan, dan kita butuh kontrol penuh atas ukuran + charset.
  app.addContentTypeParser(
    ['text/xml', 'application/xml', 'text/xml; charset=utf-8', 'application/soap+xml'],
    { parseAs: 'string', bodyLimit: MAX_BODY },
    (_req, body, done) => done(null, body),
  );

  app.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const cookies = parseCookies(req.headers.cookie);
    let sid = cookies['acs_session'];
    const raw = typeof req.body === 'string' ? req.body : '';

    if (raw.length > MAX_BODY) {
      return reply.code(413).type('text/plain').send('payload too large');
    }

    let entry: SessionEntry | undefined = sid ? ctx.sessions.get(sid) : undefined;

    if (!entry) {
      // Perangkat belum punya sesi (atau cookie-nya hilang). Buat baru —
      // sesi yang belum menerima Inform akan menolak RPC apa pun.
      sid = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
      const session = new CwmpSession({
        dequeue: (device) => {
          const id = deviceIdOf(device);
          const task = ctx.queue.dequeue(id);
          return task ? task.rpc : null;
        },
        record: (device, result) => {
          const id = deviceIdOf(device);
          ctx.onResult?.(id, result);
          try {
            applyResult(ctx, id, result);
          } catch (e) {
            // Kesalahan pemrosesan hasil tidak boleh memutus sesi CWMP.
            ctx.db.addEvent(id, 'collection_error', `Gagal memproses ${result.kind}: ${(e as Error).message}`);
          }
        },
      });
      entry = { session, identity: null, createdAt: Date.now() };
      ctx.sessions.set(sid, entry);
    }
    const outcome = entry.session.handle(raw);

    if (outcome.inform) {
      const id = deviceIdOf(outcome.inform.identity);
      // Autentikasi CPE→ACS (opsional). Prioritas: credential per-perangkat
      // dari DB (diatur di UI), lalu file ACS_CWMP_CREDENTIALS (pola glob).
      const row = ctx.db.getDevice(id);
      const deviceCred = row?.cwmp_user ? { user: row.cwmp_user, pass: row.cwmp_pass ?? '' } : null;
      const auth = checkCwmpAuth(ctx.credentials ?? [], id, req.headers.authorization, deviceCred);
      if (auth.enabled && !auth.authed) {
        // Beri tahu CPE minta Basic (beberapa ONT baru kirim credential
        // setelah menerima 401). Tak dicatat ke DB — hanya log server.
        ctx.sessions.delete(sid!);
        reply.header('WWW-Authenticate', 'Basic realm="ACS CWMP"');
        return reply.code(401).type('text/plain').send('unauthorized');
      }
      entry.identity = outcome.inform.identity;
      registerDevice(ctx, id, outcome.inform.identity, clientIp(req));
      // Nilai Inform (IP WAN, ConnectionRequestURL, versi SW) langsung
      // disimpan: data paling segar tanpa satu RPC pun.
      try {
        applyValues(ctx, id, outcome.inform.parameterValues, {});
      } catch (e) {
        ctx.db.addEvent(id, 'collection_error', `Gagal menyimpan nilai Inform: ${(e as Error).message}`);
      }
      ctx.onInform?.(id, {
        identity: outcome.inform.identity,
        events: outcome.inform.events,
        ip: clientIp(req),
      });
    }

    // Sesi selesai → buang supaya peta memori tidak tumbuh tanpa batas.
    if (outcome.done) {
      ctx.sessions.delete(sid!);
    }

    reply.header('Set-Cookie', `acs_session=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600`);
    reply.header('Content-Type', 'text/xml; charset=utf-8');
    return reply.code(outcome.status).send(outcome.responseXml);
  });

  // Connection Request dikirim ACS ke CPE (GET ke ConnectionRequestURL)
  // dengan HTTP Basic/Digest. Bukan bagian dari route ini, lihat api.ts.
}

function clientIp(req: FastifyRequest): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0]!.trim();
  return req.ip;
}

function registerDevice(ctx: CwmpContext, id: string, identity: DeviceIdentity, ip: string): void {
  ctx.db.upsertDevice({
    id,
    manufacturer: identity.manufacturer,
    oui: identity.oui,
    product_class: identity.productClass,
    serial_number: identity.serialNumber,
  });
  ctx.db.touchInform(id, ip, 'cwmp');
}

/* ------------------------------------------------------------------ *
 * Penyimpanan nilai + ringkasan
 * ------------------------------------------------------------------ */

/** Data model perangkat: kolom tersimpan, atau deteksi dari parameter. */
export function deviceModel(ctx: CwmpContext, deviceId: string): DataModel | null {
  const row = ctx.db.getDevice(deviceId);
  if (row?.data_model === 'TR-098' || row?.data_model === 'TR-181') return row.data_model;
  return detectDataModel(ctx.db.getParams(deviceId).map((p) => p.path));
}

/** Hitung ulang kolom ringkasan (redaman, PPPoE, IP WAN, SSID). */
export function refreshSummary(ctx: CwmpContext, deviceId: string): void {
  const params = ctx.db.getParams(deviceId);
  if (!params.length) return;
  const ins = buildInsight(params);
  ctx.db.setDeviceFields(deviceId, summaryFields(ins));
}

/**
 * Simpan nilai parameter (dari GPV atau Inform) beserta efek sampingnya:
 * versi SW/HW, data model, dan kredensial Connection Request.
 */
function applyValues(
  ctx: CwmpContext, deviceId: string,
  values: Record<string, string>, types: Record<string, string>,
): number {
  const entries = Object.entries(values).map(([path, value]) => ({
    path, value, type: types[path] ?? 'xsd:string',
  }));
  if (!entries.length) return 0;
  ctx.db.setParams(deviceId, entries);

  const fields: Record<string, string> = {};
  const sw = values['InternetGatewayDevice.DeviceInfo.SoftwareVersion'] ?? values['Device.DeviceInfo.SoftwareVersion'];
  const hw = values['InternetGatewayDevice.DeviceInfo.HardwareVersion'] ?? values['Device.DeviceInfo.HardwareVersion'];
  if (sw) fields['software_version'] = sw;
  if (hw) fields['hardware_version'] = hw;
  const dm = detectDataModel(Object.keys(values));
  if (dm) fields['data_model'] = dm;
  if (Object.keys(fields).length) ctx.db.setDeviceFields(deviceId, fields);

  // Kredensial Connection Request yang dilaporkan perangkat melengkapi
  // (bukan menimpa) nilai yang sudah diisi operator di UI.
  const crUrl = values['InternetGatewayDevice.ManagementServer.ConnectionRequestURL']
    ?? values['Device.ManagementServer.ConnectionRequestURL'];
  const crUser = values['InternetGatewayDevice.ManagementServer.ConnectionRequestUsername']
    ?? values['Device.ManagementServer.ConnectionRequestUsername'];
  const existing = ctx.db.getDevice(deviceId);
  const patch: Record<string, string> = {};
  if (crUrl && /^https?:\/\//i.test(crUrl.trim()) && !existing?.connection_request_url) {
    patch['connection_request_url'] = crUrl.trim();
  }
  if (crUser && !existing?.connection_request_user) patch['connection_request_user'] = crUser.trim();
  if (Object.keys(patch).length) ctx.db.setDeviceFields(deviceId, patch);

  refreshSummary(ctx, deviceId);
  return entries.length;
}

function currentProfile(ctx: CwmpContext, deviceId: string): string[] {
  const col = ctx.db.getCollection(deviceId);
  if (!col) return [];
  try {
    const v: unknown = JSON.parse(col.profile);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Path yang dibaca tiap siklus koleksi: esensial ∪ profil discovery. */
export function collectPaths(ctx: CwmpContext, deviceId: string): string[] {
  return [...new Set([...essentialPaths(deviceModel(ctx, deviceId)), ...currentProfile(ctx, deviceId)])];
}

function parsePayload(raw: unknown): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(String(raw ?? '{}'));
    return v && typeof v === 'object' ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

interface Fill { name: string; type?: string; value: string }

function asFills(v: unknown): Fill[] {
  return Array.isArray(v)
    ? (v as Fill[]).filter((f) => f && typeof f.name === 'string' && /^[\w.\-:]{1,512}$/.test(f.name))
    : [];
}

function toParams(prefix: string, fills: Fill[]): ParamValue[] {
  return fills.map((f) => ({
    name: `${prefix}${f.name}`,
    type: (f.type as ParamValue['type']) ?? 'xsd:string',
    value: String(f.value),
  }));
}

/* ------------------------------------------------------------------ *
 * Pemroses hasil RPC
 * ------------------------------------------------------------------ */

/**
 * Terapkan hasil RPC ke penyimpanan. Setiap balasan GetParameterValues
 * diratakan ke baris params supaya UI bisa menampilkan tanpa memanggil
 * perangkat lagi.
 */
function applyResult(ctx: CwmpContext, deviceId: string, result: RpcResult): void {
  switch (result.kind) {
    case 'gpv': {
      // Hanya catatan batch INI yang dihapus; batch lain yang masih
      // menunggu giliran tetap tercatat untuk pelacakan fault.
      if (result.commandKey) ctx.db.dropReadBatch(deviceId, result.commandKey);
      const n = applyValues(ctx, deviceId, result.values, result.types ?? {});
      if (n) {
        ctx.db.markCollected(deviceId, ctx.collectIntervalMin ?? 30, n);
        ctx.onCollected?.(deviceId, n);
      }
      for (const e of result.errors) {
        if (e.code === 9018) continue; // tidak ada di perangkat — wajar
        ctx.db.addEvent(deviceId, 'gpv_error', `${e.name}: ${e.code} ${e.message}`);
      }
      break;
    }
    case 'gpn': {
      const row = ctx.db.getDevice(deviceId);
      ctx.db.recordDiscoveryMany(row?.product_class ?? '', row?.manufacturer ?? '', result.nodes);

      const asked = result.askedPath;
      const names = result.nodes.map((n) => n.name).filter(Boolean);
      // Firmware yang patuh mengembalikan SELURUH subtree untuk
      // NextLevel=false. Sebagian firmware hanya mengembalikan anak
      // langsung — terdeteksi bila tak satu pun nama lebih dalam dari satu
      // tingkat. Untuk mereka, objek anak ditelusuri satu per satu (BFS) dan
      // pembersihan parameter lama TIDAK dilakukan (datanya tidak lengkap).
      const depth = (p: string): number => p.replace(/\.$/, '').split('.').length;
      const complete = !asked || names.some((n) => depth(n) > depth(asked) + 1);
      if (asked) {
        ctx.db.dropDiscoveryPath(deviceId, asked);
        if (!ctx.db.getDiscoveryRoot(deviceId)) ctx.db.setDiscoveryRoot(deviceId, asked);
        if (complete && names.length) {
          // Subtree diketahui lengkap: parameter lama yang tidak dilaporkan
          // lagi (WAN terhapus) ikut dibuang.
          const nameSet = new Set(names);
          ctx.db.pruneParams(deviceId, asked, nameSet);
          // Kandidat esensial (varian redaman vendor lain) di subtree ini
          // yang tidak dilaporkan = pasti tidak ada. Ditandai langsung,
          // tanpa harus dibuktikan lewat puluhan GPV yang di-fault.
          for (const p of essentialPaths(deviceModel(ctx, deviceId))) {
            if (p.startsWith(asked) && !nameSet.has(p)) ctx.db.markInvalidParam(deviceId, p);
          }
        } else if (!complete) {
          const children = names.filter((n) => n.endsWith('.') && n !== asked && !SKIP_SUBTREE.test(n));
          if (children.length) ctx.db.enqueueDiscoveryPaths(deviceId, children);
        }
      }

      // Profil = leaf menarik milik perangkat ini. Subtree yang barusan
      // dipetakan DIGANTI (bukan ditumpuk) supaya instans yang sudah
      // dihapus tidak terus dibaca dan memicu fault.
      const leaves = profileFromNodes(names);
      const prev = currentProfile(ctx, deviceId);
      const kept = asked && complete ? prev.filter((p) => !p.startsWith(asked)) : prev;
      const merged = [...new Set([...kept, ...leaves])].slice(0, MAX_PROFILE_PATHS);
      ctx.db.setCollectionProfile(deviceId, merged, false);
      ctx.db.unmarkInvalidParams(deviceId, leaves);

      // Baca nilai leaf baru di sesi yang sama — operator tidak perlu
      // menunggu siklus koleksi berikutnya untuk melihat PPPoE/redaman.
      const prevSet = new Set(prev);
      const fresh = leaves.filter((l) => !prevSet.has(l));
      if (fresh.length) enqueueRead(ctx, deviceId, fresh);
      if (names.length) refreshSummary(ctx, deviceId);

      continueDiscovery(ctx, deviceId);
      break;
    }
    case 'spv': {
      // parameterKey membawa id task konfigurasi, jadi jawaban ini sekaligus
      // menutup task di UI.
      const key = result.parameterKey;
      const task = key ? ctx.db.getTask(key) : undefined;
      if (result.status !== 0 && result.status !== 1) {
        ctx.db.addEvent(deviceId, 'spv_error', `SetParameterValues status=${result.status}`);
        if (task) ctx.db.updateTask(key!, 'failed', { status: result.status });
        break;
      }
      // Status 1 = diterima, berlaku setelah perangkat menerapkan/reboot.
      if (task) {
        ctx.db.updateTask(key!, 'done', { status: result.status });
        ctx.db.addEvent(deviceId, 'task', `Konfigurasi ${key} diterima perangkat`);
        const payload = parsePayload(task.payload);
        // Baca balik nilai yang ditulis supaya UI langsung menampilkan
        // kondisi terbaru (kecuali sandi — tidak perlu dibaca ulang).
        const params = Array.isArray(payload.params) ? payload.params as { name?: unknown }[] : [];
        const back = params
          .map((p) => (typeof p.name === 'string' ? p.name : ''))
          .filter((n) => n && !/Password|KeyPassphrase|PreSharedKey/i.test(n));
        if (back.length) enqueueRead(ctx, deviceId, back);
        if (payload.rediscover === true) rediscoverWan(ctx, deviceId);
      }
      break;
    }
    case 'fault': {
      ctx.db.addEvent(deviceId, 'fault',
        `${result.code}: ${result.message}` +
        (result.askedPath ? ` (path ${result.askedPath})` : ''));

      // Fault untuk tugas konfigurasi (SPV/AddObject/DeleteObject): tutup
      // task-nya sebagai gagal supaya operator tahu, bukan 'pending' abadi.
      if (result.commandKey && result.method !== 'GetParameterValues') {
        const t = ctx.db.getTask(result.commandKey);
        if (t) ctx.db.updateTask(result.commandKey, 'failed', { code: result.code, message: result.message });
      }

      // Fault 9005 untuk GetParameterValues membatalkan SELURUH batch tanpa
      // menyebut path mana yang ditolak. Batch dipecah dua sampai tersisa
      // satu path — itulah yang ditolak, dicatat supaya tidak dikirim lagi.
      if (result.method === 'GetParameterValues' && result.commandKey) {
        const batch = ctx.db.getReadBatch(deviceId, result.commandKey);
        ctx.db.dropReadBatch(deviceId, result.commandKey);

        if (batch) {
          const { paths, depth } = batch;
          const send = (part: string[], d: number): void => {
            const key = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
            ctx.db.saveReadBatch(deviceId, key, part, d);
            ctx.queue.enqueue(deviceId, buildGetParameterValues(key, part), undefined, READ_TTL_MS);
          };

          if (paths.length === 1) {
            ctx.db.markInvalidParam(deviceId, paths[0]!);
            ctx.db.addEvent(deviceId, 'param_ditolak', `Path tidak didukung perangkat: ${paths[0]}`);
          } else if (depth < SPLIT_DEPTH_CAP) {
            const mid = Math.ceil(paths.length / 2);
            send(paths.slice(0, mid), depth + 1);
            send(paths.slice(mid), depth + 1);
          } else {
            for (const one of paths) send([one], depth);
          }
        }
      }

      // GetParameterNames ditolak: root ini tidak ada di perangkat. Tandai
      // gagal dan lanjut ke root berikutnya.
      if (result.method === 'GetParameterNames' && result.askedPath) {
        ctx.db.markDiscoveryRootFailed(deviceId, result.askedPath);
        ctx.db.dropDiscoveryPath(deviceId, result.askedPath);
        continueDiscovery(ctx, deviceId);
      }
      break;
    }
    case 'transfer_complete':
      ctx.db.addEvent(
        deviceId, 'transfer',
        `Transfer ${result.commandKey}: fault=${result.faultCode} ${result.faultString}`,
      );
      break;
    case 'add_object':
      handleAddObject(ctx, deviceId, result);
      break;
    case 'delete_object': {
      const t = result.commandKey ? ctx.db.getTask(result.commandKey) : undefined;
      if (t) ctx.db.updateTask(result.commandKey!, 'done', { status: result.status });
      ctx.db.addEvent(deviceId, 'task', `DeleteObject selesai (status ${result.status})`);
      // Struktur WAN berubah: petakan ulang agar UI tidak menampilkan
      // koneksi yang sudah dihapus.
      rediscoverWan(ctx, deviceId);
      break;
    }
    case 'reboot':
      ctx.db.addEvent(deviceId, 'reboot', 'Perintah reboot dikirim');
      break;
    case 'factory_reset':
      ctx.db.addEvent(deviceId, 'factory_reset', 'Perintah factory reset dikirim');
      break;
    default:
      break;
  }
}

/**
 * AddObject berhasil → lanjutkan rencana yang tersimpan di payload task.
 *
 * Bentuk payload (lihat configure.ts):
 *   objectName  — objek tempat instans dibuat
 *   fills       — parameter STANDAR relatif ke instans baru (satu SPV)
 *   vendorFills — parameter ekstensi vendor relatif ke instans baru
 *   absFills    — parameter path absolut (mis. VLAN di level link)
 *   then        — AddObject lanjutan di DALAM instans baru (rantai:
 *                 WANConnectionDevice.N → WANPPPConnection.M)
 *
 * Parameter standar dan vendor dikirim dalam SPV TERPISAH: SPV bersifat
 * atomik, jadi satu nama vendor yang salah tebak tidak boleh menggagalkan
 * username/password PPPoE.
 */
function handleAddObject(
  ctx: CwmpContext, deviceId: string,
  result: Extract<RpcResult, { kind: 'add_object' }>,
): void {
  if (!result.commandKey) return;
  const task = ctx.db.getTask(result.commandKey);
  if (result.status !== 0 && result.status !== 1) {
    if (task) ctx.db.updateTask(result.commandKey, 'failed', { status: result.status });
    return;
  }
  const payload = parsePayload(task?.payload);
  const objectName = typeof payload.objectName === 'string' ? payload.objectName : '';
  if (!objectName) {
    ctx.db.addEvent(deviceId, 'task', `AddObject instance ${result.instanceNumber} dibuat tanpa rencana isi parameter`);
    if (task) ctx.db.updateTask(result.commandKey, 'done', `instance ${result.instanceNumber}`);
    return;
  }
  const base = objectName.endsWith('.') ? objectName : `${objectName}.`;
  const inst = `${base}${result.instanceNumber}.`;
  const label = typeof payload.label === 'string' ? payload.label : 'Tambah objek';
  if (task) ctx.db.updateTask(result.commandKey, 'done', `instance ${result.instanceNumber}`);
  ctx.db.addEvent(deviceId, 'task', `AddObject ${base} -> instance ${result.instanceNumber}`);

  const then = payload.then && typeof payload.then === 'object'
    ? payload.then as Record<string, unknown> : null;
  if (then && typeof then.objectName === 'string') {
    // Rantai: buat objek anak di dalam instans yang baru dibuat. absFills
    // (VLAN level link) dihitung sekarang karena baru sekarang nomor
    // instans induknya diketahui.
    const child = `${inst}${then.objectName}`;
    const key = `cfg_wan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const linkFills = asFills(then.parentFills).map((f) => ({ ...f, name: `${inst}${f.name}` }));
    ctx.db.createTask(key, deviceId, 'add_object', {
      objectName: child,
      fills: asFills(then.fills),
      vendorFills: asFills(then.vendorFills),
      absFills: [...asFills(payload.absFills), ...linkFills],
      label,
    }, WRITE_TTL_MS);
    enqueueAddObject(ctx, deviceId, child, key);
    return;
  }

  const core = toParams(inst, asFills(payload.fills));
  const vendor = [...toParams(inst, asFills(payload.vendorFills)), ...toParams('', asFills(payload.absFills))];
  if (core.length) {
    const k = `fill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.db.createTask(k, deviceId, 'write',
      // GPN pemetaan ulang diantrekan setelah jawaban SPV ini, sehingga
      // (FIFO) berjalan sesudah SPV vendor yang sudah ada di antrean.
      { params: core, label: `${label}: isi ${inst}`, rediscover: true }, WRITE_TTL_MS);
    enqueueWrite(ctx, deviceId, core, k);
  }
  // Parameter vendor dikirim SATU per SPV: nama hasil tebakan yang ditolak
  // perangkat hanya menggagalkan dirinya sendiri, bukan VLAN/ServiceList lain.
  vendor.forEach((p, i) => {
    const k = `fillv_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`;
    ctx.db.createTask(k, deviceId, 'write',
      { params: [p], label: `${label}: ${p.name.split('.').slice(-2).join('.')}`, rediscover: !core.length }, WRITE_TTL_MS);
    enqueueWrite(ctx, deviceId, [p], k);
  });
  if (!core.length && !vendor.length) rediscoverWan(ctx, deviceId);
}

/* ------------------------------------------------------------------ *
 * API tinggi: antrekan RPC untuk perangkat
 * ------------------------------------------------------------------ */

const SPLIT_DEPTH_CAP = 8;
/** Tulisan menunggu Inform berikutnya: 24 jam cukup wajar untuk ONU. */
export const WRITE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Bacaan menunggu Inform berikutnya (ONU Inform tiap 30–60 menit); TTL
 * pendek membuat batch kedua dst. kedaluwarsa sebelum sempat terkirim.
 */
const READ_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * Path per GetParameterValues. ONT lama punya buffer SOAP kecil; 24 path
 * per batch aman dan membatasi kerusakan bila satu batch ditolak 9005.
 */
const READ_BATCH = 24;

/**
 * Path yang tidak boleh dikirim ke GetParameterValues: wildcard `*` dan
 * nama objek (berakhiran titik) — keduanya membatalkan seluruh batch di
 * banyak firmware.
 */
function readablePaths(paths: string[], allowPartial = false): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const p = raw.trim();
    if (!p || p.includes('*') || (p.endsWith('.') && !allowPartial)) continue;
    if (p.length < 4 || !p.includes('.')) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function enqueueRead(
  ctx: CwmpContext, deviceId: string, paths: string[], ttlMs?: number, allowPartial = false,
): string {
  // Path yang pernah ditolak perangkat ini tidak dikirim ulang.
  const bad = new Set(ctx.db.invalidParams(deviceId));
  const usable = readablePaths(paths.filter((p) => !bad.has(p)), allowPartial);
  if (!usable.length) return '';

  const queue = (slice: string[]): string => {
    const key = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    ctx.queue.enqueue(deviceId, buildGetParameterValues(key, slice), undefined, ttlMs ?? READ_TTL_MS);
    // Isi batch dicatat untuk split-on-fault.
    ctx.db.saveReadBatch(deviceId, key, slice);
    return key;
  };

  let last = '';
  for (let i = 0; i < usable.length; i += READ_BATCH) {
    last = queue(usable.slice(i, i + READ_BATCH));
  }
  return last;
}

/**
 * Antrekan SetParameterValues. `parameterKey` (id task) sekaligus dipakai
 * sebagai kunci RPC sehingga Fault dari perangkat bisa menutup task-nya.
 */
export function enqueueWrite(
  ctx: CwmpContext, deviceId: string, params: ParamValue[], parameterKey = '',
): string {
  const key = parameterKey || `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  ctx.queue.enqueue(deviceId, buildSetParameterValues(key, params, parameterKey), undefined, WRITE_TTL_MS);
  return key;
}

export function enqueueReboot(ctx: CwmpContext, deviceId: string): string {
  const key = `rb_${Date.now().toString(36)}`;
  ctx.queue.enqueue(deviceId, buildReboot(key), undefined, WRITE_TTL_MS);
  return key;
}

export function enqueueFactoryReset(ctx: CwmpContext, deviceId: string): string {
  const key = `fr_${Date.now().toString(36)}`;
  ctx.queue.enqueue(deviceId, buildFactoryReset(key), undefined, WRITE_TTL_MS);
  return key;
}

export function enqueueDownload(ctx: CwmpContext, deviceId: string, fileType: string, url: string): string {
  const key = `dl_${Date.now().toString(36)}`;
  ctx.queue.enqueue(deviceId, buildDownload(key, { fileType, url }), undefined, WRITE_TTL_MS);
  return key;
}

export function enqueueAddObject(
  ctx: CwmpContext, deviceId: string, objectName: string, parameterKey = '',
): string {
  const key = parameterKey || `ao_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  ctx.queue.enqueue(deviceId, buildAddObject(key, objectName, parameterKey), undefined, WRITE_TTL_MS);
  return key;
}

export function enqueueDeleteObject(
  ctx: CwmpContext, deviceId: string, objectName: string, parameterKey = '',
): string {
  const key = parameterKey || `do_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  ctx.queue.enqueue(deviceId, buildDeleteObject(key, objectName, parameterKey), undefined, WRITE_TTL_MS);
  return key;
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

/** Antrekan GetParameterNames(path, NextLevel=false) — seluruh subtree. */
export function enqueueDiscoveryAt(ctx: CwmpContext, deviceId: string, path: string): string {
  const key = `disc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  ctx.queue.enqueue(deviceId, buildGetParameterNames(key, path, false));
  return key;
}

/**
 * Kirim GPN untuk root berikutnya di antrean discovery, atau tandai
 * pemetaan selesai bila antrean habis. Root yang berkali-kali tidak
 * dijawab (perangkat memutus sesi) dilewati agar tidak macet selamanya.
 */
export function continueDiscovery(ctx: CwmpContext, deviceId: string): void {
  const failed = new Set(ctx.db.failedDiscoveryRoots(deviceId));
  for (const next of ctx.db.pendingDiscoveryPaths(deviceId)) {
    if (failed.has(next)) { ctx.db.dropDiscoveryPath(deviceId, next); continue; }
    if (ctx.db.bumpDiscoveryTry(deviceId, next) > MAX_DISCOVERY_TRIES) {
      ctx.db.markDiscoveryRootFailed(deviceId, next);
      ctx.db.dropDiscoveryPath(deviceId, next);
      ctx.db.addEvent(deviceId, 'collection', `Discovery ${next} dilewati: tidak dijawab perangkat`);
      continue;
    }
    enqueueDiscoveryAt(ctx, deviceId, next);
    return;
  }
  const col = ctx.db.getCollection(deviceId);
  if (!col?.discovery_done) {
    const n = currentProfile(ctx, deviceId).length;
    ctx.db.markDiscoveryDone(deviceId, n);
    // Leaf profil sudah dibaca saat tiap subtree dipetakan; tinggal path
    // esensial di luar root discovery (mis. redaman Huawei/ZTE di root IGD).
    enqueueRead(ctx, deviceId, essentialPaths(deviceModel(ctx, deviceId)));
    ctx.db.addEvent(deviceId, 'collection', `Struktur perangkat dipetakan: ${n} path profil`);
    ctx.onDiscovery?.(deviceId, n, true);
  }
}

/** Mulai (ulang) pemetaan penuh perangkat sesuai data model-nya. */
export function enqueueDiscover(ctx: CwmpContext, deviceId: string): string {
  ctx.db.resetDiscovery(deviceId, PROFILE_VERSION);
  ctx.db.enqueueDiscoveryPaths(deviceId, discoveryRoots(deviceModel(ctx, deviceId)));
  continueDiscovery(ctx, deviceId);
  return deviceId;
}

/** Petakan ulang hanya subtree WAN — dipanggil setelah WAN dibuat/diubah. */
export function rediscoverWan(ctx: CwmpContext, deviceId: string): void {
  const roots = wanRoots(deviceModel(ctx, deviceId));
  const pending = new Set(ctx.db.pendingDiscoveryPaths(deviceId));
  const fresh = roots.filter((r) => !pending.has(r));
  if (!fresh.length) return;
  ctx.db.enqueueDiscoveryPaths(deviceId, fresh);
  // Kalau tidak ada discovery lain yang sedang berjalan, mulai sekarang.
  if (!pending.size) continueDiscovery(ctx, deviceId);
}

export type { Rpc };
