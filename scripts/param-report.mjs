#!/usr/bin/env node
/**
 * Laporan parameter yang TERBUKTI dipakai ONU di lapangan — per vendor,
 * model (ProductClass), dan firmware. Hasilnya tabel Markdown untuk
 * dokumentasi (docs/PARAMETERS.md) atau dikirim ke pengembang.
 *
 * Pemakaian (di server ACS, sebagai root):
 *   node /opt/acs/scripts/param-report.mjs                 # Markdown ke stdout
 *   node /opt/acs/scripts/param-report.mjs --json          # JSON
 *   ACS_DB=/path/acs.db node scripts/param-report.mjs
 *
 * Hanya membaca database (read-only). Tidak memuat serial number, IP,
 * username PPPoE, maupun nilai sandi — hanya NAMA path dan contoh nilai
 * numerik (CPU %, RAM, redaman).
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { buildInsight, trafficCounters, isPassphraseValue } = await import(join(ROOT, 'apps/server/src/insight.ts'));

function dbPath() {
  if (process.env.ACS_DB) return process.env.ACS_DB;
  const env = join(ROOT, '.env');
  if (existsSync(env)) {
    const m = /^ACS_DB=(.+)$/m.exec(readFileSync(env, 'utf8'));
    if (m) return m[1].trim();
  }
  return join(ROOT, 'data', 'acs.db');
}

const file = dbPath();
if (!existsSync(file)) { console.error(`Database tidak ditemukan: ${file}`); process.exit(1); }
const db = new DatabaseSync(file, { readOnly: true });
const devices = db.prepare('SELECT id, manufacturer, product_class, software_version, data_model FROM devices').all();
const getParams = db.prepare('SELECT path, value, type FROM params WHERE device_id = ?');
const getDiscovered = db.prepare('SELECT path FROM discovered_params WHERE product_class = ?');
/** Status nilai sandi TANPA membocorkan isinya. */
const secretState = (v) => (v === undefined ? 'tidak ada' : v === '' ? 'kosong' : /^[*•]+$/.test(v) ? 'bintang' : isPassphraseValue(v) ? 'terisi' : 'bukan sandi');

/** Bentuk path tanpa nomor instans WAN/WLAN (agar bisa digabung antar ONU). */
const shape = (p) => p?.replace(/(WANConnectionDevice|WANPPPConnection|WANIPConnection|WLANConfiguration|Interface|SSID|AccessPoint)\.\d+\./g, '$1.{i}.') ?? null;
const short = (p) => p?.replace(/^InternetGatewayDevice\./, 'IGD.') ?? '—';

const groups = new Map();
for (const d of devices) {
  const params = getParams.all(d.id);
  if (!params.length) continue;
  const ins = buildInsight(params);
  const ppp = ins.wan.find((c) => c.kind === 'ppp' && c.username) ?? ins.wan.find((c) => c.kind === 'ppp');
  const key = `${d.manufacturer}|${d.product_class}|${d.software_version ?? '?'}`;
  let g = groups.get(key);
  if (!g) {
    g = { vendor: d.manufacturer, model: d.product_class, firmware: d.software_version ?? '?', dataModel: d.data_model ?? ins.dataModel, n: 0,
      cpu: new Map(), mem: new Map(), rx: new Map(), vlan: new Map(), service: new Map(), connType: new Map(), wifiPass: new Map(), traffic: new Map(), samples: [],
      secrets: new Map(), wifiSeen: { onu: 0, hidden: 0 }, pppSeen: { onu: 0, hidden: 0 }, candidates: new Set() };
    for (const r of getDiscovered.all(d.product_class ?? '')) {
      // Kandidat sandi di struktur ONU (nama saja) — untuk menemukan lokasi sandi vendor.
      if (/WLANConfiguration\.\d+\./.test(r.path) && /pass|psk|wpakey/i.test(r.path) && !/WEPKey|Enable$|Mode$/i.test(r.path)) g.candidates.add(shape(r.path));
    }
    groups.set(key, g);
  }
  g.n++;
  const inc = (m, k) => { if (k) m.set(k, (m.get(k) ?? 0) + 1); };
  inc(g.cpu, shape(ins.system.cpuSource));
  inc(g.mem, shape(ins.system.memSource));
  inc(g.rx, ins.optical.source);
  inc(g.vlan, shape(ppp?.vlanPath));
  inc(g.service, shape(ppp?.serviceListPath));
  inc(g.connType, ppp?.connectionType);
  // Diagnostik sandi: per bentuk path → terisi/kosong/bintang (nilai tidak dicetak).
  const byPath = new Map(params.map((p) => [p.path, p.value]));
  for (const w of ins.wlan) {
    for (const p of w.passphrasePaths) inc(g.secrets, `${shape(p)} → ${secretState(byPath.get(p))}`);
  }
  if (ins.wlan.length) g.wifiSeen[ins.wlan.some((w) => w.passphrase) ? 'onu' : 'hidden']++;
  for (const c of ins.wan.filter((x) => x.kind === 'ppp' && x.username)) {
    inc(g.secrets, `${shape(c.passwordPath ?? `${c.base}Password`)} → ${secretState(c.passwordPath ? byPath.get(c.passwordPath) : undefined)}`);
    g.pppSeen[c.password ? 'onu' : 'hidden']++;
  }
  // Semua lokasi sandi yang ada (ACS menulis ke semuanya).
  for (const p of ins.wlan[0]?.passphrasePaths ?? []) inc(g.wifiPass, shape(p));
  // Counter trafik live yang terbukti ada (pasangan pertama yang dipakai).
  const known = new Set(params.map((p) => p.path));
  const tc = trafficCounters(params, ins.dataModel).find((c) => known.has(c.rx) && known.has(c.tx));
  inc(g.traffic, shape(tc?.rx?.replace(/(Bytes)Received$/, '$1{Received,Sent}')));
  if (g.samples.length < 3) {
    g.samples.push({
      cpu: ins.system.cpu, memPct: ins.system.memUsedPct, memTotalMb: ins.system.memTotalKb ? Math.round(ins.system.memTotalKb / 1024) : null,
      rx: ins.optical.rx, rawRx: ins.optical.raw.rx,
    });
  }
}

const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
const rows = [...groups.values()].sort((a, b) => `${a.vendor}${a.model}`.localeCompare(`${b.vendor}${b.model}`));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows.map((g) => ({ ...g, cpu: top(g.cpu), mem: top(g.mem), rx: top(g.rx), vlan: top(g.vlan), service: top(g.service), connType: top(g.connType), wifiPass: top(g.wifiPass), traffic: top(g.traffic), secrets: Object.fromEntries(g.secrets), candidates: [...g.candidates] })), null, 2));
  process.exit(0);
}

const cell = (m) => top(m).map((p) => `\`${short(p)}\``).join('<br>') || '—';
console.log(`# Laporan parameter AWG-ACS — ${new Date().toISOString().slice(0, 10)}\n`);
console.log(`${devices.length} perangkat, ${rows.length} kombinasi vendor/model/firmware.\n`);
console.log('## CPU, RAM, redaman\n');
console.log('| Vendor | Model | Firmware | ONU | CPU | RAM | Redaman RX | Contoh nilai |');
console.log('|---|---|---|---|---|---|---|---|');
for (const g of rows) {
  const s = g.samples[0] ?? {};
  const ex = [s.cpu != null ? `CPU ${s.cpu}%` : null, s.memPct != null ? `RAM ${s.memPct}%${s.memTotalMb ? `/${s.memTotalMb} MB` : ''}` : null,
    s.rx != null ? `RX ${s.rx} dBm (mentah ${s.rawRx})` : null].filter(Boolean).join(', ') || '—';
  console.log(`| ${g.vendor} | ${g.model} | ${g.firmware} | ${g.n} | ${cell(g.cpu)} | ${cell(g.mem)} | ${cell(g.rx)} | ${ex} |`);
}
console.log('\n## WAN & WiFi\n');
console.log('| Vendor | Model | Firmware | VLAN PPPoE | ServiceList | ConnectionType | Sandi WiFi | Counter trafik live |');
console.log('|---|---|---|---|---|---|---|---|');
for (const g of rows) {
  console.log(`| ${g.vendor} | ${g.model} | ${g.firmware} | ${cell(g.vlan)} | ${cell(g.service)} | ${top(g.connType).join(', ') || '—'} | ${cell(g.wifiPass)} | ${cell(g.traffic)} |`);
}

console.log('\n## Sandi (diagnostik — nilai tidak dicetak)\n');
console.log('ONU "terbaca" = ONU mengirim sandi saat dibaca; "disembunyikan" = semua lokasi sandi kosong/bintang (sandi hanya bisa tampil setelah disetel lewat ACS).\n');
console.log('| Vendor | Model | Firmware | WiFi terbaca / disembunyikan | PPPoE terbaca / disembunyikan | Lokasi sandi → status (jumlah) | Kandidat lain di struktur |');
console.log('|---|---|---|---|---|---|---|');
for (const g of rows) {
  const st = [...g.secrets.entries()].sort().map(([k, n]) => `\`${short(k.split(' → ')[0])}\` → ${k.split(' → ')[1]} (${n})`).join('<br>') || '—';
  const known = new Set([...g.secrets.keys()].map((k) => k.split(' → ')[0]));
  const cand = [...g.candidates].filter((c) => !known.has(c)).map((c) => `\`${short(c)}\``).join('<br>') || '—';
  console.log(`| ${g.vendor} | ${g.model} | ${g.firmware} | ${g.wifiSeen.onu} / ${g.wifiSeen.hidden} | ${g.pppSeen.onu} / ${g.pppSeen.hidden} | ${st} | ${cand} |`);
}
