// E2E: WAN internet multi-vendor (slot OLT, WCD kosong, binding, bertahap),
// perintah perangkat, prioritas antrean.
import { makeDevice, inform, settle } from './sim.mjs';
import { startAcs, reporter, idOf } from './harness.mjs';

const acs = await startAcs();
const t = reporter('WAN internet & perintah perangkat');
const W = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.';
const fh = makeDevice('fiberhome', 'FHTT0002', { emptySlot: true, strictEnd: true });
const zte = makeDevice('zte', 'ZTEG0002', { strictEnd: true });
const hw = makeDevice('huawei', 'HWTC0002', { strictEnd: true });
const cm = makeDevice('cmcc', 'CMCC0002', { strictEnd: true });
for (const d of [fh, zte, hw, cm]) await settle(d, acs.cwmp);

// FiberHome: isi slot OLT kosong WCD 3 · #1 · PPPoE_Routed
let det = await acs.get(`/api/devices/${idOf(fh)}`);
const slot = det.insight.wan.find((w) => w.wcd === 3);
t.check(slot?.connectionType === 'PPPoE_Routed' && !slot.username, 'slot OLT kosong terdeteksi');
let r = await acs.call('POST', `/api/devices/${idOf(fh)}/config`, { type: 'wan-add', placement: 'existing', target: slot.base, username: 'pel01@isp', password: 'rahasia1', vlanId: 200 });
t.check(r.status === 200 && !r.body.guessed.length, 'isi slot FiberHome tanpa tebakan');
fh.spvLog = [];
await settle(fh, acs.cwmp, '6 CONNECTION REQUEST');
const s3 = `${W}3.WANPPPConnection.1.`;
t.check(fh.V.get(`${s3}Username`) === 'pel01@isp' && fh.V.get(`${s3}Enable`) === 'true' && fh.V.get(`${s3}ConnectionType`) === 'PPPoE_Routed', 'slot terisi, aktif, ConnectionType dipertahankan');
t.check(fh.V.get(`${W}3.X_FH_WANGponLinkConfig.VLANID`) === '200' && fh.V.get(`${s3}X_FH_VLANID`) === '200', 'VLAN FiberHome link + koneksi');
t.check(/Enable=true$/.test(fh.spvLog.at(-1) ?? ''), 'Enable=true dikirim terakhir');
const BIND_ALL = 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1,InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.2,'
  + 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.3,InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.4,'
  + 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1';
t.check(fh.V.get(`${s3}X_FH_LanInterface`) === BIND_ALL, 'FiberHome: X_FH_LanInterface otomatis LAN1-4 + SSID1 (wajib binding)');
t.check(fh.V.get(`${s3}NATEnabled`) === 'true', 'FiberHome: NAT aktif untuk WAN INTERNET');
r = await acs.call('POST', `/api/devices/${idOf(fh)}/config`, { type: 'wan-add', placement: 'new', username: 'pel02@isp', password: 'rahasia2', vlanId: 300 });
await settle(fh, acs.cwmp, '6 CONNECTION REQUEST');
t.check(fh.V.get(`${W}4.WANPPPConnection.1.ConnectionType`) === 'PPPoE_Routed' && fh.V.get(`${W}4.X_FH_WANGponLinkConfig.VLANID`) === '300', 'WAN baru WCD 4 memakai PPPoE_Routed');
t.check(fh.V.get(`${W}4.WANPPPConnection.1.X_FH_LanInterface`) === BIND_ALL, 'FiberHome WAN baru: binding otomatis');
// Binding manual lewat aksi Binding (wan-bind) + terbaca di insight.
r = await acs.call('POST', `/api/devices/${idOf(fh)}/config`, { type: 'wan-bind', target: `${W}4.WANPPPConnection.1.`, bindLan: [1, 2], bindSsid: [1] });
await settle(fh, acs.cwmp, '6 CONNECTION REQUEST');
t.check(fh.V.get(`${W}4.WANPPPConnection.1.X_FH_LanInterface`) === 'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1,InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.2,InternetGatewayDevice.LANDevice.1.WLANConfiguration.1',
  'wan-bind: LAN1,LAN2 + SSID1');
det = await acs.get(`/api/devices/${idOf(fh)}`);
const b4 = det.insight.wan.find((c) => c.base === `${W}4.WANPPPConnection.1.`)?.binding;
t.check(JSON.stringify(b4) === JSON.stringify({ lan: [1, 2], ssid: [1] }) && det.wanCaps.bindingRequired && det.wanCaps.bindingParam === 'X_FH_LanInterface',
  `insight binding ${JSON.stringify(b4)}, wanCaps ${det.wanCaps.family}/${det.wanCaps.bindingParam} LAN ${det.wanCaps.lanPorts.join(',')}`);

// ZTE: koneksi baru di WCD kosong yang ada
r = await acs.call('POST', `/api/devices/${idOf(zte)}/config`, { type: 'wan-add', placement: 'wcd', wcd: 3, username: 'z@isp', password: 'pw123456', vlanId: 400 });
t.check(r.status === 200, 'ZTE WAN di WCD 3');
await settle(zte, acs.cwmp, '6 CONNECTION REQUEST');
t.check(zte.V.get(`${W}3.WANPPPConnection.1.X_ZTE-COM_VLANID`) === '400' && zte.V.get(`${W}3.WANPPPConnection.1.X_ZTE-COM_VLANEnable`) === 'true', 'ZTE VLANID + VLANEnable');
t.check(!zte.V.has(`${W}3.WANPPPConnection.1.X_ZTE-COM_LanInterface`), 'ZTE: tanpa binding otomatis (tidak wajib)');
// WAN layanan TR069 → tanpa NAT (default per layanan).
r = await acs.call('POST', `/api/devices/${idOf(zte)}/config`, { type: 'wan-ip-add', placement: 'new', vlanId: 700, serviceName: 'TR069', name: 'TR069_2' });
await settle(zte, acs.cwmp, '6 CONNECTION REQUEST');
const trBase = [...zte.V.keys()].find((k) => zte.V.get(k) === 'TR069_2')?.replace(/Name$/, '');
t.check(trBase && zte.V.get(`${trBase}NATEnabled`) === 'false', `WAN TR069: NATEnabled=false (${trBase?.split('.').slice(-4).join('.')})`);

// Huawei: IPoE + binding
r = await acs.call('POST', `/api/devices/${idOf(hw)}/config`, { type: 'wan-ip-add', placement: 'new', vlanId: 500, bindLan: [3], bindSsid: [2], name: 'IPTV' });
t.check(r.status === 200 && !r.body.guessed.length, 'Huawei IPoE + binding tanpa tebakan');
await settle(hw, acs.cwmp, '6 CONNECTION REQUEST');
const h3 = `${W}3.WANIPConnection.1.`;
t.check(hw.V.get(`${h3}X_HW_VLAN`) === '500' && hw.V.get(`${h3}X_HW_LANBIND.Lan3Enable`) === 'true' && hw.V.get(`${h3}X_HW_LANBIND.Lan1Enable`) === 'false', 'Huawei VLAN & LANBIND');

// CMCC: bertahap
r = await acs.call('POST', `/api/devices/${idOf(cm)}/config`, { type: 'wan-add', placement: 'new', username: 'c@isp', password: 'pw123456', vlanId: 600 });
t.check(r.body.plan?.some((p) => p.includes('(bertahap)')), 'CMCC pengiriman bertahap');
cm.spvLog = [];
await settle(cm, acs.cwmp, '6 CONNECTION REQUEST');
t.check(cm.spvLog.every((x) => !x.includes(' ')) && cm.V.get(`${W}3.X_CMCC_WANGponLinkConfig.VLANIDMark`) === '600', 'CMCC 1 parameter per SPV, VLAN 600');

// Perintah perangkat
const z2 = `${W}2.WANPPPConnection.1.`;
await acs.call('POST', `/api/devices/${idOf(zte)}/config`, { type: 'wan-enable', target: z2, enable: false });
await acs.call('POST', `/api/devices/${idOf(zte)}/config`, { type: 'inform-interval', informInterval: 600 });
await acs.call('POST', `/api/devices/${idOf(zte)}/reboot`);
await settle(zte, acs.cwmp, '6 CONNECTION REQUEST');
t.check(zte.V.get(`${z2}Enable`) === 'false' && zte.V.get('InternetGatewayDevice.ManagementServer.PeriodicInformInterval') === '600' && zte.rebooted === 1, 'nonaktif WAN, interval Inform, reboot');
const tasks = (await acs.get(`/api/devices/${idOf(zte)}`)).tasks;
t.check(!tasks.some((x) => x.status === 'pending'), 'semua task ZTE selesai');

// Prioritas antrean
await acs.call('POST', `/api/devices/${idOf(hw)}/refresh`);
await acs.call('POST', `/api/devices/${idOf(hw)}/config`, { type: 'wifi', ssid: 'Prioritas' });
hw.log = [];
await inform(hw, acs.cwmp, '6 CONNECTION REQUEST');
t.check(hw.log[0] === 'SetParameterValues', 'tulisan didahulukan dari bacaan');

// Satu model, dua firmware: ZTE ORI (X_ZTE-COM_*) dan ZTE berfirmware CMCC
// (X_CMCC_*) dengan ProductClass sama. Bukti discovery unit ORI tidak boleh
// ikut ditulis ke unit CMCC (SPV atomik → 9005).
const zcm = makeDevice('cmcc', 'F660CMCC', { strictEnd: true, identity: [zte.oui, zte.pc, 'ZTE'] });
await settle(zcm, acs.cwmp);
det = await acs.get(`/api/devices/${idOf(zcm)}`);
const zc = det.insight.wan.find((c) => c.kind === 'ppp' && c.username);
r = await acs.call('POST', `/api/devices/${idOf(zcm)}/config`, { type: 'vlan', target: zc.base, vlanId: 600 });
t.check(r.status === 200 && !r.body.plan.join(' ').includes('ZTE-COM'), `ZTE firmware CMCC: rencana tanpa X_ZTE-COM (${r.body.plan.join('; ')})`);
await settle(zcm, acs.cwmp, '6 CONNECTION REQUEST');
const zcLink = `${W}${zc.wcd}.X_CMCC_WANGponLinkConfig.VLANIDMark`;
t.check(zcm.V.get(zcLink) === '600' && !zcm.errors.length, `ZTE firmware CMCC: VLAN 600 di X_CMCC_WANGponLinkConfig, tanpa fault`);

// Remote management (akses WAN ke ONU) — lintas vendor.
const P = 'InternetGatewayDevice.';
const RA = `${P}UserInterface.RemoteAccess.Enable`;
const ACL = `${P}X_HW_Security.AclServices.`;
// Huawei: standar RemoteAccess + ACL per protokol; buka HTTP/HTTPS/Ping.
r = await acs.call('POST', `/api/devices/${idOf(hw)}/config`, { type: 'remote-mgmt', enable: true, protocols: ['http', 'https', 'ping'], port: 8443 });
t.check(r.status === 200 && !r.body.guessed.length, `Huawei remote-mgmt tanpa tebakan (${r.body.plan.join('; ')})`);
await settle(hw, acs.cwmp, '6 CONNECTION REQUEST');
t.check(hw.V.get(RA) === 'true' && hw.V.get(`${ACL}HTTPWanEnable`) === 'true' && hw.V.get(`${ACL}HTTPSWanEnable`) === 'true'
  && hw.V.get(`${ACL}PINGWanEnable`) === 'true' && hw.V.get(`${ACL}TELNETWanEnable`) === 'false' && hw.V.get(`${ACL}SSHWanEnable`) === 'false'
  && hw.V.get(`${ACL}HTTPWanPort`) === '8443' && !hw.errors.length,
  `Huawei: RemoteAccess + ACL per protokol diset (HTTP/HTTPS/Ping on, Telnet/SSH off, port 8443)`);

// ZTE: tanpa ACL Huawei → hanya standar RemoteAccess, tetap tanpa tebakan.
r = await acs.call('POST', `/api/devices/${idOf(zte)}/config`, { type: 'remote-mgmt', enable: true, protocols: ['http'] });
t.check(r.status === 200 && !r.body.guessed.length && !r.body.plan.join(' ').includes('X_HW_'), `ZTE remote-mgmt lewat standar TR-069 saja`);
await settle(zte, acs.cwmp, '6 CONNECTION REQUEST');
t.check(zte.V.get(RA) === 'true' && !zte.errors.length, 'ZTE: RemoteAccess.Enable=true');
// Nonaktifkan lagi.
await acs.call('POST', `/api/devices/${idOf(zte)}/config`, { type: 'remote-mgmt', enable: false });
await settle(zte, acs.cwmp, '6 CONNECTION REQUEST');
t.check(zte.V.get(RA) === 'false', 'ZTE: RemoteAccess.Enable=false (nonaktif)');

t.done(acs);
