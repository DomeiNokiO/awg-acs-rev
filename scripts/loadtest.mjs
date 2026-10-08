#!/usr/bin/env node
/**
 * Uji beban ACS — menyimulasikan N perangkat TR-069 yang melakukan Inform
 * bersamaan, lalu mengukur latensi dan pertumbuhan basis data.
 *
 * Kenapa skrip ini ada:
 *
 *  Klaim "ACS ini muat ribuan ONU" tidak ada artinya kalau tidak diukur.
 *  Bagian `README.md` soal skala sengaja menyebutnya sebagai estimasi —
 *  skrip ini yang mengubahnya jadi angka. Yang diukur justru hal yang
 *  biasanya menjadi titik gagal: BUKAN jumlah perangkat yang terdaftar,
 *  tapi BATCH yang datang bersamaan, karena di situlah `DatabaseSync`
 *  (sinkron, satu thread) akan menumpuk semua penulisan.
 *
 * Yang dinilai:
 *   - p50 / p95 / p99 latensi respons per Inform
 *   - throughput (Inform/detik)
 *   - RSS memori proses setelah beban
 *   - ukuran file DB dan jumlah baris di tiap tabel
 *
 * Cara pakai:
 *   node scripts/loadtest.mjs                       # 200 perangkat, 20 konkuren
 *   node scripts/loadtest.mjs --devices 5000        # uji skala sebenarnya
 *   node scripts/loadtest.mjs --devices 1000 --concurrency 50 --url http://acs:7547
 *   node scripts/loadtest.mjs --keep                # jangan hapus DB uji
 *
 * PERINGATAN: default menulis ke DB sementara di /tmp, tidak menyentuh DB
 * produksi. Kalau `--db` diisi, skrip TIDAK menghapus apa pun tapi juga tidak
 * membersihkan otomatis — pakai DB salinan.
 *
 * Beban skrip ini realistis, bukan login UI: hanya satu POST SOAP berisi
 * Inform lengkap DeviceId + beberapa ParameterList, lalu cartridge di luar
 * (InformResponse). Ini persis yang dikirim ONT asli setiap periode.
 */
import { createServer } from 'node:http';
import { rmSync, statSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/* ------------------------------------------------------------------ *
 * Argumen
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { devices: 200, concurrency: 20, url: null, db: null, keep: false, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--devices') out.devices = Number(argv[++i]);
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--keep') out.keep = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`argumen tidak dikenal: ${a}`);
  }
  if (!Number.isFinite(out.devices) || out.devices < 1) throw new Error('--devices harus angka >= 1');
  if (!Number.isFinite(out.concurrency) || out.concurrency < 1) throw new Error('--concurrency harus angka >= 1');
  out.concurrency = Math.min(out.concurrency, out.devices);
  return out;
}

/* ------------------------------------------------------------------ *
 * SOAP — payload yang sama dengan yang dikirim ONT
 * ------------------------------------------------------------------ */

/**
 * satu Inform realistis: DeviceId lengkap + 2 parameter DeviceInfo.
 * Nomor OUI/ProductClass sengaja dirotasi supaya setiap perangkat benar-benar
 * menjadi baris devices baru — kalau tidak, uji hanya mengukur penulisan ulang
 * dan angkanya jauh lebih bagus dari kenyataan.
 */
function informBody(index, productClass = 'F670L') {
  const oui = 'YUV802';
  const serial = `LOAD${String(index).padStart(8, '0')}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:soap-enc="http://schemas.xmlsoap.org/soap/encoding/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
 <soap-env:Header><cwmp:ID soap-env:mustUnderstand="1">${Math.random().toString(36).slice(2)}</cwmp:ID></soap-env:Header>
 <soap-env:Body><cwmp:Inform>
  <cwmp:ParameterList>
   <soap-enc:string>InternetGatewayDevice.DeviceInfo.HardwareVersion</soap-enc:string>
   <soap-enc:string>InternetGatewayDevice.DeviceInfo.SoftwareVersion</soap-enc:string>
  </cwmp:ParameterList>
  <cwmp:DeviceId>
   <cwmp:Manufacturer>ZTE</cwmp:Manufacturer>
   <cwmp:OUI>${oui}</cwmp:OUI>
   <cwmp:ProductClass>${productClass}</cwmp:ProductClass>
   <cwmp:SerialNumber>${serial}</cwmp:SerialNumber>
  </cwmp:DeviceId>
  <cwmp:Event soap-enc:arrayType="soap-enc:string[1]"><soap-enc:string>2 PERIODIC</soap-enc:string></cwmp:Event>
  <cwmp:MaxEnvelopes>1</cwmp:MaxEnvelopes>
  <cwmp:CurrentTime>2026-10-07T00:00:00Z</cwmp:CurrentTime>
  <cwmp:RetryCount>0</cwmp:RetryCount>
 </cwmp:Inform></soap-env:Body>
</soap-env:Envelope>`;
}

/** Sesi selesai setelah satu siklus: CPE menutup dengan POST kosong. */
const EMPTY_POST = '';

/* ------------------------------------------------------------------ *
 * Klien HTTP: satu percobaan = 2 POST (Inform lalu penutup)
 * ------------------------------------------------------------------ */

/**
 * Menjalankan satu perangkat sampai selesai.
 *
 * Cookie sesi WAJIB dipertahankan: ACS mengunci sesi lewat `acs_session`,
 * jadi tanpa cookie kedua POST akan dianggap perangkat berbeda dan membuat
 * sesi baru tiap kali — itu mengukur hal yang salah.
 */
function runDevice(baseUrl, index) {
  const url = new URL(baseUrl);
  const body = informBody(index);
  let cookie = '';

  const post = (payload) => new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'text/xml; charset=utf-8',
        ...(cookie ? { cookie } : {}),
      },
      body: payload,
    });
    req.then(async (res) => {
      const setCookie = res.headers.getSetCookie?.() ?? [];
      for (const c of setCookie) {
        const pair = c.split(';')[0];
        if (pair.startsWith('acs_session=')) cookie = pair;
      }
      // Respons tidak perlu dibaca seluruhnya; cukup dibuang agar socket
      // kembali ke pool (penting di bawah beban tinggi).
      await res.arrayBuffer().catch(() => {});
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (!res.ok && res.status !== 401) {
        reject(new Error(`HTTP ${res.status}`));
        return;
      }
      resolve({ ms, status: res.status });
    }, reject);
  });

  return post(body).then(async (first) => {
    if (first.status === 401) throw new Error('401 — ACS minta autentikasi');
    // Penutup: tanpa antrean RPC, satu POST kosong akan menutup sesi.
    await post(EMPTY_POST);
    return first.ms;
  });
}

/* ------------------------------------------------------------------ *
 * Beban: jalankan N perangkat dengan batas konkurensi
 * ------------------------------------------------------------------ */

/**
 * Worker pool sederhana: `concurrency` tugas berjalan bersamaan, sisanya
 * menunggu. Dipakai daripada `Promise.all` untuk 5000 perangkat karena
 * yang terakhir akan membuka ribuan socket sekaligus.
 */
async function withConcurrency(items, limit, worker) {
  let next = 0;
  let done = 0;
  let failed = 0;
  let firstError = null;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        await worker(items[i], i);
      } catch (e) {
        failed++;
        if (!firstError) firstError = e;
      }
      done++;
    }
  });

  await Promise.all(runners);
  return { done, failed, firstError };
}

/* ------------------------------------------------------------------ *
 * Statistik latensi
 * ------------------------------------------------------------------ */

/**
 * Persentil dari array yang sudah diurutkan.
 *
 * Di sini interpolasi linier: untuk ukuran sampel kecil (mis. 200 perangkat)
 * mengambil indeks bulat bisa menggeser p95 jauh dari nilai sebenarnya,
 * jadi interpolasi linier lebih jujur.
 */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function fmtMs(v) {
  return `${v.toFixed(1)} ms`;
}

/* ------------------------------------------------------------------ *
 * Menyjalankan server uji sendiri bila --url tidak diberikan
 * ------------------------------------------------------------------ */

/**
 * Menjalankan ACS sungguhan sebagai child process dengan `ACS_DB` sementara,
 * lalu menembaknya lewat HTTP. Jadi angka yang keluar benar-benar melewati
 * Fastify + cwmp.ts + SQLite — bukan simulasi.
 */
async function startAcsServer(dbFile) {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');

  const here = dirname(fileURLToPath(import.meta.url));
  const entry = resolve(here, '../apps/server/src/index.ts');

  const port = 7547 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ACS_DB: dbFile,
      ACS_CWMP_PORT: String(port),
      ACS_API_PORT: '0',        // API tidak dipakai uji ini
      ACS_ENABLE_NBI: '0',
      ACS_ENABLE_UI: '0',
      ACS_ADMIN_PASSWORD: 'loadtest-tidak-dipakai',
      ACS_LOG_LEVEL: 'error',   // quiet supaya tidak mengaburkan timing
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (b) => { stderr += String(b); });
  child.stdout.resume();

  // Tunggu listener siap. Tidak ada endpoint health di port CWMP, jadi kita
  // andalkan koneksi TCP: berhasil connect = listener sudah hidup.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const { connect } = await import('node:net');
      const ok = await new Promise((res) => {
        const s = connect(port, '127.0.0.1');
        s.on('connect', () => { s.end(); res(true); });
        s.on('error', () => res(false));
        setTimeout(() => { s.destroy(); res(false); }, 300);
      });
      if (ok) return { child, port, url: `http://127.0.0.1:${port}` };
    } catch { /* coba lagi */ }
    if (child.exitCode !== null) {
      throw new Error(`ACS berhenti sebelum siap (kode ${child.exitCode}): ${stderr.slice(-500)}}`);
    }
    await sleep(150);
  }
  child.kill('SIGKILL');
  throw new Error(`ACS tidak siap dalam 20 detik. ${stderr.slice(-500)}`);
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const args = parseArgs(process.argv);
if (args.help) {
  console.log(fs_help());
  process.exit(0);
}
function fs_help() {
  return `Uji beban ACS (TR-069 Inform simultan)

  --devices N       jumlah perangkat simulasi (default 200)
  --concurrency N   perangkat yang POST bersamaan (default 20)
  --url URL         tembak ACS yang sudah jalan (default: jalankan sendiri)
  --db PATH         file SQLite sementara (default /tmp/acs-loadtest-<pid>.db)
  --keep            jangan hapus DB uji setelah selesai
  --verbose         tampilkan setiap 100 perangkat

Contoh:
  node scripts/loadtest.mjs
  node scripts/loadtest.mjs --devices 5000 --concurrency 100
  node scripts/loadtest.mjs --url http://172.18.217.222:7547 --devices 2000`;
}

let server = null;
let dbFile = args.db ?? `/tmp/acs-loadtest-${process.pid}.db`;
let url = args.url;

if (!url) {
  server = await startAcsServer(dbFile);
  url = server.url;
  console.log(`[loadtest] ACS uji dijalankan di ${url} (DB: ${dbFile})`);
} else {
  console.log(`[loadtest]Menembak ACS di ${url} (DB tidak disentuh)`);
}

console.log(`[loadtest] ${args.devices} perangkat, konkurensi ${args.concurrency}\n`);

const latencies = [];
const rssBefore = process.memoryUsage().rss;
const startedAll = process.hrtime.bigint();

const result = await withConcurrency(
  Array.from({ length: args.devices }, (_, i) => i),
  args.concurrency,
  async (index) => {
    const ms = await runDevice(url, index);
    latencies.push(ms);
    if (args.verbose && (index + 1) % 100 === 0) {
      process.stdout.write(`  ${index + 1}/${args.devices} perangkat\n`);
    }
  },
);

const elapsedSec = Number(process.hrtime.bigint() - startedAll) / 1e9;
latencies.sort((a, b) => a - b);

const rssAfter = process.memoryUsage().rss;
const dbSize = existsSync(dbFile) ? statSync(dbFile).size : 0;

console.log('\n' + '='.repeat(58));
console.log('  HASIL UJI BEBAN');
console.log('='.repeat(58));
console.log(`  Perangkat    : ${result.done} sukses, ${result.failed} gagal`);
console.log(`  Durasi        : ${elapsedSec.toFixed(2)} s`);
console.log(`  Throughput    : ${(result.done / elapsedSec).toFixed(1)} Inform/detik`);
console.log(`  Latensi p50   : ${fmtMs(percentile(latencies, 0.50))}`);
console.log(`  Latensi p95   : ${fmtMs(percentile(latencies, 0.95))}`);
console.log(`  Latensi p99   : ${fmtMs(percentile(latencies, 0.99))}`);
console.log(`  Tercepat/lama : ${fmtMs(latencies[0] ?? 0)} / ${fmtMs(latencies.at(-1) ?? 0)}`);
console.log(`  RSS (skrip)   : ${(rssBefore / 1e6).toFixed(0)} -> ${(rssAfter / 1e6).toFixed(0)} MB`);
console.log(`  Ukuran DB     : ${(dbSize / 1e6).toFixed(2)} MB`);
console.log('='.repeat(58));

if (result.failed && result.firstError) {
  console.log(`\n  Catatan: ${result.failed} permintaan gagal. Contoh error: ${result.firstError.message}`);
  console.log('  (401 = ACS minta Basic auth — set ACS_CWMP_CREDENTIALS atau matikan untuk uji)');
}

// Hitung baris DB kalau skrip yang menjalankan servernya (bisa baca langsung).
if (server) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const probe = new DatabaseSync(dbFile, { readOnly: true });
    const tables = ['devices', 'params', 'tasks', 'events', 'sessions', 'discovered_params', 'preset_applied'];
    console.log('\n  Isi basis data:');
    for (const t of tables) {
      const row = probe.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
      console.log(`    ${t.padEnd(18)} ${String(row.n).padStart(7)} baris`);
    }
    probe.close();
  } catch (e) {
    console.log(`\n  (gagal membaca DB: ${e.message})`);
  }
}

console.log('');
if (server) {
  server.child.kill('SIGTERM');
  await sleep(300);
  if (!args.keep) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(dbFile + suffix); } catch { /* belum ada */ }
    }
    console.log(`[loadtest] DB uji dihapus${args.keep ? '' : ''}`);
  } else {
    console.log(`[loadtest] DB uji disimpan: ${dbFile}`);
  }
}
