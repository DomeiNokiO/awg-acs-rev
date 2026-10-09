// E2E: sandi WiFi/PPPoE terbuka (dari ONU / cadangan ACS), SSID tersembunyi,
// upgrade profil v5 → v6 tanpa GetParameterNames.
import { DatabaseSync } from 'node:sqlite';
import { makeDevice, inform, settle } from './sim.mjs';
import { startAcs, reporter, idOf } from './harness.mjs';

const acs = await startAcs();
const t = reporter('Sandi terbuka & SSID tersembunyi');
const W = 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.';
const zte = makeDevice('zte', 'ZTESEC', { wifiPass: 'RahasiaZTE1', pppPass: 'pppZTE123' });
const hw = makeDevice('huawei', 'HWSEC', { hideSecrets: true });
for (const d of [zte, hw]) await settle(d, acs.cwmp);
const det = (d) => acs.get(`/api/devices/${idOf(d)}`);

// 1. ONU yang mengirim sandi → tampil apa adanya.
let z = await det(zte);
const zp = z.insight.wan.find((c) => c.kind === 'ppp' && c.username);
t.check(z.insight.wlan[0].passphrase === 'RahasiaZTE1' && z.insight.wlan[0].passphraseSource === 'onu',
  `ZTE: sandi WiFi dari ONU "${z.insight.wlan[0].passphrase}"`);
t.check(zp.password === 'pppZTE123' && zp.passwordSource === 'onu', `ZTE: sandi PPPoE dari ONU "${zp.password}"`);
t.check(z.insight.wlan[0].hidden === false, 'ZTE: SSID tampil (SSIDAdvertisementEnabled=true)');

// 2. ONU yang menyembunyikan sandi → "tidak dikirim", lalu cadangan ACS setelah disetel.
let h = await det(hw);
t.check(h.insight.wlan[0].passphrase === null, 'Huawei (sandi dibaca kosong): belum ada sandi untuk ditampilkan');
let r = await acs.call('POST', `/api/devices/${idOf(hw)}/config`, { type: 'wifi', wlanIndex: 1, passphrase: 'BaruHW12345', wifiEnable: true, hidden: true });
t.check(r.status === 200 && r.body.queued > 0, `config WiFi sandi + hidden diantrekan (${r.status})`);
const hp = h.insight.wan.find((c) => c.kind === 'ppp' && c.username);
r = await acs.call('POST', `/api/devices/${idOf(hw)}/config`, { type: 'pppoe', target: hp.base, password: 'pppHW98765' });
await settle(hw, acs.cwmp, '6 CONNECTION REQUEST');
t.check(hw.V.get(`${W}SSIDAdvertisementEnabled`) === 'false' && hw.V.get(`${W}Enable`) === 'true',
  'ONU: WiFi tetap aktif, SSIDAdvertisementEnabled=false');
h = await det(hw);
const hw0 = h.insight.wlan[0];
t.check(hw0.passphrase === 'BaruHW12345' && hw0.passphraseSource === 'acs' && hw0.passphraseAt > 0,
  `Huawei: sandi WiFi cadangan ACS "${hw0.passphrase}"`);
t.check(hw0.hidden === true, 'Huawei: SSID terbaca tersembunyi setelah baca balik');
const hp2 = h.insight.wan.find((c) => c.base === hp.base);
t.check(hp2.password === 'pppHW98765' && hp2.passwordSource === 'acs', `Huawei: sandi PPPoE cadangan ACS "${hp2.password}"`);

// 3. Kredensial ManagementServer tidak ikut disimpan sebagai sandi pelanggan.
const db = new DatabaseSync(acs.dbFile);
const hid = `${hw.oui}-${hw.pc}-${hw.serial}`;
const sec = db.prepare('SELECT path FROM device_secret WHERE device_id = ?').all(hid).map((x) => x.path);
t.check(sec.length >= 2 && !sec.some((p) => /ManagementServer/.test(p)), `tersimpan ${sec.length} sandi, tanpa kredensial ManagementServer`);

// 4. Upgrade profil v5 → v6: leaf sandi/siaran ditambah dari struktur tersimpan, 0 GPN.
const zid = `${zte.oui}-${zte.pc}-${zte.serial}`;
const prof = JSON.parse(db.prepare('SELECT profile FROM collection WHERE device_id = ?').get(zid).profile)
  .filter((p) => !/(Password|SSIDAdvertisementEnabled)$/.test(p));
db.prepare('UPDATE collection SET profile = ?, profile_version = 5 WHERE device_id = ?').run(JSON.stringify(prof), zid);
db.prepare("DELETE FROM params WHERE device_id = ? AND (path LIKE '%Password' OR path LIKE '%SSIDAdvertisementEnabled')").run(zid);
zte.V.set(`${W}SSIDAdvertisementEnabled`, 'false');
zte.log = [];
await inform(zte, acs.cwmp, '2 PERIODIC');
z = await det(zte);
const gpn = zte.log.filter((m) => m === 'GetParameterNames').length;
t.check(gpn === 0 && z.insight.wlan[0].hidden === true && z.insight.wan.find((c) => c.username && c.kind === 'ppp').password === 'pppZTE123',
  `upgrade v5→v6: ${gpn} GPN, ${zte.log.length} RPC, sandi & status hidden terbaca lagi`);
t.done(acs);
