/**
 * Connection Request (ACS → CPE): HTTP GET ke ConnectionRequestURL milik
 * ONU agar ONU segera membuka sesi CWMP (Inform "6 CONNECTION REQUEST").
 *
 * TR-069 §3.2.2 mewajibkan CPE mengautentikasi permintaan ini, dan hampir
 * semua ONU (ZTE, Huawei, FiberHome, CMCC) memakai HTTP **Digest** — bukan
 * Basic. Alur yang dipakai (sama seperti GenieACS):
 *   1. GET tanpa kredensial → 2xx selesai, atau 401 + WWW-Authenticate;
 *   2. ulangi dengan Digest (bila ditawarkan) atau Basic.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export interface CrResult {
  ok: boolean;
  status?: number;
  auth: 'none' | 'basic' | 'digest';
  /** 'auth' = kredensial ditolak; 'unreachable' = tak terjangkau; 'http' = status lain; 'malformed' = URL/port tidak valid. */
  reason?: 'auth' | 'unreachable' | 'http' | 'malformed';
  detail?: string;
}

/**
 * Validasi URL Connection Request sebelum dipakai. Sebagian firmware
 * (mis. FiberHome RP2872) melaporkan ConnectionRequestURL dengan port di
 * luar rentang TCP 16-bit (contoh lapangan: `:1601009200`), sehingga
 * `new URL()` melempar ERR_INVALID_URL. Port TCP maksimal 65535, jadi URL
 * seperti ini tidak mungkin dihubungi lewat HTTP — bukan masalah NAT.
 */
export function validateCrUrl(url: string): { url: URL } | { error: string } {
  const raw = (url ?? '').trim();
  const m = /^https?:\/\/[^/?#]*:(\d{1,10})(?:[/?#]|$)/i.exec(raw);
  if (m && Number(m[1]) > 65535) {
    return { error: `port ${m[1]} di luar rentang TCP (maks 65535) — firmware ONU melaporkan port tidak valid` };
  }
  try { return { url: new URL(raw) }; }
  catch { return { error: 'format URL Connection Request tidak valid' }; }
}

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

/** Ambil parameter challenge Digest dari header WWW-Authenticate. */
export function parseDigestChallenge(header: string): Record<string, string> | null {
  const i = header.search(/Digest\s/i);
  if (i < 0) return null;
  const out: Record<string, string> = {};
  const re = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m: RegExpExecArray | null;
  const rest = header.slice(i + 7);
  while ((m = re.exec(rest))) {
    const key = m[1]!.toLowerCase();
    if (key === 'basic' || (key === 'realm' && out.realm !== undefined)) break; // challenge berikutnya
    out[key] = m[2] ?? m[3] ?? '';
  }
  return out.nonce ? out : null;
}

/** Header Authorization Digest (RFC 2617, MD5/MD5-sess, qop=auth). */
export function digestAuthorization(
  ch: Record<string, string>, user: string, pass: string, method: string, uri: string,
  cnonce = randomBytes(8).toString('hex'), nc = '00000001',
): string {
  const algo = (ch.algorithm ?? 'MD5').toUpperCase();
  let ha1 = md5(`${user}:${ch.realm ?? ''}:${pass}`);
  if (algo === 'MD5-SESS') ha1 = md5(`${ha1}:${ch.nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const qop = (ch.qop ?? '').split(',').map((q) => q.trim()).includes('auth') ? 'auth' : '';
  const response = qop
    ? md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${ch.nonce}:${ha2}`);
  const parts = [
    `username="${user}"`, `realm="${ch.realm ?? ''}"`, `nonce="${ch.nonce}"`, `uri="${uri}"`,
    `algorithm=${ch.algorithm ?? 'MD5'}`, `response="${response}"`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (ch.opaque !== undefined) parts.push(`opaque="${ch.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

interface Resp { status: number; headers: Record<string, string | string[] | undefined> }

/**
 * GET memakai node:http(s), bukan fetch: fetch menolak sejumlah port
 * ("bad port" spesifikasi Fetch), padahal port Connection Request ONU bisa
 * apa saja. Sertifikat self-signed CPE diterima (CR hanya pemicu sesi;
 * kredensial dilindungi Digest).
 */
function get(u: URL, timeoutMs: number, authorization?: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET',
      headers: { ...(authorization ? { Authorization: authorization } : {}), Connection: 'close' },
      timeout: timeoutMs,
      ...(u.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

const accepted = (s: number): boolean => (s >= 200 && s < 300) || s === 500 || s === 503;

export async function sendConnectionRequest(
  url: string, user: string, pass: string, timeoutMs = 8000,
): Promise<CrResult> {
  const parsed = validateCrUrl(url);
  if ('error' in parsed) return { ok: false, auth: 'none', reason: 'malformed', detail: parsed.error };
  const u = parsed.url;
  let first: Resp;
  try {
    first = await get(u, timeoutMs);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, auth: 'none', reason: 'unreachable', detail: err.code ?? err.message ?? 'error' };
  }
  // Sebagian CPE melapor 500/503 setelah menerima permintaan; dianggap sukses.
  if (accepted(first.status)) return { ok: true, status: first.status, auth: 'none' };
  if (first.status !== 401) return { ok: false, status: first.status, auth: 'none', reason: 'http' };

  const wa = first.headers['www-authenticate'];
  const challenge = Array.isArray(wa) ? wa.find((h) => /^Digest/i.test(h)) ?? wa.join(', ') : wa ?? '';
  const uri = `${u.pathname}${u.search}` || '/';
  const digest = parseDigestChallenge(challenge);
  const authorization = digest
    ? digestAuthorization(digest, user, pass, 'GET', uri)
    : `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const auth = digest ? 'digest' : 'basic';
  try {
    const second = await get(u, timeoutMs, authorization);
    if (accepted(second.status)) return { ok: true, status: second.status, auth };
    if (second.status === 401 || second.status === 403) return { ok: false, status: second.status, auth, reason: 'auth' };
    return { ok: false, status: second.status, auth, reason: 'http' };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, auth, reason: 'unreachable', detail: err.code ?? err.message ?? 'error' };
  }
}

/** Jeda minimum antar Connection Request per perangkat (lindungi ONU). */
export const CR_MIN_INTERVAL_MS = 10_000;
const lastCr = new Map<string, number>();

/** Sisa waktu tunggu (ms) sebelum perangkat boleh dipanggil lagi; 0 = boleh. */
export function crCooldown(deviceId: string): number {
  const last = lastCr.get(deviceId) ?? 0;
  return Math.max(0, last + CR_MIN_INTERVAL_MS - Date.now());
}
export function markCr(deviceId: string): void {
  lastCr.set(deviceId, Date.now());
  if (lastCr.size > 50_000) lastCr.clear();
}
