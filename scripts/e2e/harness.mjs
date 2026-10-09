/**
 * Utilitas uji e2e: jalankan ACS sungguhan di port acak dengan DB sementara,
 * login admin, dan helper pemanggilan API + pencatatan hasil.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startAcs(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'awg-acs-e2e-'));
  const cw = 30000 + Math.floor(Math.random() * 20000);
  const ap = cw + 1;
  const dbFile = join(dir, 'acs.db');
  const proc = spawn(process.execPath, [join(ROOT, 'apps/server/src/index.ts')], {
    env: {
      ...process.env, ACS_ADMIN_PASSWORD: 'Admin12345', ACS_DB: dbFile, ACS_CWMP_PORT: String(cw),
      ACS_API_PORT: String(ap), ACS_BIND: '127.0.0.1', ACS_LOG_LEVEL: 'warn', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !out.includes('ACS berjalan'); i++) await sleep(100);
  if (!out.includes('ACS berjalan')) throw new Error(`ACS gagal start:\n${out}`);
  const api = `http://127.0.0.1:${ap}`;
  const lg = await fetch(`${api}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'Admin12345' }) });
  const cookie = lg.headers.getSetCookie()[0].split(';')[0];
  const csrf = (await lg.json()).csrf;
  /** style 'old' = Content-Type JSON tanpa body (perilaku UI lama). */
  const call = async (method, path, body, style = 'new') => {
    const headers = { cookie, 'x-csrf': csrf };
    if (body !== undefined || style === 'old') headers['content-type'] = 'application/json';
    const r = await fetch(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, body: j };
  };
  return {
    cwmp: `http://127.0.0.1:${cw}/`, api, dbFile, cookie, csrf, call,
    get: async (p) => (await call('GET', p)).body,
    log: () => out,
    stop: () => { proc.kill(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* abaikan */ } },
  };
}

export function reporter(name) {
  let fails = 0;
  console.log(`\n# ${name}`);
  return {
    check(cond, msg) { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) fails++; },
    done(acs) { acs?.stop(); console.log(fails ? `${fails} GAGAL` : 'SEMUA LULUS'); process.exitCode = fails ? 1 : 0; },
  };
}

export const idOf = (d) => encodeURIComponent(`${d.oui}-${d.pc}-${d.serial}`);
export { sleep };
