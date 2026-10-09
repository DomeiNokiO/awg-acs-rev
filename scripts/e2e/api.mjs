// E2E: semua endpoint mutasi UI (gaya lama & baru), Connection Request
// Digest + kredensial otomatis, pesan error yang jelas.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { makeDevice, settle, inform } from './sim.mjs';
import { startAcs, reporter, idOf, sleep } from './harness.mjs';

const acs = await startAcs();
const t = reporter('API & tombol aksi');
const crPort = 40000 + Math.floor(Math.random() * 20000);
const dev = makeDevice('fiberhome', 'FHTT0077', {});
dev.V.set('InternetGatewayDevice.ManagementServer.ConnectionRequestURL', `http://127.0.0.1:${crPort}/tr069`);
let crHits = 0;
const md5 = (s) => createHash('md5').update(s).digest('hex');
const crServer = http.createServer((req, res) => {
  const h = req.headers.authorization ?? '';
  const nonce = 'abc123nonce';
  if (h.startsWith('Digest ')) {
    const f = Object.fromEntries([...h.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1], m[2] ?? m[3]]));
    const user = dev.V.get('InternetGatewayDevice.ManagementServer.ConnectionRequestUsername');
    const pass = dev.V.get('InternetGatewayDevice.ManagementServer.ConnectionRequestPassword') ?? '';
    const expect = md5(`${md5(`${user}:CPE:${pass}`)}:${nonce}:${f.nc}:${f.cnonce}:${f.qop}:${md5(`GET:${f.uri}`)}`);
    if (f.username === user && f.response === expect) { crHits++; res.writeHead(200); return res.end(); }
  }
  res.writeHead(401, { 'WWW-Authenticate': `Digest realm="CPE", nonce="${nonce}", qop="auth", algorithm=MD5` });
  res.end();
}).listen(crPort, '127.0.0.1');

await settle(dev, acs.cwmp);
const id = idOf(dev);
t.check(dev.V.get('InternetGatewayDevice.ManagementServer.ConnectionRequestUsername') === 'acs', 'kredensial Connection Request ACS terpasang otomatis');
let r = await acs.call('POST', `/api/devices/${id}/connect`, undefined, 'old');
t.check(r.status === 200 && r.body.auth === 'digest', `Hubungi (Digest) → ${r.status}`);
r = await acs.call('POST', `/api/devices/${id}/connect`);
t.check(r.status === 429 && crHits === 1, 'Hubungi beruntun dibatasi');
for (const p of [`/api/devices/${id}/discover`, `/api/devices/${id}/refresh`, `/api/devices/${id}/reboot`, '/api/presets/1/apply']) {
  for (const style of ['old', 'new']) {
    r = await acs.call('POST', p, undefined, style);
    t.check(r.status < 400, `POST ${p.replace(id, ':id')} (${style}) → ${r.status}`);
  }
}
r = await acs.call('POST', `/api/devices/${id}/factory-reset`, undefined, 'old');
t.check(r.status === 400 && /serial/.test(r.body.error), 'reset pabrik wajib konfirmasi serial');
r = await acs.call('POST', `/api/devices/${id}/write`, { values: { 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID': 'Smoke' } });
t.check(r.status === 200, 'Tulis Parameter format {values}');
r = await acs.call('PUT', `/api/devices/${id}`, { group_name: 'uji' });
t.check(r.status === 200, 'ubah metadata perangkat');
const wh = await acs.call('POST', '/api/webhooks', { name: 'uji', url: 'http://127.0.0.1:1/x', events: ['*'], enabled: true });
const whId = wh.body?.webhook?.id ?? wh.body?.id;
t.check(wh.status < 400 && whId, 'buat webhook');
t.check((await acs.call('POST', `/api/webhooks/${whId}/test`, undefined, 'old')).status < 500, 'test webhook');
t.check((await acs.call('DELETE', `/api/webhooks/${whId}`, undefined, 'old')).status < 400, 'hapus webhook');
t.check((await acs.call('POST', '/api/users', { username: 'teknisi', password: 'Teknisi12345!', role: 'viewer' })).status < 400, 'buat pengguna');
t.check((await acs.call('DELETE', '/api/users/teknisi', undefined, 'old')).status < 400, 'hapus pengguna');
t.check((await acs.call('DELETE', '/api/users/admin')).status === 400, 'tidak bisa menghapus akun sendiri');
r = await acs.call('POST', `/api/devices/${id}/config`, { type: 'wifi', ssid: '' });
t.check(r.status === 400 && r.body.error !== 'Bad Request', `config tanpa perubahan → "${r.body.error}"`);
const bad = await fetch(`${acs.api}/api/devices/${id}/discover`, { method: 'POST', headers: { cookie: acs.cookie, 'x-csrf': acs.csrf, 'content-type': 'application/json' }, body: '{rusak' });
t.check(bad.status === 400 && (await bad.json()).error === 'Body JSON tidak valid', 'JSON rusak → pesan jelas');
dev.V.set('InternetGatewayDevice.ManagementServer.ConnectionRequestURL', `http://127.0.0.1:${crPort + 1}/`);
await sleep(10_500);
await inform(dev, acs.cwmp, '6 CONNECTION REQUEST');
r = await acs.call('POST', `/api/devices/${id}/connect`);
t.check(r.status === 200 && r.body.ok === false && r.body.reason === 'unreachable' && /tidak terjangkau.*ECONNREFUSED/.test(r.body.error),
  'ONU tak terjangkau → 200 ok:false + pesan penyebab (tidak hilang di balik proxy)');

// FiberHome RP2872: ONU melaporkan port Connection Request di luar rentang TCP.
dev.V.set('InternetGatewayDevice.ManagementServer.ConnectionRequestURL', 'http://11.171.0.4:1601009200/tr069');
await sleep(10_500);
await inform(dev, acs.cwmp, '6 CONNECTION REQUEST');
r = await acs.call('POST', `/api/devices/${id}/connect`);
t.check(r.status === 200 && r.body.ok === false && r.body.reason === 'malformed' && /65535/.test(r.body.error),
  'URL CR port tak valid → reason malformed, pesan menyebut batas 65535');
crServer.close();
t.done(acs);
