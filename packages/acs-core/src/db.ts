/**
 * Penyimpanan ACS berbasis SQLite bawaan Node (node:sqlite).
 *
 * Kenapa SQLite: satu file, tanpa proses daemon, tanpa dependensi native
 * (npm install tidak perlu kompilasi). Skalanya cukup untuk puluhan ribu
 * perangkat selama ditulis dengan index yang benar — dan kalau nanti perlu
 * pindah ke Postgres, lapisan repo di sini yang diganti, bukan aplikasinya.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DeviceRow {
  id: string;                 // OUI-ProductClass-SerialNumber
  manufacturer: string;
  oui: string;
  product_class: string;
  serial_number: string;
  ip_address: string | null;
  protocol: string | null;
  software_version: string | null;
  hardware_version: string | null;
  connection_request_url: string | null;
  connection_request_user: string | null;
  connection_request_pass: string | null;
  cwmp_user: string | null;   // credential CPE→ACS (opsional, per perangkat)
  cwmp_pass: string | null;
  last_inform_at: number | null;
  registered_at: number;
  tags: string;               // JSON array
  group_name: string | null;
  notes: string | null;
  // Ringkasan operasional (diisi dari GetParameterValues, lihat insight.ts).
  // Disimpan sebagai kolom supaya daftar perangkat tidak perlu membaca
  // seluruh tabel params untuk tiap baris.
  data_model: string | null;  // 'TR-098' | 'TR-181'
  rx_power: number | null;    // dBm, sudah dinormalisasi
  tx_power: number | null;    // dBm
  optical_temp: number | null; // °C
  pppoe_user: string | null;
  pppoe_status: string | null;
  wan_ip: string | null;
  ssid: string | null;
  summary_at: number | null;
  cpu_usage: number | null;   // % beban CPU terakhir
  mem_usage: number | null;   // % RAM terpakai terakhir
  /** 1 = URL/kredensial Connection Request diisi operator (jangan ditimpa). */
  cr_manual: number | null;
  /** Terakhir kali ACS mencoba memasang kredensial Connection Request. */
  cr_provisioned_at: number | null;
}

export interface ParamRow {
  device_id: string;
  path: string;
  value: string;
  type: string;
  updated_at: number;
}

export interface PresetRow {
  id: number;
  name: string;
  enabled: number;
  priority: number;
  interval_hours: number;
  conditions: string;   // JSON array
  actions: string;      // JSON array
  created_at: number;
  applied_count?: number;
  last_applied_at: number | null;
}

export interface EventRow {
  id: number;
  device_id: string | null;
  kind: string;
  message: string;
  created_at: number;
}

export interface CollectionRow {
  device_id: string;
  profile: string;               // JSON array path
  discovery_done: number;        // 0 = belum, 1 = selesai
  discovery_nodes: number;
  last_collect_at: number | null;
  next_collect_at: number | null;
  interval_min: number;
  last_error: string | null;
  profile_version: number;       // versi format profil (lihat cwmp.ts PROFILE_VERSION)
  full_collect_at: number | null; // pembacaan profil penuh terakhir (lihat index.ts)
}

export interface WebhookRow {
  id: number;
  name: string;
  url: string;
  secret: string;
  events: string;        // JSON array jenis; [] = semua jenis
  enabled: number;
  created_at: number;
  last_delivery_at: number | null;
  last_status: number | null;
  ok_count: number;
  fail_count: number;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  manufacturer TEXT NOT NULL DEFAULT '',
  oui TEXT NOT NULL DEFAULT '',
  product_class TEXT NOT NULL DEFAULT '',
  serial_number TEXT NOT NULL DEFAULT '',
  ip_address TEXT,
  protocol TEXT,
  software_version TEXT,
  hardware_version TEXT,
  connection_request_url TEXT,
  connection_request_user TEXT,
  connection_request_pass TEXT,
  cwmp_user TEXT,
  cwmp_pass TEXT,
  last_inform_at INTEGER,
  registered_at INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  group_name TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_last_inform ON devices(last_inform_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_product ON devices(product_class);

CREATE TABLE IF NOT EXISTS params (
  device_id TEXT NOT NULL,
  path TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'xsd:string',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, path)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_params_path ON params(path);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_device ON tasks(device_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id, created_at DESC);

CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- Sandi (WiFi / PPPoE) yang terakhir DITULIS ACS dan diterima ONU. Banyak
-- firmware mengembalikan string kosong saat sandi dibaca (TR-098: "When read,
-- this parameter returns an empty string"), jadi nilai ini menjadi cadangan
-- tampilan bila ONU tidak mengirim sandinya.
CREATE TABLE IF NOT EXISTS device_secret (
  device_id TEXT NOT NULL,
  path TEXT NOT NULL,
  value TEXT NOT NULL,
  set_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, path)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS discovered_params (
  product_class TEXT NOT NULL,
  vendor TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  writable INTEGER NOT NULL DEFAULT 0,
  seen_at INTEGER NOT NULL,
  times_seen INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (product_class, path)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  interval_hours INTEGER NOT NULL DEFAULT 24,
  conditions TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_presets_enabled ON presets(enabled, priority);

-- Kapan preset terakhir diterapkan ke perangkat tertentu.
--
-- Tanpa ini, perangkat yang Inform tiap beberapa menit akan memicu aksi yang
-- sama berulang-ulang: SetParameterValues dikirim tanpa henti, log membanjir,
-- dan perangkat bekerja buang-buang siklus. Setiap baris = satu preset per
-- perangkat, dicek terhadap interval_hours.
CREATE TABLE IF NOT EXISTS preset_applied (
  preset_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (preset_id, device_id)
);

-- Target webhook (push ke sistem lain saat ada peristiwa).
--
-- Kenapa disimpan di DB, bukan hanya env: operator perlu menambah/menonaktifkan
-- target tanpa restart service, dan perlu melihat status kirim terakhir untuk
-- menjawab "kok integrasiku tidak menerima apa-apa?". Kolom secret dipakai
-- menandatangani payload (HMAC-SHA256) supaya penerima bisa memverifikasi
-- bahwa request memang dari ACS ini, bukan dari pihak lain.
-- Status pengumpulan parameter otomatis per perangkat.
--
-- Ini yang membuat detail perangkat "terisi sendiri": begitu perangkat
-- Inform, ACS mengoleksi parameter inti, lalu menelusuri pohon objek
-- (GetParameterNames) untuk menemukan instans WAN/PPPoE yang nomor
-- instannya belum diketahui. Hasilnya disimpan sebagai kolom profile (daftar
-- path yang layak dibaca ulang), sehingga pembacaan berikutnya tidak perlu
-- menebak nomor instans lagi.
--
-- Sengaja TIDAK ada kolom yang menyimpan hasil reboot/reset: ACS ini tidak
-- pernah mengirim RPC destruktif ke perangkat (lihat README bagian Keamanan).
CREATE TABLE IF NOT EXISTS collection (
  device_id TEXT PRIMARY KEY,
  profile TEXT NOT NULL DEFAULT '[]',   -- JSON array path yang dikoleksi
  discovery_done INTEGER NOT NULL DEFAULT 0,
  discovery_nodes INTEGER NOT NULL DEFAULT 0,
  last_collect_at INTEGER,
  next_collect_at INTEGER,
  interval_min INTEGER NOT NULL DEFAULT 30,
  last_error TEXT
);

-- Antrean subtree yang belum ditelusuri. Dipisah dari antrean RPC
-- karena traversal butuh bertahan beberapa siklus Inform: kalau antrean
-- RPC habis atau ACS restart, daftar ini tetap membuat discovery lanjut
-- dari titik yang sama, bukan mengulang dari root.
-- Root yang berhasil untuk perangkat ini. Disimpan karena beberapa ONU
-- menolak GetParameterNames di root TR-098 (subset TR-069), dan mencoba
-- root yang sama setiap Inform hanya menghasilkan fault berulang.
CREATE TABLE IF NOT EXISTS discovery_root (
  device_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Root yang sudah terbukti ditolak perangkat ini (Fault 9005). Tanpa ini
-- traversal mencoba root yang sama setiap Inform dan membanjiri perangkat
-- dengan GetParameterNames yang pasti ditolak.
-- Isi batch GetParameterValues terakhir per perangkat.
--
-- Saat perangkat membalas Fault 9005 untuk GetParameterValues, CWMP
-- membatalkan SELURUH batch tanpa menyebut path mana yang bermasalah.
-- Tanpa catatan ini kita tidak bisa membagi dua batch untuk menemukan path
-- jahatnya, dan perangkat yang menolak beberapa path akan selamanya gagal
-- dipetakan (kasus HG6145D2 di lapangan: params 0).
CREATE TABLE IF NOT EXISTS read_batch (
  device_id TEXT NOT NULL,
  key TEXT NOT NULL,
  paths TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, key)
);

-- Path yang terbukti ditolak perangkat. Dicoba sekali dipecah per satu,
-- setelah itu tidak pernah dikirim lagi sehingga batch berikutnya bersih.
CREATE TABLE IF NOT EXISTS invalid_param (
  device_id TEXT NOT NULL,
  path TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, path)
);

CREATE TABLE IF NOT EXISTS discovery_root_failed (
  device_id TEXT NOT NULL,
  path TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, path)
);

CREATE TABLE IF NOT EXISTS discovery_queue (
  device_id TEXT NOT NULL,
  path TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, path)
);
CREATE INDEX IF NOT EXISTS idx_discovery_queue_device ON discovery_queue(device_id);

CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL DEFAULT '',
  events TEXT NOT NULL DEFAULT '[]',       -- JSON array jenis; [] = semua jenis
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_delivery_at INTEGER,
  last_status INTEGER,
  ok_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0
);
`;

export class Database {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Migrasi ringan: tambah kolom baru bila DB lama belum punya. */
  private migrate(): void {
    const cols = (this.db.prepare('PRAGMA table_info(devices)').all() as { name: string }[]).map((c) => c.name);
    const added = [
      ['cwmp_user', 'TEXT'], ['cwmp_pass', 'TEXT'],
      ['data_model', 'TEXT'], ['rx_power', 'REAL'], ['tx_power', 'REAL'],
      ['optical_temp', 'REAL'], ['pppoe_user', 'TEXT'], ['pppoe_status', 'TEXT'],
      ['wan_ip', 'TEXT'], ['ssid', 'TEXT'], ['summary_at', 'INTEGER'],
      ['cr_manual', 'INTEGER'], ['cr_provisioned_at', 'INTEGER'],
      ['cpu_usage', 'REAL'], ['mem_usage', 'REAL'],
    ] as const;
    for (const [name, type] of added) {
      if (!cols.includes(name)) this.db.exec(`ALTER TABLE devices ADD COLUMN ${name} ${type}`);
    }
    const ccols = (this.db.prepare('PRAGMA table_info(collection)').all() as { name: string }[]).map((c) => c.name);
    if (!ccols.includes('profile_version')) {
      this.db.exec('ALTER TABLE collection ADD COLUMN profile_version INTEGER NOT NULL DEFAULT 0');
    }
    if (!ccols.includes('full_collect_at')) {
      this.db.exec('ALTER TABLE collection ADD COLUMN full_collect_at INTEGER');
    }
  }

  /* ---------------- devices ---------------- */

  upsertDevice(d: Partial<DeviceRow> & { id: string; registered_at?: number }): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO devices (id, manufacturer, oui, product_class, serial_number,
        registered_at, tags)
      VALUES (?, ?, ?, ?, ?, ?, '[]')
      ON CONFLICT(id) DO UPDATE SET
        manufacturer = excluded.manufacturer,
        oui = excluded.oui,
        product_class = excluded.product_class,
        serial_number = excluded.serial_number
    `).run(d.id, d.manufacturer ?? '', d.oui ?? '', d.product_class ?? '',
      d.serial_number ?? '', d.registered_at ?? now);
  }

  touchInform(id: string, ip: string | null, protocol: string | null): void {
    this.db.prepare(`
      UPDATE devices SET last_inform_at = ?, ip_address = COALESCE(?, ip_address),
        protocol = COALESCE(?, protocol)
      WHERE id = ?
    `).run(Date.now(), ip, protocol, id);
  }

  getDevice(id: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  }

  listDevices(opts: { q?: string; tag?: string; group?: string; online?: boolean; rxMax?: number; limit?: number; offset?: number } = {}): {
    rows: DeviceRow[]; total: number;
  } {
    const where: string[] = [];
    // Bertipe eksplisit supaya lolos ke .get(...params) milik node:sqlite
    // yang menerima SQLInputValue, bukan unknown.
    const params: (string | number | null)[] = [];
    if (opts.q) {
      where.push('(id LIKE ? OR serial_number LIKE ? OR product_class LIKE ? OR group_name LIKE ?'
        + ' OR pppoe_user LIKE ? OR wan_ip LIKE ? OR ip_address LIKE ? OR ssid LIKE ?)');
      const like = `%${opts.q}%`;
      params.push(like, like, like, like, like, like, like, like);
    }
    if (opts.group) { where.push('group_name = ?'); params.push(opts.group); }
    if (opts.tag) { where.push('tags LIKE ?'); params.push(`%"${opts.tag}"%`); }
    if (opts.rxMax !== undefined) {
      // Filter redaman buruk: RX di bawah ambang (dBm).
      where.push('rx_power IS NOT NULL AND rx_power < ?');
      params.push(opts.rxMax);
    }
    if (opts.online) {
      where.push('last_inform_at > ?');
      params.push(Date.now() - 30 * 60 * 1000);
    }

    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM devices ${cond}`).get(...params) as { n: number }).n;
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = this.db.prepare(
      `SELECT * FROM devices ${cond} ORDER BY last_inform_at DESC NULLS LAST, registered_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as unknown as DeviceRow[];
    return { rows, total };
  }

  setDeviceFields(id: string, fields: Record<string, string | number | null>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sql = `UPDATE devices SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...Object.values(fields), id);
  }

  countDevices(): { total: number; online: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n;
    const online = (this.db.prepare(
      'SELECT COUNT(*) AS n FROM devices WHERE last_inform_at > ?',
    ).get(Date.now() - 30 * 60 * 1000) as { n: number }).n;
    return { total, online };
  }

  /* ---------------- params ---------------- */

  setParams(deviceId: string, entries: { path: string; value: string; type?: string }[]): void {
    if (!entries.length) return;
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO params (device_id, path, value, type, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(device_id, path) DO UPDATE SET
        value = excluded.value, type = excluded.type, updated_at = excluded.updated_at
    `);
    this.db.exec('BEGIN');
    try {
      for (const e of entries) stmt.run(deviceId, e.path, e.value, e.type ?? 'xsd:string', now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getParams(deviceId: string, prefix?: string): ParamRow[] {
    if (prefix) {
      return this.db.prepare(
        'SELECT * FROM params WHERE device_id = ? AND path LIKE ? ORDER BY path',
      ).all(deviceId, `${prefix}%`) as unknown as ParamRow[];
    }
    return this.db.prepare('SELECT * FROM params WHERE device_id = ? ORDER BY path')
      .all(deviceId) as unknown as ParamRow[];
  }

  /**
   * Hapus parameter di bawah `prefix` yang tidak lagi dilaporkan perangkat
   * (mis. WAN yang sudah di-DeleteObject). `keep` = semua leaf terbaru.
   */
  pruneParams(deviceId: string, prefix: string, keep: Set<string>): number {
    const rows = this.db.prepare('SELECT path FROM params WHERE device_id = ? AND path LIKE ?')
      .all(deviceId, `${prefix}%`) as { path: string }[];
    const del = this.db.prepare('DELETE FROM params WHERE device_id = ? AND path = ?');
    let n = 0;
    for (const r of rows) if (!keep.has(r.path)) { del.run(deviceId, r.path); n++; }
    return n;
  }

  /* ---------------- tasks ---------------- */

  createTask(id: string, deviceId: string, kind: string, payload: unknown, ttlMs = 5 * 60 * 1000): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO tasks (id, device_id, kind, payload, status, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(id, deviceId, kind, JSON.stringify(payload ?? {}), now, now, now + ttlMs);
  }

  updateTask(id: string, status: string, result: unknown): void {
    this.db.prepare('UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?')
      .run(status, result === undefined ? null : JSON.stringify(result), Date.now(), id);
  }

  getTask(id: string): { id: string; device_id: string; kind: string; payload: string; status: string; result: string | null; created_at: number; updated_at: number } | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as never;
  }

  listTasks(deviceId?: string, limit = 50): unknown[] {
    if (deviceId) {
      return this.db.prepare('SELECT * FROM tasks WHERE device_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(deviceId, limit);
    }
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  /* ---------------- events ---------------- */

  addEvent(deviceId: string | null, kind: string, message: string): void {
    this.db.prepare('INSERT INTO events (device_id, kind, message, created_at) VALUES (?, ?, ?, ?)')
      .run(deviceId, kind, message, Date.now());
  }

  listEvents(opts: { deviceId?: string; limit?: number } = {}): EventRow[] {
    const limit = Math.min(opts.limit ?? 100, 1000);
    if (opts.deviceId) {
      return this.db.prepare('SELECT * FROM events WHERE device_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(opts.deviceId, limit) as unknown as EventRow[];
    }
    return this.db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as EventRow[];
  }

  /* ---------------- auth ---------------- */

  createUser(username: string, passwordHash: string, role = 'operator'): void {
    this.db.prepare(`
      INSERT INTO users (username, password_hash, role, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(username) DO NOTHING
    `).run(username, passwordHash, role, Date.now());
  }

  getUser(username: string): { username: string; password_hash: string; role: string; last_login_at: number | null } | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as never;
  }

  touchLogin(username: string): void {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE username = ?').run(Date.now(), username);
  }

  createSession(token: string, username: string, ttlMs: number, ip: string | null): void {
    this.db.prepare('INSERT INTO sessions (token, username, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)')
      .run(token, username, Date.now(), Date.now() + ttlMs, ip);
  }

  getSession(token: string): { token: string; username: string; expires_at: number } | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as never;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  purgeExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  }

  /* ---------------- sandi yang disetel lewat ACS ---------------- */

  setSecrets(deviceId: string, items: { path: string; value: string }[]): void {
    if (!items.length) return;
    const st = this.db.prepare(`
      INSERT INTO device_secret (device_id, path, value, set_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id, path) DO UPDATE SET value = excluded.value, set_at = excluded.set_at`);
    const now = Date.now();
    for (const it of items) st.run(deviceId, it.path, it.value, now);
  }

  getSecrets(deviceId: string): { path: string; value: string; set_at: number }[] {
    return this.db.prepare('SELECT path, value, set_at FROM device_secret WHERE device_id = ?')
      .all(deviceId) as { path: string; value: string; set_at: number }[];
  }

  /** Reset pabrik → sandi yang pernah disetel ACS tidak berlaku lagi. */
  clearSecrets(deviceId: string): void {
    this.db.prepare('DELETE FROM device_secret WHERE device_id = ?').run(deviceId);
  }

  /* ---------------- discovered params ---------------- */

  recordDiscovery(productClass: string, vendor: string, path: string, writable: boolean): void {
    this.db.prepare(`
      INSERT INTO discovered_params (product_class, vendor, path, writable, seen_at, times_seen)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(product_class, path) DO UPDATE SET
        seen_at = excluded.seen_at,
        writable = excluded.writable,
        times_seen = times_seen + 1
    `).run(productClass, vendor, path, writable ? 1 : 0, Date.now());
  }

  getDiscovered(productClass: string): { path: string; writable: number; times_seen: number }[] {
    return this.db.prepare('SELECT path, writable, times_seen FROM discovered_params WHERE product_class = ? ORDER BY path')
      .all(productClass) as never;
  }

  /** Versi massal recordDiscovery: satu transaksi untuk ratusan simpul. */
  recordDiscoveryMany(productClass: string, vendor: string, nodes: { name: string; writable: boolean }[]): void {
    if (!nodes.length) return;
    this.db.exec('BEGIN');
    try {
      for (const n of nodes) if (n.name) this.recordDiscovery(productClass, vendor, n.name, n.writable);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Path writable menurut katalog discovery model ini. */
  writablePaths(productClass: string): Set<string> {
    const rows = this.db.prepare(
      'SELECT path FROM discovered_params WHERE product_class = ? AND writable = 1',
    ).all(productClass) as { path: string }[];
    return new Set(rows.map((r) => r.path));
  }

  listDiscoveredProductClasses(): { product_class: string; vendor: string; n: number }[] {
    return this.db.prepare(`
      SELECT product_class, MIN(vendor) AS vendor, COUNT(*) AS n
      FROM discovered_params GROUP BY product_class ORDER BY n DESC
    `).all() as never;
  }

  /* ---------------- presets (provisioning otomatis) ---------------- */

  listPresets(): PresetRow[] {
    // Dua agregat agregat ini yang berguna di daftar: berapa perangkat yang
    // sudah kena preset (applied_count) dan kapan yang paling baru
    // (last_applied_at). Sengaja bukan "perangkat terakhir" tunggal —
    // angka itu tidak mewakili apa-apa untuk preset yang melayani banyak ONU.
    return this.db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM preset_applied a WHERE a.preset_id = p.id) AS applied_count,
        (SELECT MAX(a.applied_at) FROM preset_applied a WHERE a.preset_id = p.id) AS last_applied_at
      FROM presets p
      ORDER BY p.priority ASC, p.id ASC
    `).all() as never;
  }

  getPreset(id: number): PresetRow | undefined {
    return this.db.prepare('SELECT * FROM presets WHERE id = ?').get(id) as never;
  }

  createPreset(p: {
    name: string; enabled: number; priority: number; interval_hours: number;
    conditions: string; actions: string;
  }): number {
    const info = this.db.prepare(`
      INSERT INTO presets (name, enabled, priority, interval_hours, conditions, actions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(p.name, p.enabled, p.priority, p.interval_hours, p.conditions, p.actions, Date.now());
    return Number(info.lastInsertRowid);
  }

  updatePreset(id: number, p: Partial<{
    name: string; enabled: number; priority: number; interval_hours: number;
    conditions: string; actions: string;
  }>): void {
    const cols: string[] = [];
    const vals: (string | number)[] = [];
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      cols.push(`${k} = ?`);
      vals.push(v as string | number);
    }
    if (!cols.length) return;
    vals.push(id);
    this.db.prepare(`UPDATE presets SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  }

  deletePreset(id: number): void {
    // Baris penanda penerapan harus ikut terhapus, kalau tidak preset baru
    // dengan id sama bisa dianggap "sudah pernah diterapkan".
    this.db.prepare('DELETE FROM preset_applied WHERE preset_id = ?').run(id);
    this.db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  }

  /** Kapan preset ini terakhir diterapkan ke perangkat tertentu. */
  presetAppliedAt(presetId: number, deviceId: string): number | null {
    const row = this.db.prepare(
      'SELECT applied_at FROM preset_applied WHERE preset_id = ? AND device_id = ?',
    ).get(presetId, deviceId) as { applied_at: number } | undefined;
    return row?.applied_at ?? null;
  }

  markPresetApplied(presetId: number, deviceId: string): void {
    this.db.prepare(`
      INSERT INTO preset_applied (preset_id, device_id, applied_at) VALUES (?, ?, ?)
      ON CONFLICT(preset_id, device_id) DO UPDATE SET applied_at = excluded.applied_at
    `).run(presetId, deviceId, Date.now());
  }

  /** Angka berapa banyak perangkat yang pernah dipasangi preset ini. */
  presetAppliedCount(presetId: number): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM preset_applied WHERE preset_id = ?',
    ).get(presetId) as { n: number };
    return row.n;
  }

  /* ---------------- collection (pengumpulan parameter otomatis) ---------------- */

  getCollection(deviceId: string): CollectionRow | undefined {
    return this.db.prepare('SELECT * FROM collection WHERE device_id = ?')
      .get(deviceId) as CollectionRow | undefined;
  }

  /**
   * Simpan daftar path yang layak dikoleksi ulang untuk perangkat ini.
   *
   * `addNewOnly` sengaja ada: profiler berjalan berkala, dan path dari
   * discovery baru harus bisa ditambahkan tanpa menimpa daftar yang sudah
   * bekerja (mis. WANPPPConnection.1 yang ditemukan belakangan).
   */
  setCollectionProfile(deviceId: string, paths: string[], addNewOnly: boolean): number {
    const now = Date.now();
    const existing = this.getCollection(deviceId);
    let merged = paths;
    if (addNewOnly && existing) {
      let prev: string[] = [];
      try {
        const v: unknown = JSON.parse(existing.profile);
        prev = Array.isArray(v) ? (v as string[]).filter((x) => typeof x === 'string') : [];
      } catch { prev = []; }
      const seen = new Set(prev);
      merged = [...prev];
      for (const p of paths) {
        if (!seen.has(p)) { seen.add(p); merged.push(p); }
      }
    }
    const uniq = [...new Set(merged)].filter((p) => typeof p === 'string' && p.length > 0);
    this.db.prepare(`
      INSERT INTO collection (device_id, profile, next_collect_at)
      VALUES (?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET profile = excluded.profile,
        next_collect_at = excluded.next_collect_at, last_error = NULL
    `).run(deviceId, JSON.stringify(uniq), now);
    return uniq.length;
  }

  markDiscoveryDone(deviceId: string, nodes: number): void {
    this.db.prepare(`
      INSERT INTO collection (device_id, discovery_done, discovery_nodes, next_collect_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        discovery_done = 1, discovery_nodes = excluded.discovery_nodes,
        next_collect_at = excluded.next_collect_at, last_error = NULL
    `).run(deviceId, nodes, Date.now());
    // Pemetaan selesai = tidak ada lagi yang perlu ditelusuri. Sisa antrean
    // (root yang tidak pernah dijawab perangkat) dibuang SEKARANG, bukan
    // dibiarkan: kalau tidak, sisa itu diambil di setiap Inform dan menahan
    // pembacaan parameter di belakangnya (terbukti: queue tersisa 19 path
    // dan params tetap 0 karena pembacaan tak pernah sampai gilirannya).
    this.db.prepare('DELETE FROM discovery_queue WHERE device_id = ?').run(deviceId);
  }

  markCollected(deviceId: string, intervalMin: number, params: number): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE collection SET last_collect_at = ?, next_collect_at = ?, last_error = NULL
      WHERE device_id = ?
    `).run(now, now + Math.max(intervalMin, 5) * 60 * 1000, deviceId);
    // Perangkat tanpa baris collection (mis. hanya pernah di-seed manual)
    // tetap butuh penanda supaya tidak diulang setiap restart.
    if (params === 0) {
      this.db.prepare(`
        INSERT INTO collection (device_id, last_collect_at, next_collect_at, interval_min)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          last_collect_at = excluded.last_collect_at, next_collect_at = excluded.next_collect_at
      `).run(deviceId, now, now + Math.max(intervalMin, 5) * 60 * 1000, intervalMin);
    }
  }

  setProfileVersion(deviceId: string, version: number): void {
    this.db.prepare('UPDATE collection SET profile_version = ? WHERE device_id = ?').run(version, deviceId);
  }

  markFullCollect(deviceId: string): void {
    this.db.prepare('UPDATE collection SET full_collect_at = ? WHERE device_id = ?').run(Date.now(), deviceId);
  }

  markCollectError(deviceId: string, error: string): void {
    this.db.prepare(`
      INSERT INTO collection (device_id, last_error, next_collect_at)
      VALUES (?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET last_error = excluded.last_error
    `).run(deviceId, error.slice(0, 256), Date.now() + 10 * 60 * 1000);
  }

  /** Perangkat yang sudah waktunya dikoleksi ulang (limit dipakai supaya satu siklus tak meledak). */
  listDueForCollection(limit: number, onlineWindowMs: number): { device_id: string }[] {
    const now = Date.now();
    return this.db.prepare(`
      SELECT c.device_id FROM collection c
      JOIN devices d ON d.id = c.device_id
      WHERE (c.next_collect_at IS NULL OR c.next_collect_at <= ?)
        AND d.last_inform_at > ?
      ORDER BY COALESCE(c.next_collect_at, 0) ASC
      LIMIT ?
    `).all(now, now - onlineWindowMs, limit) as { device_id: string }[];
  }

  /** Perangkat yang belum pernah.discovered sama sekali. */
  listPendingDiscovery(limit: number, onlineWindowMs: number): string[] {
    const now = Date.now();
    const rows = this.db.prepare(`
      SELECT d.id FROM devices d
      LEFT JOIN collection c ON c.device_id = d.id
      WHERE (c.device_id IS NULL OR c.discovery_done = 0)
        AND d.last_inform_at > ?
      ORDER BY d.last_inform_at ASC
      LIMIT ?
    `).all(now - onlineWindowMs, limit) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /* -------- antrean discovery persisten -------- */

  enqueueDiscoveryPaths(deviceId: string, paths: string[]): void {
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO discovery_queue (device_id, path, added_at) VALUES (?, ?, ?)',
    );
    // Root yang sudah terbukti ditolak perangkat tidak boleh masuk
    // antrean lagi — kalau tidak, antrean diisi ulang dan fault yang sama
    // berulang tiap Inform (terbukti: 38 fault identik di uji).
    const failed = new Set(this.failedDiscoveryRoots(deviceId));
    const now = Date.now();
    for (const path of paths) {
      if (failed.has(path)) continue;
      ins.run(deviceId, path, now);
    }
  }

  pendingDiscoveryPaths(deviceId: string): string[] {
    const rows = this.db.prepare(
      'SELECT path FROM discovery_queue WHERE device_id = ? ORDER BY added_at ASC, path ASC',
    ).all(deviceId) as { path: string }[];
    return rows.map((r) => r.path);
  }

  /** Naikkan hitungan percobaan GPN untuk path ini; kembalikan nilai baru. */
  bumpDiscoveryTry(deviceId: string, path: string): number {
    this.db.prepare('UPDATE discovery_queue SET tries = tries + 1 WHERE device_id = ? AND path = ?')
      .run(deviceId, path);
    const row = this.db.prepare('SELECT tries FROM discovery_queue WHERE device_id = ? AND path = ?')
      .get(deviceId, path) as { tries: number } | undefined;
    return row?.tries ?? 0;
  }

  dropDiscoveryPath(deviceId: string, path: string): void {
    this.db.prepare('DELETE FROM discovery_queue WHERE device_id = ? AND path = ?').run(deviceId, path);
  }

  clearDiscoveryQueue(deviceId: string): void {
    this.db.prepare('DELETE FROM discovery_queue WHERE device_id = ?').run(deviceId);
  }

  /** Perangkat dengan antrean discovery, untuk dijadwalkan ulang. */
  listDevicesWithDiscoveryQueue(limit: number): string[] {
    const rows = this.db.prepare(
      'SELECT device_id FROM discovery_queue GROUP BY device_id LIMIT ?',
    ).all(limit) as { device_id: string }[];
    return rows.map((r) => r.device_id);
  }

  /* -------- root discovery per perangkat -------- */

  getDiscoveryRoot(deviceId: string): string | undefined {
    const row = this.db.prepare(
      'SELECT path FROM discovery_root WHERE device_id = ?',
    ).get(deviceId) as { path: string } | undefined;
    return row?.path;
  }

  setDiscoveryRoot(deviceId: string, path: string): void {
    this.db.prepare(`
      INSERT INTO discovery_root (device_id, path, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET path = excluded.path, updated_at = excluded.updated_at
    `).run(deviceId, path, Date.now());
  }

  markDiscoveryRootFailed(deviceId: string, path: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO discovery_root_failed (device_id, path, updated_at)
      VALUES (?, ?, ?)
    `).run(deviceId, path, Date.now());
  }

  failedDiscoveryRoots(deviceId: string): string[] {
    return (this.db.prepare(
      'SELECT path FROM discovery_root_failed WHERE device_id = ?',
    ).all(deviceId) as { path: string }[]).map((r) => r.path);
  }

  /* -------- batch GetParameterValues -------- */

  saveReadBatch(deviceId: string, key: string, paths: string[], depth = 0): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO read_batch (device_id, key, paths, depth, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(deviceId, key, JSON.stringify(paths), depth, Date.now());
  }

  getReadBatch(deviceId: string, key: string): { paths: string[]; depth: number } | undefined {
    const row = this.db.prepare(
      'SELECT paths, depth FROM read_batch WHERE device_id = ? AND key = ?',
    ).get(deviceId, key) as { paths: string; depth: number } | undefined;
    if (!row) return undefined;
    let paths: string[] = [];
    try { paths = JSON.parse(row.paths) as string[]; } catch { paths = []; }
    return { paths, depth: row.depth };
  }

  dropReadBatch(deviceId: string, key: string): void {
    this.db.prepare('DELETE FROM read_batch WHERE device_id = ? AND key = ?')
      .run(deviceId, key);
  }

  purgeStaleReadBatches(maxAgeMs: number): void {
    this.db.prepare('DELETE FROM read_batch WHERE created_at < ?').run(Date.now() - maxAgeMs);
  }

  clearReadBatches(deviceId: string): void {
    this.db.prepare('DELETE FROM read_batch WHERE device_id = ?').run(deviceId);
  }

  /** Path yang kini terbukti ada (muncul di discovery) dikeluarkan dari daftar tolak. */
  unmarkInvalidParams(deviceId: string, paths: string[]): void {
    if (!paths.length) return;
    const del = this.db.prepare('DELETE FROM invalid_param WHERE device_id = ? AND path = ?');
    for (const p of paths) del.run(deviceId, p);
  }

  clearInvalidParams(deviceId: string): void {
    this.db.prepare('DELETE FROM invalid_param WHERE device_id = ?').run(deviceId);
  }

  /**
   * Mulai ulang pemetaan perangkat: kosongkan antrean, root gagal, dan
   * tandai discovery belum selesai. Profil lama tetap dipakai sampai
   * discovery baru mengganti subtree-nya.
   */
  resetDiscovery(deviceId: string, profileVersion: number): void {
    this.db.prepare('DELETE FROM discovery_queue WHERE device_id = ?').run(deviceId);
    this.db.prepare('DELETE FROM discovery_root_failed WHERE device_id = ?').run(deviceId);
    this.db.prepare('DELETE FROM discovery_root WHERE device_id = ?').run(deviceId);
    this.db.prepare(`
      INSERT INTO collection (device_id, discovery_done, profile_version, next_collect_at)
      VALUES (?, 0, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET discovery_done = 0,
        profile_version = excluded.profile_version
    `).run(deviceId, profileVersion, Date.now());
  }

  markInvalidParam(deviceId: string, path: string): void {
    this.db.prepare('INSERT OR IGNORE INTO invalid_param (device_id, path, updated_at) VALUES (?, ?, ?)')
      .run(deviceId, path, Date.now());
  }

  invalidParams(deviceId: string): string[] {
    return (this.db.prepare(
      'SELECT path FROM invalid_param WHERE device_id = ?',
    ).all(deviceId) as { path: string }[]).map((r) => r.path);
  }

  countNeedingCollection(): { pending_discovery: number; due: number } {
    const now = Date.now();
    const pending = (this.db.prepare(`
      SELECT COUNT(*) AS n FROM devices d
      LEFT JOIN collection c ON c.device_id = d.id
      WHERE (c.device_id IS NULL OR c.discovery_done = 0) AND d.last_inform_at > ?
    `).get(now - 30 * 60 * 1000) as { n: number }).n;
    const due = (this.db.prepare(
      'SELECT COUNT(*) AS n FROM collection WHERE next_collect_at IS NULL OR next_collect_at <= ?',
    ).get(now) as { n: number }).n;
    return { pending_discovery: pending, due };
  }

  /* ---------------- webhook ---------------- */

  listWebhooks(): WebhookRow[] {
    return this.db.prepare('SELECT * FROM webhooks ORDER BY id ASC').all() as unknown as WebhookRow[];
  }

  /** Hanya yang aktif — dipakai dispatcher tiap kali ada peristiwa. */
  listEnabledWebhooks(): WebhookRow[] {
    return this.db.prepare('SELECT * FROM webhooks WHERE enabled = 1 ORDER BY id ASC')
      .all() as unknown as WebhookRow[];
  }

  getWebhook(id: number): WebhookRow | undefined {
    return this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow | undefined;
  }

  createWebhook(w: { name: string; url: string; secret: string; events: string; enabled: number }): number {
    const info = this.db.prepare(`
      INSERT INTO webhooks (name, url, secret, events, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(w.name, w.url, w.secret, w.events, w.enabled, Date.now());
    return Number(info.lastInsertRowid);
  }

  updateWebhook(id: number, w: Partial<{
    name: string; url: string; secret: string; events: string; enabled: number;
  }>): void {
    const cols: string[] = [];
    const vals: (string | number)[] = [];
    for (const [k, v] of Object.entries(w)) {
      if (v === undefined) continue;
      cols.push(`${k} = ?`);
      vals.push(v as string | number);
    }
    if (!cols.length) return;
    vals.push(id);
    this.db.prepare(`UPDATE webhooks SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  }

  deleteWebhook(id: number): void {
    this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  }

  /** Catat hasil satu percobaan kirim (dipanggil dispatcher). */
  recordWebhookDelivery(id: number, status: number | null, ok: boolean): void {
    this.db.prepare(`
      UPDATE webhooks SET last_delivery_at = ?, last_status = ?,
        ok_count = ok_count + ?, fail_count = fail_count + ?
      WHERE id = ?
    `).run(Date.now(), status, ok ? 1 : 0, ok ? 0 : 1, id);
  }
}
