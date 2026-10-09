// E2E: sesi CWMP firmware ketat (tanpa cookie, GPN dangkal, cwmp-1-2, 204),
// redaman & PPPoE multi-vendor, batas RPC per sesi, konfigurasi dasar.
import { makeDevice, inform, settle } from './sim.mjs';
import { startAcs, reporter, idOf } from './harness.mjs';

const acs = await startAcs();
const t = reporter('Vendor & sesi CWMP ketat');
const devs = {
  fh: makeDevice('fiberhome', 'FHTT0001', { noCookie: true, freshConn: true, rejectDeep: true, ns: 'cwmp-1-2', strictNs: true, strictEnd: true }),
  cmcc: makeDevice('cmcc', 'CMCC0001', { strictEnd: true }),
  zte: makeDevice('zte', 'ZTEG0001', { noCookie: true, strictEnd: true }),
  hw: makeDevice('huawei', 'HWTC0001', { strictEnd: true }),
};
const per = [];
for (const [n, d] of Object.entries(devs)) { const p = await settle(d, acs.cwmp); per.push(...p); console.log(`  ${n}: ${p.join('+')} RPC`); }
t.check(Math.max(...per) <= 40, `batas RPC per sesi dipatuhi (maks ${Math.max(...per)})`);
const by = Object.fromEntries((await acs.get('/api/devices?limit=50')).items.map((d) => [d.serial_number, d]));
t.check(by.FHTT0001?.rx_power === -21.5 && by.FHTT0001?.tx_power === 2.3, `FiberHome redaman ${by.FHTT0001?.rx_power}/${by.FHTT0001?.tx_power}`);
t.check(by.FHTT0001?.pppoe_user === 'fiberhomeuser@isp' && by.FHTT0001?.software_version === 'RP2872', 'FiberHome PPPoE & firmware (tanpa cookie, GPN dangkal)');
t.check(by.CMCC0001?.rx_power === -19.03 && by.CMCC0001?.tx_power === 2.79 && by.CMCC0001?.optical_temp === 45, 'CMCC redaman 0.1 µW & suhu 1/256 °C');
t.check(by.ZTEG0001?.rx_power === -19.87 && by.ZTEG0001?.pppoe_user === 'zteuser@isp', 'ZTE tanpa cookie (keep-alive)');
t.check(by.HWTC0001?.rx_power === -24.61 && by.HWTC0001?.pppoe_user === 'huaweiuser@isp', 'Huawei');
for (const d of Object.values(devs)) t.check(d.errors.length === 0, `${d.vendor}: tanpa pelanggaran protokol ${d.errors.join('; ')}`);
const fdet = await acs.get(`/api/devices/${idOf(devs.fh)}`);
t.check(fdet.insight.wan.length === 2 && fdet.insight.wlan.length === 1, `FiberHome WAN ${fdet.insight.wan.length}, WLAN ${fdet.insight.wlan.length}`);
const cdet = await acs.get(`/api/devices/${idOf(devs.cmcc)}`);
const cppp = cdet.insight.wan.find((w) => w.kind === 'ppp');
let r = await acs.call('POST', `/api/devices/${idOf(devs.cmcc)}/config`, { type: 'vlan', target: cppp.base, vlanId: 300 });
t.check(r.status === 200 && !r.body.guessed.length, 'CMCC set VLAN (bukti link config)');
r = await acs.call('POST', `/api/devices/${idOf(devs.fh)}/config`, { type: 'pppoe', username: 'baru@fh', password: 'pw12345', vlanId: 200 });
t.check(r.status === 200, 'FiberHome PPPoE + VLAN');
r = await acs.call('POST', `/api/devices/${idOf(devs.fh)}/config`, { type: 'wifi', ssid: 'FH-Baru', passphrase: 'rahasia123' });
t.check(r.status === 200, 'FiberHome WiFi');
for (const d of [devs.cmcc, devs.fh]) await settle(d, acs.cwmp, '6 CONNECTION REQUEST');
const W = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.';
t.check(devs.cmcc.V.get(`${W}2.X_CMCC_WANGponLinkConfig.VLANIDMark`) === '300', 'CMCC VLAN 300 tertulis');
t.check(devs.fh.V.get(`${W}2.WANPPPConnection.1.Username`) === 'baru@fh' && devs.fh.V.get(`${W}2.WANPPPConnection.1.X_FH_VLANID`) === '200', 'FiberHome PPPoE & X_FH_VLANID tertulis');
t.check(devs.fh.V.get('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID') === 'FH-Baru', 'FiberHome SSID tertulis');
t.done(acs);
