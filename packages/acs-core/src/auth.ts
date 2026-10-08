/**
 * Otentikasi UI: hash password dengan scrypt bawaan Node.
 *
 * scrypt dipilih karena ada di node:crypto — tidak perlu bcrypt/argon2 yang
 * butuh kompilasi native. Parameter di bawah membuat brute force mahal:
 * N=2^15 butuh ~32 MB dan ~100 ms per percobaan di mesin biasa.
 *
 * Format penyimpanan: scrypt$N$r$p$saltB64$hashB64
 * Idenya supaya parameter bisa dinaikkan nanti tanpa migrasi format.
 */
import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer, salt: string | Buffer, keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3]);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    // Batasi supaya hash lama yang dimanipulasi tidak bikin memori meledak.
    if (N > 1 << 20 || r > 32 || p > 16) return false;
    const salt = Buffer.from(parts[4]!, 'base64');
    const expected = Buffer.from(parts[5]!, 'base64');
    const actual = await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Token CSRF: HMAC dari sesi, jadi tidak bisa dipalsukan tanpa cookie sesi. */
export function csrfToken(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update('csrf').digest('base64url');
}

export function safeCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* ------------------------------------------------------------------ *
 * Rate limiting sederhana in-memory (login endpoint)
 * ------------------------------------------------------------------ */

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(maxAttempts: number, windowMs: number) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  /** @returns sisa milidetik sampai boleh coba lagi, atau 0 kalau lolos. */
  check(key: string): number {
    const now = Date.now();
    const rec = this.hits.get(key);
    if (!rec || rec.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    rec.count++;
    if (rec.count > this.maxAttempts) return rec.resetAt - now;
    return 0;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Panggil berkala supaya peta tidak tumbuh tanpa batas. */
  sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.hits) if (v.resetAt < now) this.hits.delete(k);
  }
}
