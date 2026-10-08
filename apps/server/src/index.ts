/**
 * Entry point ACS.
 *
 * Dua listener dalam satu proses:
 *   :7547  CWMP  — untuk perangkat (TR-069), tanpa auth cookie,
 *                  karena autentikasinya di level HTTP Basic/Digest CPE.
 *   :8080  API   — untuk UI, semua endpoint di belakang sesi login.
 *
 * Pisah port supaya firewall bisa diberi aturan berbeda: 7547 terbuka ke
 * jaringan manajemen ONU, 8080 hanya ke jaringan internal.
 */
import Fastify from 'fastify';
import { Database, TaskQueue, hashPassword } from '@acs/core';
import {
  registerCwmpRoutes, type CwmpContext, enqueueRead, enqueueDiscover as enqueueDiscovery,
  continueDiscovery, collectPaths, PROFILE_VERSION,
} from './cwmp.ts';
import { registerApiRoutes } from './api.ts';
import { loadCatalog } from './catalog.ts';
import { applyPresets, seedDefaultPresets } from './presets.ts';
import { WebhookDispatcher } from './webhooks.ts';
import { loadCredentials } from './cwmp-auth.ts';
import { access } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const DB_FILE = process.env['ACS_DB'] ?? '/root/acs/data/acs.db';
const CWMP_PORT = Number(process.env['ACS_CWMP_PORT'] ?? 7547);
const API_PORT = Number(process.env['ACS_API_PORT'] ?? 8080);
// 0.0.0.0 tetap default agar tidak merusak instalasi lama, tetapi operator
// bisa membatasi ke antarmuka manajemen saja.
const BIND = process.env['ACS_BIND'] ?? '0.0.0.0';

// Saklar port (dipakai installer deploy/install.sh). Default 1 = aktif;
// set 0 untuk menonaktifkan listener tertentu. Berguna saat CT dipakai
// khusus UI (tanpa CWMP) atau khusus API (tanpa UI).
const ENABLE_CWMP = (process.env['ACS_ENABLE_CWMP'] ?? '1') !== '0';
const ENABLE_API = (process.env['ACS_ENABLE_NBI'] ?? '1') !== '0';
const ENABLE_UI = (process.env['ACS_ENABLE_UI'] ?? '1') !== '0';

/**
 * Baca pasangan cert/key bila diset.
 *
 * TR-069 memakai HTTP Basic/Digest, jadi di atas HTTP polos kredensial CPE
 * dan nilai parameter yang dibaca ikut terlihat di jaringan. Env TLS opsional
 * agar instalasi lama tetap jalan, tetapi produksi seharusnya menyalakannya
 * (atau menaruh ACS di balik reverse proxy TLS).
 */
function tlsOptions(prefix: 'ACS_CWMP' | 'ACS_API'): { key: Buffer; cert: Buffer } | undefined {
  const cert = process.env[`${prefix}_TLS_CERT`];
  const key = process.env[`${prefix}_TLS_KEY`];
  if (!cert && !key) return undefined;          // keduanya tidak diset -> HTTP
  if (!cert || !key) {
    // Satu saja diset = konfigurasi salah. Lebih baik gagal saat start
    // daripada diam-diam menjalankan HTTP yang dikira sudah TLS.
    throw new Error(`${prefix}_TLS_CERT dan ${prefix}_TLS_KEY harus diisi berdua`);
  }
  if (!existsSync(cert) || !existsSync(key)) {
    throw new Error(`file TLS tidak ditemukan: cert=${cert} key=${key}`);
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}
async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function main(): Promise<void> {
  loadCatalog();

  const db = new Database(DB_FILE);
  const queue = new TaskQueue();
  const sessions = new Map();
  const webhooks = new WebhookDispatcher(db);
  const credentials = loadCredentials(process.env['ACS_CWMP_CREDENTIALS']);

  const ctx: CwmpContext = { db, queue, sessions, credentials };

  // Preset pertama: hanya dibuat bila admin belum membuat apa pun.
  // Berisi baca data berkala, keamanan dasar, dan Interval Inform —
  // tanpa reboot, tanpa factory reset.
  try { seedDefaultPresets(db); } catch (e) {
    console.error('[preset] seed gagal:', (e as Error).message);
  }

  // Preset dijalankan saat perangkat Inform (dan saat BOOTSTRAP/1 BOOT),
  // sama seperti perilaku GenieACS: begitu ONT mendaftar, konfigurasi
  // otomatis diantrekan tanpa campur tangan operator.
  // Pengumpulan parameter otomatis: begitu perangkat Inform, antrekan
  // GetParameterNames (peta struktur) lalu GetParameterValues (nilai inti).
  //
  // Kenapa otomatis: tanpa ini, detail perangkat hanya berisi DeviceId —
  // tidak ada software version, tidak ada redaman, tidak ada PPPoE, dan
  // tombol "Hubungi" gagal karena ConnectionRequestURL belum pernah dibaca.
  // Pola ini yang membuat ACS langsung "terisi sendiri" begitu ONU masuk.
  //
  // PENTING: hanya GET. Tidak ada Reboot/FactoryReset/SetParameterValues
  // di jalur ini — aman untuk ONU yang sedang dipakai pelanggan.
  const collectIntervalMin = (() => {
    const raw = process.env['ACS_COLLECT_INTERVAL_MIN'];
    const n = Number(raw);
    return Number.isFinite(n) && n >= 5 ? Math.floor(n) : 30;
  })();
  ctx.collectIntervalMin = collectIntervalMin;

  function applyPresetsSafe(deviceId: string, events: string[]): void {
    try {
      const report = applyPresets(ctx, db, deviceId, { events });
      if (report.queued > 0) {
        db.addEvent(deviceId, 'preset',
          `Preset diterapkan: ${report.queued} tugas diantrekan (${report.matched} cocok)`);
        webhooks.emit({
          kind: 'preset', deviceId, message: 'Preset diterapkan otomatis',
          data: { queued: report.queued, matched: report.matched },
        });
      }
    } catch (e) {
      // Kegagalan preset tidak boleh menggagalkan sesi CWMP.
      db.addEvent(deviceId, 'preset_error', `Gagal menerapkan preset: ${(e as Error).message}`);
    }
  }

  ctx.onInform = (deviceId, info) => {
    try {
      // Pemetaan struktur: perangkat baru, atau profil versi lama (sebelum
      // discovery per-perangkat) dipetakan ulang otomatis. Discovery yang
      // belum tamat dilanjutkan dari titik terakhir.
      const col = db.getCollection(deviceId);
      if (!col || (col.profile_version ?? 0) < PROFILE_VERSION) {
        // Pemetaan baru: pembacaan dilakukan oleh discovery itu sendiri
        // (leaf baru dibaca per subtree, path esensial setelah selesai).
        enqueueDiscovery(ctx, deviceId);
        return applyPresetsSafe(deviceId, info.events);
      }
      if (!col.discovery_done) continueDiscovery(ctx, deviceId);

      // Pembacaan parameter: esensial (info + semua varian redaman) ∪
      // profil discovery. Dilakukan bila sudah jatuh tempo, atau bila
      // perangkat baru boot / dipanggil operator (Connection Request) /
      // melaporkan perubahan nilai — saat itulah data segar dibutuhkan.
      const urgent = info.events.some((e) => /^(0|1|4|6) /.test(e));
      const due = !col.next_collect_at || col.next_collect_at <= Date.now();
      if (urgent || due) enqueueRead(ctx, deviceId, collectPaths(ctx, deviceId));
    } catch (e) {
      db.addEvent(deviceId, 'collection_error',
        `Gagal menyiapkan pengumpulan: ${(e as Error).message}`);
    }

    applyPresetsSafe(deviceId, info.events);
  };

  /* ---------------- CWMP listener ---------------- */

  const cwmpTls = tlsOptions('ACS_CWMP');
  const cwmp = Fastify({
    logger: {
      level: process.env['ACS_LOG_LEVEL'] ?? 'info',
      // Jangan log isi body SOAP — berisi kredensial PPPoE pelanggan.
      serializers: {
        req: (r) => ({ method: r.method, url: r.url, ip: r.ip }),
      },
    },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
    ...(cwmpTls ? { https: cwmpTls } : {}),
  });

  registerCwmpRoutes(cwmp, ctx);

  cwmp.get('/', async (_req, reply) =>
    reply.code(405).type('text/plain').send('ACS CWMP endpoint. Gunakan POST SOAP.'));

  /* ---------------- API listener ---------------- */

  const apiTls = tlsOptions('ACS_API');
  const api = Fastify({
    logger: { level: process.env['ACS_LOG_LEVEL'] ?? 'info' },
    // 256 KB terlalu kecil untuk impor/bandingkan katalog (katalog paimo54
    // ~1,5 MB). 10 MB cukup untuk katalog besar sekaligus mencegah
    // penyalahgunaan (bukan maksimal 100 MB+).
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
    ...(apiTls ? { https: apiTls } : {}),
  });

  registerApiRoutes(api, db, ctx, webhooks);

  // Static file UI bila sudah di-build (produksi: satu proses saja).
  // fileURLToPath, bukan URL.pathname: pathname meng-encode spasi (%20)
  // sehingga folder instalasi berisi spasi tidak pernah ditemukan.
  const dist = fileURLToPath(new URL('../../web/out/', import.meta.url));
  if (await pathExists(dist)) {
    // Dynamic import menghasilkan namespace { default }; pakai .default
    // supaya cocok dengan tipe FastifyPluginAsync.
    const staticMod = await import('@fastify/static');
    api.register(staticMod.default, { root: dist, prefix: '/' });

    // Next.js export menghasilkan file per rute: /catalog -> catalog.html.
    // @fastify/static TIDAK melayani URL tanpa ekstensi, jadi /catalog jatuh
    // ke sini. Tanpa langkah ini semua rute membalikkan index.html dan UI
    // selalu menampilkan Dashboard — bug yang sempat terjadi.
    api.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });

      const path = req.url.split('?')[0] ?? '/';
      const clean = path.replace(/^\/+|\/+$/g, '');

      // Validasi PER SEGMEN, bukan untuk seluruh string.
      //
      // Versi lama memakai satu regex yang menolak karakter '/', sehingga
      // semua rute bersarang (/presets/edit) balik 404 padahal filenya ada.
      // Rute harus boleh punya beberapa tingkat, tetapi tiap segmen tetap
      // harus polos: tanpa '..' (traversal), tanpa NUL, tanpa karakter di
      // luar [A-Za-z0-9_.-] supaya tidak bisa keluar dari direktori dist.
      const segs = clean === '' ? [] : clean.split('/');
      const unsafe = segs.some((s) =>
        s === '' || s === '.' || s === '..'
        || s.includes('\\0')
        || !/^[A-Za-z0-9_.\-]+$/.test(s),
      );
      if (unsafe) {
        return reply.code(404).type('text/html').sendFile('404.html');
      }

      const candidate = segs.length === 0 ? 'index.html' : `${segs.join('/')}.html`;

      // Sabuk pengaman kedua: jalur final wajib berada di dalam dist,
      // walau validasi di atas sudah memastikannya.
      const resolved = resolve(dist, candidate);
      if (!resolved.startsWith(resolve(dist))) {
        return reply.code(404).type('text/html').sendFile('404.html');
      }

      if (await pathExists(resolved)) {
        return reply.code(200).type('text/html').sendFile(candidate);
      }
      // Bukan rute yang diekspor -> 404 sungguhan, bukan diam-diam halaman
      // utama. Lebih jujur dan tidak membingungkan saat debugging.
      return reply.code(404).type('text/html').sendFile('404.html');
    });
  }

  /* ---------------- bootstrap admin ---------------- */

  const adminPass = process.env['ACS_ADMIN_PASSWORD'];
  if (!db.getUser('admin')) {
    const pw = adminPass ?? `Acs!${randomBytes(9).toString('base64url')}`;
    db.createUser('admin', await hashPassword(pw), 'admin');
    if (!adminPass) {
      // Tidak ada ACS_ADMIN_PASSWORD → cetak sekali di stdout, jangan simpan.
      console.log('='.repeat(64));
      console.log('  Admin ACS dibuat. Simpan password ini SEKARANG:');
      console.log(`    user: admin`);
      console.log(`    pass: ${pw}`);
      console.log('='.repeat(64));
    }
  }

  setInterval(() => db.purgeExpiredSessions(), 10 * 60 * 1000).unref();

  /* ---------------- scheduler pengumpulan parameter ---------------- */

  // Catatan batch baca lebih tua dari TTL antrean baca sudah pasti basi.
  const READ_BATCH_MAX_AGE_MS = 6 * 60 * 60 * 1000;

  function scheduleCollectionSweep(): void {
    if (!ENABLE_CWMP) return;
    try {
      // RPC hanya bisa dikirim saat perangkat membuka sesi (Inform), dan
      // onInform sudah mengantrekan discovery + pembacaan yang jatuh tempo.
      // Sweep cukup membuang catatan batch baca yang basi supaya tabel
      // read_batch tidak tumbuh tanpa batas.
      db.purgeStaleReadBatches(READ_BATCH_MAX_AGE_MS);
    } catch (e) {
      // Kegagalan penjadwalan tidak boleh menjatuhkan layanan ACS.
      console.error('[collector] siklus gagal:', (e as Error).message);
    }
  }

  // Tick pertama menunda sedikit supaya proses sempat naik dulu.
  setTimeout(scheduleCollectionSweep, 5_000).unref();
  const sweepTimer = setInterval(scheduleCollectionSweep, 60 * 1000);
  sweepTimer.unref();

  console.log(`  Pengumpulan     : otomatis, tiap ${collectIntervalMin} menit per perangkat (baca saja)`);

  if (ENABLE_CWMP) {
    await cwmp.listen({ port: CWMP_PORT, host: BIND });
  }
  if (ENABLE_API || ENABLE_UI) {
    await api.listen({ port: API_PORT, host: BIND });
  } else {
    // API log tetap berguna walau listener mati.
    console.log('  [ACS_ENABLE_NBI/UI=0] listener API/UI tidak dijalankan.');
  }

  const cwmpProto = cwmpTls ? 'https' : 'http';
  const apiProto = apiTls ? 'https' : 'http';
  console.log(`ACS berjalan:`);
  console.log(`  CWMP (perangkat) : ${cwmpProto}://${BIND}:${CWMP_PORT}${cwmpTls ? '  [TLS AKTIF]' : '  [tanpa TLS]'}${ENABLE_CWMP ? '' : '  [NONAKTIF lewat ACS_ENABLE_CWMP]'}`);
  console.log(`  API/UI           : ${apiProto}://${BIND}:${API_PORT}${apiTls ? '  [TLS AKTIF]' : '  [tanpa TLS]'}${ENABLE_API || ENABLE_UI ? '' : '  [NONAKTIF]'}`);
  console.log(`  Database         : ${DB_FILE}`);
  if (!cwmpTls) {
    console.log('  PERINGATAN: CWMP tanpa TLS — kredensial CPE terlihat di jaringan.');
    console.log('              Set ACS_CWMP_TLS_CERT/ACS_CWMP_TLS_KEY atau pakai reverse proxy.');
  }

  const shutdown = async (sig: string) => {
    console.log(`\n[${sig}] menutup...`);
    clearInterval(sweepTimer);
    await Promise.allSettled([cwmp.close(), api.close()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('ACS gagal start:', err);
  process.exit(1);
});
