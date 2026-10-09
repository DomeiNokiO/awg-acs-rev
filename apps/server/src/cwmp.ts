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
import { discoveryRoots, wanRoots, profileFromNodes, MAX_PROFILE_PATHS, SYSTEM_LEAF } from './profiler.ts';
import { essentialPaths, opticalCandidates, opticalFamily } from './modelpaths.ts';
import { buildInsight, detectDataModel, summaryFields, type DataModel } from './insight.ts';
import type { LiveTraffic } from './live.ts';

/** Ukuran maksimum body SOAP — 1 MB. Lebih dari itu kemungkinan bukan CPE. */
const MAX_BODY = 1024 * 1024;

/**
 * Versi format profil koleksi. Perangkat dengan profil versi lebih lama
 * dipetakan ulang otomatis saat Inform berikutnya — profil lama (sebelum
 * perbaikan discovery) tidak memuat redaman/PPPoE di WANConnectionDevice.N.
 */
export const PROFILE_VERSION = 5;

/**
 * Upgrade profil ringan: dari versi ini ke PROFILE_VERSION cukup memetakan
 * ulang subtree tertentu (bukan seluruh struktur). v3 → v4 menambah leaf
 * CPU/RAM vendor di bawah DeviceInfo → hanya GPN DeviceInfo. (1 RPC).
 */
export const PROFILE_INCREMENTAL: Record<number, (root: string) => string[]> = {
  3: (root) => [`${root}DeviceInfo.`],
  // v4 → v5: counter byte koneksi WAN (Stats.*) untuk trafik live.
  4: (root) => (root === 'Device.' ? ['Device.PPP.Interface.', 'Device.IP.Interface.'] : [`${root}WANDevice.`]),
};

/** Petakan ulang subtree untuk upgrade profil ringan; false = perlu penuh. */
export function upgradeProfile(ctx: CwmpContext, deviceId: string, from: number): boolean {
  // Upgrade bertingkat: setiap langkah from → PROFILE_VERSION harus punya
  // rencana subtree; bila ada yang tidak, pemetaan penuh yang dipakai.
  const steps: ((root: string) => string[])[] = [];
  for (let v = from; v < PROFILE_VERSION; v++) {
    const plan = PROFILE_INCREMENTAL[v];
    if (!plan) return false;
    steps.push(plan);
  }
  const root = deviceModel(ctx, deviceId) === 'TR-181' ? 'Device.' : 'InternetGatewayDevice.';
  ctx.db.setProfileVersion(deviceId, PROFILE_VERSION);
  ctx.db.enqueueDiscoveryPaths(deviceId, [...new Set(steps.flatMap((p) => p(root)))]);
  continueDiscovery(ctx, deviceId);
  return true;
}

/**
 * Subtree yang tidak ditelusuri pada mode BFS (firmware yang hanya
 * menjawab anak langsung): tabel besar tanpa data operasional.
 */
const SKIP_SUBTREE = /\.(?:PortMapping|Stats|Hosts|AssociatedDevice|WPS|WEPKey|DHCPOption|DHCPStaticAddress|IPv6[^.]*|X_[^.]*(?:Statistics|Stats|Log|Diagnostic)[^.]*)\.$/;

/**
 * Awalan entri antrean discovery untuk GetParameterNames NextLevel=true
 * (mode dangkal) — dipakai untuk firmware yang menolak NextLevel=false.
 */
const SHALLOW = 'next:';
/** Batas antrean penelusuran bertingkat per perangkat. */
const MAX_BFS_QUEUE = 150;

/** GPN yang tidak pernah dijawab sebanyak ini dianggap gagal dan dilewati. */
const MAX_DISCOVERY_TRIES = 3;

interface SessionEntry {
  session: CwmpSession;
  identity: DeviceIdentity | null;
  createdAt: number;
  /** IP CPE — untuk menebak sesi CPE yang tidak mengirim cookie. */
  ip: string;
  /** CPE pernah mengirim cookie sesi ini. */
  viaCookie: boolean;
  noCookieLogged: boolean;
  /** RPC yang sudah dikirim di sesi ini (lihat MAX_RPC_PER_SESSION). */
  rpcCount: number;
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
  /** Kredensial Connection Request yang dipasang ACS (null = nonaktif). */
  crCreds?: { user: string; pass: string } | null;
  /** Pemantauan trafik live (lihat live.ts). */
  live?: LiveTraffic;
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

/** Nama method SOAP pertama di dalam <Body> (untuk trace & deteksi Inform). */
function soapMethod(xml: string): string {
  if (!xml.trim()) return '(kosong)';
  const m = /<(?:[\w-]+:)?Body[^>]*>\s*<(?:[\w-]+:)?([A-Za-z]+)/.exec(xml);
  return m ? m[1]! : '(tak dikenal)';
}

/**
 * ACS_CWMP_TRACE=1 mencatat alur RPC per perangkat ke log (journalctl);
 * =2 juga menyertakan isi SOAP (dipotong 4 KB). Isi SOAP bisa memuat
 * kredensial PPPoE/WiFi — aktifkan hanya saat diagnosis.
 */
const TRACE = Number(process.env['ACS_CWMP_TRACE'] ?? 0);

/**
 * Batas RPC per sesi CWMP — menjaga ONU (CPU/RAM kecil) tidak dibanjiri
 * permintaan dalam satu sesi. 0 = tanpa batas. Pemetaan perangkat baru
 * butuh ±40–70 RPC; dengan batas ini terbagi ke beberapa Inform.
 */
const MAX_RPC_PER_SESSION = (() => {
  const n = Number(process.env['ACS_MAX_RPC_PER_SESSION'] ?? 40);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 40;
})();

/** Lama maksimum ACS menahan respons di antara poll trafik live. */
const LIVE_MAX_HOLD_MS = 10_000;

/** Sesi tanpa aktivitas selama ini dibuang dari memori. */
const SESSION_IDLE_MS = 10 * 60 * 1000;
/** Batas waktu menebak sesi lewat IP untuk CPE tanpa cookie. */
const IP_FALLBACK_MS = 2 * 60 * 1000;

export function registerCwmpRoutes(app: FastifyInstance, ctx: CwmpContext): void {
  // Body SOAP dibaca sebagai string apa pun Content-Type-nya. Sebagian ONU
  // mengirim `text/plain`, `application/octet-stream`, atau tanpa header —
  // parser yang ketat membuat Fastify membalas 415 dan sesi tak pernah jalan.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string', bodyLimit: MAX_BODY }, (_req, body, done) => done(null, body));

  // Sesi per koneksi TCP: CPE yang tidak menyimpan cookie biasanya tetap
  // memakai koneksi keep-alive yang sama sepanjang sesi.
  const bySocket = new WeakMap<object, string>();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of ctx.sessions) {
      if (now - e.session.lastSeen > SESSION_IDLE_MS) ctx.sessions.delete(k);
    }
  }, 60_000);
  timer.unref();

  const newSession = (ip: string): [string, SessionEntry] => {
    const sid = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    const session = new CwmpSession({
      dequeue: (device) => {
        const id = deviceIdOf(device);
        // Batas beban ONU: setelah N RPC sesi diakhiri dengan rapi (204);
        // sisa antrean tetap tersimpan dan dikirim pada sesi berikutnya.
        if (MAX_RPC_PER_SESSION > 0 && entry.rpcCount >= MAX_RPC_PER_SESSION) {
          // Poll trafik live (2 counter) tetap boleh lewat: operator sedang
          // memantau, dan bebannya sudah diatur oleh interval live.
          const liveTask = ctx.queue.dequeueWhere(id, (t) => t.rpc.key.startsWith('live_'));
          if (liveTask) return liveTask.rpc;
          const left = ctx.queue.size(id);
          if (left) {
            ctx.db.addEvent(id, 'cwmp',
              `Batas ${MAX_RPC_PER_SESSION} RPC per sesi tercapai — ${left} RPC dilanjutkan pada sesi berikutnya`);
          }
          return null;
        }
        const task = ctx.queue.dequeue(id);
        if (task) entry.rpcCount++;
        return task ? task.rpc : null;
      },
      record: (device, result) => {
        const id = deviceIdOf(device);
        // Hasil poll trafik live: hanya untuk perhitungan Mbps, tidak
        // disimpan sebagai parameter (dibaca tiap beberapa detik).
        if (ctx.live && 'commandKey' in result && result.commandKey?.startsWith('live_')) {
          if (result.kind === 'gpv' && Object.keys(result.values).length) ctx.live.onValues(id, result.values);
          else ctx.live.onFault(id);
          return;
        }
        ctx.onResult?.(id, result);
        try {
          applyResult(ctx, id, result);
        } catch (e) {
          // Kesalahan pemrosesan hasil tidak boleh memutus sesi CWMP.
          ctx.db.addEvent(id, 'collection_error', `Gagal memproses ${result.kind}: ${(e as Error).message}`);
        }
      },
    });
    const entry: SessionEntry = {
      session, identity: null, createdAt: Date.now(), ip, viaCookie: false, noCookieLogged: false, rpcCount: 0,
    };
    ctx.sessions.set(sid, entry);
    return [sid, entry];
  };

  app.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    if (raw.length > MAX_BODY) {
      return reply.code(413).type('text/plain').send('payload too large');
    }
    const ip = clientIp(req);
    const method = soapMethod(raw);
    const isInform = method === 'Inform';
    const socket = req.raw.socket as object;

    // Cari sesi: cookie → koneksi TCP → IP (hanya bila tidak ambigu).
    // Inform selalu membuka sesi baru.
    let sid: string | undefined;
    let entry: SessionEntry | undefined;
    let via = 'baru';
    if (!isInform) {
      const ck = parseCookies(req.headers.cookie)['acs_session'];
      if (ck && ctx.sessions.has(ck)) { sid = ck; via = 'cookie'; }
      if (!sid) {
        const s2 = bySocket.get(socket);
        if (s2 && ctx.sessions.has(s2)) { sid = s2; via = 'koneksi'; }
      }
      if (!sid) {
        const now = Date.now();
        const cands = [...ctx.sessions].filter(([, e]) =>
          e.ip === ip && e.identity && now - e.session.lastSeen < IP_FALLBACK_MS && e.session.state === 'in_session');
        if (cands.length === 1) { sid = cands[0]![0]; via = 'ip'; }
      }
      entry = sid ? ctx.sessions.get(sid) : undefined;
    }
    if (!entry) [sid, entry] = newSession(ip);
    bySocket.set(socket, sid!);
    if (via === 'cookie') entry.viaCookie = true;
    if ((via === 'koneksi' || via === 'ip') && !entry.viaCookie && !entry.noCookieLogged && entry.identity) {
      // Dicatat sekali per sesi: membantu menjelaskan perangkat yang
      // sebelumnya tak pernah terbaca datanya.
      entry.noCookieLogged = true;
      ctx.db.addEvent(deviceIdOf(entry.identity), 'cwmp',
        `CPE tidak mengirim cookie sesi — sesi dikenali lewat ${via}`);
    }

    let outcome = entry.session.handle(raw);

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
      registerDevice(ctx, id, outcome.inform.identity, ip);
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
        ip,
      });
    }

    // Trafik live: sesi tidak ditutup selama operator memantau. Tunggu
    // sampai jadwal poll berikutnya, antrekan bacaan 2 counter, lalu
    // lanjutkan sesi (bukan 204). Antrean lain tetap didahulukan.
    if (ctx.live && entry.identity && outcome.status === 204) {
      const id = deviceIdOf(entry.identity);
      if (ctx.live.isActive(id)) {
        const wait = Math.min(ctx.live.waitMs(id), LIVE_MAX_HOLD_MS);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const rpc = ctx.live.buildRpc(id);
        if (rpc) {
          ctx.queue.enqueue(id, rpc, undefined, 60_000);
          outcome = entry.session.resume();
        }
      }
    }

    if (TRACE) {
      const who = entry.identity ? deviceIdOf(entry.identity) : ip;
      const out = outcome.status === 204 ? '204 (akhir sesi)' : soapMethod(outcome.responseXml);
      console.log(`[cwmp] ${who} sesi=${sid} via=${via} ← ${method}${isInform && outcome.inform ? ` [${outcome.inform.events.join(', ')}] ns=${entry.session.cwmpNs.slice(-3)}` : ''} → ${out}`);
      if (TRACE >= 2) {
        if (raw) console.log(`[cwmp]   ← ${raw.slice(0, 4000)}`);
        if (outcome.responseXml) console.log(`[cwmp]   → ${outcome.responseXml.slice(0, 4000)}`);
      }
    }

    // Sesi selesai → buang supaya peta memori tidak tumbuh tanpa batas.
    if (outcome.done) ctx.sessions.delete(sid!);

    // Cookie polos: atribut SameSite/HttpOnly/Max-Age tidak berguna untuk
    // klien CWMP dan membuat parser cookie firmware lama menolaknya.
    reply.header('Set-Cookie', `acs_session=${sid}; Path=/`);
    if (outcome.status === 204 || !outcome.responseXml) {
      // TR-069: respons HTTP kosong mengakhiri sesi.
      return reply.code(204).send();
    }
    reply.header('Content-Type', 'text/xml; charset="utf-8"');
    reply.header('SOAPServer', 'AWG-ACS');
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

  // URL Connection Request mengikuti laporan ONU terbaru (IP manajemen
  // ONU bisa berubah setelah reboot/DHCP) — kecuali operator mengisinya
  // manual (cr_manual). Username melengkapi bila belum ada.
  const crUrl = values['InternetGatewayDevice.ManagementServer.ConnectionRequestURL']
    ?? values['Device.ManagementServer.ConnectionRequestURL'];
  const crUser = values['InternetGatewayDevice.ManagementServer.ConnectionRequestUsername']
    ?? values['Device.ManagementServer.ConnectionRequestUsername'];
  const existing = ctx.db.getDevice(deviceId);
  const patch: Record<string, string> = {};
  if (crUrl && /^https?:\/\//i.test(crUrl.trim()) && !existing?.cr_manual
    && crUrl.trim() !== existing?.connection_request_url) {
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

/**
 * Path esensial perangkat ini: info dasar + kandidat redaman keluarga
 * vendornya (lebih sedikit RPC split-on-fault di ONU yang menolak discovery).
 */
function deviceEssentials(ctx: CwmpContext, deviceId: string): string[] {
  const row = ctx.db.getDevice(deviceId);
  const fam = opticalFamily(row?.manufacturer ?? '', row?.oui ?? '', row?.product_class ?? '');
  const invalid = new Set(ctx.db.invalidParams(deviceId));
  return essentialPaths(deviceModel(ctx, deviceId), opticalCandidates(fam, invalid));
}

/**
 * Leaf "panas": yang benar-benar berubah dari waktu ke waktu (redaman,
 * status koneksi, IP, uptime, jumlah klien). Siklus koleksi rutin hanya
 * membaca ini — biasanya 1 GetParameterValues — sedangkan profil penuh
 * (nama, VLAN, SSID, ServiceList…) dibaca berkala jarang / saat BOOT /
 * saat diminta operator. Inilah yang membuat beban per ONU jauh lebih
 * kecil dari penyegaran penuh.
 */
const HOT_LEAF = /(?:RXPower|RxPower|TXPower|TxPower|OpticalSignalLevel|TransmitOpticalLevel|Temperature|TemperatureSensor\.\d+\.Value|ConnectionStatus|ExternalIPAddress|LastConnectionError|\.UpTime|\.Uptime|TotalAssociations|HostNumberOfEntries|AssociatedDeviceNumberOfEntries|Optical\.Interface\.\d+\.Status|PPP\.Interface\.\d+\.Status)$/;

export function hotPaths(paths: string[]): string[] {
  // CPU/RAM ikut dibaca tiap siklus: nilainya berubah terus.
  return paths.filter((p) => HOT_LEAF.test(p) || SYSTEM_LEAF.test(p) || /DeviceInfo\.(?:ProcessStatus\.CPUUsage|MemoryStatus\.Free)$/.test(p));
}

/** Path yang dibaca tiap siklus koleksi: esensial ∪ profil discovery. */
export function collectPaths(ctx: CwmpContext, deviceId: string): string[] {
  return [...new Set([...deviceEssentials(ctx, deviceId), ...currentProfile(ctx, deviceId)])];
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

/**
 * Pasang kredensial Connection Request milik ACS pada ONU yang password
 * CR-nya tidak diketahui ACS (password tidak bisa dibaca lewat TR-069),
 * supaya tombol Hubungi bekerja. Sekali per perangkat; dicoba lagi paling
 * cepat 7 hari bila ditolak. Tidak dilakukan bila operator mengisi
 * kredensial sendiri (cr_manual) atau ACS_CR_AUTO=0.
 */
export function maybeProvisionCrCreds(ctx: CwmpContext, deviceId: string): void {
  const cr = ctx.crCreds;
  if (!cr) return;
  const row = ctx.db.getDevice(deviceId);
  if (!row || row.cr_manual || row.connection_request_pass) return;
  if (row.cr_provisioned_at && Date.now() - row.cr_provisioned_at < 7 * 24 * 3600 * 1000) return;
  const root = deviceModel(ctx, deviceId) === 'TR-181' ? 'Device.' : 'InternetGatewayDevice.';
  ctx.db.setDeviceFields(deviceId, { cr_provisioned_at: Date.now() });
  const params: ParamValue[] = [
    { name: `${root}ManagementServer.ConnectionRequestUsername`, type: 'xsd:string', value: cr.user },
    { name: `${root}ManagementServer.ConnectionRequestPassword`, type: 'xsd:string', value: cr.pass },
  ];
  const key = `cfg_cr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  ctx.db.createTask(key, deviceId, 'write',
    { params, label: 'Kredensial Connection Request ACS', crCreds: { user: cr.user, pass: cr.pass } }, WRITE_TTL_MS);
  enqueueWrite(ctx, deviceId, params, key);
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
        // Entri antrean bisa berupa "next:<path>" (mode dangkal, lihat
        // SHALLOW). Bila itu yang barusan dijawab, perangkat ini memang
        // hanya mau NextLevel=true — subtree berikutnya ikut mode itu.
        const wasShallow = ctx.db.pendingDiscoveryPaths(deviceId).includes(SHALLOW + asked);
        ctx.db.dropDiscoveryPath(deviceId, asked);
        ctx.db.dropDiscoveryPath(deviceId, SHALLOW + asked);
        const root = ctx.db.getDiscoveryRoot(deviceId);
        if (wasShallow && !root?.startsWith(SHALLOW)) {
          ctx.db.setDiscoveryRoot(deviceId, SHALLOW + asked);
          ctx.db.addEvent(deviceId, 'collection',
            'Perangkat menolak GetParameterNames NextLevel=false — pemetaan memakai mode bertingkat (NextLevel=true)');
        } else if (!root) {
          ctx.db.setDiscoveryRoot(deviceId, asked);
        }
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
          const shallowMode = ctx.db.getDiscoveryRoot(deviceId)?.startsWith(SHALLOW) ?? false;
          // Batasi penelusuran bertingkat supaya ONU dengan pohon besar
          // tidak dipanggil ratusan kali.
          if (children.length && ctx.db.pendingDiscoveryPaths(deviceId).length < MAX_BFS_QUEUE) {
            ctx.db.enqueueDiscoveryPaths(deviceId, shallowMode ? children.map((c) => SHALLOW + c) : children);
          }
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
        // Kredensial Connection Request terpasang di ONU → simpan supaya
        // tombol Hubungi bisa mengautentikasi (Digest).
        const cr = payload.crCreds as { user?: unknown; pass?: unknown } | undefined;
        if (cr && typeof cr.user === 'string' && typeof cr.pass === 'string') {
          ctx.db.setDeviceFields(deviceId, { connection_request_user: cr.user, connection_request_pass: cr.pass });
          ctx.db.addEvent(deviceId, 'cwmp', 'Kredensial Connection Request ACS terpasang di ONU');
        }
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
        if (t) {
          ctx.db.updateTask(result.commandKey, 'failed', { code: result.code, message: result.message });
          // Langkah terakhir rangkaian WAN gagal → tetap petakan ulang agar UI
          // menampilkan kondisi nyata perangkat.
          if (parsePayload(t.payload).rediscover === true) rediscoverWan(ctx, deviceId);
        }
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
      // GetParameterNames ditolak. Percobaan NextLevel=false yang ditolak
      // dicoba ulang SEKALI dengan NextLevel=true — sebagian firmware
      // FiberHome/operator menolak permintaan seluruh subtree tetapi
      // melayani penelusuran per tingkat. Bila mode dangkal juga ditolak,
      // root ini memang tidak ada di perangkat.
      if (result.method === 'GetParameterNames' && result.askedPath) {
        const p = result.askedPath;
        const pending = ctx.db.pendingDiscoveryPaths(deviceId);
        if (pending.includes(SHALLOW + p)) {
          ctx.db.markDiscoveryRootFailed(deviceId, SHALLOW + p);
          ctx.db.dropDiscoveryPath(deviceId, SHALLOW + p);
        } else {
          ctx.db.markDiscoveryRootFailed(deviceId, p);
          ctx.db.dropDiscoveryPath(deviceId, p);
          ctx.db.enqueueDiscoveryPaths(deviceId, [SHALLOW + p]);
        }
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
    case 'factory_reset': {
      // Respons Reboot/FactoryReset tidak membawa kunci — tutup task
      // sejenis yang masih menunggu untuk perangkat ini.
      const kind = result.kind;
      for (const t of ctx.db.listTasks(deviceId, 50) as { id: string; kind: string; status: string }[]) {
        if (t.kind === kind && t.status === 'pending') ctx.db.updateTask(t.id, 'done', 'diterima perangkat');
      }
      ctx.db.addEvent(deviceId, kind, kind === 'reboot'
        ? 'Perangkat menerima perintah reboot'
        : 'Perangkat menerima perintah reset pabrik');
      break;
    }
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
      finalFills: asFills(then.finalFills),
      sequential: then.sequential === true,
      absFills: [...asFills(payload.absFills), ...linkFills],
      label,
    }, WRITE_TTL_MS);
    enqueueAddObject(ctx, deviceId, child, key);
    return;
  }

  // Urutan tulisan ke instans baru:
  //   1. parameter standar — satu SPV (atau satu per SPV bila `sequential`);
  //   2. parameter vendor — SATU per SPV, supaya nama tebakan yang ditolak
  //      hanya menggagalkan dirinya sendiri, bukan VLAN/ServiceList lain;
  //   3. finalFills (Enable=true) — terakhir, setelah semua terisi.
  // Antrean FIFO menjaga urutan ini; pemetaan ulang WAN dipicu oleh SPV
  // terakhir (berhasil maupun gagal).
  const core = toParams(inst, asFills(payload.fills));
  const vendor = [...toParams(inst, asFills(payload.vendorFills)), ...toParams('', asFills(payload.absFills))];
  const final = toParams(inst, asFills(payload.finalFills));
  const groups: ParamValue[][] = [];
  if (core.length) {
    if (payload.sequential === true) core.forEach((p) => groups.push([p]));
    else groups.push(core);
  }
  vendor.forEach((p) => groups.push([p]));
  if (final.length) groups.push(final);
  groups.forEach((g, i) => {
    const k = `fill_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`;
    const what = g.length > 1 ? `isi ${inst}` : g[0]!.name.split('.').slice(-2).join('.');
    ctx.db.createTask(k, deviceId, 'write',
      { params: g, label: `${label}: ${what}`, rediscover: i === groups.length - 1 }, WRITE_TTL_MS);
    enqueueWrite(ctx, deviceId, g, k);
  });
  if (!groups.length) rediscoverWan(ctx, deviceId);
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
export function enqueueDiscoveryAt(ctx: CwmpContext, deviceId: string, entry: string): string {
  const key = `disc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const shallow = entry.startsWith(SHALLOW);
  const path = shallow ? entry.slice(SHALLOW.length) : entry;
  ctx.queue.enqueue(deviceId, buildGetParameterNames(key, path, shallow));
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
    enqueueRead(ctx, deviceId, deviceEssentials(ctx, deviceId));
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
