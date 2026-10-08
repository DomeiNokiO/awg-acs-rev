/**
 * Autentikasi CWMP (CPE → ACS).
 *
 * TR-069 mengizinkan ACS meminta HTTP Basic/Digest pada endpoint Inform.
 * ONT tidak selalu mengirim credential — banyak yang mengirim tanpa auth.
 * Karena itu fitur ini OPSIONAL, dengan urutan prioritas berikut:
 *
 *   1. Credential PER PERANGKAT di DB (`devices.cwmp_user`/`cwmp_pass`),
 *      diedit dari UI halaman detail perangkat. Berlaku begitu diisi.
 *   2. Bila DB kosong → pakai file `ACS_CWMP_CREDENTIALS` (pola glob).
 *   3. Bila keduanya kosong → ACS menerima semua CPE (perilaku default).
 *
 * Format file: `pola|user|pass` per baris (`*` = wildcard), `#` komentar.
 */
import { readFileSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

export interface CwmpCredential {
  pattern: string;      // deviceId, atau pola glob dengan *
  username: string;
  password: string;
}

export interface CwmpAuthResult {
  enabled: boolean;
  authed: boolean;
  matched?: string;     // credential yang cocok
}

/** Muat daftar credential dari file; [] bila file tidak ada / tidak diset. */
export function loadCredentials(file: string | undefined): CwmpCredential[] {
  if (!file || !existsSync(file)) return [];
  try {
    const raw = readFileSync(file, 'utf8');
    const out: CwmpCredential[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const [pattern, username, password] = t.split('|').map((s) => s.trim());
      if (pattern && username && password && password !== '') {
        out.push({ pattern, username, password });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function globMatch(pattern: string, id: string): boolean {
  // Ubah pola glob sederhana (*) jadi regex.
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(id);
}

/** Cocokkan credential untuk deviceId dengan auth header Basic. */
export function checkCwmpAuth(
  creds: CwmpCredential[],
  deviceId: string,
  authHeader: string | undefined,
  deviceCred?: { user: string; pass: string } | null,
): CwmpAuthResult {
  // Prioritas 1: credential per-perangkat dari DB (diedit lewat UI).
  if (deviceCred && deviceCred.user) {
    const parsed = parseBasic(authHeader);
    if (!parsed) return { enabled: true, authed: false, matched: 'db' };
    const ok = safeEq(parsed.user, deviceCred.user) && safeEq(parsed.pass, deviceCred.pass);
    return { enabled: true, authed: ok, matched: 'db' };
  }

  if (!creds.length) {
    return { enabled: false, authed: true }; // fitur nonaktif → terima semua
  }
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return { enabled: true, authed: false }; // Wajib auth, tapi tidak ada header
  }
  let decoded: string;
  try {
    decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return { enabled: true, authed: false };
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return { enabled: true, authed: false };
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  for (const c of creds) {
    if (globMatch(c.pattern, deviceId)) {
      const ok = safeEq(user, c.username) && safeEq(pass, c.password);
      if (ok) return { enabled: true, authed: true, matched: c.pattern };
      // Pola cocok tapi credential salah → tolak (jangan lanjut ke pola lain).
      return { enabled: true, authed: false, matched: c.pattern };
    }
  }
  return { enabled: true, authed: false };
}

/** Perbandingan waktu-konstan (hindari timing oracle). */
function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * Baca Basic auth dari header (bantuan untuk dokumentasi / debugging).
 * Kembalikan {user, pass} atau null.
 */
export function parseBasic(authHeader: string | undefined): { user: string; pass: string } | null {
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}