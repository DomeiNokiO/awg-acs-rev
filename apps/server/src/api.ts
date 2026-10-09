/**
 * REST API (port 8080) untuk UI.
 *
 * Keamanan yang dipasang di sini, dan alasannya:
 *  - Semua endpoint kecuali /api/login butuh cookie sesi. Tidak ada API
 *    terbuka tanpa auth seperti NBI GenieACS (yang terbukti `GET /devices`
 *    balas 200 tanpa kredensial).
 *  - Login di-rate-limit per IP + per username supaya tidak bisa ditebak.
 *  - CSRF: header `x-csrf` harus cocok dengan HMAC cookie sesi. Cookie
 *    SameSite=Strict sudah membantu, tapi header kedua ini menutup celah
 *    bila ada subdomain yang kompromi.
 *  - Body dibatasi ukurannya, dan semua nilai yang masuk divalidasi tipe.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  hashPassword, verifyPassword, newSessionToken, csrfToken, safeCompare,
  RateLimiter, type Database, type PresetRow,
} from '@acs/core';
import {
  enqueueRead, enqueueWrite, enqueueReboot, enqueueFactoryReset,
  enqueueDownload, enqueueDiscover, enqueueAddObject, enqueueDeleteObject, collectPaths,
  PROFILE_VERSION, type CwmpContext,
} from './cwmp.ts';
import { parseCookies } from './cwmp.ts';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadCatalog, catalogWritePath, writeCatalogFile, CATALOG_FILE } from './catalog.ts';
import { validateCatalog } from './catalog-schema.ts';
import { validatePreset, applyPresets, type PresetCondition, type PresetAction } from './presets.ts';
import { applyConfig, CONFIG_TYPES, type ConfigRequest } from './configure.ts';
import { buildInsight, trafficCounters } from './insight.ts';
import { sendConnectionRequest, crCooldown, markCr } from './connreq.ts';
import { WebhookDispatcher, type DeliveryLogEntry } from './webhooks.ts';
import type { WebhookRow } from '@acs/core';

// Dibaca sekali saat module load. Menerima milidetik langsung, atau angka
// polos yang ditafsirkan jam (8 = 8 jam) supaya penulisan env tidak mudah
// salah. Bila nilainya tidak valid, kembali ke default dan dicatat.
const SESSION_TTL = (() => {
  const raw = process.env['ACS_SESSION_TTL'];
  if (!raw) return 8 * 60 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[api] ACS_SESSION_TTL tidak valid (${raw}), memakai default 8 jam`);
    return 8 * 60 * 60 * 1000;
  }
  // Angka kecil (< 1000) hampir pasti maksudnya jam, bukan milidetik.
  return n < 1000 ? n * 60 * 60 * 1000 : n;
})();

const loginLimiter = new RateLimiter(10, 5 * 60 * 1000);   // 10 percobaan / 5 menit
const globalLimiter = new RateLimiter(300, 60 * 1000);      // 300 request / menit / IP

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: { username: string; role: string };
  }
}

interface LoginBody { username?: unknown; password?: unknown }

export function registerApiRoutes(
  app: FastifyInstance, db: Database, ctx: CwmpContext,
  dispatcher?: WebhookDispatcher,
): void {
  // Error tak tertangani: kirim alasan yang bisa dibaca operator di `error`
  // (bawaan Fastify hanya "Bad Request"/"Internal Server Error").
  app.setErrorHandler((err: unknown, req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    const code = e.statusCode ?? 500;
    if (code >= 500) req.log.error(err);
    const msg = e.message ?? 'error';
    reply.code(code).send({ error: code >= 500 ? `Kesalahan server: ${msg}` : msg });
  });

  // JSON dengan body kosong dianggap {} — banyak klien (termasuk UI lama
  // dan skrip curl) mengirim Content-Type JSON pada POST tanpa body.
  // Parser bawaan Fastify menolaknya dengan 400 "Bad Request".
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) { done(null, {}); return; }
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error('Body JSON tidak valid') as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  /* ---------------- auth plumbing ---------------- */

  // Emit ke webhook bila dispatcher dipasang. Dipanggil dari jalur hot
  // (login, task, preset, event) — gagal diam-diam tanpa mengganggu request.
  function emitWebhook(kind: string, message: string, data?: Record<string, unknown>): void {
    try {
      dispatcher?.emit({ kind, deviceId: null, message, data });
    } catch { /* webhook tidak boleh menggagalkan request utama */ }
  }

  function currentSession(req: FastifyRequest): { username: string; role: string; token: string } | null {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['acs_auth'];
    if (!token) return null;
    const row = db.getSession(token);
    if (!row || row.expires_at < Date.now()) return null;
    const user = db.getUser(row.username);
    if (!user) return null;
    return { username: user.username, role: user.role, token };
  }

  async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const s = currentSession(req);
    if (!s) {
      reply.code(401).send({ error: 'unauthorized' });
      return false;
    }
    // CSRF wajib untuk semua request yang mengubah data.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const header = req.headers['x-csrf'];
      if (typeof header !== 'string' || !safeCompare(header, csrfToken(s.token))) {
        reply.code(403).send({ error: 'csrf_token_invalid' });
        return false;
      }
    }
    req.authUser = { username: s.username, role: s.role };
    return true;
  }

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // Batasi laju global per IP.
    if (globalLimiter.check(req.ip) > 0) {
      reply.code(429).send({ error: 'rate_limited' });
      return;
    }
    if (req.url === '/api/login' || req.url === '/api/health') return;
    const ok = await requireAuth(req, reply);
    if (!ok) return; // reply sudah dikirim
  });

  /* ---------------- login / logout ---------------- */

  app.post('/api/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const wait = Math.max(loginLimiter.check(req.ip), 0);
    if (wait > 0) {
      reply.header('retry-after', Math.ceil(wait / 1000));
      return reply.code(429).send({ error: 'rate_limited', retryAfterMs: wait });
    }

    const body = (req.body ?? {}) as LoginBody;
    const username = typeof body.username === 'string' ? body.username.trim().slice(0, 64) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) return reply.code(400).send({ error: 'username_password_required' });

    const user = db.getUser(username);
    // Selalu jalankan verifikasi supaya timing login valid/invalid mirip.
    const stored = user?.password_hash ?? 'scrypt$32768$8$1$AAAA$AAAA';
    const ok = await verifyPassword(password, stored) && !!user;
    if (!ok) {
      db.addEvent(null, 'login_failed', `Login gagal: ${username} dari ${req.ip}`);
      emitWebhook('login_failed', `Login gagal: ${username} dari ${req.ip}`);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    loginLimiter.reset(req.ip);
    const token = newSessionToken();
    db.createSession(token, username, SESSION_TTL, req.ip);
    db.touchLogin(username);
    db.addEvent(null, 'login', `Login: ${username} dari ${req.ip}`);
    emitWebhook('login', `Login: ${username} dari ${req.ip}`);

    reply.header('Set-Cookie',
      `acs_auth=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`);
    return reply.send({ username, role: user!.role, csrf: csrfToken(token) });
  });

  app.post('/api/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies['acs_auth']) db.deleteSession(cookies['acs_auth']);
    reply.header('Set-Cookie', 'acs_auth=; Path=/; HttpOnly; Max-Age=0');
    return reply.send({ ok: true });
  });

  app.get('/api/me', async (req, reply) => {
    const s = currentSession(req);
    if (!s) return reply.code(401).send({ error: 'unauthorized' });
    return reply.send({ username: s.username, role: s.role, csrf: csrfToken(s.token) });
  });

  app.get('/api/health', async (_req, reply) => reply.send({ ok: true, uptime: process.uptime() }));

  /* ---------------- devices ---------------- */

  app.get('/api/devices', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Number(q['limit'] ?? 50);
    const offset = Number(q['offset'] ?? 0);
    const rxMax = q['rxmax'] !== undefined && q['rxmax'] !== '' ? Number(q['rxmax']) : undefined;
    const { rows, total } = db.listDevices({
      q: q['q'], tag: q['tag'], group: q['group'],
      online: q['online'] === '1',
      ...(rxMax !== undefined && Number.isFinite(rxMax) ? { rxMax } : {}),
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    const now = Date.now();
    return reply.send({
      total,
      // Redaman/PPPoE diambil dari kolom ringkasan (diisi insight.ts saat
      // parameter masuk) — tidak membaca tabel params per baris.
      items: rows.map((d) => ({
        ...maskDevice(d),
        online: !!d.last_inform_at && now - d.last_inform_at < 30 * 60 * 1000,
        pending_tasks: ctx.queue.size(d.id),
      })),
    });
  });

  app.get('/api/devices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const d = db.getDevice(id);
    if (!d) return reply.code(404).send({ error: 'device_not_found' });
    const params = db.getParams(id);
    return reply.send({
      insight: buildInsight(params, d.data_model === 'TR-181' || d.data_model === 'TR-098' ? d.data_model : null),
      device: {
        ...maskDevice(d),
        online: !!d.last_inform_at && Date.now() - d.last_inform_at < 30 * 60 * 1000,
        pending_tasks: ctx.queue.size(id),
      },
      params,
      events: db.listEvents({ deviceId: id, limit: 50 }),
      tasks: db.listTasks(id, 30),
      discovered: db.getDiscovered(d.product_class),
    });
  });

  /* ---------------- perangkat: ubah metadata + Connection Request ---------------- */

  /**
   * Sembunyikan password (connection request & CWMP) dari respons API —
   * diganti penanda boolean agar UI tahu sudah diisi tanpa membocorkan nilainya.
   */
function maskDevice<T extends {
    connection_request_pass?: string | null;
    cwmp_pass?: string | null;
  }>(d: T): Omit<T, 'connection_request_pass' | 'cwmp_pass'> & {
    has_connection_request_pass: boolean;
    has_cwmp_pass: boolean;
  } {
    const { connection_request_pass, cwmp_pass, ...rest } = d;
    return {
      ...(rest as Omit<T, 'connection_request_pass' | 'cwmp_pass'>),
      has_connection_request_pass: !!connection_request_pass,
      has_cwmp_pass: !!cwmp_pass,
    };
  }

  app.put('/api/devices/:id', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const { id } = req.params as { id: string };
    const d = db.getDevice(id);
    if (!d) return reply.code(404).send({ error: 'device_not_found' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const fields: Record<string, string | number | null> = {};

    // Connection Request — untuk ACS menjangkau CPE (dipakai endpoint /connect)
    if (typeof b.connection_request_url === 'string') {
      const u = b.connection_request_url.trim().slice(0, 2048);
      if (u && !/^https?:\/\//i.test(u)) return reply.code(400).send({ error: 'invalid_url' });
      fields.connection_request_url = u || null;
      // URL diisi manual → jangan ditimpa nilai yang dilaporkan ONU.
      if ((u || null) !== d.connection_request_url) fields.cr_manual = u ? 1 : 0;
    }
    if (typeof b.connection_request_user === 'string') {
      fields.connection_request_user = b.connection_request_user.trim().slice(0, 128) || null;
    }
    if (typeof b.connection_request_pass === 'string' && b.connection_request_pass.trim()) {
      fields.connection_request_pass = b.connection_request_pass.trim().slice(0, 128);
      // Kredensial dari operator: hentikan pemasangan kredensial otomatis.
      fields.cr_manual = 1;
    }
    // Grup & catatan
    if (typeof b.group_name === 'string') fields.group_name = b.group_name.trim().slice(0, 64) || null;
    if (typeof b.notes === 'string') fields.notes = b.notes.trim().slice(0, 512) || null;
    // Credential CPE→ACS (autentikasi Inform). Kosong = ACS tak minta auth.
    if (typeof b.cwmp_user === 'string') fields.cwmp_user = b.cwmp_user.trim().slice(0, 128) || null;
    if (typeof b.cwmp_pass === 'string') fields.cwmp_pass = b.cwmp_pass.trim().slice(0, 128) || null;

    if (Object.keys(fields).length === 0) return reply.code(400).send({ error: 'no_fields' });
    db.setDeviceFields(id, fields);
    db.addEvent(id, 'device', 'Metadata perangkat diubah dari UI');
    return reply.send({ ok: true, fields });
  });

  // Kirim Connection Request ke CPE — "mengetuk" perangkat supaya langsung
  // Inform (tanpa menunggu interval). Sama seperti "Notification" di GenieACS.
  app.post('/api/devices/:id/connect', async (req, reply) => {
    const { id } = req.params as { id: string };
    const d = db.getDevice(id);
    if (!d) return reply.code(404).send({ error: 'device_not_found' });
    const url = d.connection_request_url;
    if (!url) {
      return reply.code(409).send({ error: 'ONU belum melaporkan ConnectionRequestURL — tunggu Inform berikutnya, perintah tetap terkirim saat itu' });
    }
    // Lindungi ONU dari klik beruntun: satu Connection Request per 10 detik.
    const wait = crCooldown(id);
    if (wait > 0) {
      return reply.code(429).send({ error: `ONU baru saja dipanggil — tunggu ${Math.ceil(wait / 1000)} detik` });
    }
    markCr(id);
    const r = await sendConnectionRequest(url, d.connection_request_user ?? '', d.connection_request_pass ?? '');
    if (r.ok) {
      db.addEvent(id, 'connect', `Connection Request diterima ONU (HTTP ${r.status}, auth ${r.auth}) — ONU akan Inform`);
      return reply.send({ ok: true, status: r.status, auth: r.auth });
    }
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    const msg = r.reason === 'auth'
      ? `ONU menolak kredensial Connection Request (HTTP ${r.status}, ${r.auth}). Isi user/password di "Akses ACS → CPE", atau biarkan ACS memasang kredensial otomatis (ACS_CR_AUTO).`
      : r.reason === 'unreachable'
        ? `ONU tidak terjangkau di ${host} (${r.detail}). Biasanya IP manajemen ONU tidak bisa dicapai dari server ACS (NAT/VLAN berbeda). Perintah tetap dikirim saat Inform berikutnya.`
        : `ONU membalas HTTP ${r.status} untuk Connection Request`;
    db.addEvent(id, 'connect_failed', msg);
    return reply.code(502).send({ error: msg, reason: r.reason, status: r.status });
  });

  /* ---------------- trafik live (Mbps) ---------------- */

  /**
   * Mulai pemantauan trafik live: pilih pasangan counter byte WAN, lalu
   * panggil ONU (Connection Request) agar membuka sesi. Selama sesi itu
   * ACS membaca counter tiap `intervalSec` detik (lihat live.ts).
   */
  app.post('/api/devices/:id/live', async (req, reply) => {
    const { id } = req.params as { id: string };
    const d = db.getDevice(id);
    if (!d || !ctx.live) return reply.code(404).send({ error: 'device_not_found' });
    const b = (req.body ?? {}) as { seconds?: unknown; intervalSec?: unknown };
    const seconds = Math.min(300, Math.max(15, Number(b.seconds) || 60));
    const intervalMs = Math.min(10, Math.max(2, Number(b.intervalSec) || 3)) * 1000;
    const params = db.getParams(id);
    const model = d.data_model === 'TR-181' || d.data_model === 'TR-098' ? d.data_model : null;
    const started = ctx.live.start(id, trafficCounters(params, model), seconds, intervalMs);
    if ('error' in started) return reply.code(409).send(started);

    // Sesi sudah terbuka (mis. ONU sedang Inform) → poll mulai di sesi itu.
    const open = [...ctx.sessions.values()].some((e) =>
      e.identity && `${e.identity.oui}-${e.identity.productClass}-${e.identity.serialNumber}` === id
      && e.session.state === 'in_session');
    let cr: { ok: boolean; error?: string } = { ok: true };
    if (!open) {
      if (!d.connection_request_url) cr = { ok: false, error: 'ONU belum melaporkan ConnectionRequestURL' };
      else if (crCooldown(id) > 0) cr = { ok: true };
      else {
        markCr(id);
        const r = await sendConnectionRequest(d.connection_request_url, d.connection_request_user ?? '', d.connection_request_pass ?? '');
        cr = r.ok ? { ok: true } : { ok: false, error: r.reason === 'unreachable' ? `ONU tidak terjangkau (${r.detail})` : `Connection Request ditolak (HTTP ${r.status ?? '-'})` };
      }
    }
    db.addEvent(id, 'live', `Trafik live dimulai (${seconds} detik, tiap ${intervalMs / 1000} detik)`);
    return reply.send({ ...ctx.live.get(id), cr });
  });

  app.get('/api/devices/:id/live', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(ctx.live?.get(id) ?? { status: 'idle', samples: [] });
  });

  app.delete('/api/devices/:id/live', async (req, reply) => {
    const { id } = req.params as { id: string };
    ctx.live?.stop(id);
    return reply.send(ctx.live?.get(id) ?? { status: 'idle', samples: [] });
  });

  app.post('/api/devices/:id/read', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getDevice(id)) return reply.code(404).send({ error: 'device_not_found' });
    const body = (req.body ?? {}) as { paths?: unknown };
    const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string') : [];
    if (!paths.length) return reply.code(400).send({ error: 'paths_required' });
    if (paths.length > 500) return reply.code(400).send({ error: 'too_many_paths', max: 500 });
    // Validasi bentuk path: hanya karakter aman untuk TR-069.
    const bad = paths.find((p) => !/^[\w.-]{1,512}$/.test(p));
    if (bad) return reply.code(400).send({ error: 'invalid_path', path: bad });
    // Baca manual boleh memakai partial path (berakhiran titik) — TR-069
    // mengizinkannya dan operator memang ingin melihat seluruh subtree.
    const key = enqueueRead(ctx, id, paths, undefined, true);
    if (!key) return reply.code(400).send({ error: 'paths_rejected', detail: 'semua path pernah ditolak perangkat' });
    db.addEvent(id, 'task', `Baca ${paths.length} path diantrekan`);
    return reply.send({ task: key, queued: ctx.queue.size(id) });
  });

  app.post('/api/devices/:id/write', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getDevice(id)) return reply.code(404).send({ error: 'device_not_found' });
    const body = (req.body ?? {}) as { params?: unknown; values?: unknown };
    // Dua format: { params: [{name,type,value}] } atau { values: {path: nilai} }
    // (dipakai tab Perintah). Untuk `values`, tipe diambil dari tipe yang
    // dilaporkan ONU saat dibaca — tipe salah membuat SPV ditolak 9006.
    if (!Array.isArray(body.params) && body.values && typeof body.values === 'object') {
      const known = new Map(db.getParams(id).map((p) => [p.path, p.type]));
      body.params = Object.entries(body.values as Record<string, unknown>).map(([name, value]) => {
        const v = String(value ?? '');
        const t = known.get(name);
        const type = t && t !== 'xsd:string' ? t
          : /\.(?:Enable|[A-Za-z]+Enabled?)$/.test(name) && /^(true|false|0|1)$/i.test(v) ? 'xsd:boolean' : 'xsd:string';
        return { name, type, value: type === 'xsd:boolean' ? v.toLowerCase() : v };
      });
    }
    if (!Array.isArray(body.params) || !body.params.length) {
      return reply.code(400).send({ error: 'Isi minimal satu baris "Path = nilai"' });
    }
    if (body.params.length > 100) return reply.code(400).send({ error: 'too_many_params', max: 100 });

    const allowed = new Set(['xsd:string', 'xsd:int', 'xsd:unsignedInt', 'xsd:boolean', 'xsd:dateTime']);
    const params = [];
    for (const p of body.params as { name?: unknown; type?: unknown; value?: unknown }[]) {
      if (typeof p?.name !== 'string' || !/^[\w.-]{1,512}$/.test(p.name)) {
        return reply.code(400).send({ error: 'invalid_param_name', name: p?.name });
      }
      const type = typeof p.type === 'string' && allowed.has(p.type) ? p.type : 'xsd:string';
      if (type === 'xsd:int' || type === 'xsd:unsignedInt') {
        if (!/^-?\d{1,12}$/.test(String(p.value))) {
          return reply.code(400).send({ error: 'invalid_int_value', name: p.name });
        }
      }
      if (type === 'xsd:boolean' && !['true', 'false', '1', '0'].includes(String(p.value))) {
        return reply.code(400).send({ error: 'invalid_boolean_value', name: p.name });
      }
      params.push({ name: p.name, type: type as 'xsd:string', value: String(p.value ?? '') });
    }
    // Kunci task = ParameterKey → jawaban/Fault ONU menutup task ini.
    const key = `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    db.createTask(key, id, 'write', { params, label: `Tulis ${params.length} parameter` }, 24 * 60 * 60 * 1000);
    enqueueWrite(ctx, id, params, key);
    return reply.send({ task: key, queued: ctx.queue.size(id) });
  });

  app.post('/api/devices/:id/reboot', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getDevice(id)) return reply.code(404).send({ error: 'device_not_found' });
    const key = enqueueReboot(ctx, id);
    db.createTask(key, id, 'reboot', { label: 'Reboot' }, 24 * 60 * 60 * 1000);
    db.addEvent(id, 'task', 'Reboot diantrekan');
    emitWebhook('task', `Reboot diantrekan untuk ${id}`, { deviceId: id, action: 'reboot' });
    return reply.send({ task: key });
  });

  app.post('/api/devices/:id/factory-reset', async (req, reply) => {
    const { id } = req.params as { id: string };
    const dev = db.getDevice(id);
    if (!dev) return reply.code(404).send({ error: 'device_not_found' });
    // Reset pabrik menghapus PPPoE/WiFi pelanggan (dan bisa juga URL ACS):
    // hanya admin, dan wajib konfirmasi dengan mengetik serial number.
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const confirm = String(((req.body ?? {}) as { confirm?: unknown }).confirm ?? '').trim();
    if (confirm !== dev.serial_number) {
      return reply.code(400).send({ error: 'Konfirmasi tidak cocok: ketik serial number perangkat untuk reset pabrik' });
    }
    const key = enqueueFactoryReset(ctx, id);
    db.createTask(key, id, 'factory_reset', { label: 'Reset pabrik' }, 24 * 60 * 60 * 1000);
    db.addEvent(id, 'task', 'Factory reset diantrekan');
    emitWebhook('task', `Factory reset diantrekan untuk ${id}`, { deviceId: id, action: 'factory_reset' });
    return reply.send({ task: key, warning: 'Perangkat akan kehilangan semua konfigurasi' });
  });

  app.post('/api/devices/:id/discover', async (req, reply) => {
    const { id } = req.params as { id: string };
    const d = db.getDevice(id);
    if (!d) return reply.code(404).send({ error: 'device_not_found' });
    // Pemetaan ulang penuh. Tidak membuat baris task: discovery berjalan
    // beberapa RPC dan hasilnya terlihat di tab Peristiwa.
    enqueueDiscover(ctx, id);
    db.addEvent(id, 'task', 'Pemetaan struktur ulang diantrekan');
    return reply.send({ ok: true, task: `discover_${Date.now().toString(36)}` });
  });

  /**
   * Segarkan data perangkat: antrekan pembacaan esensial (redaman, info)
   * ∪ profil discovery. Dijalankan saat Inform berikutnya — UI biasanya
   * menyusulkan Connection Request (/connect) agar perangkat segera Inform.
   */
  app.post('/api/devices/:id/refresh', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getDevice(id)) return reply.code(404).send({ error: 'device_not_found' });
    const paths = collectPaths(ctx, id);
    enqueueRead(ctx, id, paths);
    db.markFullCollect(id);
    const col = db.getCollection(id);
    if (!col || (col.profile_version ?? 0) < PROFILE_VERSION) enqueueDiscover(ctx, id);
    return reply.send({ ok: true, paths: paths.length, queued: ctx.queue.size(id) });
  });

  app.post('/api/devices/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getDevice(id)) return reply.code(404).send({ error: 'device_not_found' });
    const body = (req.body ?? {}) as { url?: unknown; fileType?: unknown };
    const url = typeof body.url === 'string' ? body.url : '';
    if (!/^https?:\/\/[\w.-]+(:\d+)?\//.test(url)) {
      return reply.code(400).send({ error: 'invalid_url' });
    }
    const fileType = typeof body.fileType === 'string' &&
      ['1 Firmware Upgrade Image', '2 Web Content', '3 Vendor Configuration File'].includes(body.fileType)
      ? body.fileType : '1 Firmware Upgrade Image';
    const key = enqueueDownload(ctx, id, fileType, url);
    db.createTask(key, id, 'download', { url, fileType });
    return reply.send({ task: key });
  });

  app.post('/api/devices/:id/add-object', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getDevice(id)) return reply.code(404).send({ error: 'device_not_found' });
    const body = (req.body ?? {}) as { objectName?: unknown; parameterKey?: unknown };
    const objectName = typeof body.objectName === 'string' ? body.objectName.trim() : '';
    if (!objectName) return reply.code(400).send({ error: 'object_name_required' });
    if (!/^[\w\.\-:]{1,512}$/.test(objectName)) return reply.code(400).send({ error: 'invalid_object_name' });
    const parameterKey = typeof body.parameterKey === 'string' ? body.parameterKey.slice(0, 128) : '';
    const key = parameterKey || `ao_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    db.createTask(key, id, 'add_object', { objectName, parameterKey: key }, 24 * 60 * 60 * 1000);
    enqueueAddObject(ctx, id, objectName, key);
    db.addEvent(id, 'task', 'AddObject diantrekan');
    emitWebhook('task', `AddObject diantrekan untuk ${id}`, { deviceId: id, action: 'add_object', objectName });
    return reply.send({ task: key, queued: ctx.queue.size(id) });
  });

  /* ---------------------------------------------------------------- *
   * Konfigurasi terstruktur perangkat.
   *
   * Satu endpoint untuk operasi yang paling sering dilakukan teknisi:
   * ganti SSID/sandi WiFi, isi kredensial PPPoE, set VLAN, dan menambah
   * koneksi WAN PPPoE/IP baru. Semua jalannya SetParameterValues /
   * AddObject — TANPA reboot dan tanpa factory reset, karena perintah
   * itu akan memutus pelanggan yang sedang berjalan.
   *
   * Path ditentukan di server (configure.ts) dengan formula multi-varian
   * per vendor, jadi teknisi cukup mengisi nilai — tidak perlu hafal
   * apakah perangkat memakai X_ZTE-COM_VLANID atau X_CMCC_VLANIDMark.
   * ---------------------------------------------------------------- */
  app.post('/api/devices/:id/config', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getDevice(id)) return reply.code(404).send({ error: 'device_not_found' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const type = typeof body.type === 'string' ? body.type : '';
    const allowed = new Set<string>(CONFIG_TYPES);
    if (!allowed.has(type)) return reply.code(400).send({ error: 'type_invalid', allowed: [...allowed] });

    const report = applyConfig(ctx, db, id, body as unknown as ConfigRequest);
    if (report.queued > 0) {
      db.addEvent(id, 'task', `Konfigurasi ${type} diantrekan: ${report.plan.join('; ')}`);
      emitWebhook('task', `Konfigurasi ${type} untuk ${id}`,
        { deviceId: id, action: 'config', type });
    }
    if (report.queued > 0) return reply.send(report);
    // UI menampilkan `error` dari respons non-2xx — isi dengan alasan nyata.
    return reply.code(400).send({ ...report, error: report.skipped.join('; ') || 'tidak ada perubahan yang diantrekan' });
  });

  app.post('/api/devices/:id/delete-object', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!db.getDevice(id)) return reply.code(404).send({ error: 'device_not_found' });
    const body = (req.body ?? {}) as { objectName?: unknown; parameterKey?: unknown };
    const objectName = typeof body.objectName === 'string' ? body.objectName.trim() : '';
    if (!objectName) return reply.code(400).send({ error: 'object_name_required' });
    if (!/^[\w\.\-:]{1,512}$/.test(objectName)) return reply.code(400).send({ error: 'invalid_object_name' });
    const parameterKey = typeof body.parameterKey === 'string' ? body.parameterKey.slice(0, 128) : '';
    const key = parameterKey || `do_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    db.createTask(key, id, 'delete_object', { objectName, parameterKey: key }, 24 * 60 * 60 * 1000);
    enqueueDeleteObject(ctx, id, objectName, key);
    db.addEvent(id, 'task', 'DeleteObject diantrekan');
    emitWebhook('task', `DeleteObject diantrekan untuk ${id}`, { deviceId: id, action: 'delete_object', objectName });
    return reply.send({ task: key, queued: ctx.queue.size(id) });
  });


  /** JSON field DB -> array; rusak atau null -> [] (jangan pernah lempar). */
  function parseArr<T>(raw: string | null | undefined): T[] {
    if (!raw) return [];
    try {
      const v: unknown = JSON.parse(raw);
      return Array.isArray(v) ? (v as T[]) : [];
    } catch {
      return [];
    }
  }

  /* ---------------- presets ---------------- */

  /**
   * Ubah baris DB mentah menjadi bentuk kontrak API.
   *
   * Tanpa langkah ini UI menerima `interval_hours` dan string JSON mentah
   * sehingga baris tampil "jam" tanpa angka dan badge kondisi menampilkan
   * panjang karakter string (50, 81) bukan jumlah kondisi. Bentuk kambing
   * hitamnya bukan UI: kontrak yang saya buat sendiri memakai camelCase dan
   * array, jadi API-lah yang wajib menepatinya.
   */
  const presetOut = (row: PresetRow) => ({
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1 ? 1 as const : 0 as const,
    priority: row.priority,
    intervalHours: row.interval_hours,
    conditions: parseArr<PresetCondition>(row.conditions),
    actions: parseArr<PresetAction>(row.actions),
    lastAppliedAt: row.last_applied_at ?? null,
    appliedCount: row.applied_count ?? 0,
    createdAt: row.created_at,
  });

  app.get('/api/presets', async (_req, reply) => {
    return reply.send({ items: db.listPresets().map(presetOut) });
  });

  app.post('/api/presets', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return reply.code(400).send({ error: 'name_required' });

    const conditions = Array.isArray(b.conditions) ? b.conditions as PresetCondition[] : [];
    const actions = Array.isArray(b.actions) ? b.actions as PresetAction[] : [];
    const errs = validatePreset({ conditions, actions });
    if (errs.length) return reply.code(400).send({ error: 'invalid_preset', details: errs });

    const id = db.createPreset({
      name,
      enabled: b.enabled === 0 ? 0 : 1,
      priority: typeof b.priority === 'number' ? b.priority : 100,
      interval_hours: typeof b.intervalHours === 'number' ? b.intervalHours : 24,
      conditions: JSON.stringify(conditions),
      actions: JSON.stringify(actions),
    });
    db.addEvent(null, 'preset', `Preset dibuat: ${name}`);
    emitWebhook('preset', `Preset dibuat: ${name}`, { preset: name });
    const created = db.getPreset(id);
    if (!created) return reply.code(500).send({ error: 'preset_not_created' });
    return reply.code(201).send(presetOut(created));
  });

  app.put('/api/presets/:id', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const id = Number((req.params as { id: string }).id);
    const old = db.getPreset(id);
    if (!old) return reply.code(404).send({ error: 'preset_not_found' });

    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : old.name;
    if (!name) return reply.code(400).send({ error: 'name_required' });

    const conditions = Array.isArray(b.conditions) ? b.conditions as PresetCondition[] : JSON.parse(old.conditions);
    const actions = Array.isArray(b.actions) ? b.actions as PresetAction[] : JSON.parse(old.actions);
    const errs = validatePreset({ conditions, actions });
    if (errs.length) return reply.code(400).send({ error: 'invalid_preset', details: errs });

    db.updatePreset(id, {
      name,
      enabled: b.enabled === undefined ? old.enabled : (b.enabled === 0 ? 0 : 1),
      priority: typeof b.priority === 'number' ? b.priority : old.priority,
      interval_hours: typeof b.intervalHours === 'number' ? b.intervalHours : old.interval_hours,
      conditions: JSON.stringify(conditions),
      actions: JSON.stringify(actions),
    });
    db.addEvent(null, 'preset', `Preset diubah: ${name}`);
    emitWebhook('preset', `Preset diubah: ${name}`, { preset: name });
    const updated = db.getPreset(id);
    if (!updated) return reply.code(404).send({ error: 'preset_not_found' });
    return reply.send(presetOut(updated));
  });

  app.delete('/api/presets/:id', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const id = Number((req.params as { id: string }).id);
    const old = db.getPreset(id);
    if (!old) return reply.code(404).send({ error: 'preset_not_found' });
    db.deletePreset(id);
    db.addEvent(null, 'preset', `Preset dihapus: ${old.name}`);
    emitWebhook('preset', `Preset dihapus: ${old.name}`, { preset: old.name });
    return reply.code(204).send();
  });

  app.post('/api/presets/:id/apply', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const id = Number((req.params as { id: string }).id);
    const p = db.getPreset(id);
    if (!p) return reply.code(404).send({ error: 'preset_not_found' });

    const devices = db.listDevices({ limit: 10000 }).rows;
    let totalMatched = 0;
    let totalQueued = 0;

    for (const d of devices) {
      // { force: true } memaksa melewati pengecekan interval_hours, karena
      // tombol manual dipakai admin yang sengaja ingin menerapkan ulang.
      const res = applyPresets(ctx, db, d.id, { force: true });
      totalMatched += res.matched > 0 ? 1 : 0;
      totalQueued += res.queued;
    }
    return reply.send({ matched: totalMatched, queued: totalQueued });
  });

  app.get('/api/tasks', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    return reply.send({ items: db.listTasks(q['device'], 100) });
  });

  app.get('/api/events', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Number(q['limit'] ?? 200);
    return reply.send({
      items: db.listEvents({
        deviceId: q['device'],
        limit: Number.isFinite(limit) ? Math.min(limit, 1000) : 200,
      }),
    });
  });

  /* ---------------- catalog & stats ---------------- */

  /**
   * Bandingkan dua katalog parameter — berguna menilai selisih antara
   * katalog bawaan vs hasil impor (mis. paimo54). Membandingkan per model
   * dan per path, menandai yang sama / hanya di satu sisi.
   *
   * Body: { a?: CatalogObject, b?: CatalogObject }
   *   - tanpa a/b: memakai katalog aktif vs katalog bawaan (default)
   */
  app.post('/api/catalog/compare', async (req, reply) => {
    const body = (req.body ?? {}) as { a?: unknown; b?: unknown };
    const active = loadCatalog();
    // Default: katalog aktif vs katalog bawaan (file di repo, bila ada).
    let builtin: unknown = null;
    if (CATALOG_FILE) {
      try {
        builtin = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'));
      } catch { builtin = null; }
    }

    const a = body.a !== undefined ? body.a : (builtin ?? active);
    const b = body.b !== undefined ? body.b : active;

    function modelPaths(cat: unknown): Map<string, Set<string>> {
      const map = new Map<string, Set<string>>();
      const models = (cat as { models?: { id: string; params?: { path: string }[] }[] })?.models ?? [];
      for (const m of models) {
        map.set(m.id, new Set((m.params ?? []).map((p) => p.path)));
      }
      return map;
    }
    const mapA = modelPaths(a);
    const mapB = modelPaths(b);

    const modelsA = new Set(mapA.keys());
    const modelsB = new Set(mapB.keys());
    const modelOnlyA = [...modelsA].filter((m) => !modelsB.has(m));
    const modelOnlyB = [...modelsB].filter((m) => !modelsA.has(m));
    const modelBoth = [...modelsA].filter((m) => modelsB.has(m));

    const same: string[] = [];
    const diff: { model: string; onlyA: string[]; onlyB: string[] }[] = [];
    for (const m of modelBoth) {
      const aPaths = mapA.get(m) ?? new Set();
      const bPaths = mapB.get(m) ?? new Set();
      const onlyA = [...aPaths].filter((p) => !bPaths.has(p));
      const onlyB = [...bPaths].filter((p) => !aPaths.has(p));
      if (onlyA.length === 0 && onlyB.length === 0) same.push(m);
      else diff.push({ model: m, onlyA, onlyB });
    }

    return reply.send({
      modelOnlyA, modelOnlyB, same, diff,
      summary: {
        modelsA: modelsA.size, modelsB: modelsB.size,
        sameModels: same.length, diffModels: diff.length,
        added: diff.reduce((s, d) => s + d.onlyB.length, 0),
        removed: diff.reduce((s, d) => s + d.onlyA.length, 0),
      },
    });
  });

  app.get('/api/catalog', async (_req, reply) => {
    const cat = loadCatalog();
    return reply.send({
      version: cat.version,
      generatedAt: cat.generatedAt,
      // File yang jadi sumber — operator perlu tahu apakah yang termuat
      // katalog bawaan atau repo parameter luar (ACS_CATALOG).
      source: cat.source,
      standard: cat.standard,
      // params ikut dikirim supaya tampilan "kumpulan lengkap" di UI bisa
      // merendernya tanpa request tambahan per model (totalnya kecil).
      models: cat.models.map((m) => ({
        id: m.id, vendor: m.vendor, productClass: m.productClass,
        dataModel: m.dataModel, notes: m.notes, paramCount: m.params.length,
        params: m.params,
      })),
      counts: {
        tr098: cat.standard['TR-098'].length,
        tr181: cat.standard['TR-181'].length,
        models: cat.models.length,
        params: cat.models.reduce((n, m) => n + m.params.length, 0),
      },
    });
  });

  /**
   * Impor katalog parameter — padanan `mongorestore --db genieacs --drop`
   * untuk ACS ini.
   *
   * Body: { "catalog": <objek dengan bentuk sama seperti models.json> }
   *
   * Struktur divalidasi SEBELUM menimpa, file ditulis atomik dengan
   * cadangan .bak, lalu cache di-refresh paksa sehingga langsung terbaca.
   *
   * Sengaja TIDAK menerima URL untuk diambil server: mengunduh dari alamat
   * yang dikirim klien membuka celah SSRF. Mengambil repo eksternal tetap
   * lewat `git clone` di host, lalu arahkan ACS_CATALOG.
   */
  app.post('/api/catalog/import', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });

    const body = (req.body ?? {}) as { catalog?: unknown };
    if (!('catalog' in body)) {
      return reply.code(400).send({ error: 'catalog_required', hint: 'kirim {"catalog": {...}}' });
    }

    const { report, clean } = validateCatalog(body.catalog);
    if (!report.ok) {
      return reply.code(400).send({
        error: 'invalid_catalog',
        fatal: report.fatal,
        warnings: report.warnings,
      });
    }

    const target = catalogWritePath();
    try {
      writeCatalogFile(clean, target);
    } catch (e) {
      return reply.code(500).send({
        error: 'write_failed',
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    const cat = loadCatalog(true);
    db.addEvent(null, 'catalog',
      `Katalog diimpor (${report.counts.tr098} TR-098, ${report.counts.tr181} TR-181, ` +
      `${report.counts.models} model) → ${target}`);

    return reply.send({
      ok: true,
      target,
      source: cat.source,
      counts: report.counts,
      // Berapa entri dibuang + alasannya, supaya impor yang "berhasil
      // sebagian" tidak disalahartikan sebagai impor penuh.
      dropped: report.warnings.length,
      warnings: report.warnings.slice(0, 50),
      degraded: cat.degraded,
    });
  });

  app.get('/api/catalog/models/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const cat = loadCatalog();
    const m = cat.models.find((x) => x.id === id);
    if (!m) return reply.code(404).send({ error: 'model_not_found' });
    return reply.send(m);
  });

  app.get('/api/catalog/search', async (req, reply) => {
    const q = ((req.query as Record<string, string>).q ?? '').toLowerCase();
    if (!q) return reply.send({ items: [] });
    const cat = loadCatalog();
    const items: { path: string; label: string; type: string; source: string; model?: string }[] = [];
    for (const std of [cat.standard['TR-098'], cat.standard['TR-181']]) {
      for (const p of std) {
        if (p.path.toLowerCase().includes(q) || p.label.toLowerCase().includes(q)) {
          items.push({ path: p.path, label: p.label, type: p.type, source: 'standard' });
        }
      }
    }
    for (const m of cat.models) {
      for (const p of m.params) {
        if (p.path.toLowerCase().includes(q) || p.label.toLowerCase().includes(q)) {
          items.push({ path: p.path, label: p.label, type: p.type, source: p.source ?? 'standard', model: m.id });
        }
      }
    }
    return reply.send({ items: items.slice(0, 200), total: items.length });
  });

  app.get('/api/stats', async (_req, reply) => {
    const counts = db.countDevices();
    const events = db.listEvents({ limit: 20 });
    const classes = db.listDiscoveredProductClasses();
    return reply.send({
      devices: counts,
      queue: ctx.queue.size(),
      sessions: ctx.sessions.size,
      recentEvents: events,
      discoveredClasses: classes,
    });
  });

  /* ---------------- pengaturan sistem (.env) ---------------- */

  app.get('/api/settings', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const envFile = '/opt/acs/.env';
    const config: Record<string, string> = {
      ACS_DB: process.env.ACS_DB ?? '',
      ACS_BIND: process.env.ACS_BIND ?? '',
      ACS_CWMP_PORT: process.env.ACS_CWMP_PORT ?? '',
      ACS_API_PORT: process.env.ACS_API_PORT ?? '',
      ACS_ENABLE_CWMP: process.env.ACS_ENABLE_CWMP ?? '1',
      ACS_ENABLE_NBI: process.env.ACS_ENABLE_NBI ?? '1',
      ACS_ENABLE_UI: process.env.ACS_ENABLE_UI ?? '1',
      ACS_SESSION_TTL: process.env.ACS_SESSION_TTL ?? '8',
      ACS_CWMP_CREDENTIALS: process.env.ACS_CWMP_CREDENTIALS ?? '',
      ACS_CATALOG: process.env.ACS_CATALOG ?? '',
    };
    if (existsSync(envFile)) {
      const raw = readFileSync(envFile, 'utf8').split('\n');
      for (const line of raw) {
        if (!line || line.startsWith('#')) continue;
        const i = line.indexOf('=');
        if (i > 0) {
          const k = line.slice(0, i).trim();
          if (config[k] !== undefined) config[k] = line.slice(i + 1).trim();
        }
      }
    }
    return reply.send(config);
  });

  app.put('/api/settings', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const envFile = '/opt/acs/.env';
    if (!existsSync(envFile)) return reply.code(404).send({ error: 'env_not_found', message: 'Pengaturan hanya didukung di instalasi CT/VPS (file .env tidak ada)' });

    const b = (req.body ?? {}) as Record<string, string>;
    // Whitelist: hanya kunci ini yang boleh diubah dari UI. Tanpa ini, body
    // arbitrer bisa menimpa ACS_ADMIN_PASSWORD atau mengalihkan ACS_DB.
    const ALLOWED = new Set([
      'ACS_CWMP_PORT', 'ACS_API_PORT', 'ACS_BIND', 'ACS_SESSION_TTL',
      'ACS_ENABLE_CWMP', 'ACS_ENABLE_NBI', 'ACS_ENABLE_UI',
      'ACS_CWMP_CREDENTIALS', 'ACS_CATALOG', 'ACS_LOG_LEVEL',
    ]);
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(b)) {
      if (ALLOWED.has(k) && typeof v === 'string') patch[k] = v.slice(0, 512);
    }
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: 'no_allowed_fields' });
    }

    const raw = readFileSync(envFile, 'utf8').split('\n');
    const newLines: string[] = [];
    const keysSet = new Set<string>();

    for (const line of raw) {
      const i = line.indexOf('=');
      if (i > 0 && !line.startsWith('#')) {
        const k = line.slice(0, i).trim();
        if (patch[k] !== undefined) {
          newLines.push(`${k}=${patch[k]}`);
          keysSet.add(k);
          continue;
        }
      }
      newLines.push(line);
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!keysSet.has(k) && v !== '') newLines.push(`${k}=${v}`);
    }

    writeFileSync(envFile, newLines.join('\n'));
    db.addEvent(null, 'settings', 'Konfigurasi sistem diubah dari UI');
    emitWebhook('settings', 'Konfigurasi sistem diubah');
    return reply.send({ ok: true, note: 'Tersimpan. Lakukan systemctl restart acs agar aktif.' });
  });

  /* ---------------- admin: user ---------------- */

  app.post('/api/users', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown; role?: unknown };
    const username = typeof body.username === 'string' ? body.username.trim().slice(0, 64) : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) return reply.code(400).send({ error: 'invalid_username' });
    if (password.length < 12) return reply.code(400).send({ error: 'password_too_short', min: 12 });
    if (db.getUser(username)) return reply.code(409).send({ error: 'user_exists' });
    const role = body.role === 'admin' ? 'admin' : 'operator';
    db.createUser(username, await hashPassword(password), role);
    db.addEvent(null, 'user', `User dibuat: ${username} (${role})`);
    emitWebhook('user', `User dibuat: ${username} (${role})`, { username, role });
    return reply.code(201).send({ username, role });
  });

  /* ---------------- admin: webhook ---------------- */

  // Validasi URL target: hanya http/https, dan tidak boleh menunjuk ke
  // diri sendiri (protokol+host+port ACS) — kalau dibiarkan, webhook bisa
  // memanggil API-nya sendiri dan bermutasi data, atau jadi loop tak
  // berujung saat target mati.
  const WEBHOOK_EVENTS = new Set([
    'inform', 'login', 'login_failed', 'task', 'preset', 'catalog',
    'user', 'reboot', 'factory_reset', 'gpv_error', 'spv_error',
    'fault', 'transfer', 'device_added', 'device_offline',
  ]);

  function validWebhookUrl(url: string, self: URL): boolean {
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.hostname === self.hostname && (u.port || '80') === (self.port || '80')) return false;
    return true;
  }

  function parseWebhookBody(body: unknown): {
    name?: string; url?: string; secret?: string; events?: string[]; enabled?: number;
  } | null {
    const b = (body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 64) : undefined;
    const url = typeof b.url === 'string' ? b.url.trim().slice(0, 2048) : undefined;
    const secret = typeof b.secret === 'string' ? b.secret.slice(0, 128) : undefined;
    let events: string[] | undefined;
    if (Array.isArray(b.events)) {
      events = (b.events as unknown[]).filter((e): e is string => typeof e === 'string').slice(0, 50);
      // Setelah filter, hanya jenis yang dikenali yang disimpan.
      events = events.length === 0 ? [] : events.filter((e) => WEBHOOK_EVENTS.has(e));
    }
    let enabled: number | undefined;
    if (typeof b.enabled === 'boolean') enabled = b.enabled ? 1 : 0;
    return { name, url, secret, events, enabled };
  }

  function webhookToClient(w: WebhookRow) {
    // Secret TIDAK pernah dikembalikan ke klien (UI menampilkan placeholder).
    const { secret: _secret, ...rest } = w;
    return rest;
  }

  app.get('/api/webhooks', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const rows = db.listWebhooks().map(webhookToClient);
    return reply.send({ items: rows, stats: dispatcher?.stats() ?? null });
  });

  app.post('/api/webhooks', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const b = parseWebhookBody(req.body);
    if (!b?.name || !b.url) return reply.code(400).send({ error: 'name_dan_url_wajib' });
    const self = new URL('http://' + req.headers.host);
    if (!validWebhookUrl(b.url, self)) return reply.code(400).send({ error: 'url_tidak_valid' });
    const events = JSON.stringify(b.events ?? []);
    const id = db.createWebhook({
      name: b.name, url: b.url, secret: b.secret ?? '', events, enabled: b.enabled ?? 1,
    });
    db.addEvent(null, 'webhook', `Webhook "${b.name}" dibuat: ${b.url}`);
    return reply.code(201).send({ id });
  });

  app.put('/api/webhooks/:id', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id) || !db.getWebhook(id)) return reply.code(404).send({ error: 'not_found' });
    const b = parseWebhookBody(req.body);
    if (!b) return reply.code(400).send({ error: 'bad_body' });
    if (b.url) {
      const self = new URL('http://' + req.headers.host);
      if (!validWebhookUrl(b.url, self)) return reply.code(400).send({ error: 'url_tidak_valid' });
    }
    db.updateWebhook(id, {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.url !== undefined ? { url: b.url } : {}),
      ...(b.secret !== undefined && b.secret !== '' ? { secret: b.secret } : {}),
      ...(b.events !== undefined ? { events: JSON.stringify(b.events) } : {}),
      ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
    });
    const w = db.getWebhook(id)!;
    db.addEvent(null, 'webhook', `Webhook "${w.name}" diubah`);
    return reply.send({ ok: true });
  });

  app.delete('/api/webhooks/:id', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const id = Number((req.params as { id?: string }).id);
    const w = db.getWebhook(id);
    if (!w) return reply.code(404).send({ error: 'not_found' });
    db.deleteWebhook(id);
    db.addEvent(null, 'webhook', `Webhook "${w.name}" dihapus`);
    return reply.send({ ok: true });
  });

  app.post('/api/webhooks/:id/test', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const id = Number((req.params as { id?: string }).id);
    if (!dispatcher || !db.getWebhook(id)) return reply.code(404).send({ error: 'not_found' });
    try {
      const entry = await dispatcher.sendTest(id);
      return reply.send({ entry });
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : 'test_gagal' });
    }
  });

  app.get('/api/webhooks/log', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    return reply.send({ items: dispatcher?.recentLog(100) ?? [] });
  });

  app.get('/api/users', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const rows = db.db.prepare('SELECT username, role, created_at, last_login_at FROM users ORDER BY username').all();
    return reply.send({ items: rows });
  });

  // Hapus pengguna (dipakai halaman Setelan; sebelumnya route ini tidak ada
  // sehingga tombol hapus selalu 404).
  app.delete('/api/users/:username', async (req, reply) => {
    if (req.authUser?.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
    const { username } = req.params as { username: string };
    if (username === req.authUser.username) {
      return reply.code(400).send({ error: 'Tidak bisa menghapus akun yang sedang dipakai' });
    }
    const u = db.getUser(username);
    if (!u) return reply.code(404).send({ error: 'Pengguna tidak ditemukan' });
    if (u.role === 'admin') {
      const admins = (db.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
      if (admins <= 1) return reply.code(400).send({ error: 'Admin terakhir tidak bisa dihapus' });
    }
    db.db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
    db.db.prepare('DELETE FROM users WHERE username = ?').run(username);
    db.addEvent(null, 'user', `Pengguna ${username} dihapus oleh ${req.authUser.username}`);
    return reply.send({ ok: true });
  });
}
